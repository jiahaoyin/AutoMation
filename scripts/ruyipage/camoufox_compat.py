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
    body = str(script or "").strip()
    if not body:
        return "() => undefined"
    if body.startswith("function") or body.startswith("(") or body.startswith("async"):
        return body
    if "return " in body or body.startswith("return"):
        return f"() => {{ {body if body.startswith('return') else body} }}"
    return f"() => {{ return ({body}); }}"


@dataclass
class _States:
    is_alive: bool = True
    is_displayed: bool = True
    is_enabled: bool = True


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
        timeout_ms = int((timeout or 30) * 1000) if timeout and timeout < 1000 else int(timeout or 30_000)
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
        self.states = _States(is_alive=True, is_displayed=True, is_enabled=True)
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
        body = str(script or "").strip()
        # Support ruyiPage element scripts that use `this`.
        if "this." in body or "this " in body or body.startswith("function"):
            fn = body
            if not fn.startswith("function") and not fn.startswith("("):
                fn = f"function() {{ {fn if 'return' in fn else 'return (' + fn + ')'} }}"
            return self._locator.evaluate(f"el => ({fn}).call(el)")
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
        self.states = _States(is_alive=True)
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
        return self._page_like().evaluate(wrap_return_script(script))

    def eles(self, selector: str, timeout: float | int | None = None) -> list[CamoufoxElement]:
        css = normalize_selector(selector)
        if not css:
            return []
        timeout_s = 0.0 if timeout is None else float(timeout)
        # ruyiPage timeout is seconds; 0 means non-blocking poll.
        wait_ms = max(0, int(timeout_s * 1000)) if timeout_s < 1000 else int(timeout_s)
        root = self._page_like()
        locator = root.locator(css)
        try:
            if wait_ms > 0:
                locator.first.wait_for(state="attached", timeout=wait_ms)
            count = locator.count()
        except Exception:
            return []
        elements: list[CamoufoxElement] = []
        for index in range(count):
            item = locator.nth(index)
            element = CamoufoxElement(self, item)
            if element.states.is_alive:
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
        target = str(url or "").strip() or "about:blank"
        self._page.goto(target, wait_until="domcontentloaded")
        try:
            self._page.wait_for_load_state("domcontentloaded", timeout=90_000)
        except Exception:
            pass
        return self

    def get_tabs(self, url: str | None = None) -> list["CamoufoxScope"]:
        return self._session.get_tabs(url=url)

    def screenshot(self, path: str, full_page: bool = True) -> None:
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

        self._camoufox_cm = Camoufox(**kwargs)
        self._context = self._camoufox_cm.__enter__()
        # persistent_context returns BrowserContext directly.
        context = self._context
        if hasattr(context, "new_page"):
            page = context.new_page()
        else:
            # Non-persistent Browser fallback.
            context = context.new_context()
            self._context = context
            page = context.new_page()

        scope = CamoufoxScope(self, page)
        self._tabs = [scope]
        self.latest_tab = scope
        # Emit once via page attribute so the flow can report fingerprint reuse.
        try:
            page._camoufox_fingerprint_os = "macos"
            page._camoufox_fingerprint_token = self._fingerprint_token
        except Exception:
            pass
        return scope

    def new_tab(self, url: str = "about:blank") -> CamoufoxScope:
        if self._context is None:
            raise RuntimeError("Camoufox session is not started")
        page = self._context.new_page()
        scope = CamoufoxScope(self, page)
        self._tabs.append(scope)
        self.latest_tab = scope
        target = str(url or "about:blank")
        if target and target != "about:blank":
            page.goto(target, wait_until="domcontentloaded")
        else:
            try:
                page.goto("about:blank", wait_until="domcontentloaded")
            except Exception:
                pass
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
            tab.states.is_alive = True
            if url:
                try:
                    href = str(tab._page.url or "")
                except Exception:
                    href = ""
                if url not in href:
                    continue
            alive.append(tab)
        self._tabs = alive
        if alive:
            self.latest_tab = alive[-1]
        return list(alive)

    def close(self) -> None:
        if not self._close_on_exit:
            return
        try:
            if self._camoufox_cm is not None:
                self._camoufox_cm.__exit__(None, None, None)
        except Exception:
            pass
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
