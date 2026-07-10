#!/usr/bin/env python3
"""ruyiPage-only account.apple.com browser phase.

The script speaks JSONL on stdout/stdin so Node can keep ownership of macOS
2FA collection and top-level reporting. All browser lifecycle and page access
remain inside ruyiPage.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import signal
import sys
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit


ACCOUNT_INFORMATION_URL = "https://account.apple.com/account/manage/section/information"
EMAIL_SELECTORS = (
    "css:#account_name_text_field",
    "css:input[name='accountName']",
    "css:input[autocomplete='username']",
    "css:input[type='email']",
)
PASSWORD_SELECTORS = (
    "css:#password_text_field",
    "css:input[name='password']",
    "css:input[autocomplete='current-password']",
    "css:input[type='password']",
)
REMEMBER_SELECTORS = (
    ("css:#remember-me", "css:#remember-me:checked"),
    ("css:input[name='rememberMe']", "css:input[name='rememberMe']:checked"),
    ("css:input[name='remember-me']", "css:input[name='remember-me']:checked"),
)
CODE_FIELD_SELECTORS = (
    ("css:input[autocomplete='one-time-code']", True),
    ("css:.security-code-input input", True),
    ("css:input[inputmode='numeric'][maxlength='1']", False),
    ("css:input[maxlength='1']", False),
)
TRUST_BUTTON_RE = re.compile(r"^(trust(?: this browser)?|continue|信任(?:此浏览器)?|继续)$", re.IGNORECASE)
REJECT_TRUST_RE = re.compile(r"don't trust|do not trust|not now|cancel|不信任|取消|暂不", re.IGNORECASE)
TWO_FACTOR_SUBMIT_RE = re.compile(r"^(verify|continue|submit|next|验证|继续|提交|下一步)$", re.IGNORECASE)
APPLE_AUTH_HOSTS = frozenset(
    {
        "account.apple.com",
        "appleid.apple.com",
        "idmsa.apple.com",
    }
)


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def read_command() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("stdin closed before command")
    return json.loads(line)


def human_pause(min_ms: int = 250, max_ms: int = 900) -> None:
    time.sleep(random.uniform(min_ms / 1000, max_ms / 1000))


def safe_elements(page: Any, selector: str) -> list[Any]:
    try:
        return list(page.eles(selector) or [])
    except Exception:
        return []


def iter_page_scopes(page: Any):
    pending = [page]
    seen: set[int] = set()
    while pending:
        scope = pending.pop(0)
        identity = id(scope)
        if identity in seen:
            continue
        seen.add(identity)
        yield scope
        try:
            pending.extend(list(scope.get_frames() or []))
        except Exception:
            pass


def element_is_interactable(element: Any) -> bool:
    try:
        states = element.states
        return bool(states.is_displayed and states.is_enabled)
    except Exception:
        return True


def find_elements(page: Any, selector: str) -> list[Any]:
    return [element for _scope, element in find_scoped_elements(page, selector)]


def find_scoped_elements(page: Any, selector: str) -> list[tuple[Any, Any]]:
    for scope in iter_page_scopes(page):
        elements = [element for element in safe_elements(scope, selector) if element_is_interactable(element)]
        if elements:
            return [(scope, element) for element in elements]
    return []


def find_first_element(page: Any, selectors: tuple[str, ...]) -> Any | None:
    found = find_first_scoped_element(page, selectors)
    return found[1] if found else None


def find_first_scoped_element(
    page: Any,
    selectors: tuple[str, ...],
) -> tuple[Any, Any] | None:
    for selector in selectors:
        elements = find_scoped_elements(page, selector)
        if elements:
            return elements[0]
    return None


def wait_for_element(
    page: Any,
    selectors: tuple[str, ...],
    timeout_s: int,
) -> tuple[Any, Any]:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        found = find_first_scoped_element(page, selectors)
        if found is not None:
            return found
        human_pause(300, 650)
    raise RuntimeError(f"page element did not appear: {', '.join(selectors)}")


def human_click(
    scope: Any,
    element: Any,
    pause: Callable[[int, int], None] = human_pause,
) -> None:
    pause(80, 220)
    scope.actions.human_click(element).perform()


def input_and_verify(
    scope: Any,
    field: Any,
    value: str,
    label: str,
    keys: Any,
    pause: Callable[[int, int], None] = human_pause,
) -> None:
    validate_apple_scope(scope)
    human_click(scope, field, pause=pause)
    pause(180, 480)
    scope.actions.combo(keys.COMMAND, "a").press(keys.DELETE).perform()
    pause(120, 320)
    scope.actions.type(value, interval=random.randint(55, 145)).perform()
    pause(280, 680)
    try:
        actual = field.value
    except Exception:
        return
    if actual is not None and str(actual) != value:
        detail = f"length {len(str(actual))}" if label == "password" else repr(str(actual))
        raise RuntimeError(f"{label} input verification failed: {detail}")


def submit_with_enter(
    scope: Any,
    keys: Any,
    pause: Callable[[int, int], None] = human_pause,
    min_ms: int = 350,
    max_ms: int = 800,
) -> None:
    pause(min_ms, max_ms)
    scope.actions.press(keys.ENTER).perform()


def ensure_remember_checked(
    page: Any,
    pause: Callable[[int, int], None] = human_pause,
) -> bool:
    for selector, _checked_selector in REMEMBER_SELECTORS:
        found = find_scoped_elements(page, selector)
        fields = [element for _scope, element in found]
        if not fields:
            continue
        scope = found[0][0]
        validate_apple_scope(scope)
        try:
            if fields[0].states.is_checked:
                return True
        except Exception:
            pass
        human_click(scope, fields[0], pause=pause)
        pause(180, 420)
        try:
            checked = bool(fields[0].states.is_checked)
        except Exception:
            checked = False
        if not checked:
            raise RuntimeError("remember-account checkbox did not become checked")
        return True
    raise RuntimeError("remember-account checkbox not found")


def security_code_fields(page: Any) -> list[tuple[Any, Any]]:
    for selector, allow_single in CODE_FIELD_SELECTORS:
        for scope in iter_page_scopes(page):
            fields = [
                element
                for element in safe_elements(scope, selector)
                if element_is_interactable(element)
            ]
            if len(fields) >= 6:
                return [(scope, field) for field in fields[:6]]
            if allow_single and len(fields) == 1:
                return [(scope, fields[0])]
    return []


def fill_security_code(
    page: Any,
    code: str,
    keys: Any,
    pause: Callable[[int, int], None] = human_pause,
) -> None:
    digits = "".join(ch for ch in str(code) if ch.isdigit())
    if len(digits) != 6:
        raise RuntimeError("2FA code must contain exactly six digits")

    fields = security_code_fields(page)
    if not fields:
        raise RuntimeError("2FA code input was not detected; refusing unfocused typing")

    if len(fields) == 1:
        scope, field = fields[0]
        input_and_verify(scope, field, digits, "2FA code", keys, pause=pause)
        return

    for (scope, field), digit in zip(fields, digits):
        input_and_verify(scope, field, digit, "2FA digit", keys, pause=pause)
        pause(80, 220)


def click_trust_browser(
    page: Any,
    pause: Callable[[int, int], None] = human_pause,
) -> bool:
    for scope in iter_page_scopes(page):
        try:
            state = detect_scope_login_state(scope)
            if not state.get("trustPrompt"):
                continue
            validate_apple_url(str(state.get("href") or ""))
        except Exception:
            continue
        for button in safe_elements(scope, "css:button"):
            if not element_is_interactable(button):
                continue
            try:
                text = str(button.text or "").strip()
            except Exception:
                continue
            if REJECT_TRUST_RE.search(text) or not TRUST_BUTTON_RE.fullmatch(text):
                continue
            pause(320, 760)
            human_click(scope, button, pause=pause)
            return True
    return False


def click_two_factor_submit(
    page: Any,
    pause: Callable[[int, int], None] = human_pause,
) -> bool:
    for scope in iter_page_scopes(page):
        try:
            state = detect_scope_login_state(scope)
        except Exception:
            continue
        if not (state.get("twofa") or int(state.get("codeInputCount") or 0) > 0):
            continue
        try:
            validate_apple_url(str(state.get("href") or ""))
        except Exception:
            continue
        for button in safe_elements(scope, "css:button"):
            if not element_is_interactable(button):
                continue
            try:
                text = str(button.text or "").strip()
            except Exception:
                continue
            if REJECT_TRUST_RE.search(text) or not TWO_FACTOR_SUBMIT_RE.fullmatch(text):
                continue
            pause(280, 680)
            human_click(scope, button, pause=pause)
            return True
    return False


def detect_scope_login_state(scope: Any) -> dict[str, Any]:
    raw = scope.run_js(
        r"""
        return JSON.stringify((() => {
          const body = document.body?.innerText || '';
          const visible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
          };
          const inputs = [...document.querySelectorAll('input')].filter(visible);
          const codeInputs = inputs.filter((el) =>
            el.maxLength === 1 ||
            el.getAttribute('maxlength') === '1' ||
            /code|security|otp/i.test((el.name || '') + (el.id || '') + (el.className || '') + (el.autocomplete || '')) ||
            el.getAttribute('inputmode') === 'numeric'
          );
          const href = location.href;
          const password = inputs.some((el) => el.type === 'password');
          const email = inputs.some((el) => el.type === 'email' || /accountName|username/i.test(el.name || el.autocomplete || ''));
          const error = /incorrect|invalid|wrong password|try again|captcha|locked|无法登录|错误|不正确|无效|被锁定/i.test(body);
          const twofa = /two-factor|verification code|security code|双重认证|验证码/i.test(body) || codeInputs.length >= 1;
          const trustPrompt = /trust this browser|信任此浏览器/i.test(body);
          const accountMarker =
            /personal information|个人信息|sign out|退出|account security|账户安全/i.test(body);
          const trusted =
            /account\.apple\.com\/account\/manage/i.test(href) &&
            accountMarker &&
            !password &&
            !email &&
            !twofa;
          return {
            href,
            twofa,
            trustPrompt,
            error,
            trusted,
            accountMarker,
            password,
            email,
            codeInputCount: codeInputs.length,
            snippet: body.slice(0, 500)
          };
        })())
        """
    )
    return json.loads(raw) if isinstance(raw, str) else raw


def parse_valid_apple_url(url: str):
    parsed = urlsplit(str(url).strip())
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or host not in APPLE_AUTH_HOSTS
    ):
        return None
    return parsed


def is_apple_url(url: str) -> bool:
    return parse_valid_apple_url(url) is not None


def is_account_manage_url(url: str) -> bool:
    parsed = parse_valid_apple_url(url)
    if parsed is None:
        return False
    host = (parsed.hostname or "").lower()
    return host == "account.apple.com" and (
        parsed.path == "/account/manage" or parsed.path.startswith("/account/manage/")
    )


def detect_login_state(page: Any) -> dict[str, Any]:
    states: list[dict[str, Any]] = []
    for scope in iter_page_scopes(page):
        try:
            state = detect_scope_login_state(scope)
        except Exception:
            continue
        if isinstance(state, dict):
            states.append(state)

    if not states:
        raise RuntimeError("unable to inspect login page state through ruyiPage")

    root_state = states[0]
    root_href = str(root_state.get("href") or "")
    root_is_account_manage = is_account_manage_url(root_href)
    has_apple_account_marker = any(
        is_apple_url(str(state.get("href") or ""))
        and bool(state.get("trusted") or state.get("accountMarker"))
        for state in states
    )
    snippets = [
        str(state.get("snippet", "")).strip()
        for state in states
        if str(state.get("snippet", "")).strip()
    ]
    has_auth_ui = any(
        bool(state.get(key))
        for state in states
        for key in ("email", "password", "twofa", "trustPrompt")
    )
    return {
        "href": root_href or next(
            (state.get("href") for state in states if state.get("href")),
            "",
        ),
        "twofa": any(bool(state.get("twofa")) for state in states),
        "trustPrompt": any(bool(state.get("trustPrompt")) for state in states),
        "error": any(bool(state.get("error")) for state in states),
        "trusted": (
            not has_auth_ui
            and root_is_account_manage
            and has_apple_account_marker
        ),
        "password": any(bool(state.get("password")) for state in states),
        "email": any(bool(state.get("email")) for state in states),
        "codeInputCount": max(
            (int(state.get("codeInputCount") or 0) for state in states),
            default=0,
        ),
        "snippet": " | ".join(snippets)[:500],
    }


def wait_for_2fa_or_session(page: Any, timeout_s: int = 75) -> dict[str, Any]:
    deadline = time.time() + timeout_s
    last_state: dict[str, Any] = {}
    while time.time() < deadline:
        last_state = detect_login_state(page)
        if last_state.get("error"):
            raise RuntimeError(f"login stopped before 2FA: {last_state.get('snippet', '')[:180]}")
        if last_state.get("trusted"):
            return last_state
        fields = security_code_fields(page)
        if fields:
            last_state["codeInputCount"] = len(fields)
            return last_state
        human_pause(500, 1000)
    raise RuntimeError(f"2FA code page did not appear: {last_state.get('snippet', '')[:180]}")


def wait_for_signed_in(
    page: Any,
    timeout_s: int = 90,
    submitted: bool = False,
) -> dict[str, Any]:
    deadline = time.time() + timeout_s
    last_state: dict[str, Any] = {}
    while time.time() < deadline:
        last_state = detect_login_state(page)
        if last_state.get("error"):
            raise RuntimeError(f"2FA/login failed: {last_state.get('snippet', '')[:180]}")
        if last_state.get("trusted"):
            return last_state
        if last_state.get("trustPrompt"):
            if not click_trust_browser(page):
                raise RuntimeError("trust-browser prompt detected but no matching button was found")
            human_pause(700, 1400)
            continue
        if last_state.get("twofa") and not submitted:
            submitted = click_two_factor_submit(page)
        human_pause(600, 1100)
    raise RuntimeError(f"account session was not confirmed after 2FA: {last_state.get('snippet', '')[:180]}")


def collect_scope_personal_info(scope: Any) -> dict[str, Any]:
    raw = scope.run_js(
        r"""
        return JSON.stringify((() => {
          const lines = (document.body?.innerText || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
          const pick = (labels) => {
            for (let i = 0; i < lines.length; i++) {
              if (labels.some(l => lines[i] === l || lines[i].startsWith(l + ' '))) return lines[i + 1] || null;
            }
            return null;
          };
          return {
            fullName: pick(['Name', '姓名', 'Full Name', '全名']),
            birthday: pick(['Birthday', '生日', 'Date of Birth', '出生日期']),
            href: location.href,
            title: document.title
          };
        })())
        """
    )
    return json.loads(raw) if isinstance(raw, str) else raw


def collect_personal_info(page: Any) -> dict[str, Any]:
    collected: list[dict[str, Any]] = []
    for scope in iter_page_scopes(page):
        try:
            info = collect_scope_personal_info(scope)
        except Exception:
            continue
        if isinstance(info, dict):
            if not is_apple_url(str(info.get("href") or "")):
                continue
            collected.append(info)

    if not collected:
        raise RuntimeError("unable to inspect personal information through ruyiPage")

    root_info = collected[0]
    return {
        "fullName": next(
            (info.get("fullName") for info in collected if info.get("fullName")),
            None,
        ),
        "birthday": next(
            (info.get("birthday") for info in collected if info.get("birthday")),
            None,
        ),
        "href": root_info.get("href"),
        "title": root_info.get("title"),
    }


def validate_personal_info_result(
    login_state: dict[str, Any],
    personal_info: dict[str, Any],
) -> None:
    if not login_state.get("trusted"):
        raise RuntimeError("personal information page did not confirm an authenticated Apple session")
    if not (personal_info.get("fullName") or personal_info.get("birthday")):
        raise RuntimeError("personal information page loaded but name and birthday were not parsed")


def take_screenshot(page: Any, path: Path) -> str | None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(str(path), full_page=True)
        return str(path)
    except Exception as exc:
        emit({"event": "warning", "message": f"screenshot failed: {exc}"})
        return None


def protocol_self_test() -> int:
    emit({"event": "ready", "mode": "protocol-self-test"})
    emit({"event": "result", "success": True, "personalInfo": {}, "screenshots": {}})
    return 0


def node_self_test() -> int:
    emit({"event": "ready", "mode": "node-self-test"})
    emit({"event": "need_2fa"})
    command = read_command()
    code = "".join(ch for ch in str(command.get("code", "")) if ch.isdigit())[:6]
    argv_text = "\0".join(sys.argv[1:])
    sensitive_values = (os.environ.get("APPLE_ID", ""), os.environ.get("APPLE_PASSWORD", ""))
    credentials_in_argv = "--apple-id" in sys.argv or any(
        value and value in argv_text for value in sensitive_values
    )
    emit(
        {
            "event": "result",
            "success": len(code) == 6,
            "twoFaCodeLength": len(code),
            "credentialsInArgv": credentials_in_argv,
            "personalInfo": {"fullName": None, "birthday": None, "selfTest": True},
            "screenshots": {},
        }
    )
    return 0 if len(code) == 6 else 2


def hang_self_test() -> int:
    emit({"event": "ready", "mode": "hang-self-test"})
    while True:
        time.sleep(1)


def ignore_signals_self_test() -> int:
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(signum, signal.SIG_IGN)
        except (AttributeError, OSError, ValueError):
            pass
    emit({"event": "ready", "mode": "ignore-signals-self-test"})
    while True:
        time.sleep(1)


def import_ruyipage() -> tuple[Any, Any, Any]:
    try:
        from ruyipage import FirefoxOptions, FirefoxPage, Keys  # type: ignore

        return FirefoxOptions, FirefoxPage, Keys
    except Exception as exc:  # pragma: no cover - exercised on macOS install machine
        raise RuntimeError(
            "ruyipage is not installed. Run ./install.sh or install ruyiPage==1.2.45 in the selected Python environment"
        ) from exc


def validate_apple_url(url: str) -> str:
    parsed = parse_valid_apple_url(url)
    if parsed is None:
        raise RuntimeError("browser sign-in URL must be an Apple HTTPS URL")
    return parsed.geturl()


def validate_apple_scope(scope: Any) -> str:
    try:
        href = scope.run_js("return location.href")
    except Exception as exc:
        raise RuntimeError("unable to verify the ruyiPage scope URL before input") from exc
    return validate_apple_url(str(href or ""))


def pop_browser_credentials() -> tuple[str, str]:
    apple_id = os.environ.pop("APPLE_ID", "")
    password = os.environ.pop("APPLE_PASSWORD", "")
    if not apple_id or not password:
        raise RuntimeError("missing Apple ID or password")
    return apple_id, password


def browser_flow(args: argparse.Namespace) -> int:
    apple_id, password = pop_browser_credentials()
    sign_in_url = validate_apple_url(args.sign_in_url)

    FirefoxOptions, FirefoxPage, Keys = import_ruyipage()
    opts = FirefoxOptions()
    if args.firefox:
        opts.set_browser_path(args.firefox)
    if args.profile_dir:
        opts.set_user_dir(args.profile_dir)
    opts.set_window_size(1280, 960)
    opts.set_timeouts(2, 90, 30)
    opts.headless(False)
    opts.close_on_exit(True)
    if hasattr(opts, "set_human_algorithm"):
        opts.set_human_algorithm("windmouse")

    report_dir = Path(args.report_dir)
    screenshots_dir = report_dir / "screenshots"
    screenshots: dict[str, str | None] = {}
    page = FirefoxPage(opts)
    try:
        emit({"event": "ready", "mode": "ruyipage-only"})
        page.get(sign_in_url)
        page.wait.doc_loaded(timeout=20)
        human_pause(900, 1800)

        initial_state = detect_login_state(page)
        skipped_login = bool(initial_state.get("trusted"))
        skipped_2fa = skipped_login
        remember_checked: bool | None = None

        if not skipped_login:
            email_scope, email = wait_for_element(page, EMAIL_SELECTORS, timeout_s=45)
            input_and_verify(email_scope, email, apple_id, "email", Keys)
            submit_with_enter(email_scope, Keys)

            password_scope, password_field = wait_for_element(
                page,
                PASSWORD_SELECTORS,
                timeout_s=45,
            )
            input_and_verify(password_scope, password_field, password, "password", Keys)
            remember_checked = ensure_remember_checked(page)
            submit_with_enter(password_scope, Keys, min_ms=420, max_ms=900)

            login_state = wait_for_2fa_or_session(page)
            if login_state.get("trusted"):
                skipped_2fa = True
            else:
                emit(
                    {
                        "event": "need_2fa",
                        "state": {
                            "href": login_state.get("href"),
                            "codeInputCount": login_state.get("codeInputCount"),
                        },
                    }
                )
                command = read_command()
                code = "".join(ch for ch in str(command.get("code", "")) if ch.isdigit())
                fill_security_code(page, code, Keys)
                submitted = click_two_factor_submit(page)
                human_pause(900, 1600)
                wait_for_signed_in(page, submitted=submitted)

        screenshots["afterLogin"] = take_screenshot(
            page, screenshots_dir / "02-ruyipage-after-login.png"
        )

        page.get(ACCOUNT_INFORMATION_URL)
        page.wait.doc_loaded(timeout=20)
        human_pause(1200, 2400)
        final_state = detect_login_state(page)
        if not final_state.get("trusted"):
            raise RuntimeError("personal information page did not confirm an authenticated Apple session")
        personal_info = collect_personal_info(page)
        validate_personal_info_result(final_state, personal_info)
        screenshots["manage"] = take_screenshot(
            page, screenshots_dir / "03-account-manage.png"
        )

        emit(
            {
                "event": "result",
                "success": True,
                "browserLogin": {
                    "success": True,
                    "backend": "ruyipage",
                    "skippedLogin": skipped_login,
                    "skipped2FA": skipped_2fa,
                    "rememberAccount": remember_checked,
                },
                "personalInfo": personal_info,
                "screenshots": screenshots,
            }
        )
        return 0
    except Exception:
        screenshots["failure"] = take_screenshot(
            page, screenshots_dir / "99-ruyipage-failure.png"
        )
        raise
    finally:
        had_error = sys.exc_info()[0] is not None
        try:
            page.quit()
        except Exception as exc:
            if not had_error:
                raise
            emit({"event": "warning", "message": f"ruyiPage quit failed after flow error: {exc}"})


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--protocol-self-test", action="store_true")
    parser.add_argument("--node-self-test", action="store_true")
    parser.add_argument("--hang-self-test", action="store_true")
    parser.add_argument("--ignore-signals-self-test", action="store_true")
    parser.add_argument("--report-dir", default="data/reports/ruyipage")
    parser.add_argument("--profile-dir", default=os.environ.get("FIREFOX_PROFILE_DIR", ""))
    parser.add_argument("--firefox", default=os.environ.get("FIREFOX_EXECUTABLE", ""))
    parser.add_argument(
        "--sign-in-url",
        default=os.environ.get("BROWSER_SIGN_IN_URL", "https://appleid.apple.com/sign-in"),
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.protocol_self_test:
        return protocol_self_test()
    if args.node_self_test:
        return node_self_test()
    if args.hang_self_test:
        return hang_self_test()
    if args.ignore_signals_self_test:
        return ignore_signals_self_test()
    return browser_flow(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as exc:
        emit({"event": "result", "success": False, "error": str(exc)})
        print(str(exc), file=sys.stderr, flush=True)
        raise SystemExit(1)
