#!/usr/bin/env python3
"""
ruyiPage-compatible Camoufox / Playwright adapter.

Keeps apple_account_flow.py call sites stable:
  page.eles("css:..."), scope.actions.human_click(el).perform(),
  page.new_tab(url), field.input(value, clear=True), Keys.*, etc.

One Camoufox persistent context = one fingerprint for every new_page/tab.
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
    """Convert ruyiPage-style JS snippets to Playwright evaluate expressions."""
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


class _States:
    """Observable state container.  ``is_alive`` dynamically checks page closure."""

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


def _click_with_retry(locator: Any, timeout: int = 15_000) -> None:
    """Click with auto-retry for page hydration races."""
    last_error: Exception | None = None
    for attempt in range(_MAX_CLICK_RETRIES):
        try:
            locator.scroll_into_view_if_needed(timeout=5_000)
            time.sleep(random.uniform(0.05, 0.18))
            locator.click(timeout=timeout, delay=random.randint(20, 80))
            return
        except Exception as exc:
            last_error = exc
            msg = str(exc).lower()
            if "closed" in msg or "disposed" in msg or "target closed" in msg:
                raise
            if attempt < _MAX_CLICK_RETRIES - 1:
                sys.stderr.write(
                    f"[camoufox-click] retry {attempt+1}/{_MAX_CLICK_RETRIES}: {exc}\n"
                )
                time.sleep(random.uniform(*_CLICK_RETRY_DELAY))
    if last_error is not None:
        raise last_error


class _ActionChain:
    def __init__(self, scope: "CamoufoxScope") -> None:
        self._scope = scope
        self._steps: list[Callable[[], None]] = []

    def human_click(self, target: Any) -> "_ActionChain":
        def step() -> None:
            locator = self._scope._resolve_locator(target)
            _click_with_retry(locator)

        self._steps.append(step)
        return self

    def type(self, text: str, interval: int | float | None = None) -> "_ActionChain":
        delay_ms = int(interval) if interval is not None else random.randint(55, 145)

        def step() -> None:
            page = self._scope._keyboard_page()
            page.keyboard.type(str(text), delay=delay_ms)

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
        if isinstance(key, str):
            return key
        return str(key)


class _WaitApi:
    def __init__(self, scope: "CamoufoxScope") -> None:
        self._scope = scope

    def doc_loaded(self, timeout: float | int | None = None) -> None:
        """Wait for DOMContentLoaded.  ``timeout`` is in seconds (ruyiPage convention)."""
        if timeout is not None and timeout > 0:
            timeout_ms = int(float(timeout) * 1000)
        else:
            timeout_ms = 30_000
        try:
            self._scope._page_like().wait_for_load_state(
                "domcontentloaded", timeout=timeout_ms
            )
        except Exception:
            pass


class _ScrollApi:
    """Adapter for ruyiPage's ``element.scroll.to_see()``."""

    def __init__(self, locator: Any) -> None:
        self._locator = locator

    def to_see(self) -> None:
        try:
            self._locator.scroll_into_view_if_needed(timeout=5_000)
        except Exception:
            pass


