#!/usr/bin/env python3
"""
ruyiPage-compatible Camoufox / Playwright adapter — full API surface.

Maps every ruyiPage call site in apple_account_flow.py to Playwright equivalents:
  page.eles / element.attr / element.value / element.run_js / element.input /
  element.location / element.size / element.scroll.to_see /
  scope.actions.human_click / .type / .combo / .press /
  scope.run_js / scope.get_frames / scope.new_tab / scope.get / scope.get_tabs
"""

from __future__ import annotations

import random
import sys
import time
from dataclasses import dataclass
from typing import Any, Callable

from camoufox_session import build_camoufox_launch_kwargs

_MAX_CLICK_RETRIES = 3
_CLICK_RETRY_DELAY = (0.4, 1.0)

_FRAME_LIFECYCLE_KEYWORDS = (
    "context was destroyed",
    "execution context",
    "frame was detached",
    "frame has been detached",
    "target closed",
    "page has been closed",
    "object has been collected",
    "disposed",
    "navigation",
    "frame.evaluate",
)


def _is_frame_lifecycle_error(exc: Exception) -> bool:
    """Return True for transient Playwright errors caused by frame navigation."""
    msg = str(exc).lower()
    return any(kw in msg for kw in _FRAME_LIFECYCLE_KEYWORDS)


# ---------------------------------------------------------------------------
# Keys (ruyiPage.Keys → Playwright key names)
# ---------------------------------------------------------------------------
class Keys:
    COMMAND = "Meta"
    CONTROL = "Control"
    ALT = "Alt"
    SHIFT = "Shift"
    ENTER = "Enter"
    RETURN = "Enter"
    DELETE = "Backspace"
    BACKSPACE = "Backspace"
    TAB = "Tab"
    ESCAPE = "Escape"
    SPACE = " "


# ---------------------------------------------------------------------------
# Selector / JS helpers
# ---------------------------------------------------------------------------
def normalize_selector(selector: str) -> str:
    text = str(selector or "").strip()
    if not text:
        return text
    if text.startswith("css:"):
        return text[4:]
    if text.startswith("xpath:"):
        return f"xpath={text[6:]}"
    if text.startswith("text:"):
        return f"text={text[5:]}"
    if text.startswith("tag:"):
        return text[4:]
    return text


def wrap_return_script(script: str) -> str:
    """Convert ruyiPage-style JS to Playwright evaluate expression."""
    body = str(script or "").strip()
    if not body:
        return "() => undefined"
    if body.startswith("(") or body.startswith("async"):
        return body
    if body.startswith("function"):
        return f"({body})()"
    if body.startswith("return "):
        expr = body[len("return "):].rstrip(";").strip()
        return f"() => {{ return ({expr}); }}"
    if "return " in body:
        return f"() => {{ {body} }}"
    return f"() => {{ return ({body}); }}"


# ---------------------------------------------------------------------------
# _States — dynamic visibility / alive checks via Playwright
# ---------------------------------------------------------------------------
class _States:
    def __init__(
        self,
        is_alive: bool = True,
        is_displayed: bool = True,
        is_enabled: bool = True,
        _page: Any = None,
        _locator: Any = None,
    ) -> None:
        self._is_alive = is_alive
        self._is_displayed = is_displayed
        self._is_enabled = is_enabled
        self._page = _page
        self._locator = _locator

    @property
    def is_alive(self) -> bool:
        if self._page is not None:
            try:
                return not self._page.is_closed()
            except Exception:
                return False
        return self._is_alive

    @is_alive.setter
    def is_alive(self, value: bool) -> None:
        self._is_alive = value

    @property
    def is_displayed(self) -> bool:
        if self._locator is not None:
            try:
                return bool(self._locator.is_visible(timeout=800))
            except Exception:
                return self._is_displayed
        return self._is_displayed

    @is_displayed.setter
    def is_displayed(self, value: bool) -> None:
        self._is_displayed = value

    @property
    def is_enabled(self) -> bool:
        if self._locator is not None:
            try:
                return bool(self._locator.is_enabled(timeout=800))
            except Exception:
                return self._is_enabled
        return self._is_enabled

    @is_enabled.setter
    def is_enabled(self, value: bool) -> None:
        self._is_enabled = value

    @property
    def is_checked(self) -> bool:
        """ruyiPage checkbox/radio checked state."""
        if self._locator is not None:
            try:
                return bool(self._locator.is_checked(timeout=1_000))
            except Exception:
                try:
                    return self._locator.evaluate(
                        "el => Boolean(el.checked || el.getAttribute('aria-checked') === 'true')"
                    )
                except Exception:
                    return False
        return False


