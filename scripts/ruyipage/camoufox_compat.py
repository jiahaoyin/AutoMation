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
import time
from dataclasses import dataclass
from typing import Any, Callable

from camoufox_session import build_camoufox_launch_kwargs


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
    """Convert ruyiPage-style JS snippets to Playwright evaluate expressions.

    ruyiPage's run_js accepts bare ``return ...`` statements as well as full
    function bodies and arrow expressions.  Playwright's evaluate expects either
    an expression or a ``() => { ... }`` wrapper.
    """
    body = str(script or "").strip()
    if not body:
        return "() => undefined"
    # Already a callable — pass through.
    if body.startswith("(") or body.startswith("async"):
        return body
    # Full function declaration — wrap in IIFE so evaluate() can call it.
    if body.startswith("function"):
        return f"({body})()"
    # Bare "return expr" — wrap in arrow.
    if body.startswith("return "):
        expr = body[len("return "):].rstrip(";").strip()
        return f"() => {{ return ({expr}); }}"
    if "return " in body:
        return f"() => {{ {body} }}"
    # Plain expression.
    return f"() => {{ return ({body}); }}"


class _States:
    """Observable state container.  For scope-level states, ``is_alive`` dynamically
    checks whether the underlying Playwright page is still open."""

    def __init__(
        self,
        is_alive: bool = True,
        is_displayed: bool = True,
        is_enabled: bool = True,
        _page: Any = None,
    ) -> None:
        self._is_alive = is_alive
        self.is_displayed = is_displayed
        self.is_enabled = is_enabled
        self._page = _page

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


class _ActionChain:
    def __init__(self, scope: "CamoufoxScope") -> None:
        self._scope = scope
        self._steps: list[Callable[[], None]] = []

    def human_click(self, target: Any) -> "_ActionChain":
        def step() -> None:
            locator = self._scope._resolve_locator(target)
            # Camoufox humanize applies to mouse moves; click through Playwright.
            locator.scroll_into_view_if_needed(timeout=5_000)
            time.sleep(random.uniform(0.05, 0.18))
            locator.click(timeout=15_000, delay=random.randint(20, 80))

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
            self._scope._page_like().wait_for_load_state("domcontentloaded", timeout=timeout_ms)
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
        self.states = _States(is_alive=True, is_displayed=True, is_enabled=True, _page=None)
        self._refresh_states()

    def _refresh_states(self) -> None:
        try:
            visible = bool(self._locator.is_visible(timeout=500))
            enabled = bool(self._locator.is_enabled(timeout=500))
            self.states.is_displayed = visible
            self.states.is_enabled = enabled
            self.states.is_alive = True
        except Exception:
            self.states.is_displayed = False
            self.states.is_enabled = False

    def attr(self, name: str) -> str | None:
        try:
            value = self._locator.get_attribute(name)
            return None if value is None else str(value)
        except Exception:
            return None

    def run_js(self, script: str) -> Any:
        """Run JS in the element context.  ruyiPage binds ``this`` to the element."""
        body = str(script or "").strip()
        if not body:
            return None
        # Playwright evaluate on a locator passes the element as the first arg.
        # We need to map ruyiPage's ``this`` → Playwright's ``el``.
        if body.startswith("function"):
            # function() { ... }  →  el => (function(){...}).call(el)
            return self._locator.evaluate(f"el => ({body}).call(el)")
        if "this." in body or "this " in body or "this," in body:
            # Bare statements using ``this`` — wrap in function and bind.
            if "return" not in body:
                inner = f"return ({body})"
            else:
                inner = body
            return self._locator.evaluate(
                f"el => (function(){{ {inner} }}).call(el)"
            )
        # No ``this`` reference — plain expression on the page.
        return self._locator.evaluate(wrap_return_script(body))

    def input(self, value: str, clear: bool = True) -> None:
        locator = self._locator
        locator.scroll_into_view_if_needed(timeout=5_000)
        locator.click(timeout=10_000)
        if clear:
            locator.fill("")
        # Prefer fill for reliability; humanize already covers mouse approach.
        locator.fill(str(value))

    def screenshot(self, path: str) -> None:
        from pathlib import Path as P

        P(path).parent.mkdir(parents=True, exist_ok=True)
        self._locator.screenshot(path=path)

    def scroll_into_view(self) -> None:
        try:
            self._locator.scroll_into_view_if_needed(timeout=5_000)
        except Exception:
            pass


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
        # Stable id for apple_account_flow scope_browsing_context_id / OTP frame checks.
        try:
            if frame is not None:
                frame_name = str(getattr(frame, "name", "") or "")
                frame_url = str(getattr(frame, "url", "") or "")
                self.tab_id = f"frame:{id(page)}:{id(frame)}:{frame_name}:{frame_url[:120]}"
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

    def _root_locator(self) -> Any:
        target = self._page_like()
        return target.locator(":root")

    def _resolve_locator(self, target: Any) -> Any:
        if isinstance(target, CamoufoxElement):
            return target._locator
        if isinstance(target, dict) and "x" in target and "y" in target:
            # Coordinate click fallback used by frame host targeting.
            x = int(target["x"])
            y = int(target["y"])
            return self._page.locator("html").first  # noqa: placeholder
            # Actual coordinate click is handled specially below via mouse.
        return target

    def run_js(self, script: str) -> Any:
        """Run JS on the page/frame scope.  Handles ruyiPage's ``return ...`` style."""
        body = str(script or "").strip()
        if not body:
            return None
        target = self._page_like()
        # Fast path: ``return location.href`` — the most called pattern.
        if body == "return location.href":
            try:
                return target.evaluate("() => location.href")
            except Exception:
                try:
                    return str(target.url or "")
                except Exception:
                    return ""
        return target.evaluate(wrap_return_script(body))

    def eles(self, selector: str, timeout: float | int | None = None) -> list[CamoufoxElement]:
        css = normalize_selector(selector)
        if not css:
            return []
        # ruyiPage timeout is in seconds; 0 / None means instant poll.
        timeout_s = float(timeout) if timeout is not None else 0.0
        wait_ms = max(0, int(timeout_s * 1000)) if 0 < timeout_s < 300 else (
            int(timeout_s) if timeout_s >= 300 else 0
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
            element = CamoufoxElement(self, item)
            elements.append(element)
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
                                self._session, self._page, frame=frame, parent=self
                            )
                        )
                except Exception:
                    continue
        except Exception:
            return frames
        return frames

    def shadow_roots(self, mode: str = "all", include_frames: bool = False) -> list[Any]:
        # Playwright CSS already pierces open shadow DOM; return empty extra roots.
        return []

    def new_tab(self, url: str = "about:blank") -> "CamoufoxScope":
        return self._session.new_tab(url)

    def get(self, url: str) -> "CamoufoxScope":
        """ruyiPage-compatible navigation on the current tab."""
        import sys

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
        sys.stderr.write(f"[camoufox-nav] loaded url={self._page.url[:100]}\n")
        return self

    def get_tabs(self, url: str | None = None) -> list["CamoufoxScope"]:
        return self._session.get_tabs(url=url)

    def screenshot(self, path: str, full_page: bool = True) -> None:
        from pathlib import Path as P

        P(path).parent.mkdir(parents=True, exist_ok=True)
        self._page.screenshot(path=path, full_page=full_page)

    def quit(self) -> None:
        self._session.close()

    def human_click_at(self, x: int, y: int) -> None:
        self._page.mouse.click(x, y)