class CamoufoxElement:
    def __init__(
        self,
        scope: "CamoufoxScope",
        locator: Any,
        *,
        handle: Any | None = None,
    ) -> None:
        self._scope = scope
        self._locator = locator
        self._handle = handle
        self.states = _States(
            is_alive=True,
            is_displayed=True,
            is_enabled=True,
            _page=None,
            _locator=locator,
        )
        self.scroll = _ScrollApi(locator)

    @property
    def location(self) -> dict[str, float]:
        """ruyiPage compat: element bounding-box top-left in viewport coords."""
        try:
            box = self._locator.bounding_box(timeout=5_000)
            if box:
                return {"x": box["x"], "y": box["y"]}
        except Exception:
            pass
        return {"x": 0, "y": 0}

    @property
    def size(self) -> dict[str, float]:
        """ruyiPage compat: element width/height."""
        try:
            box = self._locator.bounding_box(timeout=5_000)
            if box:
                return {"width": box["width"], "height": box["height"]}
        except Exception:
            pass
        return {"width": 0, "height": 0}

    def attr(self, name: str) -> str | None:
        try:
            value = self._locator.get_attribute(name, timeout=3_000)
            return None if value is None else str(value)
        except Exception:
            return None

    def run_js(self, script: str) -> Any:
        """Run JS in the element context.  ruyiPage binds ``this`` to the element."""
        body = str(script or "").strip()
        if not body:
            return None
        if body.startswith("function"):
            return self._locator.evaluate(f"el => ({body}).call(el)")
        if "this." in body or "this " in body or "this," in body:
            if "return" not in body:
                inner = f"return ({body})"
            else:
                inner = body
            return self._locator.evaluate(
                f"el => (function(){{ {inner} }}).call(el)"
            )
        return self._locator.evaluate(wrap_return_script(body))

    def input(self, value: str, clear: bool = True) -> None:
        locator = self._locator
        locator.scroll_into_view_if_needed(timeout=5_000)
        _click_with_retry(locator, timeout=10_000)
        if clear:
            locator.fill("")
        locator.fill(str(value))

    def screenshot(self, path: str) -> None:
        from pathlib import Path as P

        P(path).parent.mkdir(parents=True, exist_ok=True)
        self._locator.screenshot(path=path)

    def scroll_into_view(self) -> None:
        self.scroll.to_see()


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
                frame_name = str(getattr(frame, "name", "") or "")
                frame_url = str(getattr(frame, "url", "") or "")
                self.tab_id = (
                    f"frame:{id(page)}:{id(frame)}:{frame_name}:{frame_url[:120]}"
                )
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
        return self._page

    def _resolve_locator(self, target: Any) -> Any:
        if isinstance(target, CamoufoxElement):
            return target._locator
        if isinstance(target, dict) and "x" in target and "y" in target:
            return target
        return target

    def run_js(self, script: str) -> Any:
        """Run JS on the page/frame scope.

        Cross-origin iframes reject evaluate(); fall back to Playwright
        frame.url for the most common pattern.
        """
        body = str(script or "").strip()
        if not body:
            return None
        target = self._page_like()
        if body == "return location.href":
            try:
                return target.evaluate("() => location.href")
            except Exception:
                try:
                    return str(target.url or "")
                except Exception:
                    return ""
        try:
            return target.evaluate(wrap_return_script(body))
        except Exception:
            if body.startswith("return "):
                try:
                    return str(target.url or "")
                except Exception:
                    pass
            return None

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
        locator = root.locator(css)
        try:
            if wait_ms > 0:
                locator.first.wait_for(state="attached", timeout=wait_ms)
            count = locator.count()
        except Exception:
            return []
        elements: list[CamoufoxElement] = []
        for index in range(min(count, 200)):
            item = locator.nth(index)
            elements.append(CamoufoxElement(self, item))
        return elements

    def get_frames(self) -> list["CamoufoxScope"]:
        frames: list[CamoufoxScope] = []
        try:
            main = self._page.main_frame
            current = self._frame if self._frame is not None else main
            for frame in list(self._page.frames):
                try:
                    if frame.parent_frame == current:
                        frames.append(
                            CamoufoxScope(
                                self._session,
                                self._page,
                                frame=frame,
                                parent=self,
                            )
                        )
                except Exception:
                    continue
        except Exception:
            return frames
        return frames

    def shadow_roots(
        self, mode: str = "all", include_frames: bool = False
    ) -> list[Any]:
        return []

    def new_tab(self, url: str = "about:blank") -> "CamoufoxScope":
        return self._session.new_tab(url)

    def get(self, url: str) -> "CamoufoxScope":
        """ruyiPage-compatible navigation on the current tab."""
        target = str(url or "").strip() or "about:blank"
        sys.stderr.write(f"[camoufox-nav] get {target[:80]}\n")
        try:
            self._page.goto(target, wait_until="domcontentloaded", timeout=90_000)
        except Exception as exc:
            sys.stderr.write(f"[camoufox-nav] goto error: {exc}\n")
            if self._page.is_closed():
                raise
        try:
            self._page.wait_for_load_state("load", timeout=30_000)
        except Exception:
            pass
        try:
            self._page.wait_for_load_state("networkidle", timeout=10_000)
        except Exception:
            pass
        sys.stderr.write(f"[camoufox-nav] loaded url={self._page.url[:100]}\n")
        return self

    def get_tabs(
        self, url: str | None = None
    ) -> list["CamoufoxScope"]:
        return self._session.get_tabs(url=url)

    def screenshot(self, path: str, full_page: bool = True) -> None:
        from pathlib import Path as P

        P(path).parent.mkdir(parents=True, exist_ok=True)
        self._page.screenshot(path=path, full_page=full_page)

    def quit(self) -> None:
        self._session.close()

    def human_click_at(self, x: int, y: int) -> None:
        self._page.mouse.click(x, y)


_original_human_click = _ActionChain.human_click


def _human_click_with_coords(self: _ActionChain, target: Any) -> _ActionChain:
    if isinstance(target, dict) and "x" in target and "y" in target:
        x = int(target["x"])
        y = int(target["y"])

        def step() -> None:
            page = self._scope._keyboard_page()
            time.sleep(random.uniform(0.05, 0.18))
            page.mouse.click(x, y, delay=random.randint(20, 80))

        self._steps.append(step)
        return self
    return _original_human_click(self, target)


_ActionChain.human_click = _human_click_with_coords  # type: ignore[method-assign]