# ---------------------------------------------------------------------------
# Click with auto-retry for Apple hydration races
# ---------------------------------------------------------------------------
def _click_with_retry(locator: Any, timeout: int = 15_000) -> None:
    """Click with escalating strategies to handle Camoufox humanize hangs.

    Strategy 1: normal click (humanized mouse trajectory)
    Strategy 2: click with force=True (skip actionability, no trajectory)
    Strategy 3: dispatch_event("click") (pure JS, no mouse at all)
    """
    from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FTimeout

    click_timeout_s = max(5, timeout // 1000) + 3

    def _try_scroll(loc: Any) -> None:
        try:
            loc.scroll_into_view_if_needed(timeout=5_000)
        except Exception:
            pass

    for attempt in range(_MAX_CLICK_RETRIES):
        _try_scroll(locator)
        time.sleep(random.uniform(0.05, 0.18))

        # Strategy 1: normal click — humanized mouse path.
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(
                    locator.click, timeout=timeout, delay=random.randint(20, 80)
                )
                future.result(timeout=click_timeout_s)
            return
        except _FTimeout:
            sys.stderr.write(
                f"[camoufox-click] humanize click hung ({click_timeout_s}s), "
                f"falling back to force click\n"
            )
        except Exception as exc:
            if _is_frame_lifecycle_error(exc):
                raise
            sys.stderr.write(
                f"[camoufox-click] attempt {attempt+1}: {exc}\n"
            )

        # Strategy 2: force click — bypasses actionability checks + mouse trajectory.
        try:
            locator.click(force=True, timeout=5_000)
            return
        except Exception as exc:
            if _is_frame_lifecycle_error(exc):
                raise
            sys.stderr.write(
                f"[camoufox-click] force click failed: {exc}\n"
            )

        # Strategy 3: JS dispatch — no mouse involvement at all.
        try:
            locator.dispatch_event("click")
            return
        except Exception as exc:
            if _is_frame_lifecycle_error(exc):
                raise
            sys.stderr.write(
                f"[camoufox-click] dispatch_event failed: {exc}\n"
            )

        if attempt < _MAX_CLICK_RETRIES - 1:
            time.sleep(random.uniform(*_CLICK_RETRY_DELAY))


# ---------------------------------------------------------------------------
# _ActionChain (scope.actions.human_click / type / combo / press)
# ---------------------------------------------------------------------------
class _ActionChain:
    def __init__(self, scope: "CamoufoxScope") -> None:
        self._scope = scope
        self._steps: list[Callable[[], None]] = []

    def human_click(self, target: Any) -> "_ActionChain":
        def step() -> None:
            if isinstance(target, dict) and "x" in target and "y" in target:
                page = self._scope._keyboard_page()
                time.sleep(random.uniform(0.05, 0.18))
                page.mouse.click(
                    int(target["x"]),
                    int(target["y"]),
                    delay=random.randint(20, 80),
                )
                return
            locator = self._scope._resolve_locator(target)
            _click_with_retry(locator)

        self._steps.append(step)
        return self

    def type(self, text: str, interval: int | float | None = None) -> "_ActionChain":
        delay_ms = int(interval) if interval is not None else random.randint(55, 145)

        def step() -> None:
            self._scope._keyboard_page().keyboard.type(str(text), delay=delay_ms)

        self._steps.append(step)
        return self

    def combo(self, *keys: Any) -> "_ActionChain":
        mapped = [self._map_key(k) for k in keys]

        def step() -> None:
            page = self._scope._keyboard_page()
            if not mapped:
                return
            for key in mapped[:-1]:
                page.keyboard.down(key)
            try:
                page.keyboard.press(mapped[-1])
            finally:
                for key in reversed(mapped[:-1]):
                    page.keyboard.up(key)

        self._steps.append(step)
        return self

    def press(self, key: Any) -> "_ActionChain":
        mapped = self._map_key(key)

        def step() -> None:
            self._scope._keyboard_page().keyboard.press(mapped)

        self._steps.append(step)
        return self

    def perform(self) -> None:
        for step in self._steps:
            step()
        self._steps.clear()

    @staticmethod
    def _map_key(key: Any) -> str:
        if key is None:
            return ""
        return str(key)


# ---------------------------------------------------------------------------
# _WaitApi / _ScrollApi
# ---------------------------------------------------------------------------
class _WaitApi:
    def __init__(self, scope: "CamoufoxScope") -> None:
        self._scope = scope

    def doc_loaded(self, timeout: float | int | None = None) -> None:
        timeout_ms = int(float(timeout) * 1000) if timeout and timeout > 0 else 30_000
        try:
            self._scope._page_like().wait_for_load_state(
                "domcontentloaded", timeout=timeout_ms
            )
        except Exception:
            pass


class _ScrollApi:
    def __init__(self, locator: Any) -> None:
        self._locator = locator

    def to_see(self) -> None:
        try:
            self._locator.scroll_into_view_if_needed(timeout=5_000)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# CamoufoxElement — full ruyiPage element surface
# ---------------------------------------------------------------------------
class CamoufoxElement:
    def __init__(self, scope: "CamoufoxScope", locator: Any, **_kw: Any) -> None:
        self._scope = scope
        self._locator = locator
        self.states = _States(
            is_alive=True, is_displayed=True, is_enabled=True,
            _page=None, _locator=locator,
        )
        self.scroll = _ScrollApi(locator)

    # -- ruyiPage .location / .size (bounding box) --------------------------
    @property
    def location(self) -> dict[str, float]:
        try:
            box = self._locator.bounding_box(timeout=5_000)
            if box:
                return {"x": box["x"], "y": box["y"]}
        except Exception:
            pass
        return {"x": 0, "y": 0}

    @property
    def size(self) -> dict[str, float]:
        try:
            box = self._locator.bounding_box(timeout=5_000)
            if box:
                return {"width": box["width"], "height": box["height"]}
        except Exception:
            pass
        return {"width": 0, "height": 0}

    # -- ruyiPage .value (direct property read) -----------------------------
    @property
    def value(self) -> str | None:
        """Read the current value — Playwright native, no JS evaluate needed."""
        try:
            return self._locator.input_value(timeout=3_000)
        except Exception:
            pass
        try:
            return self._locator.evaluate(
                "el => typeof el.value === 'string' ? el.value : "
                "(el.innerText ?? el.textContent ?? null)"
            )
        except Exception:
            return None

    # -- ruyiPage .text (visible text content) --------------------------------
    @property
    def text(self) -> str:
        try:
            return str(self._locator.inner_text(timeout=3_000) or "")
        except Exception:
            try:
                return str(self._locator.text_content(timeout=3_000) or "")
            except Exception:
                return ""

    # -- .attr(name) --------------------------------------------------------
    def attr(self, name: str) -> str | None:
        try:
            value = self._locator.get_attribute(name, timeout=3_000)
            return None if value is None else str(value)
        except Exception:
            return None

    # -- .run_js(script)  — this-bound JS on the element --------------------
    def run_js(self, script: str) -> Any:
        body = str(script or "").strip()
        if not body:
            return None
        if body in ("return this.value", "this.value"):
            return self.value
        try:
            if body.startswith("function"):
                return self._locator.evaluate(f"el => ({body}).call(el)")
            if "this." in body or "this " in body or "this," in body:
                inner = body if "return" in body else f"return ({body})"
                return self._locator.evaluate(
                    f"el => (function(){{ {inner} }}).call(el)"
                )
            return self._locator.evaluate(wrap_return_script(body))
        except Exception as exc:
            if _is_frame_lifecycle_error(exc):
                return None
            raise

    # -- .input(value, clear=True) — trusted element fill -------------------
    def input(self, value: str, clear: bool = True) -> None:
        loc = self._locator
        loc.scroll_into_view_if_needed(timeout=5_000)
        _click_with_retry(loc, timeout=10_000)
        if clear:
            loc.fill("")
        loc.fill(str(value))

    # -- .screenshot(path) --------------------------------------------------
    def screenshot(self, path: str) -> None:
        from pathlib import Path as P
        P(path).parent.mkdir(parents=True, exist_ok=True)
        self._locator.screenshot(path=path)

    def scroll_into_view(self) -> None:
        self.scroll.to_see()


# ---------------------------------------------------------------------------
# CamoufoxScope — page / frame scope
# ---------------------------------------------------------------------------
class CamoufoxScope:
    """Page or Frame scope with ruyiPage-like surface."""

    def __init__(
        self,
        session: "CamoufoxSession",
        page: Any,
        *,
        frame: Any | None = None,
        parent: "CamoufoxScope | None" = None,
    ) -> None:
        self._session = session
        self._page = page
        self._frame = frame
        self.parent = parent
        self.states = _States(is_alive=True, _page=page)
        self.wait = _WaitApi(self)
        self.actions = _ActionChain(self)
        self.browser = session
        try:
            if frame is not None:
                fn = str(getattr(frame, "name", "") or "")
                fu = str(getattr(frame, "url", "") or "")
                self.tab_id = f"frame:{id(page)}:{id(frame)}:{fn}:{fu[:120]}"
            else:
                self.tab_id = f"page:{id(page)}"
        except Exception:
            self.tab_id = f"scope:{id(self)}"

    @property
    def latest_tab(self) -> "CamoufoxScope":
        return self._session.latest_tab or self

    def _page_like(self) -> Any:
        return self._frame if self._frame is not None else self._page

    def _keyboard_page(self) -> Any:
        """Return the page object for keyboard dispatch.  Playwright routes
        keyboard events to whichever frame currently has focus."""
        return self._page

    def _resolve_locator(self, target: Any) -> Any:
        if isinstance(target, CamoufoxElement):
            return target._locator
        return target

    # -- scope.run_js -------------------------------------------------------
    def run_js(self, script: str) -> Any:
        body = str(script or "").strip()
        if not body:
            return None
        target = self._page_like()
        # Fast path for the most-called pattern.
        if body == "return location.href":
            try:
                return target.evaluate("() => location.href")
            except Exception:
                try:
                    return str(target.url or "")
                except Exception:
                    return ""
        # Ensure the frame is still attached and loaded before evaluating.
        try:
            if hasattr(target, "url"):
                url = str(target.url or "")
                if not url or url == "about:blank":
                    # Frame hasn't navigated yet — JS eval would be meaningless.
                    return None
        except Exception:
            return None
        try:
            return target.evaluate(wrap_return_script(body))
        except Exception as exc:
            if _is_frame_lifecycle_error(exc):
                return None
            if body.startswith("return "):
                return None
            raise

    # -- scope.eles ---------------------------------------------------------
    def eles(
        self, selector: str, timeout: float | int | None = None
    ) -> list[CamoufoxElement]:
        css = normalize_selector(selector)
        if not css:
            return []
        timeout_s = float(timeout) if timeout is not None else 0.0
        wait_ms = (
            max(0, int(timeout_s * 1000))
            if 0 < timeout_s < 300
            else (int(timeout_s) if timeout_s >= 300 else 0)
        )
        root = self._page_like()
        try:
            # Skip detached/navigating frames entirely.
            if hasattr(root, "url") and not root.url:
                return []
        except Exception:
            return []
        locator = root.locator(css)
        try:
            if wait_ms > 0:
                locator.first.wait_for(state="attached", timeout=wait_ms)
            count = locator.count()
        except Exception:
            return []
        return [
            CamoufoxElement(self, locator.nth(i))
            for i in range(min(count, 200))
        ]

    # -- scope.get_frames ---------------------------------------------------
    def get_frames(self) -> list["CamoufoxScope"]:
        frames: list[CamoufoxScope] = []
        try:
            main = self._page.main_frame
            current = self._frame if self._frame is not None else main
            for frame in list(self._page.frames):
                try:
                    if frame.parent_frame != current:
                        continue
                    url = str(frame.url or "")
                    if url == "about:blank" or url == "about:srcdoc":
                        continue
                    frames.append(
                        CamoufoxScope(
                            self._session, self._page,
                            frame=frame, parent=self,
                        )
                    )
                except Exception:
                    continue
        except Exception:
            pass
        return frames

    def shadow_roots(self, mode: str = "all", include_frames: bool = False) -> list[Any]:
        return []

    # -- navigation ---------------------------------------------------------
    def new_tab(self, url: str = "about:blank") -> "CamoufoxScope":
        return self._session.new_tab(url)

    def get(self, url: str) -> "CamoufoxScope":
        target = str(url or "").strip() or "about:blank"
        sys.stderr.write(f"[camoufox-nav] get {target[:80]}\n")
        try:
            self._page.goto(target, wait_until="domcontentloaded", timeout=90_000)
        except Exception as exc:
            sys.stderr.write(f"[camoufox-nav] goto error: {exc}\n")
            if self._page.is_closed():
                raise
        for state in ("load", "networkidle"):
            try:
                self._page.wait_for_load_state(state, timeout=15_000)
            except Exception:
                pass
        sys.stderr.write(f"[camoufox-nav] loaded url={self._page.url[:100]}\n")
        return self

    def get_tabs(self, url: str | None = None) -> list["CamoufoxScope"]:
        return self._session.get_tabs(url=url)

    # -- screenshot / quit --------------------------------------------------
    def screenshot(self, path: str, full_page: bool = True) -> None:
        from pathlib import Path as P
        P(path).parent.mkdir(parents=True, exist_ok=True)
        self._page.screenshot(path=path, full_page=full_page)

    def quit(self) -> None:
        self._session.close()

    def human_click_at(self, x: int, y: int) -> None:
        self._page.mouse.click(x, y)


# ---------------------------------------------------------------------------
# CamoufoxSession — one persistent context = one fingerprint
# ---------------------------------------------------------------------------
class CamoufoxSession:
    def __init__(self) -> None:
        self._camoufox_cm: Any = None
        self._context: Any = None
        self._tabs: list[CamoufoxScope] = []
        self.latest_tab: CamoufoxScope | None = None
        self.address = "camoufox:local"
        self._close_on_exit = True
        self._preserved = False
        self._fingerprint_token = (
            f"camoufox-{int(time.time())}-{random.randint(1000, 9999)}"
        )

    @property
    def fingerprint_token(self) -> str:
        return self._fingerprint_token

    def launch(self, opts: "FirefoxOptions") -> CamoufoxScope:
        import traceback as tb
        from camoufox.sync_api import Camoufox

        kwargs = build_camoufox_launch_kwargs(
            profile_dir=opts.user_dir,
            window=opts.window_size,
            headless=opts.headless_mode,
            close_on_exit=opts.close_on_exit_flag,
            firefox_executable=opts.browser_path,
        )
        preserve = bool(kwargs.pop("_preserve_process", False))
        self._close_on_exit = opts.close_on_exit_flag and not preserve
        self._preserved = False

        proxy_server = kwargs.get("proxy", {}).get("server", "none") if "proxy" in kwargs else "none"
        sys.stderr.write(
            f"[camoufox-launch] fingerprint_preset={kwargs.get('fingerprint_preset')} "
            f"os={kwargs.get('os')} humanize={kwargs.get('humanize')} "
            f"geoip={kwargs.get('geoip', False)} proxy={proxy_server} "
            f"persistent_context={kwargs.get('persistent_context')} "
            f"user_data_dir={kwargs.get('user_data_dir', 'none')}\n"
        )

        try:
            self._camoufox_cm = Camoufox(**kwargs)
            self._context = self._camoufox_cm.__enter__()
        except Exception as exc:
            sys.stderr.write(f"[camoufox-launch] FAILED: {exc}\n{tb.format_exc()}")
            raise

        ctx = self._context
        pages: list[Any] = []
        try:
            pages = list(ctx.pages) if hasattr(ctx, "pages") else []
        except Exception:
            pages = []

        if pages:
            page = pages[0]
            sys.stderr.write(
                f"[camoufox-launch] reusing persistent-context page "
                f"(total={len(pages)})\n"
            )
        elif hasattr(ctx, "new_page"):
            page = ctx.new_page()
        else:
            ctx = ctx.new_context()
            self._context = ctx
            page = ctx.new_page()

        scope = CamoufoxScope(self, page)
        self._tabs = [scope]
        self.latest_tab = scope
        sys.stderr.write(f"[camoufox-launch] ready url={page.url}\n")
        return scope

    def new_tab(self, url: str = "about:blank") -> CamoufoxScope:
        if self._context is None:
            raise RuntimeError("Camoufox session is not started")
        page = self._context.new_page()
        scope = CamoufoxScope(self, page)
        self._tabs.append(scope)
        self.latest_tab = scope
        target = str(url or "about:blank").strip()
        if target and target != "about:blank":
            sys.stderr.write(f"[camoufox-tab] goto {target[:80]}\n")
            try:
                page.goto(target, wait_until="domcontentloaded", timeout=90_000)
            except Exception as exc:
                sys.stderr.write(f"[camoufox-tab] goto error: {exc}\n")
                if page.is_closed():
                    raise
            for state in ("load", "networkidle"):
                try:
                    page.wait_for_load_state(state, timeout=15_000)
                except Exception:
                    pass
            sys.stderr.write(f"[camoufox-tab] loaded url={page.url[:100]}\n")
        return scope

    def get_tabs(self, url: str | None = None) -> list[CamoufoxScope]:
        alive: list[CamoufoxScope] = []
        for tab in list(self._tabs):
            try:
                if tab._page.is_closed():
                    continue
            except Exception:
                continue
            if url and url.lower() not in str(tab._page.url or "").lower():
                continue
            alive.append(tab)
        self._tabs = [t for t in self._tabs if not t._page.is_closed()]
        if alive:
            self.latest_tab = alive[-1]
        return list(alive)

    def close(self) -> None:
        if not self._close_on_exit:
            sys.stderr.write(
                "[camoufox-close] preserve requested — detaching browser\n"
            )
            self._preserved = True
            # Detach ALL references so Python's GC/atexit cannot trigger
            # Playwright cleanup.  The Camoufox Firefox process survives.
            self._camoufox_cm = None
            self._context = None
            return
        try:
            if self._camoufox_cm is not None:
                self._camoufox_cm.__exit__(None, None, None)
        except Exception as exc:
            sys.stderr.write(f"[camoufox-close] error: {exc}\n")
        self._camoufox_cm = None
        self._context = None
        self._tabs = []
        self.latest_tab = None


# ---------------------------------------------------------------------------
# FirefoxOptions / FirefoxPage — constructor-compatible stand-ins
# ---------------------------------------------------------------------------
@dataclass
class FirefoxOptions:
    browser_path: str | None = None
    user_dir: str | None = None
    window_size: tuple[int, int] = (1280, 960)
    headless_mode: bool = False
    close_on_exit_flag: bool = True
    page_load_timeout: int = 90
    script_timeout: int = 30
    implicit_timeout: int = 2
    human_algorithm: str | None = None

    def set_browser_path(self, path: str) -> None:
        self.browser_path = str(path) if path else None

    def set_user_dir(self, path: str) -> None:
        self.user_dir = str(path) if path else None

    def set_window_size(self, w: int, h: int) -> None:
        self.window_size = (int(w), int(h))

    def set_timeouts(self, implicit: int, page_load: int, script: int) -> None:
        self.implicit_timeout = int(implicit)
        self.page_load_timeout = int(page_load)
        self.script_timeout = int(script)

    def headless(self, value: bool = True) -> None:
        self.headless_mode = bool(value)

    def close_on_exit(self, value: bool = True) -> None:
        self.close_on_exit_flag = bool(value)

    def set_human_algorithm(self, name: str) -> None:
        self.human_algorithm = str(name)


class FirefoxPage:
    """FirefoxPage(opts) → CamoufoxScope  (constructor compat)."""

    def __new__(cls, opts: FirefoxOptions | None = None):  # type: ignore[misc]
        return CamoufoxSession().launch(opts or FirefoxOptions())


def import_camoufox_runtime() -> (
    tuple[type[FirefoxOptions], type[FirefoxPage], type[Keys]]
):
    try:
        import camoufox  # noqa: F401
    except Exception as exc:
        raise RuntimeError(
            "camoufox is not installed. Run ./install.sh"
        ) from exc
    return FirefoxOptions, FirefoxPage, Keys