# Patch ActionChain human_click for coordinate dicts used by prepare_frame_input_target.
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
        self._fingerprint_token = f"camoufox-{int(time.time())}-{random.randint(1000, 9999)}"

    @property
    def fingerprint_token(self) -> str:
        return self._fingerprint_token

    def launch(self, opts: "FirefoxOptions") -> CamoufoxScope:
        import sys
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
        proxy_server = kwargs.get("proxy", {}).get("server", "none") if "proxy" in kwargs else "none"
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
            sys.stderr.write(f"[camoufox-launch] FAILED to start Camoufox: {exc}\n")
            sys.stderr.write(tb.format_exc())
            raise

        context = self._context
        # persistent_context returns BrowserContext directly — it already has
        # one blank page open. Reuse it instead of opening yet another tab.
        existing_pages = []
        try:
            existing_pages = context.pages if hasattr(context, "pages") else []
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
        sys.stderr.write(f"[camoufox-launch] session ready, page url={page.url}\n")
        return scope

    def new_tab(self, url: str = "about:blank") -> CamoufoxScope:
        import sys

        if self._context is None:
            raise RuntimeError("Camoufox session is not started")
        page = self._context.new_page()
        scope = CamoufoxScope(self, page)
        self._tabs.append(scope)
        self.latest_tab = scope
        target = str(url or "about:blank").strip()
        if target and target != "about:blank":
            sys.stderr.write(f"[camoufox-tab] navigating new tab to {target[:80]}\n")
            try:
                page.goto(target, wait_until="domcontentloaded", timeout=90_000)
            except Exception as exc:
                sys.stderr.write(f"[camoufox-tab] goto failed: {exc}\n")
                if page.is_closed():
                    raise
            try:
                page.wait_for_load_state("load", timeout=30_000)
            except Exception:
                pass
            sys.stderr.write(f"[camoufox-tab] loaded url={page.url[:100]}\n")
        return scope

    def get_tabs(self, url: str | None = None) -> list[CamoufoxScope]:
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
        self._tabs = [t for t in self._tabs if not t._page.is_closed()]
        if alive:
            self.latest_tab = alive[-1]
        return list(alive)

    def close(self) -> None:
        import sys

        if not self._close_on_exit:
            sys.stderr.write("[camoufox-close] preserve requested, skipping close\n")
            return
        try:
            if self._camoufox_cm is not None:
                sys.stderr.write("[camoufox-close] closing Camoufox context manager\n")
                self._camoufox_cm.__exit__(None, None, None)
        except Exception as exc:
            sys.stderr.write(f"[camoufox-close] error during close: {exc}\n")
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
    """Constructor-compatible wrapper: FirefoxPage(opts) -> CamoufoxScope."""

    def __new__(cls, opts: FirefoxOptions | None = None):  # type: ignore[misc]
        options = opts or FirefoxOptions()
        session = CamoufoxSession()
        return session.launch(options)


def import_camoufox_runtime() -> tuple[type[FirefoxOptions], type[FirefoxPage], type[Keys]]:
    try:
        import camoufox  # noqa: F401
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "camoufox is not installed. Run ./install.sh or install camoufox[geoip] "
            "in the project virtual environment"
        ) from exc
    return FirefoxOptions, FirefoxPage, Keys