class CamoufoxSession:
    """Owns one Camoufox context (one fingerprint) and multiple tabs/pages."""

    def __init__(self) -> None:
        self._playwright = None
        self._camoufox_cm = None
        self._context = None
        self._tabs: list[CamoufoxScope] = []
        self.latest_tab: CamoufoxScope | None = None
        self.address = "camoufox:local"
        self._close_on_exit = True
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

        safe_kwargs = {k: v for k, v in kwargs.items() if k != "proxy"}
        proxy_server = (
            kwargs.get("proxy", {}).get("server", "none")
            if "proxy" in kwargs
            else "none"
        )
        sys.stderr.write(
            f"[camoufox-launch] fingerprint_preset={safe_kwargs.get('fingerprint_preset')} "
            f"os={safe_kwargs.get('os')} humanize={safe_kwargs.get('humanize')} "
            f"geoip={safe_kwargs.get('geoip', False)} proxy={proxy_server} "
            f"persistent_context={safe_kwargs.get('persistent_context')} "
            f"user_data_dir={safe_kwargs.get('user_data_dir', 'none')}\n"
        )

        try:
            self._camoufox_cm = Camoufox(**kwargs)
            self._context = self._camoufox_cm.__enter__()
        except Exception as exc:
            sys.stderr.write(
                f"[camoufox-launch] FAILED to start Camoufox: {exc}\n"
            )
            sys.stderr.write(tb.format_exc())
            raise

        context = self._context
        existing_pages: list[Any] = []
        try:
            existing_pages = (
                list(context.pages) if hasattr(context, "pages") else []
            )
        except Exception:
            existing_pages = []

        if existing_pages:
            page = existing_pages[0]
            sys.stderr.write(
                f"[camoufox-launch] reusing existing page from persistent context "
                f"(total pages={len(existing_pages)})\n"
            )
        elif hasattr(context, "new_page"):
            page = context.new_page()
        else:
            context = context.new_context()
            self._context = context
            page = context.new_page()

        scope = CamoufoxScope(self, page)
        self._tabs = [scope]
        self.latest_tab = scope
        try:
            page._camoufox_fingerprint_os = "macos"
            page._camoufox_fingerprint_token = self._fingerprint_token
        except Exception:
            pass
        sys.stderr.write(
            f"[camoufox-launch] session ready, page url={page.url}\n"
        )
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
            sys.stderr.write(
                f"[camoufox-tab] navigating new tab to {target[:80]}\n"
            )
            try:
                page.goto(
                    target, wait_until="domcontentloaded", timeout=90_000
                )
            except Exception as exc:
                sys.stderr.write(f"[camoufox-tab] goto failed: {exc}\n")
                if page.is_closed():
                    raise
            try:
                page.wait_for_load_state("load", timeout=30_000)
            except Exception:
                pass
            try:
                page.wait_for_load_state("networkidle", timeout=10_000)
            except Exception:
                pass
            sys.stderr.write(
                f"[camoufox-tab] loaded url={page.url[:100]}\n"
            )
        return scope

    def get_tabs(
        self, url: str | None = None
    ) -> list[CamoufoxScope]:
        alive: list[CamoufoxScope] = []
        for tab in list(self._tabs):
            try:
                if tab._page.is_closed():
                    tab.states.is_alive = False
                    continue
            except Exception:
                tab.states.is_alive = False
                continue
            if url:
                try:
                    href = str(tab._page.url or "")
                except Exception:
                    href = ""
                if url.lower() not in href.lower():
                    continue
            alive.append(tab)
        self._tabs = [
            t for t in self._tabs if not t._page.is_closed()
        ]
        if alive:
            self.latest_tab = alive[-1]
        return list(alive)

    def close(self) -> None:
        if not self._close_on_exit:
            sys.stderr.write(
                "[camoufox-close] preserve requested, skipping close\n"
            )
            return
        try:
            if self._camoufox_cm is not None:
                sys.stderr.write(
                    "[camoufox-close] closing Camoufox context manager\n"
                )
                self._camoufox_cm.__exit__(None, None, None)
        except Exception as exc:
            sys.stderr.write(
                f"[camoufox-close] error during close: {exc}\n"
            )
        self._camoufox_cm = None
        self._context = None
        self._tabs = []
        self.latest_tab = None


@dataclass
class FirefoxOptions:
    """Drop-in stand-in for ruyipage.FirefoxOptions."""

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

    def set_window_size(self, width: int, height: int) -> None:
        self.window_size = (int(width), int(height))

    def set_timeouts(
        self, implicit: int, page_load: int, script: int
    ) -> None:
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
    """Constructor-compatible wrapper: FirefoxPage(opts) -> CamoufoxScope."""

    def __new__(cls, opts: FirefoxOptions | None = None):  # type: ignore[misc]
        options = opts or FirefoxOptions()
        session = CamoufoxSession()
        return session.launch(options)


def import_camoufox_runtime() -> (
    tuple[type[FirefoxOptions], type[FirefoxPage], type[Keys]]
):
    try:
        import camoufox  # noqa: F401
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "camoufox is not installed. Run ./install.sh or install camoufox[geoip] "
            "in the project virtual environment"
        ) from exc
    return FirefoxOptions, FirefoxPage, Keys
