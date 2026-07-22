#!/usr/bin/env python3
"""ruyiPage-only account.apple.com browser phase.

The script speaks JSONL on stdout/stdin so Node can keep ownership of macOS
2FA collection and top-level reporting. All browser lifecycle and page access
remain inside ruyiPage.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import random
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, TextIO
from urllib.parse import urljoin, urlsplit


ACCOUNT_INFORMATION_URL = "https://account.apple.com/account/manage/section/information"
PERSONAL_INFORMATION_PATH = "/account/manage/section/information"
PROFILE_CARD_SELECTORS = (
    "css:button.button.button-bare",
    "css:button[class*='button-bare']",
    "css:.card",
)
PROFILE_NAME_CARD_SELECTORS = PROFILE_CARD_SELECTORS[:2]
PROFILE_NAME_MODAL_SELECTORS = (
    "css:[id^='modal-content-']",
    "css:[role='dialog']",
    "css:aside",
)
PROFILE_CARD_WAIT_TIMEOUT_S = 35.0
PROFILE_MODAL_WAIT_TIMEOUT_S = 20.0
PROFILE_VALUE_STABLE_OBSERVATIONS = 2
PROFILE_VALUE_MAX_LENGTHS = {"name": 256, "birthday": 128}
EMAIL_SELECTORS = (
    "css:#account_name_text_field",
    "css:input[name='accountName']",
    "css:input[autocomplete='username']",
    "css:input[type='email']",
)
PASSWORD_SELECTORS = (
    "css:input#password_text_field",
    "css:input[name='password']",
    "css:input[autocomplete='current-password']",
    "css:input[type='password']",
)
REMEMBER_SELECTORS = (
    (
        "css:#remember-me",
        (
            "css:#remember-me-label",
            "css:label[for='remember-me']",
            "css:.si-remember-password label",
        ),
    ),
    (
        "css:input[name='rememberMe']",
        ("css:label[for='rememberMe']", "css:.si-remember-password label"),
    ),
    (
        "css:input[name='remember-me']",
        ("css:label[for='remember-me']", "css:.si-remember-password label"),
    ),
)
CODE_FIELD_SELECTORS = (
    ("css:.form-security-code-inputs input", True),
    ("css:input[autocomplete='one-time-code']", True),
    ("css:.security-code-input input", True),
    ("css:input[inputmode='numeric'][maxlength='1']", False),
    ("css:input[maxlength='1']", False),
)
FORM_SECURITY_CODE_INPUT_SELECTOR = "css:.form-security-code-inputs input"
APPLE_SIX_CELL_WIDGET_IFRAME_ID = "aid-auth-widget-iFrame"
APPLE_SIX_CELL_WIDGET_IFRAME_SELECTOR = (
    f"css:iframe#{APPLE_SIX_CELL_WIDGET_IFRAME_ID}"
)
OTP_SEMANTIC_RE = re.compile(
    r"one[\s_-]?time|verification|security[\s_-]*code|\botp\b|passcode|\bcode\b|验证码|驗證碼|双重认证|雙重認證",
    re.IGNORECASE,
)
OTP_REJECTION_JS_PATTERN = (
    r"(?:(?:(?:this|the|your)\s+)?"
    r"(?:verification code|security code|one-time code)"
    r"(?:\s+(?:you\s+)?entered)?\s+"
    r"(?:(?:is|was|has)\s+)?(?:incorrect|invalid|expired)"
    r"|(?:incorrect|invalid|expired)\s+"
    r"(?:verification code|security code|one-time code)"
    r"|(?:您(?:输入|輸入)的)?(?:验证码|驗證碼)\s*"
    r"(?:不正确|不正確|无效|無效|(?:已)?过期|(?:已)?過期)"
    r"|(?:不正确|不正確|无效|無效|(?:已)?过期|(?:已)?過期)"
    r"\s*(?:的)?\s*(?:验证码|驗證碼))"
)
TRUST_BUTTON_RE = re.compile(r"^(trust(?: this browser)?|continue|信任(?:此浏览器)?|继续)$", re.IGNORECASE)
REJECT_TRUST_RE = re.compile(r"don't trust|do not trust|not now|cancel|不信任|取消|暂不", re.IGNORECASE)
TWO_FACTOR_SUBMIT_RE = re.compile(r"^(verify|continue|submit|next|验证|继续|提交|下一步)$", re.IGNORECASE)
TWO_FACTOR_SUBMIT_SELECTORS = (
    "css:button",
    "css:input[type='submit']",
    "css:[role='button']",
)
EDITABLE_TEXT_INPUT_TYPES = frozenset(
    {"text", "search", "tel", "url", "email", "password", "number"}
)
APPLE_AUTH_HOSTS = frozenset(
    {
        "account.apple.com",
        "appleid.apple.com",
        "idmsa.apple.com",
    }
)
OPAQUE_TWO_FACTOR_FRAME_URLS = frozenset({"about:blank", "about:srcdoc"})
SCREENSHOT_FAILURE_REASON = "ruyipage_screenshot_failed"
QUIT_FAILURE_REASON = "ruyipage_quit_failed"
TOP_LEVEL_FAILURE_REASON = "ruyipage_browser_flow_failed"
FOCUS_NOT_CONFIRMED_REASON = "ruyiPage input target focus was not confirmed"
# Apple can replace the authentication iframe before its account shell and
# profile data finish hydrating. Keep the submit transition bounded, but do
# not turn an ordinary slow account-page handoff into a false OTP failure.
TWO_FACTOR_SUBMIT_TRANSITION_TIMEOUT_S = 60.0
TWO_FACTOR_TARGET_REFRESH_TIMEOUT_S = 5.0
TWO_FACTOR_EMPTY_CELL_FALLBACK_PROBE_TIMEOUT_S = 1.5
TWO_FACTOR_INPUT_UNCONFIRMED_REASON = "2FA code input was not confirmed"
BROWSER_ATTACH_STATE_FILE_SUFFIX = ".ruyipage-attach.json"
BROWSER_ATTACH_STATE_MAX_BYTES = 1024
BROWSER_STARTUP_STAGES = {
    "not_started",
    "credentials_received",
    "url_validated",
    "runtime_importing",
    "runtime_imported",
    "browser_constructing",
    "browser_ready",
    "login_navigation",
    "login_page_loaded",
    "login_state_detected",
    "email_wait",
    "email_input",
    "email_submit",
    "password_wait",
    "password_input",
    "remember_account",
    "twofa_prepare",
    "password_submit",
    "twofa_page_wait",
    "twofa_code_wait",
    "twofa_input",
    "signed_in",
    "account_information",
    "profile_capture",
    "profile_birthday",
    "profile_name",
}
browser_startup_stage = "not_started"
browser_stage_file: Path | None = None
diagnostic_secrets: list[str] = []
BROWSER_BROKER_MODE_ENV = "APPLE_AUTOMATION_BROWSER_BROKER_MODE"
BROWSER_BROKER_CREDENTIALS_ERROR = "invalid browser broker credentials"
BROWSER_STAGE_FILE_ENV = "APPLE_AUTOMATION_BROWSER_STAGE_FILE"
BROWSER_PRESERVE_ON_FAILURE_ENV = "BROWSER_PRESERVE_ON_FAILURE"
BROWSER_PRESERVE_ON_SUCCESS_ENV = "BROWSER_PRESERVE_ON_SUCCESS"
BROWSER_ATTACH_EXISTING_ENV = "BROWSER_ATTACH_EXISTING"
BROWSER_ATTACH_ADDRESS_ENV = "BROWSER_ATTACH_ADDRESS"
BROKER_APPLE_ID_MAX_LENGTH = 320
BROKER_PASSWORD_MAX_LENGTH = 1024
BROKER_CREDENTIAL_FRAME_MAX_CHARS = 16384
TWO_FACTOR_PROGRESS_PHASES = frozenset(
    {
        "code_received",
        "target_waiting",
        "target_resolved",
        "input_started",
        "input_completed",
        "submit_started",
        "submit_sent",
        "transition_waiting",
        "transition_retry_requested",
        "transition_confirmed",
        "handoff_failed",
    }
)


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def configure_diagnostic_secrets(*values: str) -> None:
    diagnostic_secrets.clear()
    diagnostic_secrets.extend(
        sorted({str(value) for value in values if str(value)}, key=len, reverse=True)
    )


def add_diagnostic_secret(value: str) -> None:
    normalized = str(value)
    if not normalized or normalized in diagnostic_secrets:
        return
    diagnostic_secrets.append(normalized)
    diagnostic_secrets.sort(key=len, reverse=True)


def sanitize_diagnostic_text(value: Any) -> str:
    text = str(value)
    for secret in diagnostic_secrets:
        text = text.replace(secret, "[REDACTED_SECRET]")

    def redact_url(match: re.Match[str]) -> str:
        candidate = match.group(0)
        try:
            parsed = urlsplit(candidate)
            host = parsed.hostname or ""
            if parsed.port is not None:
                host = f"{host}:{parsed.port}"
            sanitized = f"{parsed.scheme}://{host}{parsed.path}"
            if parsed.query or parsed.fragment:
                sanitized += "?[REDACTED_QUERY]"
            return sanitized
        except (TypeError, ValueError):
            base = re.split(r"[?#]", candidate, maxsplit=1)[0]
            base = re.sub(r"^(https?://)[^/@\s]+@", r"\1", base, flags=re.IGNORECASE)
            return base + ("?[REDACTED_QUERY]" if re.search(r"[?#]", candidate) else "")

    text = re.sub(
        r"\bhttps?://[^\s\"'<>?#]+(?:\?[^\s\"'<>#]*)?(?:#[^\s\"'<>]*)?",
        redact_url,
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
        "[REDACTED_EMAIL]",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"\b[0-9]{3}[\s-]+[0-9]{3}\b", "[REDACTED_OTP]", text)
    text = re.sub(r"\b[0-9]{6}\b", "[REDACTED_OTP]", text)
    return text[: 64 * 1024] + ("\n[TRUNCATED]" if len(text) > 64 * 1024 else "")


def classify_browser_exception(error: Exception) -> str:
    """Convert backend exceptions to fixed diagnostics without forwarding page text."""
    message = str(error).lower()
    if "2fa digit input verification failed" in message:
        return "twofa_digit_input_verification_failed"
    if "2fa code sequence verification failed" in message:
        return "twofa_sequence_failed"
    if "2fa code input was not confirmed" in message:
        return "twofa_input_unconfirmed"
    if "2fa code input was not detected" in message:
        return "twofa_input_missing"
    if "2fa code input must resolve" in message:
        return "twofa_input_target_count"
    if "interactable otp target did not appear" in message:
        return "twofa_target_missing"
    if "input target focus was not confirmed" in message:
        return "twofa_focus_unconfirmed"
    if "2fa submit" in message:
        return "twofa_submit_not_confirmed"
    if "2fa code page did not appear" in message:
        return "twofa_page_missing"
    if "login stopped before 2fa" in message:
        return "login_stopped_before_2fa"
    if "account session was not confirmed after 2fa" in message:
        return "account_session_unconfirmed_after_2fa"
    if "2fa/login failed" in message:
        return "twofa_login_failed"
    if "password input verification failed" in message:
        return "password_input_verification_failed"
    if "personal information page did not confirm" in message:
        return "account_home_unconfirmed"
    if "personal information" in message or "profile" in message:
        return "profile_capture_failed"
    return "browser_exception"


def emit_input_progress(label: str, step: str, route: str | None = None) -> None:
    normalized_label = label.strip().lower()
    field = {
        "email": "email",
        "password": "password",
        "2fa code": "twofa_code",
        "2fa digit": "twofa_digit",
    }.get(normalized_label, "unknown")
    event = {
        "event": "status",
        "status": "input_progress",
        "field": field,
        "step": step,
    }
    if route in ("root", "owner"):
        event["route"] = route
    emit(event)


def emit_remember_progress(step: str, route: str | None = None) -> None:
    event = {
        "event": "status",
        "status": "remember_progress",
        "step": step,
    }
    if route in ("root", "owner"):
        event["route"] = route
    emit(event)


def emit_two_factor_progress(
    phase: str,
    *,
    generation: int,
    target_count: int | None = None,
    submitted: bool | None = None,
) -> None:
    """Emit only fixed, non-secret 2FA handoff checkpoints to the runner."""
    if phase not in TWO_FACTOR_PROGRESS_PHASES:
        raise RuntimeError("2FA progress phase is invalid")
    generation = validate_otp_generation(generation)
    event: dict[str, Any] = {
        "event": "status",
        "status": "twofa_progress",
        "phase": phase,
        "generation": generation,
    }
    if target_count in (1, 6):
        event["targetCount"] = target_count
    if submitted is not None:
        event["submitted"] = submitted is True
    emit(event)


def preserve_browser_on_failure() -> bool:
    """Keep direct-run Firefox open for a human to inspect a failed handoff.

    Supervised broker sessions retain their strict process cleanup contract. The
    direct `run.sh` path is intentionally inspectable unless explicitly disabled.
    """
    configured = os.environ.get(BROWSER_PRESERVE_ON_FAILURE_ENV, "1").strip().lower()
    enabled = configured not in {"0", "false", "no", "off"}
    return enabled and not browser_broker_mode_enabled()


def preserve_browser_on_success() -> bool:
    """Keep a direct-run authenticated session available for the next run."""
    configured = os.environ.get(BROWSER_PRESERVE_ON_SUCCESS_ENV, "1").strip().lower()
    enabled = configured not in {"0", "false", "no", "off"}
    return enabled and not browser_broker_mode_enabled()


def browser_connection_is_alive(page: Any) -> bool:
    """Confirm that ruyiPage can still reach the Firefox browsing context."""
    try:
        return bool(page.states.is_alive)
    except Exception:
        return False


def classify_input_read(readable: bool, actual: Any, expected: str) -> str:
    if not readable:
        return "unreadable"
    if str(actual) == expected:
        return "matched"
    if str(actual) == "":
        return "empty"
    return "mismatch"


def otp_input_readback_is_limited(readable: bool, actual: Any) -> bool:
    """Apple can accept a trusted OTP input while withholding its rendered value."""
    return not readable or str(actual) == ""


def configure_browser_stage_file(report_dir: Path) -> None:
    global browser_stage_file
    configured = os.environ.get(BROWSER_STAGE_FILE_ENV, "").strip()
    if not configured:
        browser_stage_file = None
        return
    candidate = Path(configured).expanduser().resolve()
    expected_parent = report_dir.expanduser().resolve()
    if candidate.parent != expected_parent or candidate.name != ".browser-stage.json":
        raise RuntimeError("browser stage file path is invalid")
    browser_stage_file = candidate


def set_browser_startup_stage(stage: str) -> None:
    global browser_startup_stage
    if stage not in BROWSER_STARTUP_STAGES:
        raise RuntimeError("browser startup stage is invalid")
    browser_startup_stage = stage
    emit({"event": "status", "status": "browser_stage", "stage": stage})
    if browser_stage_file is None:
        return
    temporary = browser_stage_file.with_name(
        f"{browser_stage_file.name}.tmp-{os.getpid()}"
    )
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(
                json.dumps(
                    {"version": 1, "stage": stage},
                    ensure_ascii=True,
                    separators=(",", ":"),
                )
                + "\n"
            )
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, browser_stage_file)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def read_command(input_stream: TextIO | None = None) -> dict[str, Any]:
    stream = input_stream if input_stream is not None else sys.stdin
    line = stream.readline()
    if not line:
        raise RuntimeError("stdin closed before command")
    return json.loads(line)


def emit_two_factor_command_ack(
    command: str,
    generation: int | None = None,
) -> None:
    if not browser_broker_mode_enabled():
        return
    event: dict[str, Any] = {"event": "2fa_command_ack", "command": command}
    if generation is not None:
        event["generation"] = generation
    emit(event)


def request_two_factor_preparation() -> None:
    emit({"event": "prepare_2fa"})
    command = read_command()
    if not isinstance(command, dict) or command.get("type") != "2fa_prepared":
        raise RuntimeError("2FA preparation acknowledgement was not received")
    emit_two_factor_command_ack("2fa_prepared")


def validate_otp_generation(generation: Any) -> int:
    if isinstance(generation, bool) or not isinstance(generation, int):
        raise RuntimeError("2FA generation must be 1 or 2")
    if generation not in (1, 2):
        raise RuntimeError("2FA generation must be 1 or 2")
    return generation


def validate_two_factor_code_command(command: Any, expected_generation: int) -> str:
    expected_generation = validate_otp_generation(expected_generation)
    if not isinstance(command, dict) or command.get("type") != "2fa_code":
        raise RuntimeError("2FA code command was not received")
    generation = validate_otp_generation(command.get("generation"))
    if generation != expected_generation:
        raise RuntimeError("2FA code generation did not match the request")
    code = command.get("code")
    if not isinstance(code, str) or re.fullmatch(r"[0-9]{6}", code) is None:
        raise RuntimeError("2FA code must contain exactly six digits")
    emit_two_factor_command_ack("2fa_code", generation)
    return code


def human_pause(min_ms: int = 250, max_ms: int = 900) -> None:
    time.sleep(random.uniform(min_ms / 1000, max_ms / 1000))


def classify_strong_two_factor(
    *,
    has_strong_text: bool,
    semantic_target_count: int,
    digit_cell_count: int,
) -> bool:
    return bool(
        has_strong_text
        or semantic_target_count > 0
        or digit_cell_count == 6
    )


def should_resume_at_password(state: dict[str, Any]) -> bool:
    return state.get("password") is True and state.get("email") is False


def safe_elements(
    page: Any,
    selector: str,
    timeout_s: float | None = None,
) -> list[Any]:
    try:
        if timeout_s is None:
            return list(page.eles(selector) or [])
        return list(page.eles(selector, timeout=timeout_s) or [])
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


def current_element_search_roots(page: Any) -> list[tuple[Any, Any]]:
    scopes = list(iter_page_scopes(page))
    roots = [(scope, scope) for scope in scopes]
    seen_roots = {id(scope) for scope in scopes}
    for scope in scopes:
        try:
            shadow_roots = scope.shadow_roots(mode="all", include_frames=False)
        except Exception:
            continue
        for root in list(shadow_roots or []):
            identity = id(root)
            if identity in seen_roots:
                continue
            seen_roots.add(identity)
            roots.append((scope, root))
    return roots


def element_is_interactable(element: Any) -> bool:
    try:
        if str(element.attr("aria-disabled") or "").strip().lower() == "true":
            return False
        states = element.states
        return bool(states.is_displayed and states.is_enabled)
    except Exception:
        return False


def element_is_editable_text_control(element: Any) -> bool:
    try:
        input_type = str(element.attr("type") or "text").strip().lower()
    except Exception:
        return False
    return input_type in EDITABLE_TEXT_INPUT_TYPES


def find_elements(page: Any, selector: str) -> list[Any]:
    return [element for _scope, element in find_scoped_elements(page, selector)]


def find_scoped_elements(page: Any, selector: str) -> list[tuple[Any, Any]]:
    for scope, root in current_element_search_roots(page):
        elements = [
            element
            for element in safe_elements(root, selector, timeout_s=0)
            if element_is_interactable(element)
        ]
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
    search_roots = current_element_search_roots(page)
    for selector in selectors:
        for scope, root in search_roots:
            elements = [
                element
                for element in safe_elements(root, selector, timeout_s=0)
                if element_is_interactable(element)
            ]
            if elements:
                return scope, elements[0]
    return None


def wait_for_element(
    page: Any,
    selectors: tuple[str, ...],
    timeout_s: int,
    stable_observations: int = 1,
    pause: Callable[[int, int], None] | None = None,
) -> tuple[Any, Any]:
    if pause is None:
        pause = human_pause
    deadline = time.monotonic() + max(0, timeout_s)
    required_observations = max(1, min(3, int(stable_observations)))
    previous_signature: tuple[str, tuple[str, ...]] | None = None
    stable_count = 0
    while time.monotonic() < deadline:
        found = find_first_scoped_element(page, selectors)
        if found is not None:
            scope, element = found
            signature = element_stability_signature(scope, element)
            stable_count = stable_count + 1 if signature == previous_signature else 1
            previous_signature = signature
            if stable_count >= required_observations:
                return found
            pause(160, 320)
            continue
        previous_signature = None
        stable_count = 0
        pause(300, 650)
    raise RuntimeError(f"page element did not appear: {', '.join(selectors)}")


def wait_for_document_settle(
    page: Any,
    timeout_s: float = 12,
    pause: Callable[[int, int], None] | None = None,
) -> None:
    """Give an Apple form transition time to hydrate before locating its next field."""
    if pause is None:
        pause = human_pause
    try:
        page.wait.doc_loaded(timeout=max(1, int(timeout_s)))
    except Exception:
        if not browser_connection_is_alive(page):
            raise RuntimeError("ruyiPage browser connection was lost during page transition")
        # Apple can swap an iframe without a top-level navigation. The
        # following target wait remains the authoritative readiness check.
        pass
    pause(500, 1100)


def scope_browsing_context_id(scope: Any) -> str:
    """Read ruyiPage's public browsing-context id for a stable frame identity."""
    try:
        context_id = str(scope.tab_id or "").strip()
    except Exception:
        context_id = ""
    if not context_id:
        raise RuntimeError("ruyiPage frame has no browsing-context id")
    return context_id


def element_stability_signature(scope: Any, element: Any) -> tuple[str, tuple[str, ...]]:
    """Use non-secret attributes plus the owner context to reject hydration races."""
    attributes: list[str] = []
    for name in ("id", "name", "autocomplete", "type", "role", "maxlength"):
        try:
            attributes.append(str(element.attr(name) or "").strip())
        except Exception:
            attributes.append("")
    return scope_browsing_context_id(scope), tuple(attributes)


def normalized_apple_frame_url(url: str) -> str | None:
    parsed = parse_valid_apple_url(url)
    if parsed is None:
        return None
    host = (parsed.hostname or "").lower()
    port = parsed.port
    netloc = host if port in (None, 443) else f"{host}:{port}"
    return parsed._replace(netloc=netloc, fragment="").geturl()


def sanitized_apple_url(url: str) -> str | None:
    parsed = parse_valid_apple_url(url)
    if parsed is None:
        return None
    host = (parsed.hostname or "").lower()
    return parsed._replace(netloc=host, query="", fragment="").geturl()


def find_hosting_frame_element(frame_scope: Any) -> tuple[Any, Any]:
    parent = getattr(frame_scope, "parent", None)
    if parent is None:
        raise RuntimeError("ruyiPage frame has no parent context for trusted input")

    parent_url = validate_apple_scope(parent)
    frame_url = normalized_apple_frame_url(validate_apple_scope(frame_scope))
    frame_parts = urlsplit(frame_url or "")
    exact_matches: list[Any] = []
    same_path_matches: list[Any] = []
    parent_path_matches: list[Any] = []
    same_host_matches: list[Any] = []
    for candidate in safe_elements(parent, "css:iframe"):
        if not element_is_interactable(candidate):
            continue
        try:
            candidate_url = normalized_apple_frame_url(
                urljoin(parent_url, str(candidate.attr("src") or ""))
            )
        except Exception:
            continue
        if not candidate_url or not frame_url:
            continue
        candidate_parts = urlsplit(candidate_url)
        if candidate_parts.hostname != frame_parts.hostname:
            continue
        same_host_matches.append(candidate)
        if candidate_url == frame_url:
            exact_matches.append(candidate)
        elif candidate_parts.path == frame_parts.path:
            same_path_matches.append(candidate)
        else:
            candidate_path = candidate_parts.path.rstrip("/")
            if candidate_path and frame_parts.path.startswith(f"{candidate_path}/"):
                parent_path_matches.append(candidate)

    # Use the strongest unique relation and never guess within an ambiguous tier.
    for matches in (
        exact_matches,
        same_path_matches,
        parent_path_matches,
        same_host_matches,
    ):
        if not matches:
            continue
        if len(matches) == 1:
            return parent, matches[0]
        break
    raise RuntimeError("unable to map ruyiPage frame to its visible iframe element")


def has_unique_visible_frame_host(parent: Any, frame_url: str) -> bool:
    """Map a child frame without assuming its parent has an HTTPS URL."""
    normalized_frame_url = normalized_apple_frame_url(frame_url)
    if normalized_frame_url is None:
        return False
    candidates = [
        candidate
        for candidate in safe_elements(parent, "css:iframe")
        if element_is_interactable(candidate)
    ]
    exact_matches = []
    for candidate in candidates:
        try:
            candidate_url = normalized_apple_frame_url(str(candidate.attr("src") or ""))
        except Exception:
            continue
        if candidate_url == normalized_frame_url:
            exact_matches.append(candidate)
    if len(exact_matches) == 1:
        return True
    # An opaque parent cannot safely resolve relative iframe sources. A single
    # visible host is still enough to keep the child frame fail-closed live.
    return bool(
        is_opaque_two_factor_frame_url(scope_location_url(parent))
        and len(candidates) == 1
    )


def scope_has_live_frame_chain(page: Any, scope: Any) -> bool:
    """Return whether a frame still maps to visible iframe hosts under page."""
    current = scope
    seen: set[int] = set()
    while current is not page:
        identity = id(current)
        if identity in seen:
            return False
        seen.add(identity)
        parent = getattr(current, "parent", None)
        if parent is None:
            return False
        current_url = scope_location_url(current)
        if is_opaque_two_factor_frame_url(current_url):
            candidates = [
                candidate
                for candidate in safe_elements(parent, "css:iframe")
                if element_is_interactable(candidate)
            ]
            known_widget = [
                candidate
                for candidate in candidates
                if str(candidate.attr("id") or "").strip()
                == APPLE_SIX_CELL_WIDGET_IFRAME_ID
            ]
            if len(known_widget) == 1:
                pass
            elif len(candidates) != 1:
                return False
        else:
            try:
                parent, _iframe = find_hosting_frame_element(current)
            except Exception:
                if not has_unique_visible_frame_host(parent, current_url):
                    return False
        current = parent
    return True


def is_apple_six_cell_widget_scope(page: Any, scope: Any) -> bool:
    """Require the observed top-level Apple six-cell iframe before fallback.

    The strict fallback is deliberately narrower than general OTP discovery:
    it is only for the visible ``iframe#aid-auth-widget-iFrame`` documented on
    Apple's account sign-in page.  Other trusted one-time-code widgets keep
    the primary owner-frame sequence and are never targeted per cell.
    """
    if getattr(scope, "parent", None) is not page:
        return False
    candidates = [
        candidate
        for candidate in safe_elements(page, APPLE_SIX_CELL_WIDGET_IFRAME_SELECTOR)
        if element_is_interactable(candidate)
        and str(candidate.attr("id") or "").strip()
        == APPLE_SIX_CELL_WIDGET_IFRAME_ID
    ]
    if len(candidates) != 1:
        return False
    try:
        parent, hosting_iframe = find_hosting_frame_element(scope)
    except Exception:
        return False
    return parent is page and hosting_iframe == candidates[0]


def apple_six_cell_widget_fields(scope: Any) -> list[Any]:
    """Return only the documented Apple six-cell container, in DOM order."""
    return [
        field
        for field in safe_elements(scope, FORM_SECURITY_CODE_INPUT_SELECTOR, timeout_s=0)
        if element_is_interactable(field) and element_is_editable_text_control(field)
    ]


def fields_are_the_live_apple_six_cell_widget(
    scope: Any,
    fields: list[tuple[Any, Any]],
) -> bool:
    """Reject generic numeric fields that are not Apple's visible six-cell widget."""
    if len(fields) != 6 or any(candidate_scope is not scope for candidate_scope, _field in fields):
        return False
    widget_fields = apple_six_cell_widget_fields(scope)
    return len(widget_fields) == 6 and all(
        candidate_field == widget_field
        for (_candidate_scope, candidate_field), widget_field in zip(fields, widget_fields)
    )


def fields_keep_the_same_widget_identity(
    reference_fields: list[tuple[Any, Any]],
    current_fields: list[tuple[Any, Any]],
) -> bool:
    """Allow ruyiPage wrapper recreation, but reject replacement DOM cells."""
    if len(reference_fields) != len(current_fields):
        return False
    return all(
        reference_field == current_field
        for (_reference_scope, reference_field), (_current_scope, current_field) in zip(
            reference_fields,
            current_fields,
        )
    )


def root_viewport_center(root_page: Any, scope: Any, field: Any) -> dict[str, int]:
    try:
        location = field.location
        size = field.size
        x = float(location["x"]) + float(size["width"]) / 2
        y = float(location["y"]) + float(size["height"]) / 2
    except Exception as exc:
        raise RuntimeError("unable to read ruyiPage field geometry") from exc

    current = scope
    seen: set[int] = set()
    while current is not root_page:
        identity = id(current)
        if identity in seen:
            raise RuntimeError("cycle detected in ruyiPage frame hierarchy")
        seen.add(identity)
        parent, iframe = find_hosting_frame_element(current)
        try:
            iframe_location = iframe.location
            x += float(iframe_location["x"])
            y += float(iframe_location["y"])
        except Exception as exc:
            raise RuntimeError("unable to read ruyiPage iframe geometry") from exc
        current = parent

    return {"x": round(x), "y": round(y)}


def scroll_element_into_view(element: Any) -> None:
    try:
        element.scroll.to_see()
    except Exception as exc:
        raise RuntimeError("unable to scroll ruyiPage input target into view") from exc


def prepare_frame_input_target(root_page: Any, scope: Any, field: Any) -> dict[str, int]:
    scroll_element_into_view(field)
    current = scope
    seen: set[int] = set()
    while current is not root_page:
        identity = id(current)
        if identity in seen:
            raise RuntimeError("cycle detected in ruyiPage frame hierarchy")
        seen.add(identity)
        parent, iframe = find_hosting_frame_element(current)
        scroll_element_into_view(iframe)
        current = parent
    return root_viewport_center(root_page, scope, field)


def element_focus_is_confirmed(element: Any) -> bool:
    try:
        focused = element.run_js(
            """
            function() {
              return Boolean(
                this === document.activeElement ||
                this === this.getRootNode()?.activeElement
              );
            }
            """
        )
    except Exception:
        return False
    return focused is True


def require_keyboard_target_ready(element: Any) -> None:
    if not element_is_interactable(element):
        raise RuntimeError("ruyiPage input target is not interactable")
    if not element_focus_is_confirmed(element):
        raise RuntimeError(FOCUS_NOT_CONFIRMED_REASON)


def require_password_bidi_input_target(scope: Any, element: Any) -> None:
    """Validate the exact password target before a trusted element-input fallback."""
    validate_apple_scope(scope)
    if not element_is_interactable(element):
        raise RuntimeError("ruyiPage input target is not interactable")
    try:
        input_type = str(element.attr("type") or "").strip().lower()
    except Exception as exc:
        raise RuntimeError("password input target type was not confirmed") from exc
    if input_type != "password":
        raise RuntimeError("password input target type was not confirmed")


def input_password_with_owner_bidi_fallback(
    scope: Any,
    field: Any,
    value: str,
    pause: Callable[[int, int], None] = human_pause,
) -> Any:
    """Use ruyiPage's trusted element input when Firefox cannot expose focus state."""
    require_password_bidi_input_target(scope, field)
    emit_input_progress("password", "owner_bidi_fallback_started", "owner")
    try:
        pause(180, 420)
        field.input(value, clear=True)
        validate_apple_scope(scope)
        emit_input_progress("password", "owner_bidi_typed", "owner")
        pause(280, 680)
        readable, actual = read_element_input_value(field)
        read_state = classify_input_read(readable, actual, value)
        emit_input_progress("password", f"owner_bidi_value_{read_state}", "owner")
        if readable and str(actual) == value:
            emit_input_progress("password", "verified", "owner")
        elif readable and str(actual) == "":
            raise RuntimeError("password input empty after trusted input")
        elif readable:
            raise RuntimeError("password input verification failed")
        else:
            raise RuntimeError("password input unreadable after trusted input")
        return scope
    except Exception as exc:
        if str(exc) not in (
            "password input empty after trusted input",
            "password input unreadable after trusted input",
            "password input verification failed",
        ):
            emit_input_progress("password", "failed")
        raise


def require_otp_bidi_input_target(scope: Any, element: Any, label: str) -> None:
    """Validate an already-discovered OTP target before trusted element input."""
    validate_two_factor_scope(scope)
    if not element_is_interactable(element) or not element_is_editable_text_control(element):
        raise RuntimeError("2FA input target is not interactable")
    try:
        maxlength = str(element.attr("maxlength") or "").strip()
    except Exception:
        maxlength = ""
    if label == "2FA digit":
        if maxlength != "1" and not element_has_otp_semantics(element):
            raise RuntimeError("2FA digit target was not confirmed")
    elif not element_has_otp_semantics(element):
        raise RuntimeError("2FA input target was not confirmed")


def input_otp_with_owner_bidi_fallback(
    scope: Any,
    field: Any,
    value: str,
    label: str,
    pause: Callable[[int, int], None] = human_pause,
) -> Any:
    """Keep OTP entry in ruyiPage when Firefox loses observable focus after a click."""
    require_otp_bidi_input_target(scope, field, label)
    emit_input_progress(label, "owner_bidi_fallback_started", "owner")
    pause(180, 420)
    field.input(value, clear=True)
    validate_two_factor_scope(scope)
    emit_input_progress(label, "owner_bidi_typed", "owner")
    pause(280, 680)
    readable, actual = read_element_input_value(field)
    read_state = classify_input_read(readable, actual, value)
    emit_input_progress(label, f"owner_bidi_value_{read_state}", "owner")
    if readable and str(actual) == value:
        emit_input_progress(label, "verified", "owner")
    elif otp_input_readback_is_limited(readable, actual):
        # The element input call is a trusted ruyiPage BiDi action. Do not
        # replay a code when Apple masks a cell value after accepting it.
        validate_two_factor_scope(scope)
        emit_input_progress(label, "owner_bidi_unverified_continue", "owner")
    else:
        raise RuntimeError(f"{label} input verification failed")
    return scope


def otp_control_has_expected_value_length(field: Any, expected_length: int) -> bool:
    """Query only the length of a live OTP control, never its sensitive value."""
    if expected_length < 0:
        return False
    try:
        return field.run_js(
            """
            function() {
              /* ruyipage-otp-length-check */
              const value = typeof this.value === 'string'
                ? this.value
                : (this.isContentEditable
                  ? (this.innerText ?? this.textContent ?? '')
                  : '');
              return Boolean(this.isConnected && value.length === __EXPECTED_LENGTH__);
            }
            """.replace("__EXPECTED_LENGTH__", str(expected_length))
        ) is True
    except Exception:
        return False


def otp_fields_have_expected_value_length(
    fields: list[tuple[Any, Any]],
    expected_length: int,
) -> bool:
    if len(fields) not in (1, 6):
        return False
    scope = fields[0][0]
    if any(candidate_scope is not scope for candidate_scope, _field in fields):
        return False
    try:
        validate_two_factor_scope(scope)
    except Exception:
        return False
    return all(
        otp_control_has_expected_value_length(field, expected_length)
        for _candidate_scope, field in fields
    )


def otp_fields_match_expected_lengths(
    fields: list[tuple[Any, Any]],
    expected_lengths: list[int],
) -> bool:
    if len(fields) != len(expected_lengths):
        return False
    scope = fields[0][0] if fields else None
    if scope is None or any(candidate_scope is not scope for candidate_scope, _field in fields):
        return False
    try:
        validate_two_factor_scope(scope)
    except Exception:
        return False
    return all(
        otp_control_has_expected_value_length(field, expected_length)
        for (_candidate_scope, field), expected_length in zip(fields, expected_lengths)
    )


def require_pristine_six_cell_target(
    page: Any,
    expected_count: int,
    reference_fields: list[tuple[Any, Any]],
    timeout_s: float = TWO_FACTOR_TARGET_REFRESH_TIMEOUT_S,
) -> list[tuple[Any, Any]]:
    """Require the same empty six-cell widget before any clear or fallback."""
    if expected_count != 6 or len(reference_fields) != expected_count:
        raise RuntimeError("2FA six-cell widget target count changed before entry")
    reference_scope = reference_fields[0][0]
    if any(scope is not reference_scope for scope, _field in reference_fields):
        raise RuntimeError("2FA six-cell widget scopes changed before entry")
    reference_context_id = scope_browsing_context_id(reference_scope)
    if not otp_fields_match_expected_lengths(reference_fields, [0] * expected_count):
        raise RuntimeError("2FA six-cell widget was not empty before entry")

    current_fields = refresh_otp_target(
        page,
        expected_count=expected_count,
        timeout_s=timeout_s,
    )
    current_scope = current_fields[0][0]
    if scope_browsing_context_id(current_scope) != reference_context_id:
        raise RuntimeError("2FA six-cell iframe changed before entry")
    if not fields_keep_the_same_widget_identity(reference_fields, current_fields):
        raise RuntimeError("2FA six-cell widget fields changed before entry")
    if not otp_fields_match_expected_lengths(current_fields, [0] * expected_count):
        raise RuntimeError("2FA six-cell widget was not empty before entry")
    return current_fields


def input_otp_sequence_in_owner_context(
    scope: Any,
    first_field: Any,
    value: str,
    keys: Any,
    pause: Callable[[int, int], None] = human_pause,
    before_clear: Callable[[], None] | None = None,
) -> None:
    """Enter an OTP through its owning ruyiPage frame without reading its value."""
    validate_two_factor_scope(scope)
    emit_input_progress("2FA code", "sequence_focus_started", "owner")
    human_click(scope, first_field, pause=pause)
    pause(180, 480)
    validate_two_factor_scope(scope)
    require_keyboard_target_ready(first_field)
    if before_clear is not None:
        before_clear()
    scope.actions.combo(keys.COMMAND, "a").press(keys.DELETE).perform()
    emit_input_progress("2FA code", "sequence_cleared", "owner")
    pause(120, 320)
    validate_two_factor_scope(scope)
    require_keyboard_target_ready(first_field)
    scope.actions.type(value, interval=random.randint(55, 145)).perform()
    validate_two_factor_scope(scope)
    emit_input_progress("2FA code", "sequence_typed", "owner")


def fill_empty_six_cell_otp_with_element_bidi(
    page: Any,
    digits: str,
    expected_count: int,
    pristine_fields: list[tuple[Any, Any]],
    pause: Callable[[int, int], None] = human_pause,
) -> list[tuple[Any, Any]] | None:
    """Use exact ruyiPage element input only when the six-cell widget is empty.

    Apple normally advances focus itself, so the owner-context key sequence is
    the primary path. If Firefox accepted none of those keys, ruyiPage can
    focus each already-validated cell and dispatch one trusted BiDi key through
    that cell's frame. This fallback never clears individual cells and never
    runs after a partial entry, which avoids shifting or replaying an OTP.
    """
    if expected_count != 6 or len(digits) != 6:
        return None
    fallback_started = False
    reference_fields = list(pristine_fields)

    def refresh_live_widget(expected_context_id: str) -> list[tuple[Any, Any]]:
        current_fields = refresh_otp_target(
            page,
            expected_count=expected_count,
            timeout_s=TWO_FACTOR_EMPTY_CELL_FALLBACK_PROBE_TIMEOUT_S,
        )
        current_scope = current_fields[0][0]
        if scope_browsing_context_id(current_scope) != expected_context_id:
            raise RuntimeError("Apple six-cell iframe browsing context changed during OTP entry")
        if not is_apple_six_cell_widget_scope(page, current_scope):
            raise RuntimeError("Apple six-cell iframe changed during OTP entry")
        if not fields_are_the_live_apple_six_cell_widget(current_scope, current_fields):
            raise RuntimeError("Apple six-cell widget fields changed during OTP entry")
        if reference_fields and not fields_keep_the_same_widget_identity(
            reference_fields,
            current_fields,
        ):
            raise RuntimeError("Apple six-cell widget identity changed during OTP entry")
        return current_fields

    try:
        fields = require_pristine_six_cell_target(
            page,
            expected_count=expected_count,
            reference_fields=reference_fields,
            timeout_s=TWO_FACTOR_EMPTY_CELL_FALLBACK_PROBE_TIMEOUT_S,
        )
        scope = fields[0][0]
        expected_context_id = scope_browsing_context_id(scope)
        if (
            not is_apple_six_cell_widget_scope(page, scope)
            or not fields_are_the_live_apple_six_cell_widget(scope, fields)
        ):
            return None

        emit_input_progress("2FA code", "cell_bidi_fallback_started", "owner")
        fallback_started = True
        for index, digit in enumerate(digits):
            # FirefoxElement.input(clear=False) focuses this exact element and
            # sends input.performActions in its owner frame. No synthetic JS
            # input event or outer-page keyboard action is involved.
            # Apple can rehydrate the widget after every digit, so reacquire
            # the ordered live field set before the next trusted dispatch.
            fields = refresh_live_widget(expected_context_id)
            scope, field = fields[index]
            expected_before = [1] * index + [0] * (expected_count - index)
            if not otp_fields_match_expected_lengths(fields, expected_before):
                raise RuntimeError("Apple six-cell widget did not preserve prior OTP input")
            require_otp_bidi_input_target(scope, field, "2FA digit")
            field.input(digit, clear=False)
            validate_two_factor_scope(scope)
            pause(70, 170)

            try:
                fields = refresh_live_widget(expected_context_id)
            except Exception:
                if index == expected_count - 1:
                    return None
                raise
            expected_after = [1] * (index + 1) + [0] * (expected_count - index - 1)
            if not otp_fields_match_expected_lengths(fields, expected_after):
                raise RuntimeError("Apple six-cell widget did not confirm current OTP input")

        emit_input_progress("2FA code", "cell_bidi_fallback_completed", "owner")
        return fields
    except Exception:
        if fallback_started:
            emit_input_progress("2FA code", "cell_bidi_fallback_unconfirmed", "owner")
    return None


def input_with_owner_bidi_fallback(
    scope: Any,
    field: Any,
    value: str,
    label: str,
    pause: Callable[[int, int], None] = human_pause,
) -> Any | None:
    if label == "password":
        return input_password_with_owner_bidi_fallback(
            scope,
            field,
            value,
            pause=pause,
        )
    if label in ("2FA code", "2FA digit"):
        try:
            require_otp_bidi_input_target(scope, field, label)
        except RuntimeError:
            return None
        return input_otp_with_owner_bidi_fallback(
            scope,
            field,
            value,
            label,
            pause=pause,
        )
    return None


def element_uses_rendered_text(element: Any) -> bool:
    try:
        input_type = str(element.attr("type") or "").strip().lower()
        if input_type == "password":
            return False
        if str(element.attr("contenteditable") or "").strip().lower() == "true":
            return True
        if str(element.attr("role") or "").strip().lower() != "textbox":
            return False
        return element.run_js(
            """
            function() {
              return !['INPUT', 'TEXTAREA'].includes(
                String(this.tagName || '').toUpperCase()
              );
            }
            """
        ) is True
    except Exception:
        return True


def read_element_input_value(element: Any) -> tuple[bool, Any]:
    try:
        if element_uses_rendered_text(element):
            value = element.run_js(
                """
                function() {
                  return this.innerText ?? this.textContent ?? null;
                }
                """
            )
        else:
            value = element.value
    except Exception:
        return False, None
    return value is not None, value


def human_click(
    scope: Any,
    element: Any,
    pause: Callable[[int, int], None] = human_pause,
) -> None:
    pause(80, 220)
    scope.actions.human_click(element).perform()


def focus_keyboard_target_in_owner_context(
    scope: Any,
    field: Any,
    pause: Callable[[int, int], None] = human_pause,
    two_factor_scope: bool = False,
) -> Any:
    if two_factor_scope:
        validate_two_factor_scope(scope)
    else:
        validate_apple_scope(scope)
    human_click(scope, field, pause=pause)
    pause(180, 480)
    require_keyboard_target_ready(field)
    return scope


def focus_keyboard_target(
    root_page: Any,
    scope: Any,
    field: Any,
    pause: Callable[[int, int], None] = human_pause,
    two_factor_scope: bool = False,
) -> Any:
    """Focus a field through the top context, then fall back to its owner context."""
    if two_factor_scope:
        validate_two_factor_scope(scope)
    else:
        validate_apple_scope(scope)
    root_page = root_page or scope
    if scope is root_page:
        human_click(scope, field, pause=pause)
        pause(180, 480)
        require_keyboard_target_ready(field)
        return scope

    validate_apple_scope(root_page)
    if two_factor_scope and is_opaque_two_factor_frame_url(scope_location_url(scope)):
        return focus_keyboard_target_in_owner_context(
            scope,
            field,
            pause=pause,
            two_factor_scope=True,
        )
    click_target = prepare_frame_input_target(root_page, scope, field)
    human_click(root_page, click_target, pause=pause)
    pause(180, 480)
    if not element_is_interactable(field):
        raise RuntimeError("ruyiPage input target is not interactable")
    if element_focus_is_confirmed(field):
        return root_page

    # A shadow-root target can reject a top-context coordinate focus even when
    # its owning frame context can target the same element directly.
    return focus_keyboard_target_in_owner_context(
        scope,
        field,
        pause=pause,
        two_factor_scope=two_factor_scope,
    )


def input_and_verify(
    scope: Any,
    field: Any,
    value: str,
    label: str,
    keys: Any,
    pause: Callable[[int, int], None] = human_pause,
    root_page: Any | None = None,
) -> Any:
    root_page = root_page or scope
    password_keyboard_retry_required = False
    if label == "password":
        try:
            return input_password_with_owner_bidi_fallback(
                scope,
                field,
                value,
                pause=pause,
            )
        except RuntimeError as error:
            message = str(error)
            if message == "password input verification failed":
                raise
            if message not in (
                "password input empty after trusted input",
                "password input unreadable after trusted input",
            ):
                raise
            password_keyboard_retry_required = True
            emit_input_progress("password", "owner_bidi_keyboard_retry", "owner")

    two_factor_scope = label in ("2FA code", "2FA digit")
    saw_readable_nonempty_mismatch = False
    action_scope: Any | None = None
    route: str | None = None
    readable = False
    actual: Any = None
    try:
        emit_input_progress(label, "focus_started")
        try:
            action_scope = focus_keyboard_target(
                root_page,
                scope,
                field,
                pause=pause,
                two_factor_scope=two_factor_scope,
            )
        except RuntimeError as error:
            if str(error) != FOCUS_NOT_CONFIRMED_REASON:
                raise
            if label == "password" and password_keyboard_retry_required:
                raise
            emit_input_progress(label, "owner_focus_unconfirmed", "owner")
            fallback = input_with_owner_bidi_fallback(
                scope,
                field,
                value,
                label,
                pause=pause,
            )
            if fallback is None:
                raise
            return fallback
        route = "root" if action_scope is root_page else "owner"
        emit_input_progress(label, "focus_confirmed", route)
        action_scope.actions.combo(keys.COMMAND, "a").press(keys.DELETE).perform()
        emit_input_progress(label, "keyboard_cleared", route)
        pause(120, 320)
        require_keyboard_target_ready(field)
        action_scope.actions.type(value, interval=random.randint(55, 145)).perform()
        if two_factor_scope:
            validate_two_factor_scope(scope)
        emit_input_progress(label, "keyboard_typed", route)
        pause(280, 680)
        readable, actual = read_element_input_value(field)
        read_state = classify_input_read(readable, actual, value)
        emit_input_progress(label, f"value_{read_state}", route)
        if readable and str(actual) == value:
            emit_input_progress(label, "verified", route)
            return action_scope
        if two_factor_scope and otp_input_readback_is_limited(readable, actual):
            # The focused ruyiPage actions route is trusted. Avoid a second
            # keystroke sequence solely because Apple masks the OTP value.
            validate_two_factor_scope(scope)
            emit_input_progress(label, "keyboard_unverified_continue", route)
            return action_scope
        saw_readable_nonempty_mismatch = readable and str(actual) != ""

        if scope is not root_page and action_scope is root_page:
            emit_input_progress(label, "owner_fallback_started", "owner")
            action_scope = focus_keyboard_target_in_owner_context(
                scope,
                field,
                pause=pause,
                two_factor_scope=two_factor_scope,
            )
            route = "owner"
            emit_input_progress(label, "owner_focus_confirmed", route)
            action_scope.actions.combo(keys.COMMAND, "a").press(keys.DELETE).perform()
            emit_input_progress(label, "owner_keyboard_cleared", route)
            pause(120, 320)
            require_keyboard_target_ready(field)
            action_scope.actions.type(value, interval=random.randint(55, 145)).perform()
            if two_factor_scope:
                validate_two_factor_scope(scope)
            emit_input_progress(label, "owner_keyboard_typed", route)
            pause(280, 680)
            readable, actual = read_element_input_value(field)
            read_state = classify_input_read(readable, actual, value)
            emit_input_progress(label, f"owner_value_{read_state}", route)
            if readable and str(actual) == value:
                emit_input_progress(label, "verified", route)
                return action_scope
            saw_readable_nonempty_mismatch = (
                saw_readable_nonempty_mismatch
                or (readable and str(actual) != "")
            )

        if action_scope is scope and not (
            label == "password" and password_keyboard_retry_required
        ):
            emit_input_progress(label, "element_fallback_started", route)
            pause(180, 420)
            require_keyboard_target_ready(field)
            action_scope.actions.combo(keys.COMMAND, "a").press(keys.DELETE).perform()
            pause(120, 320)
            require_keyboard_target_ready(field)
            field.input(value, clear=False)
            if two_factor_scope:
                validate_two_factor_scope(scope)
            emit_input_progress(label, "element_typed", route)
            pause(280, 680)
            readable, actual = read_element_input_value(field)
            read_state = classify_input_read(readable, actual, value)
            emit_input_progress(label, f"element_value_{read_state}", route)
        if two_factor_scope and otp_input_readback_is_limited(readable, actual):
            validate_two_factor_scope(scope)
            emit_input_progress(label, "element_unverified_continue", route)
            return action_scope
        if not readable:
            raise RuntimeError(f"{label} input verification failed")
        if (
            label == "password"
            and str(actual) == ""
            and not saw_readable_nonempty_mismatch
        ):
            raise RuntimeError(f"{label} input verification failed")
        if str(actual) != value:
            raise RuntimeError(f"{label} input verification failed")
        emit_input_progress(label, "verified", route)
        return action_scope
    except RuntimeError as error:
        if str(error) == FOCUS_NOT_CONFIRMED_REASON:
            if label == "password" and password_keyboard_retry_required:
                emit_input_progress(label, "failed", route)
                raise
            try:
                emit_input_progress(label, "owner_focus_unconfirmed", "owner")
                fallback = input_with_owner_bidi_fallback(
                    scope,
                    field,
                    value,
                    label,
                    pause=pause,
                )
                if fallback is not None:
                    return fallback
            except Exception:
                emit_input_progress(label, "failed", route)
                raise
        emit_input_progress(label, "failed", route)
        raise
    except Exception:
        emit_input_progress(label, "failed", route)
        raise


def submit_with_enter(
    scope: Any,
    element: Any,
    keys: Any,
    pause: Callable[[int, int], None] = human_pause,
    min_ms: int = 350,
    max_ms: int = 800,
) -> None:
    pause(min_ms, max_ms)
    require_keyboard_target_ready(element)
    scope.actions.press(keys.ENTER).perform()


def submit_element_with_enter(
    root_page: Any,
    scope: Any,
    element: Any,
    keys: Any,
    pause: Callable[[int, int], None] = human_pause,
    min_ms: int = 350,
    max_ms: int = 800,
    password_value: str | None = None,
) -> None:
    candidate_scope = scope
    candidate_element = element
    for attempt in range(2):
        try:
            action_scope = focus_keyboard_target(
                root_page,
                candidate_scope,
                candidate_element,
                pause=pause,
            )
        except RuntimeError as error:
            if str(error) != FOCUS_NOT_CONFIRMED_REASON or attempt != 0:
                raise
            try:
                input_type = str(candidate_element.attr("type") or "").strip().lower()
            except Exception:
                raise error
            if input_type != "password" or not password_value:
                emit_input_progress("password", "submit_focus_unconfirmed", "owner")
                raise error

            # The 2FA prepare acknowledgement can outlive an Apple iframe
            # refresh. Rediscover and revalidate before sending any key.
            candidate_scope, candidate_element = wait_for_element(
                root_page,
                PASSWORD_SELECTORS,
                timeout_s=15,
            )
            input_and_verify(
                candidate_scope,
                candidate_element,
                password_value,
                "password",
                keys,
                pause=pause,
                root_page=root_page,
            )
            emit_input_progress("password", "submit_target_refreshed", "owner")
            continue

        submit_with_enter(
            action_scope,
            candidate_element,
            keys,
            pause=pause,
            min_ms=min_ms,
            max_ms=max_ms,
        )
        return

    raise RuntimeError(FOCUS_NOT_CONFIRMED_REASON)


def ensure_remember_checked(
    page: Any,
    pause: Callable[[int, int], None] = human_pause,
) -> bool:
    state_found = False
    emit_remember_progress("search_started")
    for state_selector, click_selectors in REMEMBER_SELECTORS:
        for scope, root in current_element_search_roots(page):
            fields = safe_elements(root, state_selector, timeout_s=0)
            if not fields:
                continue
            state_found = True
            field = fields[0]
            validate_apple_scope(scope)
            emit_remember_progress("target_found")
            try:
                if field.states.is_checked:
                    emit_remember_progress("already_checked")
                    return True
            except Exception:
                pass

            click_target = field if element_is_interactable(field) else None
            if click_target is None:
                for click_selector in click_selectors:
                    candidates = [
                        element
                        for element in safe_elements(
                            root,
                            click_selector,
                            timeout_s=0,
                        )
                        if element_is_interactable(element)
                    ]
                    if candidates:
                        click_target = candidates[0]
                        break
            if click_target is None:
                emit_remember_progress("target_not_interactable")
                continue

            if scope is page:
                action_scope = scope
                action_target = click_target
                route = "root"
            else:
                action_scope = page
                action_target = prepare_frame_input_target(page, scope, click_target)
                route = "root"
            emit_remember_progress("click_started", route)
            human_click(action_scope, action_target, pause=pause)
            pause(180, 420)
            try:
                checked = bool(field.states.is_checked)
            except Exception:
                checked = False
            if checked:
                emit_remember_progress("checked", route)
            if (
                not checked
                and scope is not page
                and element_is_interactable(click_target)
            ):
                validate_apple_scope(scope)
                emit_remember_progress("owner_fallback_started", "owner")
                human_click(scope, click_target, pause=pause)
                pause(180, 420)
                try:
                    checked = bool(field.states.is_checked)
                except Exception:
                    checked = False
                if checked:
                    emit_remember_progress("checked", "owner")
            if not checked:
                emit_remember_progress("failed", route)
                raise RuntimeError("remember-account checkbox did not become checked")
            return True
    if state_found:
        emit_remember_progress("failed")
        raise RuntimeError("remember-account checkbox is not interactable")
    emit_remember_progress("not_found")
    raise RuntimeError("remember-account checkbox not found")


def detect_shadow_root_state(root: Any) -> dict[str, bool]:
    try:
        raw = root.run_js(
            r"""
            function() {
              const shadowRoot = this;
              if (!shadowRoot?.querySelectorAll) {
                return JSON.stringify({
                  hasStrongText: false,
                  semanticTargetCount: 0,
                  digitCellCount: 0,
                  trustPrompt: false,
                  otpRejected: false,
                  blocked: false,
                  error: false
                });
              }
              const visible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = el.ownerDocument?.defaultView?.getComputedStyle(el);
                return rect.width > 2 && rect.height > 2 &&
                  style?.display !== 'none' && style?.visibility !== 'hidden';
              };
              const isEditableTextInput = (el) => {
                if (el.tagName !== 'INPUT') return true;
                return ['text', 'search', 'tel', 'url', 'email', 'password', 'number']
                  .includes(String(el.type || 'text').toLowerCase());
              };
              const visibleTextElements = [...shadowRoot.querySelectorAll('*')]
                .filter(visible)
                .filter((el) => !['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(el.tagName));
              const strongTwoFactorText = visibleTextElements.some((el) => {
                const text = typeof el.innerText === 'string'
                  ? el.innerText
                  : (el.children.length === 0 ? (el.textContent || '') : '');
                return /two-factor|verification code|security code|one-time code|双重认证|雙重認證|验证码|驗證碼/i.test(text);
              });
              const targets = [...shadowRoot.querySelectorAll('input, [role="textbox"], [contenteditable="true"]')]
                .filter(visible)
                .filter(isEditableTextInput);
              const semantics = (el) => /one[\s_-]?time|verification|security[\s_-]*code|\botp\b|passcode|\bcode\b|验证码|驗證碼|双重认证|雙重認證/i.test([
                el.getAttribute('aria-label'), el.getAttribute('aria-describedby'), el.getAttribute('aria-description'),
                el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('class'),
                el.getAttribute('autocomplete'), el.getAttribute('placeholder')
              ].filter(Boolean).join(' '));
              const semanticTargets = targets.filter(semantics);
              const digitCells = targets.filter((el) =>
                (el.maxLength === 1 || el.getAttribute('maxlength') === '1') &&
                (el.tagName === 'INPUT' || semantics(el))
              );
              const body = visibleTextElements.map((el) => {
                if (typeof el.innerText === 'string') return el.innerText;
                return el.children.length === 0 ? (el.textContent || '') : '';
              }).join('\n');
              const normalizedBody = body.replace(/\s+/g, ' ');
              const otpRejected = /__OTP_REJECTION_PATTERN__/i.test(normalizedBody);
              const blocked = /captcha|locked|account locked|被锁定|被鎖定|账户锁定|帳戶鎖定/i.test(body);
              return JSON.stringify({
                hasStrongText: strongTwoFactorText,
                semanticTargetCount: semanticTargets.length,
                digitCellCount: digitCells.length,
                trustPrompt: /trust this browser|信任此浏览器|信任此瀏覽器/i.test(body),
                otpRejected,
                blocked,
                error: otpRejected || blocked ||
                  /\berror\b|something went wrong|incorrect|invalid|expired|wrong password|try again|unable to sign in|无法登录|無法登入|错误|錯誤|不正确|不正確|无效|無效/i.test(body)
              });
            }
            """.replace("__OTP_REJECTION_PATTERN__", OTP_REJECTION_JS_PATTERN)
        )
    except Exception:
        return {}
    try:
        evidence = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(evidence, dict):
            return {}
        return {
            "twofa": classify_strong_two_factor(
                has_strong_text=evidence.get("hasStrongText") is True,
                semantic_target_count=int(evidence.get("semanticTargetCount") or 0),
                digit_cell_count=int(evidence.get("digitCellCount") or 0),
            ),
            "trustPrompt": evidence.get("trustPrompt") is True,
            "otpRejected": evidence.get("otpRejected") is True,
            "blocked": evidence.get("blocked") is True,
            "error": evidence.get("error") is True,
        }
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}


def shadow_root_has_two_factor_marker(root: Any) -> bool:
    return bool(detect_shadow_root_state(root).get("twofa"))


def unique_elements(elements: list[Any]) -> list[Any]:
    result: list[Any] = []
    seen: set[Any] = set()
    for element in elements:
        if element in seen:
            continue
        seen.add(element)
        result.append(element)
    return result


def unique_scoped_elements(
    elements: list[tuple[Any, Any]],
) -> list[tuple[Any, Any]]:
    result: list[tuple[Any, Any]] = []
    seen: set[Any] = set()
    for scope, element in elements:
        if element in seen:
            continue
        seen.add(element)
        result.append((scope, element))
    return result


def security_code_fields(page: Any) -> list[tuple[Any, Any]]:
    all_candidates: list[tuple[Any, Any]] = []
    candidate_groups: list[list[tuple[Any, Any]]] = []
    grouped: list[tuple[Any, list[Any]]] = []
    group_indexes: dict[int, int] = {}
    for scope, root in current_element_search_roots(page):
        identity = id(scope)
        if identity not in group_indexes:
            group_indexes[identity] = len(grouped)
            grouped.append((scope, []))
        grouped[group_indexes[identity]][1].append(root)

    for scope, roots in grouped:
        try:
            state = detect_scope_login_state(scope)
        except Exception:
            continue
        if not isinstance(state, dict) or not is_trusted_two_factor_scope(
            scope,
            str(state.get("href") or ""),
        ):
            continue

        shadow_twofa = any(
            root is not scope and shadow_root_has_two_factor_marker(root)
            for root in roots
        )
        two_factor_scope = bool(state.get("twofa") or shadow_twofa)
        candidates: list[Any] = []
        digit_inputs: list[Any] = []
        role_textboxes: list[Any] = []

        for root in roots:
            for selector, direct_candidate in CODE_FIELD_SELECTORS:
                matching_elements = editable_text_elements(root, selector)
                if selector == FORM_SECURITY_CODE_INPUT_SELECTOR:
                    if len(matching_elements) == 6:
                        candidates.extend(matching_elements)
                elif direct_candidate:
                    candidates.extend(matching_elements)
                else:
                    digit_inputs.extend(matching_elements)
            candidates.extend(semantic_otp_elements(root, "css:input"))
            if two_factor_scope:
                role_textboxes.extend(
                    editable_text_elements(root, "css:[role='textbox']")
                )
                candidates.extend(
                    semantic_otp_elements(root, "css:[contenteditable='true']")
                )

        digit_inputs = unique_elements(digit_inputs)
        if len(digit_inputs) == 6:
            candidates.extend(digit_inputs)

        if two_factor_scope:
            role_textboxes = unique_elements(role_textboxes)
            candidates.extend(
                field for field in role_textboxes if element_has_otp_semantics(field)
            )

        candidates = unique_elements(candidates)
        scoped_candidates = [(scope, field) for field in candidates]
        candidate_groups.append(scoped_candidates)
        all_candidates.extend(scoped_candidates)

    all_candidates = unique_scoped_elements(all_candidates)
    six_digit_groups = [group for group in candidate_groups if len(group) == 6]
    # A live Apple document can transiently expose both a single OTP control
    # and the six-cell widget while it rehydrates. Refuse that global
    # ambiguity rather than guessing which context should receive a code.
    if len(all_candidates) == 6 and len(six_digit_groups) == 1:
        return six_digit_groups[0]
    return all_candidates if len(all_candidates) == 1 else []


def interactable_elements(root: Any, selector: str) -> list[Any]:
    return [
        element
        for element in safe_elements(root, selector, timeout_s=0)
        if element_is_interactable(element)
    ]


def editable_text_elements(root: Any, selector: str) -> list[Any]:
    return [
        element
        for element in interactable_elements(root, selector)
        if element_is_editable_text_control(element)
    ]


def element_has_otp_semantics(element: Any) -> bool:
    values: list[str] = []
    for name in (
        "aria-label",
        "aria-describedby",
        "aria-description",
        "name",
        "id",
        "class",
        "autocomplete",
        "inputmode",
        "maxlength",
        "placeholder",
    ):
        try:
            value = element.attr(name)
        except Exception:
            continue
        if value is not None:
            values.append(str(value))
    return bool(OTP_SEMANTIC_RE.search(" ".join(values)))


def semantic_otp_elements(root: Any, selector: str) -> list[Any]:
    return [
        element
        for element in editable_text_elements(root, selector)
        if element_has_otp_semantics(element)
    ]


def wait_for_otp_target(
    page: Any,
    timeout_s: float = 30,
    stable_observations: int = 2,
) -> list[tuple[Any, Any]]:
    deadline = time.monotonic() + max(0.0, timeout_s)
    required_observations = max(1, min(3, int(stable_observations)))
    previous_signature: tuple[str, int] | None = None
    stable_count = 0
    while time.monotonic() < deadline:
        fields = security_code_fields(page)
        if fields and len(fields) in (1, 6):
            scope = fields[0][0]
            if all(candidate_scope is scope for candidate_scope, _field in fields):
                try:
                    signature = (validate_two_factor_scope(scope), len(fields))
                except Exception:
                    signature = None
                if signature is not None:
                    stable_count = stable_count + 1 if signature == previous_signature else 1
                    previous_signature = signature
                    if stable_count >= required_observations:
                        return fields
                    human_pause(180, 420)
                    continue
        previous_signature = None
        stable_count = 0
        human_pause(260, 560)
    raise RuntimeError("2FA is visible but an interactable OTP target did not appear")


def refresh_otp_target(
    page: Any,
    expected_count: int,
    timeout_s: float = TWO_FACTOR_TARGET_REFRESH_TIMEOUT_S,
) -> list[tuple[Any, Any]]:
    fields = wait_for_otp_target(page, timeout_s=timeout_s, stable_observations=1)
    if len(fields) != expected_count:
        raise RuntimeError("2FA code input target count changed during entry")
    return fields


def wait_for_otp_entry_confirmation(
    page: Any,
    expected_count: int,
    timeout_s: float = TWO_FACTOR_TARGET_REFRESH_TIMEOUT_S,
) -> list[tuple[Any, Any]] | None:
    """Confirm only OTP control state after trusted input, never the OTP value.

    Apple can immediately advance away from the six-cell widget after the last
    key.  Returning ``None`` records that expected automatic transition so the
    caller can wait for the signed-in state instead of sending an extra Enter.
    """
    deadline = time.monotonic() + max(0.0, timeout_s)
    while time.monotonic() < deadline:
        fields = security_code_fields(page)
        target_is_still_visible = False
        if len(fields) == expected_count:
            scope = fields[0][0]
            if all(candidate_scope is scope for candidate_scope, _field in fields):
                target_is_still_visible = True
                try:
                    validate_two_factor_scope(scope)
                except Exception:
                    pass
                else:
                    expected_length = 6 if expected_count == 1 else 1
                    if otp_fields_have_expected_value_length(fields, expected_length):
                        return fields

        try:
            state = detect_login_state(page)
        except Exception:
            state = {}
        # A vanished widget alone is not an automatic submission. Apple can
        # rehydrate a frame, return to credentials, or expose an error page
        # between polls. Only a confirmed signed-in state or the explicit
        # post-OTP trust prompt is a safe reason to avoid a second submit.
        if not target_is_still_visible and (
            state.get("trusted") or state.get("trustPrompt")
        ):
            return None
        human_pause(140, 300)
    raise RuntimeError(TWO_FACTOR_INPUT_UNCONFIRMED_REASON)


def fill_security_code(
    page: Any,
    code: str,
    keys: Any,
    pause: Callable[[int, int], None] = human_pause,
    fields: list[tuple[Any, Any]] | None = None,
) -> list[tuple[Any, Any]] | None:
    digits = "".join(ch for ch in str(code) if ch.isdigit())
    if len(digits) != 6:
        raise RuntimeError("2FA code must contain exactly six digits")

    fields = fields if fields is not None else security_code_fields(page)
    if not fields:
        raise RuntimeError("2FA code input was not detected; refusing unfocused typing")
    if len(fields) not in (1, 6):
        raise RuntimeError("2FA code input must resolve to exactly one or six targets")

    if len(fields) == 1:
        scope, field = fields[0]
        try:
            require_otp_bidi_input_target(scope, field, "2FA code")
            input_otp_sequence_in_owner_context(scope, field, digits, keys, pause=pause)
            confirmed_fields = wait_for_otp_entry_confirmation(page, expected_count=1)
        except Exception as error:
            emit_input_progress("2FA code", "input_unconfirmed", "owner")
            raise RuntimeError(TWO_FACTOR_INPUT_UNCONFIRMED_REASON) from error
        if confirmed_fields is None:
            emit_input_progress("2FA code", "sequence_auto_submitted", "owner")
        return confirmed_fields

    expected_count = len(fields)
    sequence_scope = fields[0][0]
    if any(scope is not sequence_scope for scope, _field in fields):
        raise RuntimeError(
            "2FA code input must resolve to six targets in one trusted Apple frame"
        )
    # hsa2-sk7 moves the focus between its six cells itself. Issuing one trusted
    # BiDi key sequence in the owner frame is critical: per-cell ``clear=True``
    # can erase a preceding cell after Apple has advanced focus.
    try:
        current_fields = refresh_otp_target(page, expected_count=expected_count)
        pristine_fields = require_pristine_six_cell_target(
            page,
            expected_count=expected_count,
            reference_fields=current_fields,
        )
        scope, first_field = pristine_fields[0]
        if any(candidate_scope is not scope for candidate_scope, _field in pristine_fields):
            raise RuntimeError("2FA code input must resolve to six targets in one trusted Apple frame")
        for _candidate_scope, field in pristine_fields:
            require_otp_bidi_input_target(scope, field, "2FA digit")

        def require_pristine_before_clear() -> None:
            require_pristine_six_cell_target(
                page,
                expected_count=expected_count,
                reference_fields=pristine_fields,
            )

        # Keep all input actions in the discovered owner frame. The page root
        # cannot safely dispatch keyboard actions into a cross-origin iframe.
        input_otp_sequence_in_owner_context(
            scope,
            first_field,
            digits,
            keys,
            pause=pause,
            before_clear=require_pristine_before_clear,
        )
    except Exception as error:
        if str(error) != FOCUS_NOT_CONFIRMED_REASON:
            emit_input_progress("2FA code", "input_unconfirmed", "owner")
            raise RuntimeError(TWO_FACTOR_INPUT_UNCONFIRMED_REASON) from error
        # Firefox can accept an owner-frame pointer action while Apple's
        # hsa2-sk7 control does not expose document.activeElement yet. The
        # target is already exact and trusted, so defer to the narrower
        # element-owned BiDi route below. It only runs if all six live cells
        # remain empty, and never replays a partially entered code.
        emit_input_progress("2FA code", "sequence_focus_unconfirmed", "owner")

    # The visible Apple widget is six separate inputs inside
    # iframe#aid-auth-widget-iFrame. Only if the first BiDi sequence left all
    # six controls empty do we switch to exact element-owned BiDi input.
    pause(160, 360)
    completed_fields = fill_empty_six_cell_otp_with_element_bidi(
        page,
        digits,
        expected_count=expected_count,
        pristine_fields=pristine_fields,
        pause=pause,
    )

    try:
        if completed_fields is None:
            completed_fields = wait_for_otp_entry_confirmation(
                page,
                expected_count=expected_count,
            )
    except Exception as error:
        emit_input_progress("2FA code", "input_unconfirmed", "owner")
        raise RuntimeError(TWO_FACTOR_INPUT_UNCONFIRMED_REASON) from error
    if completed_fields is None:
        emit_input_progress("2FA code", "sequence_auto_submitted", "owner")
        return None
    if not otp_fields_have_expected_value_length(completed_fields, 1):
        emit_input_progress("2FA code", "input_unconfirmed", "owner")
        raise RuntimeError(TWO_FACTOR_INPUT_UNCONFIRMED_REASON)
    emit_input_progress("2FA code", "aggregate_confirmed", "owner")
    return completed_fields


def button_has_prompt_semantics(button: Any, prompt_kind: str) -> bool:
    if prompt_kind not in ("trust", "twofa"):
        return False
    script = r"""
    function() {
      const expectedPrompt = '__PROMPT_KIND__';
      const container = this.closest([
        'form', '[role="dialog"]', '[aria-modal="true"]', 'fieldset',
        '.si-container', '.signin-container', '.auth-content',
        '.security-code-input', '.form-security-code-inputs', 'hsa2-sk7'
      ].join(', '));
      if (!container) return false;
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = el.ownerDocument?.defaultView?.getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 &&
          style?.display !== 'none' && style?.visibility !== 'hidden';
      };
      const isEditableTextInput = (el) => {
        if (el.tagName !== 'INPUT') return true;
        return ['text', 'search', 'tel', 'url', 'email', 'password', 'number']
          .includes(String(el.type || 'text').toLowerCase());
      };
      if (!visible(container)) return false;
      const text = container.innerText || '';
      if (expectedPrompt === 'trust') {
        return /trust this browser|信任此浏览器|信任此瀏覽器/i.test(text);
      }
      const otpSemantics = (el) =>
        /one[\s_-]?time|verification|security[\s_-]*code|\botp\b|passcode|\bcode\b|验证码|驗證碼|双重认证|雙重認證/i.test([
          el.getAttribute('aria-label'), el.getAttribute('aria-describedby'), el.getAttribute('aria-description'),
          el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('class'),
          el.getAttribute('autocomplete'), el.getAttribute('placeholder')
        ].filter(Boolean).join(' '));
      const targets = [...container.querySelectorAll(
        'input, [role="textbox"], [contenteditable="true"]'
      )].filter(visible).filter(isEditableTextInput);
      const semanticTargets = targets.filter(otpSemantics);
      const digitCells = targets.filter((el) =>
        (el.maxLength === 1 || el.getAttribute('maxlength') === '1') &&
        (el.tagName === 'INPUT' || otpSemantics(el))
      );
      return Boolean(
        /two-factor|verification code|security code|one-time code|双重认证|雙重認證|验证码|驗證碼/i.test(text) ||
        semanticTargets.length > 0 || digitCells.length === 6
      );
    }
    """.replace("__PROMPT_KIND__", prompt_kind)
    try:
        return button.run_js(script) is True
    except Exception:
        return False


def click_trust_browser(
    page: Any,
    pause: Callable[[int, int], None] = human_pause,
) -> bool:
    for scope, root in current_element_search_roots(page):
        try:
            state = detect_scope_login_state(scope)
            validate_apple_url(str(state.get("href") or ""))
        except Exception:
            continue
        for button in safe_elements(root, "css:button", timeout_s=0):
            if not element_is_interactable(button):
                continue
            try:
                text = str(button.text or "").strip()
            except Exception:
                continue
            if REJECT_TRUST_RE.search(text) or not TRUST_BUTTON_RE.fullmatch(text):
                continue
            if not button_has_prompt_semantics(button, "trust"):
                continue
            pause(320, 760)
            human_click(scope, button, pause=pause)
            return True
    return False


def two_factor_submit_label(element: Any) -> str:
    try:
        text = str(element.text or "").strip()
    except Exception:
        text = ""
    if text:
        return text
    for name in ("value", "aria-label", "title"):
        try:
            value = element.attr(name)
        except Exception:
            continue
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def set_two_factor_submit_outcome(
    outcome: dict[str, str] | None,
    method: str,
    failure: str | None = None,
) -> None:
    if outcome is None:
        return
    outcome.clear()
    outcome["method"] = method
    if failure is not None:
        outcome["failure"] = failure


def classify_two_factor_submit_failure(error: Exception) -> str:
    message = str(error)
    if message == FOCUS_NOT_CONFIRMED_REASON:
        return "focus_unconfirmed"
    if "trusted Apple frame chain" in message:
        return "scope_invalid"
    return "target_unavailable"


def two_factor_auto_submission_started(
    page: Any,
    fields: list[tuple[Any, Any]] | None,
    timeout_s: float,
    pause: Callable[[int, int], None] = human_pause,
) -> bool:
    """Observe a brief confirmed auto-submit window before a fallback Enter.

    ruyiPage can replace the Python wrapper for a still-visible iframe or input.
    Object identity is therefore not evidence that Apple submitted the form.
    """
    if not fields:
        return False
    deadline = time.monotonic() + max(0.0, timeout_s)
    while True:
        try:
            state = detect_login_state(page)
        except Exception:
            # A transient state probe must not suppress the only submit action.
            # submit_two_factor_with_enter() will independently revalidate focus.
            return False
        if (
            state.get("trusted")
            or state.get("error")
            or state.get("otpRejected")
            or state.get("blocked")
            or not state.get("twofa")
        ):
            return True
        if time.monotonic() >= deadline:
            return False
        pause(90, 180)


def submit_two_factor_with_enter(
    page: Any,
    fields: list[tuple[Any, Any]] | None,
    keys: Any | None,
    pause: Callable[[int, int], None] = human_pause,
    outcome: dict[str, str] | None = None,
) -> bool:
    """Submit a visible Apple OTP widget without inventing a click target."""
    if keys is None or not fields or len(fields) not in (1, 6):
        set_two_factor_submit_outcome(outcome, "none", "target_missing")
        return False
    try:
        refreshed_fields = security_code_fields(page)
    except Exception:
        refreshed_fields = []
    if len(refreshed_fields) == len(fields):
        # Use a current ruyiPage context if Firefox re-wrapped the iframe while
        # Apple was deciding whether to auto-submit the sixth digit.
        fields = refreshed_fields
    scope, field = fields[-1]
    if any(candidate_scope is not scope for candidate_scope, _field in fields):
        set_two_factor_submit_outcome(outcome, "none", "scope_invalid")
        return False
    try:
        validate_two_factor_scope(scope)
        action_scope = focus_keyboard_target(
            page,
            scope,
            field,
            pause=pause,
            two_factor_scope=True,
        )
        pause(180, 420)
        # Focus can move while the humanized pause runs. Verify the exact
        # owner-frame target immediately before dispatching Enter.
        validate_two_factor_scope(scope)
        require_keyboard_target_ready(field)
        action_scope.actions.press(keys.ENTER).perform()
        validate_two_factor_scope(scope)
    except Exception as error:
        set_two_factor_submit_outcome(
            outcome,
            "none",
            classify_two_factor_submit_failure(error),
        )
        return False
    set_two_factor_submit_outcome(outcome, "enter")
    return True


def click_two_factor_submit(
    page: Any,
    pause: Callable[[int, int], None] = human_pause,
    *,
    keys: Any | None = None,
    fields: list[tuple[Any, Any]] | None = None,
    submit_outcome: dict[str, str] | None = None,
    auto_submit_wait_s: float = 0.6,
) -> bool:
    set_two_factor_submit_outcome(submit_outcome, "none", "target_missing")
    for scope, root in current_element_search_roots(page):
        try:
            state = detect_scope_login_state(scope)
        except Exception:
            continue
        if not is_trusted_two_factor_scope(scope, str(state.get("href") or "")):
            continue
        for selector in TWO_FACTOR_SUBMIT_SELECTORS:
            for button in safe_elements(root, selector, timeout_s=0):
                if not element_is_interactable(button):
                    continue
                text = two_factor_submit_label(button)
                if REJECT_TRUST_RE.search(text) or not TWO_FACTOR_SUBMIT_RE.fullmatch(text):
                    continue
                if not button_has_prompt_semantics(button, "twofa"):
                    continue
                pause(280, 680)
                human_click(scope, button, pause=pause)
                set_two_factor_submit_outcome(submit_outcome, "button")
                return True
    if two_factor_auto_submission_started(
        page,
        fields,
        auto_submit_wait_s,
        pause=pause,
    ):
        set_two_factor_submit_outcome(submit_outcome, "automatic")
        return True
    return submit_two_factor_with_enter(
        page,
        fields,
        keys,
        pause=pause,
        outcome=submit_outcome,
    )


def detect_scope_login_state(scope: Any) -> dict[str, Any]:
    raw = scope.run_js(
        r"""
        return JSON.stringify((() => {
          const body = document.body?.innerText || '';
          const visible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 2 && r.height > 2 && s.display !== 'none' &&
              s.visibility !== 'hidden' && !el.disabled &&
              el.getAttribute('aria-disabled') !== 'true';
          };
          const isEditableTextInput = (el) => {
            if (el.tagName !== 'INPUT') return true;
            return ['text', 'search', 'tel', 'url', 'email', 'password', 'number']
              .includes(String(el.type || 'text').toLowerCase());
          };
          const inputs = [...document.querySelectorAll('input')].filter(visible);
          const otpInputs = inputs.filter(isEditableTextInput);
          const textTargets = [...document.querySelectorAll('[role="textbox"], [contenteditable="true"]')]
            .filter(visible)
            .filter(isEditableTextInput);
          const otpSemantics = (el) =>
            /one[\s_-]?time|verification|security[\s_-]*code|\botp\b|passcode|\bcode\b|验证码|驗證碼|双重认证|雙重認證/i.test([
              el.getAttribute('aria-label'), el.getAttribute('aria-describedby'), el.getAttribute('aria-description'),
              el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('class'),
              el.getAttribute('autocomplete'), el.getAttribute('placeholder')
            ].filter(Boolean).join(' '));
          const semanticTargets = [...otpInputs, ...textTargets].filter(otpSemantics);
          const digitCells = [...otpInputs, ...textTargets].filter((el) =>
            (el.maxLength === 1 || el.getAttribute('maxlength') === '1') &&
            (el.tagName === 'INPUT' || otpSemantics(el))
          );
          const href = location.href;
          const password = inputs.some((el) => el.type === 'password');
          const email = inputs.some((el) => el.type === 'email' || /accountName|username/i.test(el.name || el.autocomplete || ''));
          const normalizedBody = body.replace(/\s+/g, ' ');
          const otpRejected = /__OTP_REJECTION_PATTERN__/i.test(normalizedBody);
          const blocked = /captcha|locked|account locked|被锁定|被鎖定|账户锁定|帳戶鎖定/i.test(body);
          const error = otpRejected || blocked ||
            /\berror\b|something went wrong|incorrect|invalid|expired|wrong password|try again|unable to sign in|无法登录|無法登入|错误|錯誤|不正确|不正確|无效|無效/i.test(body);
          const strongTwoFactorText = /two-factor|verification code|security code|one-time code|双重认证|雙重認證|验证码|驗證碼/i.test(body);
          const trustPrompt = /trust this browser|信任此浏览器|信任此瀏覽器/i.test(body);
          const accountMarker =
            /personal information|个人信息|個人資料|sign out|退出|account security|账户安全|帳戶安全/i.test(body);
          return {
            href,
            hasStrongTwoFactorText: strongTwoFactorText,
            semanticTargetCount: semanticTargets.length,
            digitCellCount: digitCells.length,
            trustPrompt,
            error,
            otpRejected,
            blocked,
            accountManage: /account\.apple\.com\/account\/manage/i.test(href),
            accountMarker,
            password,
            email,
            codeInputCount: new Set([
              ...semanticTargets,
              ...(digitCells.length === 6 ? digitCells : [])
            ]).size
          };
        })())
        """.replace("__OTP_REJECTION_PATTERN__", OTP_REJECTION_JS_PATTERN)
    )
    state = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(state, dict):
        raise RuntimeError("ruyiPage returned an invalid login-state result")

    state["twofa"] = classify_strong_two_factor(
        has_strong_text=state.get("hasStrongTwoFactorText") is True,
        semantic_target_count=int(state.get("semanticTargetCount") or 0),
        digit_cell_count=int(state.get("digitCellCount") or 0),
    )
    if "accountManage" in state:
        state["trusted"] = bool(
            state.get("accountManage")
            and state.get("accountMarker")
            and not state.get("password")
            and not state.get("email")
            and not state["twofa"]
        )
    return state


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


def scope_location_url(scope: Any) -> str:
    try:
        return str(scope.run_js("return location.href") or "").strip()
    except Exception:
        return ""


def is_opaque_two_factor_frame_url(url: str) -> bool:
    normalized = str(url or "").strip().lower()
    normalized = normalized.split("#", 1)[0].split("?", 1)[0]
    return normalized in OPAQUE_TWO_FACTOR_FRAME_URLS


def trusted_two_factor_scope_url(
    scope: Any,
    initial_url: str | None = None,
) -> str | None:
    """Return the Apple root only for an Apple-rooted opaque 2FA frame chain."""
    current = scope
    seen: set[int] = set()
    use_initial_url = initial_url is not None
    while current is not None:
        identity = id(current)
        if identity in seen:
            return None
        seen.add(identity)
        current_href = scope_location_url(current)
        if use_initial_url:
            if current_href != str(initial_url or "").strip():
                return None
            use_initial_url = False
        href = current_href
        validated = parse_valid_apple_url(href)
        if validated is None and not is_opaque_two_factor_frame_url(href):
            return None
        parent = getattr(current, "parent", None)
        # An opaque top-level document never establishes an Apple trust anchor.
        # Only descendants of a verified Apple HTTPS top-level context may use
        # the narrow 2FA-only opaque-frame allowance.
        if parent is None:
            return validated.geturl() if validated is not None else None
        current = parent
    return None


def is_trusted_two_factor_scope(scope: Any, initial_url: str | None = None) -> bool:
    return trusted_two_factor_scope_url(scope, initial_url) is not None


def validate_two_factor_scope(scope: Any) -> str:
    trusted_url = trusted_two_factor_scope_url(scope)
    if trusted_url is None:
        raise RuntimeError("2FA target must stay within a trusted Apple frame chain")
    return trusted_url


def is_account_manage_url(url: str) -> bool:
    parsed = parse_valid_apple_url(url)
    if parsed is None:
        return False
    host = (parsed.hostname or "").lower()
    return host == "account.apple.com" and (
        parsed.path == "/account/manage" or parsed.path.startswith("/account/manage/")
    )


def confirmed_account_manage_state(page: Any) -> dict[str, Any] | None:
    """Accept the account root redirect only when no live auth UI contradicts it."""
    if not browser_connection_is_alive(page):
        return None
    current_url = scope_location_url(page)
    if not is_account_manage_url(current_url):
        return None

    # The URL can change before account-page text has hydrated, so do not
    # require an account marker here.  We do still query the root and every
    # live trusted child context for explicit authentication UI or errors.
    # Retired/unreadable child frames are intentionally ignored: they are a
    # normal part of Apple's post-OTP iframe teardown.
    blockers = (
        "twofa",
        "trustPrompt",
        "error",
        "otpRejected",
        "blocked",
        "password",
        "email",
    )
    root_state: dict[str, Any] | None = None
    for scope in iter_page_scopes(page):
        try:
            state = detect_scope_login_state(scope)
        except Exception:
            if scope is page:
                return None
            continue
        if scope is page:
            root_state = state
            if not is_account_manage_url(str(state.get("href") or "")):
                return None
            if any(bool(state.get(key)) for key in blockers):
                return None
        else:
            if not is_trusted_two_factor_scope(scope, str(state.get("href") or "")):
                continue
            if not scope_has_live_frame_chain(page, scope):
                continue
            if any(bool(state.get(key)) for key in blockers):
                return None

        if not is_trusted_two_factor_scope(scope, str(state.get("href") or "")):
            continue
        try:
            shadow_roots = scope.shadow_roots(mode="all", include_frames=False)
        except Exception:
            shadow_roots = []
        for root in list(shadow_roots or []):
            shadow_state = detect_shadow_root_state(root)
            if any(bool(shadow_state.get(key)) for key in blockers):
                return None

    if root_state is None:
        return None
    return {
        **root_state,
        "href": current_url,
        "accountManage": True,
        "rootSessionTrusted": True,
        "rootError": False,
        "trusted": True,
    }


def detect_login_state(page: Any) -> dict[str, Any]:
    scope_states: list[tuple[Any, dict[str, Any]]] = []
    for scope in iter_page_scopes(page):
        try:
            state = detect_scope_login_state(scope)
        except Exception:
            continue
        if isinstance(state, dict):
            if is_trusted_two_factor_scope(scope, str(state.get("href") or "")):
                try:
                    shadow_roots = scope.shadow_roots(
                        mode="all",
                        include_frames=False,
                    )
                except Exception:
                    shadow_roots = []
                for root in list(shadow_roots or []):
                    shadow_state = detect_shadow_root_state(root)
                    for key in (
                        "twofa",
                        "trustPrompt",
                        "otpRejected",
                        "blocked",
                        "error",
                    ):
                        if shadow_state.get(key):
                            state = {**state, key: True}
            scope_states.append((scope, state))

    if not scope_states:
        raise RuntimeError("unable to inspect login page state through ruyiPage")

    root_scope, root_state = scope_states[0]
    root_href = str(root_state.get("href") or "")
    root_is_account_manage = root_scope is page and is_account_manage_url(root_href)
    apple_states = [
        state
        for _scope, state in scope_states
        if is_apple_url(str(state.get("href") or ""))
    ]
    two_factor_states = [
        state
        for scope, state in scope_states
        if is_trusted_two_factor_scope(scope, str(state.get("href") or ""))
    ]
    has_apple_account_marker = any(
        is_apple_url(str(state.get("href") or ""))
        and bool(state.get("trusted") or state.get("accountMarker"))
        for _scope, state in scope_states
    )
    has_auth_ui = any(
        bool(state.get(key))
        for state in apple_states
        for key in ("email", "password", "trustPrompt")
    ) or any(bool(state.get("twofa")) for state in two_factor_states)
    root_has_auth_ui = any(
        bool(root_state.get(key))
        for key in ("email", "password", "trustPrompt", "twofa")
    )
    root_error = any(
        bool(root_state.get(key)) for key in ("error", "otpRejected", "blocked")
    )
    has_descendant_login_or_trust_ui = any(
        is_trusted_two_factor_scope(scope, str(state.get("href") or ""))
        and bool(state.get(key))
        and scope_has_live_frame_chain(page, scope)
        for scope, state in scope_states
        if scope is not page
        for key in ("email", "password", "trustPrompt")
    )
    has_live_descendant_two_factor_ui = any(
        is_trusted_two_factor_scope(scope, str(state.get("href") or ""))
        and bool(state.get("twofa"))
        and scope_has_live_frame_chain(page, scope)
        for scope, state in scope_states
        if scope is not page
    )
    has_live_descendant_error = any(
        is_trusted_two_factor_scope(scope, str(state.get("href") or ""))
        and any(bool(state.get(key)) for key in ("error", "otpRejected", "blocked"))
        and scope_has_live_frame_chain(page, scope)
        for scope, state in scope_states
        if scope is not page
    )
    # After OTP submission, the top-level account shell is authoritative.
    # Retiring idmsa frames can retain a verification widget or generic error
    # text. A frame still mapped to a visible iframe host remains active and
    # continues to block session success, as do login and Trust UI.
    root_session_trusted = bool(
        root_is_account_manage
        and root_state.get("accountMarker")
        and not root_has_auth_ui
        and not root_error
        and not has_descendant_login_or_trust_ui
        and not has_live_descendant_two_factor_ui
        and not has_live_descendant_error
    )
    legacy_session_trusted = bool(
        not has_auth_ui
        and root_is_account_manage
        and has_apple_account_marker
        and not root_error
        and not has_descendant_login_or_trust_ui
        and not has_live_descendant_two_factor_ui
        and not has_live_descendant_error
    )
    twofa_visible = any(bool(state.get("twofa")) for state in two_factor_states)
    code_input_count = max(
        (int(state.get("codeInputCount") or 0) for state in two_factor_states),
        default=0,
    )
    return {
        "href": root_href or next(
            (state.get("href") for _scope, state in scope_states if state.get("href")),
            "",
        ),
        "twofa": twofa_visible,
        "twofaVisible": twofa_visible,
        "inputReady": False,
        "trustPrompt": any(bool(state.get("trustPrompt")) for state in two_factor_states),
        "error": any(bool(state.get("error")) for state in two_factor_states),
        "otpRejected": any(bool(state.get("otpRejected")) for state in two_factor_states),
        "blocked": any(bool(state.get("blocked")) for state in two_factor_states),
        "trusted": (
            root_session_trusted
            or legacy_session_trusted
        ),
        "rootError": root_error,
        "rootSessionTrusted": root_session_trusted,
        "password": any(bool(state.get("password")) for state in apple_states),
        "email": any(bool(state.get("email")) for state in apple_states),
        "codeInputCount": code_input_count,
    }


def has_confirmed_account_session(state: dict[str, Any]) -> bool:
    """Accept root-session evidence without letting retired 2FA frames win."""
    return bool(
        state.get("rootSessionTrusted")
        or (state.get("trusted") and not state.get("rootError"))
    )


def settle_trust_state(
    page: Any,
    state: dict[str, Any],
    *,
    deadline: float,
    pause: Callable[[int, int], None] | None = None,
    hydration_timeout_s: float = 5.0,
) -> dict[str, Any]:
    if pause is None:
        pause = human_pause
    hydration_deadline = min(deadline, time.monotonic() + hydration_timeout_s)
    scanned_current_state = False
    while True:
        if state.get("error"):
            return state
        if scanned_current_state and time.monotonic() >= hydration_deadline:
            if state.get("trustPrompt"):
                raise RuntimeError(
                    "trust-browser prompt detected but no matching button was found"
                )
            raise RuntimeError("trust-browser state did not settle before deadline")
        if click_trust_browser(page, pause=pause):
            pause(700, 1400)
            state = detect_login_state(page)
            scanned_current_state = True
            continue
        scanned_current_state = True
        if not state.get("trustPrompt"):
            return state
        if time.monotonic() >= hydration_deadline:
            raise RuntimeError(
                "trust-browser prompt detected but no matching button was found"
            )
        pause(120, 260)
        state = detect_login_state(page)


def otp_retry_allowed(state: dict[str, Any], generation: int | None) -> bool:
    return bool(
        generation == 1
        and is_apple_url(str(state.get("href") or ""))
        and state.get("twofa")
        and state.get("otpRejected")
        and not state.get("blocked")
    )


def wait_for_2fa_or_session(page: Any, timeout_s: int = 75) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + timeout_s
    last_state: dict[str, Any] = {}
    while time.monotonic() < deadline:
        try:
            last_state = detect_login_state(page)
            last_state = settle_trust_state(page, last_state, deadline=deadline)
        except RuntimeError as error:
            if str(error) != "unable to inspect login page state through ruyiPage":
                raise
            human_pause(500, 1000)
            continue
        elapsed_ms = min(
            max(0, int((time.monotonic() - started) * 1000)),
            max(0, int(timeout_s * 1000)),
        )
        if has_confirmed_account_session(last_state):
            last_state["trusted"] = True
            last_state["elapsedMs"] = elapsed_ms
            return last_state
        if last_state.get("error"):
            raise RuntimeError("login stopped before 2FA")
        if last_state.get("twofa"):
            fields = security_code_fields(page)
            if fields:
                last_state["twofaVisible"] = True
                last_state["inputReady"] = True
                last_state["elapsedMs"] = elapsed_ms
                last_state["codeInputCount"] = len(fields)
                return last_state
            # The native code popup can appear before Apple hydrates the
            # hsa2-sk7 fields.  Start popup-first collection now; the browser
            # handoff will use wait_for_otp_target() after it receives a code.
            last_state["twofaVisible"] = True
            last_state["inputReady"] = False
            last_state["elapsedMs"] = elapsed_ms
            last_state["codeInputCount"] = 0
            return last_state
        fields = security_code_fields(page)
        if fields:
            last_state["twofa"] = True
            last_state["twofaVisible"] = True
            last_state["inputReady"] = True
            last_state["codeInputCount"] = len(fields)
            last_state["elapsedMs"] = elapsed_ms
            return last_state
        human_pause(500, 1000)
    raise RuntimeError("2FA code page did not appear")


def wait_for_signed_in(
    page: Any,
    timeout_s: int = 90,
    submitted: bool = False,
    otp_generation: int | None = None,
    submission_method: str | None = None,
) -> dict[str, Any]:
    if otp_generation is not None:
        validate_otp_generation(otp_generation)
    deadline = time.monotonic() + timeout_s
    submission_transition_deadline = (
        min(deadline, time.monotonic() + TWO_FACTOR_SUBMIT_TRANSITION_TIMEOUT_S)
        if submitted and submission_method in {"button", "enter", "automatic"}
        else None
    )
    last_state: dict[str, Any] = {}
    allow_post_otp_clicks = not (
        submitted and submission_method == "automatic"
    )
    while time.monotonic() < deadline:
        direct_session_state = confirmed_account_manage_state(page)
        if direct_session_state is not None:
            return direct_session_state
        try:
            last_state = detect_login_state(page)
            if allow_post_otp_clicks:
                last_state = settle_trust_state(page, last_state, deadline=deadline)
        except RuntimeError as error:
            if str(error) != "unable to inspect login page state through ruyiPage":
                raise
            # Firefox can retire the old frame before ruyiPage exposes the
            # replacement. A single unreadable poll after OTP submission is
            # not evidence that the browser flow failed.
            if (
                submission_transition_deadline is not None
                and time.monotonic() >= submission_transition_deadline
            ):
                raise RuntimeError("2FA submit state could not be confirmed") from error
            human_pause(350, 700)
            continue
        if otp_generation is not None and not is_apple_url(
            str(last_state.get("href") or "")
        ):
            raise RuntimeError("2FA state left the verified Apple HTTPS origin")
        if has_confirmed_account_session(last_state):
            # A retiring idmsa frame can still expose generic error text after
            # the top-level account shell has already established the session.
            # A root-page error remains terminal; only retired child-frame
            # evidence is allowed to lose to a confirmed root session.
            last_state["trusted"] = True
            return last_state
        if last_state.get("error"):
            if otp_retry_allowed(last_state, otp_generation):
                return {**last_state, "retry2FA": True}
            raise RuntimeError("2FA/login failed")
        if (
            last_state.get("twofa")
            and submission_transition_deadline is not None
            and time.monotonic() >= submission_transition_deadline
        ):
            raise RuntimeError("2FA submit did not transition")
        if last_state.get("twofa") and not submitted:
            submitted = click_two_factor_submit(page)
            if submitted:
                submission_transition_deadline = min(
                    deadline,
                    time.monotonic() + TWO_FACTOR_SUBMIT_TRANSITION_TIMEOUT_S,
                )
        human_pause(600, 1100)
    raise RuntimeError("account session was not confirmed after 2FA")


def is_personal_information_scope(page: Any, scope: Any) -> bool:
    if scope is not page or getattr(scope, "parent", None) is not None:
        return False
    parsed = parse_valid_apple_url(scope_location_url(scope))
    return bool(
        parsed is not None
        and (parsed.hostname or "").lower() == "account.apple.com"
        and parsed.path == PERSONAL_INFORMATION_PATH
    )


def parse_profile_query_result(raw: Any, label: str) -> dict[str, Any]:
    value = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(value, dict):
        raise RuntimeError(f"personal information {label} query returned an invalid result")
    return value


def profile_card_summary(card: Any) -> dict[str, Any]:
    raw = card.run_js(
        r"""
        function () {
          // ruyipage-profile-card-summary
          const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 2 && rect.height > 2 &&
              style.display !== 'none' && style.visibility !== 'hidden' &&
              element.getAttribute('aria-hidden') !== 'true';
          };
          const normalize = (value) => String(value || '')
            .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
          const lines = String(this.innerText || this.textContent || '')
            .split(/\n+/).map((line) => line.trim()).filter(Boolean);
          const labels = {
            name: ['full name', 'name', '姓名', '全名'],
            birthday: ['date of birth', 'birthday', '出生日期', '生日']
          };
          const labelIndex = (kind) => lines.findIndex((line) => {
            const normalized = normalize(line);
            return labels[kind].some((label) =>
              normalized === normalize(label) ||
              normalized.startsWith(`${normalize(label)} `));
          });
          const birthdayIndex = labelIndex('birthday');
          const birthdayLabel = birthdayIndex >= 0 ? lines[birthdayIndex] : '';
          const birthdayLabelNormalized = normalize(birthdayLabel);
          const birthdayValue = (() => {
            if (birthdayIndex < 0) return null;
            for (const label of labels.birthday) {
              const normalizedLabel = normalize(label);
              if (birthdayLabelNormalized.startsWith(normalizedLabel)) {
                const tail = birthdayLabel.slice(label.length).trim();
                if (tail) return tail;
              }
            }
            const next = lines[birthdayIndex + 1] || '';
            if (next) return next;
            return lines.find((line) =>
              /(?:\d{4}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}|\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2,4}|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b)/i.test(line)
            ) || null;
          })();
          return JSON.stringify({
            visible: visible(this),
            name: labelIndex('name') >= 0,
            birthday: birthdayIndex >= 0,
            birthdayValue
          });
        }
        """
    )
    result = parse_profile_query_result(raw, "card")
    return {
        "visible": result.get("visible") is True,
        "name": result.get("name") is True,
        "birthday": result.get("birthday") is True,
        "birthdayValue": result.get("birthdayValue"),
    }


def normalize_profile_value(value: Any, field: str) -> str:
    if field not in PROFILE_VALUE_MAX_LENGTHS or not isinstance(value, str):
        raise RuntimeError(f"personal information {field} is invalid")
    if any(character in value for character in ("\r", "\n", "\0")):
        raise RuntimeError(f"personal information {field} is invalid")
    normalized = " ".join(value.split())
    if not normalized or len(normalized) > PROFILE_VALUE_MAX_LENGTHS[field]:
        raise RuntimeError(f"personal information {field} is invalid")
    return normalized


def profile_value_is_ready(value: Any, field: str) -> bool:
    try:
        normalize_profile_value(value, field)
    except RuntimeError:
        return False
    return True


def profile_card_candidates(page: Any, kind: str) -> list[tuple[Any, Any, dict[str, Any]]]:
    if kind not in {"name", "birthday"}:
        raise RuntimeError("personal information card kind is invalid")
    selectors = PROFILE_NAME_CARD_SELECTORS if kind == "name" else PROFILE_CARD_SELECTORS
    candidates: list[tuple[Any, Any, dict[str, Any]]] = []
    seen: dict[tuple[Any, ...], str] = {}
    for selector in selectors:
        for card in safe_elements(page, selector):
            if not element_is_interactable(card):
                continue
            try:
                summary = profile_card_summary(card)
            except Exception:
                continue
            identity = (
                element_stability_signature(page, card),
                summary["name"],
                summary["birthday"],
                normalize_profile_value(summary.get("birthdayValue"), "birthday")
                if profile_value_is_ready(summary.get("birthdayValue"), "birthday")
                else "",
            )
            previous_selector = seen.get(identity)
            if previous_selector is not None and previous_selector != selector:
                continue
            seen.setdefault(identity, selector)
            if summary["visible"] and summary[kind] is True:
                candidates.append((page, card, summary))
    return candidates


def resolve_profile_card(page: Any, kind: str) -> tuple[Any, Any, dict[str, Any]] | None:
    if not is_personal_information_scope(page, page):
        return None
    candidates = profile_card_candidates(page, kind)
    if not candidates:
        return None
    if kind == "birthday":
        candidates = [
            candidate
            for candidate in candidates
            if profile_value_is_ready(candidate[2].get("birthdayValue"), "birthday")
        ]
        if not candidates:
            return None
        values = {
            normalize_profile_value(summary.get("birthdayValue"), "birthday")
            for _scope, _card, summary in candidates
        }
        if len(values) == 1:
            return candidates[0]
        if len(values) > 1:
            raise RuntimeError("personal information birthday card is ambiguous")
    if len(candidates) != 1:
        raise RuntimeError(f"personal information {kind} card is ambiguous")
    return candidates[0]


def wait_for_profile_card(
    page: Any,
    kind: str,
    timeout_s: float = PROFILE_CARD_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] | None = None,
) -> tuple[Any, Any, dict[str, Any]]:
    if pause is None:
        pause = human_pause
    if not is_personal_information_scope(page, page):
        raise RuntimeError(f"personal information {kind} card was not found")
    deadline = time.monotonic() + timeout_s
    previous_signature: tuple[Any, ...] | None = None
    stable_observations = 0
    while time.monotonic() < deadline:
        resolved = resolve_profile_card(page, kind)
        if resolved is not None:
            _scope, card, summary = resolved
            signature = (
                element_stability_signature(_scope, card),
                normalize_profile_value(summary.get("birthdayValue"), "birthday")
                if kind == "birthday"
                else "name-card",
            )
            stable_observations = (
                stable_observations + 1 if signature == previous_signature else 1
            )
            previous_signature = signature
            if stable_observations >= PROFILE_VALUE_STABLE_OBSERVATIONS:
                return resolved
        else:
            previous_signature = None
            stable_observations = 0
        pause(180, 420)
    raise RuntimeError(f"personal information {kind} card was not found")


def profile_name_modal_summary(modal: Any) -> dict[str, Any]:
    raw = modal.run_js(
        r"""
        function () {
          // ruyipage-profile-name-modal
          const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 2 && rect.height > 2 &&
              style.display !== 'none' && style.visibility !== 'hidden' &&
              element.getAttribute('aria-hidden') !== 'true';
          };
          const labelText = (field) => {
            const labels = Array.from(field.labels || []).map((label) => label.innerText || label.textContent || '');
            const closest = field.closest('label')?.innerText || '';
            return [
              field.getAttribute('autocomplete'), field.getAttribute('name'), field.getAttribute('id'),
              field.getAttribute('aria-label'), field.getAttribute('placeholder'), closest, ...labels
            ].filter(Boolean).join(' ');
          };
          const fields = Array.from(this.querySelectorAll('input')).filter((field) =>
            visible(field) && !field.disabled && !field.readOnly &&
            ['text', 'search'].includes(String(field.type || 'text').toLowerCase())
          );
          const classify = (field) => {
            const meta = normalize(labelText(field));
            if (/middle-name|middlename|additional-name|additionalname|\u4e2d\u95f4\u540d|\u4e2d\u9593\u540d/.test(meta)) return 'middle';
            if (/family-name|familyname|surname|last-name|lastname|姓氏|姓/.test(meta)) return 'family';
            if (/given-name|givenname|first-name|firstname|名字|名/.test(meta)) return 'given';
            return null;
          };
          let given = null;
          let family = null;
          for (const field of fields) {
            const value = String(field.value || '').trim();
            if (!value) continue;
            const kind = classify(field);
            if (kind === 'given' && given === null) given = value;
            if (kind === 'family' && family === null) family = value;
          }
          return JSON.stringify({
            visible: visible(this),
            fieldCount: fields.length,
            given,
            family
          });
        }
        """
    )
    result = parse_profile_query_result(raw, "name modal")
    return {
        "visible": result.get("visible") is True,
        "fieldCount": int(result.get("fieldCount") or 0),
        "given": result.get("given"),
        "family": result.get("family"),
    }


def resolve_profile_name_modal(page: Any) -> tuple[Any, Any, dict[str, Any]] | None:
    if not is_personal_information_scope(page, page):
        return None
    for selector in PROFILE_NAME_MODAL_SELECTORS:
        visible_candidates: list[tuple[Any, Any, dict[str, Any]]] = []
        candidates: list[tuple[Any, Any, dict[str, Any]]] = []
        seen: dict[tuple[str, tuple[str, ...]], str] = {}
        for modal in safe_elements(page, selector):
            if not element_is_interactable(modal):
                continue
            try:
                summary = profile_name_modal_summary(modal)
            except Exception:
                continue
            identity = element_stability_signature(page, modal)
            previous_selector = seen.get(identity)
            if previous_selector is not None and previous_selector != selector:
                continue
            seen.setdefault(identity, selector)
            if not (summary["visible"] and summary["fieldCount"] >= 2):
                continue
            visible_candidates.append((page, modal, summary))
            if profile_value_is_ready(summary.get("given"), "name") and profile_value_is_ready(
                summary.get("family"), "name"
            ):
                candidates.append((page, modal, summary))
        if visible_candidates:
            if len(visible_candidates) != 1:
                raise RuntimeError("personal information name modal is ambiguous")
            return candidates[0] if candidates else None
    return None


def wait_for_profile_name_modal(
    page: Any,
    timeout_s: float = PROFILE_MODAL_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] | None = None,
) -> tuple[Any, Any, dict[str, Any]]:
    if pause is None:
        pause = human_pause
    deadline = time.monotonic() + timeout_s
    previous_signature: tuple[Any, ...] | None = None
    stable_observations = 0
    while time.monotonic() < deadline:
        resolved = resolve_profile_name_modal(page)
        if resolved is not None:
            _scope, modal, summary = resolved
            signature = (
                element_stability_signature(_scope, modal),
                normalize_profile_value(summary.get("given"), "name"),
                normalize_profile_value(summary.get("family"), "name"),
            )
            stable_observations = (
                stable_observations + 1 if signature == previous_signature else 1
            )
            previous_signature = signature
            if stable_observations >= PROFILE_VALUE_STABLE_OBSERVATIONS:
                return resolved
        else:
            previous_signature = None
            stable_observations = 0
        pause(180, 420)
    raise RuntimeError("personal information name modal was not found")


def wait_for_profile_capture_ready(page: Any) -> None:
    wait_for_profile_card(page, "birthday")
    wait_for_profile_card(page, "name")


def collect_personal_info(page: Any) -> dict[str, Any]:
    _birthday_scope, _birthday_card, birthday_summary = wait_for_profile_card(
        page,
        "birthday",
    )
    birthday = normalize_profile_value(birthday_summary.get("birthdayValue"), "birthday")
    emit({"event": "status", "status": "profile_birthday_collected"})

    name_scope, name_card, _name_summary = wait_for_profile_card(page, "name")
    set_browser_startup_stage("profile_name")
    human_pause(280, 620)
    human_click(name_scope, name_card)
    _modal_scope, _modal, modal_summary = wait_for_profile_name_modal(page)
    given = normalize_profile_value(modal_summary.get("given"), "name")
    family = normalize_profile_value(modal_summary.get("family"), "name")
    name = normalize_profile_value(f"{given} {family}", "name")
    emit({"event": "status", "status": "profile_name_collected"})
    return {"name": name, "birthday": birthday}


def validate_personal_info_result(
    login_state: dict[str, Any],
    personal_info: dict[str, Any],
) -> None:
    if not login_state.get("trusted"):
        raise RuntimeError("personal information page did not confirm an authenticated Apple session")
    if not (personal_info.get("name") and personal_info.get("birthday")):
        raise RuntimeError("personal information page loaded but name and birthday were not parsed")


def take_screenshot(page: Any, path: Path) -> str | None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if hasattr(path.parent, "chmod"):
            path.parent.chmod(0o700)
        page.screenshot(str(path), full_page=True)
        if hasattr(path, "chmod"):
            path.chmod(0o600)
        return str(path)
    except Exception:
        emit({"event": "warning", "message": SCREENSHOT_FAILURE_REASON})
        return None


def protocol_self_test() -> int:
    emit({"event": "ready", "mode": "protocol-self-test"})
    emit({"event": "result", "success": True, "personalInfo": {}, "screenshots": {}})
    return 0


def node_self_test() -> int:
    emit({"event": "ready", "mode": "node-self-test"})
    request_two_factor_preparation()
    emit({"event": "need_2fa", "generation": 1})
    code = validate_two_factor_code_command(read_command(), 1)
    emit_two_factor_progress("code_received", generation=1)
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
            "personalInfo": {"name": None, "birthday": None, "selfTest": True},
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


def browser_broker_mode_enabled() -> bool:
    return os.environ.get(BROWSER_BROKER_MODE_ENV) == "1"


def read_browser_broker_credentials(
    input_stream: TextIO | None = None,
) -> tuple[str, str]:
    stream = input_stream if input_stream is not None else sys.stdin
    try:
        line = stream.readline(BROKER_CREDENTIAL_FRAME_MAX_CHARS + 1)
    except (OSError, TypeError, UnicodeError, ValueError):
        raise RuntimeError(BROWSER_BROKER_CREDENTIALS_ERROR) from None
    if (
        type(line) is not str
        or not line
        or len(line) > BROKER_CREDENTIAL_FRAME_MAX_CHARS
    ):
        raise RuntimeError(BROWSER_BROKER_CREDENTIALS_ERROR)

    def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def reject_constant(_value: str) -> Any:
        raise ValueError("non-standard JSON constant")

    try:
        frame = json.loads(
            line,
            object_pairs_hook=strict_object,
            parse_constant=reject_constant,
        )
    except (json.JSONDecodeError, TypeError, ValueError):
        raise RuntimeError(BROWSER_BROKER_CREDENTIALS_ERROR) from None

    expected_fields = {"type", "appleId", "password"}
    if type(frame) is not dict or set(frame) != expected_fields:
        raise RuntimeError(BROWSER_BROKER_CREDENTIALS_ERROR)

    apple_id = frame.get("appleId")
    password = frame.get("password")
    if (
        frame.get("type") != "credentials"
        or type(apple_id) is not str
        or type(password) is not str
        or not apple_id.strip()
        or not password.strip()
        or len(apple_id) > BROKER_APPLE_ID_MAX_LENGTH
        or len(password) > BROKER_PASSWORD_MAX_LENGTH
    ):
        raise RuntimeError(BROWSER_BROKER_CREDENTIALS_ERROR)
    return apple_id, password


def load_browser_credentials(
    input_stream: TextIO | None = None,
) -> tuple[str, str]:
    if not browser_broker_mode_enabled():
        return pop_browser_credentials()

    if os.environ.get("APPLE_ID") and os.environ.get("APPLE_PASSWORD"):
        return pop_browser_credentials()

    os.environ.pop("APPLE_ID", None)
    os.environ.pop("APPLE_PASSWORD", None)
    return read_browser_broker_credentials(input_stream)


def should_attach_existing_browser() -> bool:
    configured = os.environ.get(BROWSER_ATTACH_EXISTING_ENV, "1").strip().lower()
    return configured not in {"0", "false", "no", "off"} and not browser_broker_mode_enabled()


def valid_browser_attach_address(value: str) -> str | None:
    candidate = str(value or "").strip()
    if not candidate:
        return None
    host, separator, port = candidate.rpartition(":")
    if separator != ":" or host not in {"127.0.0.1", "localhost"}:
        return None
    try:
        numeric_port = int(port)
    except ValueError:
        return None
    return candidate if 1 <= numeric_port <= 65535 else None


def browser_attach_state_path(profile_dir: str) -> Path | None:
    normalized = str(profile_dir or "").strip()
    if not normalized or any(character in normalized for character in ("\r", "\n", "\0")):
        return None
    try:
        profile_path = Path(normalized).expanduser()
    except (TypeError, ValueError):
        return None
    profile_name = profile_path.name
    if not profile_name or profile_name in {".", ".."}:
        return None
    return profile_path.parent / f".{profile_name}{BROWSER_ATTACH_STATE_FILE_SUFFIX}"


def read_browser_attach_address(profile_dir: str) -> str | None:
    state_path = browser_attach_state_path(profile_dir)
    if state_path is None:
        return None
    try:
        if state_path.is_symlink() or not state_path.is_file():
            return None
        if state_path.stat().st_size > BROWSER_ATTACH_STATE_MAX_BYTES:
            return None
        payload = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return valid_browser_attach_address(str(payload.get("address") or ""))


def persist_browser_attach_address(page: Any, profile_dir: str) -> str | None:
    state_path = browser_attach_state_path(profile_dir)
    if state_path is None:
        return None
    try:
        address = valid_browser_attach_address(str(page.browser.address or ""))
    except Exception:
        return None
    if address is None:
        return None
    try:
        if state_path.is_symlink() or not state_path.parent.is_dir():
            return None
        state_path.write_text(
            json.dumps({"version": 1, "address": address}, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        if os.name != "nt":
            os.chmod(state_path, 0o600)
    except OSError:
        return None
    return address


def normalized_profile_path(value: str | Path) -> Path | None:
    candidate = str(value or "").strip()
    if not candidate or any(character in candidate for character in ("\r", "\n", "\0")):
        return None
    try:
        return Path(candidate).expanduser().resolve(strict=False)
    except (OSError, TypeError, ValueError):
        return None


def macos_firefox_process_ids() -> list[int] | None:
    """List Firefox process IDs without reading unrelated process command lines."""
    if sys.platform != "darwin":
        return None
    try:
        result = subprocess.run(
            ["/bin/ps", "-ax", "-o", "pid=", "-o", "comm="],
            capture_output=True,
            check=False,
            text=True,
            timeout=1,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    process_ids: list[int] = []
    for line in str(result.stdout or "").splitlines():
        parts = line.strip().split(maxsplit=1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        executable = Path(parts[1]).name.casefold()
        if executable not in {"firefox", "firefox-bin"}:
            continue
        process_ids.append(int(parts[0]))
    return process_ids


RUYIPAGE_PROFILE_OPTION_PATTERN = (
    r"(?:--headless|-private|--width=\d+|--height=\d+|--fpfile=[^\s]+)"
)


def ruyipage_profile_trailing_options_are_supported(value: str) -> bool:
    """Accept the known FirefoxOptions arguments emitted after ``--profile``."""
    return bool(
        re.fullmatch(
            rf"{RUYIPAGE_PROFILE_OPTION_PATTERN}(?:\s+{RUYIPAGE_PROFILE_OPTION_PATTERN})*",
            str(value or "").strip(),
        )
    )


def ruyipage_profile_argument_has_unknown_option(value: str) -> bool:
    """Reject only option-shaped path fragments ruyiPage cannot emit here."""
    options = re.findall(
        r"(?:^|\s)(--?[A-Za-z][A-Za-z0-9_-]*(?:=[^\s]*)?)",
        str(value or ""),
    )
    return any(
        re.fullmatch(RUYIPAGE_PROFILE_OPTION_PATTERN, option) is None
        for option in options
    )


def raw_firefox_command_uses_profile(command: str, profile_path: Path) -> bool | None:
    """Compare the ruyiPage ``--profile`` argument without shell parsing."""
    command_text = str(command or "")
    matches = list(
        re.finditer(r"(?:^|\s)(?:--profile|-profile)(?:=|\s+)", command_text)
    )
    if not matches:
        # ruyiPage always launches this managed profile with --profile. A
        # Firefox without the flag cannot be using this non-default directory.
        return False
    if len(matches) != 1:
        return None
    tail = command_text[matches[0].end() :].strip()
    if not tail:
        return None
    if tail[0] in {"'", '"'}:
        quote = tail[0]
        closing = tail.find(quote, 1)
        if closing <= 0:
            return None
        trailing = tail[closing + 1 :].strip()
        if trailing and not ruyipage_profile_trailing_options_are_supported(trailing):
            return None
        argument = tail[1:closing]
    else:
        # macOS ps does not guarantee shell quoting. First honor the whole
        # remaining string when it is the target Profile itself, which avoids
        # mistaking a literal `` --width=...`` in a Profile name for an option.
        if normalized_profile_path(tail) == profile_path:
            return True
        boundaries = list(re.finditer(
            r"\s+(?=(?:--headless(?:\s|$)|-private(?:\s|$)|--fpfile=|"
            r"--width=\d+(?:\s|$)|--height=\d+(?:\s|$)))",
            tail,
        ))
        if not boundaries:
            if ruyipage_profile_argument_has_unknown_option(tail):
                return None
            argument = tail
        else:
            for boundary in boundaries:
                argument = tail[: boundary.start()].strip()
                trailing = tail[boundary.start() :].strip()
                if (
                    not argument
                    or ruyipage_profile_argument_has_unknown_option(argument)
                    or not ruyipage_profile_trailing_options_are_supported(trailing)
                ):
                    # An unquoted unknown option is indistinguishable from part
                    # of a Profile path, so retain the lock rather than guessing.
                    return None
                candidate_path = normalized_profile_path(argument)
                if candidate_path is None:
                    return None
                if candidate_path == profile_path:
                    return True
            return False
    if not argument:
        return None
    candidate_path = normalized_profile_path(argument)
    if candidate_path is None:
        return None
    return candidate_path == profile_path


def macos_firefox_process_uses_profile(
    profile_dir: str | Path,
    process_ids: list[int] | None = None,
) -> bool | None:
    """Return whether macOS Firefox is using exactly ``profile_dir``."""
    if sys.platform != "darwin":
        return None
    profile_path = normalized_profile_path(profile_dir)
    if profile_path is None:
        return None
    candidate_ids = process_ids
    if candidate_ids is None:
        candidate_ids = macos_firefox_process_ids()
    if candidate_ids is None:
        return None
    for process_id in dict.fromkeys(candidate_ids):
        if not isinstance(process_id, int) or process_id <= 0:
            return None
        try:
            result = subprocess.run(
                [
                    "/bin/ps",
                    "-p",
                    str(process_id),
                    "-ww",
                    "-o",
                    "pid=",
                    "-o",
                    "comm=",
                    "-o",
                    "command=",
                ],
                capture_output=True,
                check=False,
                text=True,
                timeout=1,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0:
            return None
        lines = [line for line in str(result.stdout or "").splitlines() if line.strip()]
        # BSD ps may report success but produce no row after a lock PID exits.
        # That is a stale lock, not an uncertain live Firefox process.
        if not lines:
            continue
        if len(lines) != 1:
            return None
        parts = lines[0].strip().split(maxsplit=2)
        if len(parts) != 3 or parts[0] != str(process_id):
            return None
        executable = Path(parts[1]).name.casefold()
        if executable not in {"firefox", "firefox-bin"}:
            continue
        profile_match = raw_firefox_command_uses_profile(parts[2], profile_path)
        if profile_match is True:
            return True
        if profile_match is None:
            return None
    return False


def firefox_profile_has_active_lock(profile_dir: str) -> bool:
    normalized = str(profile_dir or "").strip()
    if not normalized or any(character in normalized for character in ("\r", "\n", "\0")):
        return False
    try:
        profile_path = Path(normalized).expanduser()
    except (TypeError, ValueError):
        return False
    lock_paths = [
        profile_path / lock_name for lock_name in ("parent.lock", ".parentlock", "lock")
    ]
    lock_paths = [lock_path for lock_path in lock_paths if os.path.lexists(lock_path)]
    if not lock_paths:
        return False
    # A stale macOS profile lock can retain a reused PID or remain as a regular
    # file. Only an actual Firefox command bound to this exact profile blocks a
    # new ruyiPage launch; a failed process probe remains fail-closed.
    if sys.platform == "darwin":
        return (
            macos_firefox_process_uses_profile(profile_path)
            is not False
        )
    for lock_path in lock_paths:
        if not lock_path.is_symlink():
            return True
        try:
            target = os.readlink(lock_path)
        except OSError:
            return True
        pid_match = re.search(r":\+?(\d+)$", target)
        if pid_match is None:
            # macOS Firefox uses ``127.0.0.1:+<pid>``.  A symlink outside
            # that documented shape has no liveness proof; treating it as
            # permanently active would strand a profile after a stale lock.
            return sys.platform != "darwin"
        try:
            os.kill(int(pid_match.group(1)), 0)
        except ProcessLookupError:
            continue
        except PermissionError:
            return True
        except OSError:
            return True
        return True
    return False


def attached_account_matches_apple_id(scope: Any, expected_apple_id: str) -> bool:
    expected = str(expected_apple_id or "").strip().lower()
    if not expected or any(character in expected for character in ("\r", "\n", "\0")):
        return False
    try:
        raw = scope.run_js(
            r"""
            function () {
              // ruyipage-account-session-identity
              const root = document.querySelector('#root') || document.body;
              const text = String(root?.innerText || root?.textContent || '');
              const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
              return JSON.stringify([...new Set(matches.map((value) => value.trim().toLowerCase()))]);
            }
            """
        )
        values = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return False
    if not isinstance(values, list):
        return False
    candidates = {
        str(value).strip().lower()
        for value in values
        if isinstance(value, str)
        and 3 <= len(value.strip()) <= BROKER_APPLE_ID_MAX_LENGTH
        and not any(character in value for character in ("\r", "\n", "\0"))
    }
    return candidates == {expected}


def try_attach_existing_browser(profile_dir: str = "") -> Any | None:
    """Attach to one running Firefox through ruyiPage without changing its tabs."""
    if not should_attach_existing_browser():
        return None
    try:
        ruyipage = importlib.import_module("ruyipage")
    except Exception:
        return None

    attach = getattr(ruyipage, "attach_exist_browser", None)
    addresses = [
        valid_browser_attach_address(os.environ.get(BROWSER_ATTACH_ADDRESS_ENV, "")),
        read_browser_attach_address(profile_dir),
    ]
    attempted_addresses: set[str] = set()
    for address in addresses:
        if not address or address in attempted_addresses or not callable(attach):
            continue
        attempted_addresses.add(address)
        try:
            candidate = attach(address=address, latest_tab=True)
        except Exception:
            continue
        if browser_connection_is_alive(candidate):
            return candidate

    attach_by_process = getattr(ruyipage, "auto_attach_exist_browser_by_process", None)
    if not callable(attach_by_process):
        return None
    for attempt in range(3):
        try:
            candidate = attach_by_process(timeout=1.0, max_workers=64, latest_tab=True)
        except TypeError:
            try:
                candidate = attach_by_process()
            except Exception:
                candidate = None
        except Exception:
            candidate = None
        if browser_connection_is_alive(candidate):
            return candidate
        if attempt < 2:
            time.sleep(0.35)
    return None


def is_blank_or_home_tab(page: Any) -> bool:
    """Only reuse Firefox's empty/home tab; leave any user content untouched."""
    current_url = scope_location_url(page).strip().lower()
    normalized_url = current_url.split("#", 1)[0].split("?", 1)[0]
    return normalized_url in {
        "about:blank",
        "about:newtab",
        "about:home",
        "about:welcome",
    }


def try_attach_existing_account_page(expected_apple_id: str, profile_dir: str = "") -> Any | None:
    """Return an already-open authenticated account tab through ruyiPage."""
    candidate = try_attach_existing_browser(profile_dir)
    if candidate is None:
        return None
    try:
        for account_tab in candidate.get_tabs(url="account.apple.com"):
            if not browser_connection_is_alive(account_tab):
                continue
            if (
                is_account_manage_url(scope_location_url(account_tab))
                and attached_account_matches_apple_id(account_tab, expected_apple_id)
            ):
                return account_tab
        return None
    except Exception:
        return None


def try_attach_existing_browser_for_flow(
    expected_apple_id: str, profile_dir: str = ""
) -> tuple[Any | None, str]:
    """Choose a safe tab in an attached Firefox without replacing user content."""
    candidate = try_attach_existing_browser(profile_dir)
    if candidate is None:
        return None, "new_browser"

    try:
        account_tabs = candidate.get_tabs(url="account.apple.com") or []
    except Exception:
        account_tabs = []
    for account_tab in account_tabs:
        if not browser_connection_is_alive(account_tab):
            continue
        if (
            is_account_manage_url(scope_location_url(account_tab))
            and attached_account_matches_apple_id(account_tab, expected_apple_id)
        ):
            return account_tab, "account_session"

    try:
        latest_tab = getattr(candidate, "latest_tab", None) or candidate
        if latest_tab is not None and browser_connection_is_alive(latest_tab):
            if is_blank_or_home_tab(latest_tab):
                return latest_tab, "empty_tab"
        new_tab = candidate.new_tab("about:blank")
        if new_tab is not None and browser_connection_is_alive(new_tab):
            return new_tab, "new_tab"
    except Exception:
        pass
    return None, "new_browser"


def construct_firefox_page(FirefoxPage: Any, opts: Any) -> Any:
    if not browser_broker_mode_enabled() or sys.platform != "darwin":
        return FirefoxPage(opts)

    browser_module = importlib.import_module("ruyipage._base.browser")
    runtime_subprocess = browser_module.subprocess
    original_popen = runtime_subprocess.Popen

    def inherit_broker_process_group(*args: Any, **kwargs: Any) -> Any:
        if kwargs.get("start_new_session") is True:
            kwargs = dict(kwargs)
            kwargs.pop("start_new_session")
        return original_popen(*args, **kwargs)

    runtime_subprocess.Popen = inherit_broker_process_group
    try:
        return FirefoxPage(opts)
    finally:
        runtime_subprocess.Popen = original_popen


def browser_flow(args: argparse.Namespace) -> int:
    report_dir = Path(args.report_dir)
    configure_browser_stage_file(report_dir)
    set_browser_startup_stage("not_started")
    apple_id, password = load_browser_credentials()
    configure_diagnostic_secrets(apple_id, password)
    broker_mode = browser_broker_mode_enabled()
    if broker_mode:
        set_browser_startup_stage("credentials_received")
        emit({"event": "status", "status": "broker_credentials_received"})
    sign_in_url = validate_apple_url(args.sign_in_url)
    if broker_mode:
        set_browser_startup_stage("url_validated")
        emit({"event": "status", "status": "browser_url_validated"})

    if broker_mode:
        set_browser_startup_stage("runtime_importing")
    FirefoxOptions, FirefoxPage, Keys = import_ruyipage()
    if broker_mode:
        set_browser_startup_stage("runtime_imported")
        emit({"event": "status", "status": "browser_runtime_imported"})
    opts = FirefoxOptions()
    if args.firefox:
        opts.set_browser_path(args.firefox)
    if args.profile_dir:
        opts.set_user_dir(args.profile_dir)
    opts.set_window_size(1280, 960)
    opts.set_timeouts(2, 90, 30)
    opts.headless(False)
    preserve_on_failure = preserve_browser_on_failure()
    preserve_on_success = preserve_browser_on_success()
    opts.close_on_exit(not (preserve_on_failure or preserve_on_success))
    if hasattr(opts, "set_human_algorithm"):
        opts.set_human_algorithm("windmouse")

    screenshots_dir = report_dir / "screenshots"
    success_screenshot_paths = (
        screenshots_dir / "02-ruyipage-after-login.png",
        screenshots_dir / "03-account-information.png",
    )
    generated_screenshot_paths: list[Path] = []
    screenshots: dict[str, str | None] = {}
    account_home_confirmed = False
    if broker_mode:
        set_browser_startup_stage("browser_constructing")
        emit({"event": "status", "status": "browser_constructing"})
    page, browser_route = try_attach_existing_browser_for_flow(apple_id, args.profile_dir)
    attached_existing_browser = browser_route == "account_session"
    if page is None:
        if should_attach_existing_browser() and firefox_profile_has_active_lock(args.profile_dir):
            emit({"event": "status", "status": "browser_profile_attach_required"})
            raise RuntimeError("active Firefox profile could not be attached through ruyiPage")
        page = construct_firefox_page(FirefoxPage, opts)
    persist_browser_attach_address(page, args.profile_dir)
    if broker_mode:
        set_browser_startup_stage("browser_ready")
    try:
        emit({"event": "ready", "mode": "ruyipage-only"})
        set_browser_startup_stage("login_navigation")
        if attached_existing_browser:
            emit({"event": "status", "status": "browser_session_attached"})
            page.wait.doc_loaded(timeout=20)
            human_pause(300, 700)
        else:
            if browser_route == "empty_tab":
                emit({"event": "status", "status": "browser_blank_tab_attached"})
            elif browser_route == "new_tab":
                emit({"event": "status", "status": "browser_login_tab_created"})
            page.get(sign_in_url)
            page.wait.doc_loaded(timeout=20)
            human_pause(900, 1800)
        set_browser_startup_stage("login_page_loaded")

        initial_state = detect_login_state(page)
        initial_state = settle_trust_state(
            page,
            initial_state,
            deadline=time.monotonic() + 5.0,
        )
        if initial_state.get("error") and not has_confirmed_account_session(
            initial_state
        ):
            raise RuntimeError("login page reported an authentication error")
        set_browser_startup_stage("login_state_detected")
        skipped_login = has_confirmed_account_session(initial_state)
        if skipped_login:
            initial_state["trusted"] = True
        skipped_2fa = skipped_login
        remember_checked: bool | None = None

        if not skipped_login:
            if initial_state.get("twofa"):
                set_browser_startup_stage("twofa_prepare")
                request_two_factor_preparation()
            else:
                if not should_resume_at_password(initial_state):
                    set_browser_startup_stage("email_wait")
                    email_scope, email = wait_for_element(
                        page,
                        EMAIL_SELECTORS,
                        timeout_s=45,
                    )
                    set_browser_startup_stage("email_input")
                    input_and_verify(
                        email_scope,
                        email,
                        apple_id,
                        "email",
                        Keys,
                        root_page=page,
                    )
                    set_browser_startup_stage("email_submit")
                    submit_element_with_enter(
                        page,
                        email_scope,
                        email,
                        Keys,
                    )
                    wait_for_document_settle(page)

                set_browser_startup_stage("password_wait")
                password_scope, password_field = wait_for_element(
                    page,
                    PASSWORD_SELECTORS,
                    timeout_s=45,
                    stable_observations=2,
                )
                set_browser_startup_stage("password_input")
                input_and_verify(
                    password_scope,
                    password_field,
                    password,
                    "password",
                    Keys,
                    root_page=page,
                )
                set_browser_startup_stage("remember_account")
                remember_checked = ensure_remember_checked(page)
                set_browser_startup_stage("twofa_prepare")
                request_two_factor_preparation()
                set_browser_startup_stage("password_submit")
                submit_element_with_enter(
                    page,
                    password_scope,
                    password_field,
                    Keys,
                    min_ms=420,
                    max_ms=900,
                    password_value=password,
                )
                wait_for_document_settle(page)

            set_browser_startup_stage("twofa_page_wait")
            login_state = wait_for_2fa_or_session(page)
            if login_state.get("trusted"):
                skipped_2fa = True
                set_browser_startup_stage("signed_in")
            else:
                for generation in (1, 2):
                    set_browser_startup_stage("twofa_code_wait")
                    emit(
                        {
                            "event": "need_2fa",
                            "generation": generation,
                            "state": {
                                "href": sanitized_apple_url(
                                    str(login_state.get("href") or "")
                                ),
                                "twofaVisible": bool(
                                    login_state.get("twofaVisible")
                                    or login_state.get("twofa")
                                ),
                                "inputReady": bool(login_state.get("inputReady")),
                                "codeInputCount": login_state.get("codeInputCount"),
                                "elapsedMs": max(
                                    0,
                                    int(login_state.get("elapsedMs") or 0),
                                ),
                            },
                        }
                    )
                    code = validate_two_factor_code_command(
                        read_command(),
                        generation,
                    )
                    add_diagnostic_secret(code)
                    set_browser_startup_stage("twofa_input")
                    emit_two_factor_progress("code_received", generation=generation)
                    try:
                        emit_two_factor_progress("target_waiting", generation=generation)
                        fields = wait_for_otp_target(page)
                        emit_two_factor_progress(
                            "target_resolved",
                            generation=generation,
                            target_count=len(fields),
                        )
                        emit_two_factor_progress("input_started", generation=generation)
                        fill_security_code(page, code, Keys, fields=fields)
                        emit_two_factor_progress("input_completed", generation=generation)
                        emit_two_factor_progress("submit_started", generation=generation)
                        # Apple submits a verified code as soon as the final
                        # digit lands. A second click or Enter can race the
                        # retiring iframe and interrupt the account redirect.
                        submitted = True
                        emit_two_factor_progress(
                            "submit_sent",
                            generation=generation,
                            submitted=submitted,
                        )
                        human_pause(900, 1600)
                        emit_two_factor_progress(
                            "transition_waiting",
                            generation=generation,
                            submitted=submitted,
                        )
                        signed_in_state = wait_for_signed_in(
                            page,
                            submitted=True,
                            otp_generation=generation,
                            submission_method="automatic",
                        )
                    except Exception:
                        emit_two_factor_progress("handoff_failed", generation=generation)
                        raise
                    if signed_in_state.get("retry2FA"):
                        if generation != 1:
                            raise RuntimeError("2FA/login failed")
                        emit_two_factor_progress(
                            "transition_retry_requested",
                            generation=generation,
                        )
                        login_state = signed_in_state
                        continue
                    emit_two_factor_progress(
                        "transition_confirmed",
                        generation=generation,
                    )
                    set_browser_startup_stage("signed_in")
                    break
        else:
            set_browser_startup_stage("signed_in")

        emit({"event": "status", "status": "account_home_confirmed"})
        account_home_confirmed = True
        screenshots["afterLogin"] = take_screenshot(
            page, success_screenshot_paths[0]
        )
        if screenshots["afterLogin"] is not None:
            generated_screenshot_paths.append(success_screenshot_paths[0])

        set_browser_startup_stage("account_information")
        page.get(ACCOUNT_INFORMATION_URL)
        page.wait.doc_loaded(timeout=20)
        human_pause(1200, 2400)
        final_state = detect_login_state(page)
        final_state = settle_trust_state(
            page,
            final_state,
            deadline=time.monotonic() + 5.0,
        )
        if not has_confirmed_account_session(final_state):
            direct_session_state = confirmed_account_manage_state(page)
            if direct_session_state is not None:
                final_state = direct_session_state
        if final_state.get("error") and not has_confirmed_account_session(final_state):
            raise RuntimeError("personal information page reported an authentication error")
        if not has_confirmed_account_session(final_state):
            raise RuntimeError("personal information page did not confirm an authenticated Apple session")
        final_state["trusted"] = True
        set_browser_startup_stage("profile_capture")
        wait_for_profile_capture_ready(page)
        emit({"event": "status", "status": "profile_page_ready"})
        screenshots["personalInformation"] = take_screenshot(
            page, success_screenshot_paths[1]
        )
        if screenshots["personalInformation"] is not None:
            generated_screenshot_paths.append(success_screenshot_paths[1])
            emit({"event": "status", "status": "profile_screenshot_saved"})
        set_browser_startup_stage("profile_birthday")
        personal_info = collect_personal_info(page)
        validate_personal_info_result(final_state, personal_info)
        if preserve_on_success and browser_connection_is_alive(page):
            emit(
                {
                    "event": "status",
                    "status": "browser_session_preserved",
                    "preserved": True,
                }
            )

        emit(
            {
                "event": "result",
                "success": True,
                "browserLogin": {
                    "success": True,
                    "backend": "ruyipage",
                    "accountHomeConfirmed": True,
                    "skippedLogin": skipped_login,
                    "skipped2FA": skipped_2fa,
                    "sessionReused": skipped_login or attached_existing_browser,
                    "rememberAccount": remember_checked,
                },
                "personalInfo": personal_info,
                "screenshots": screenshots,
            }
        )
        return 0
    except Exception:
        if broker_mode and browser_startup_stage in BROWSER_STARTUP_STAGES:
            emit(
                {
                    "event": "status",
                    "status": "browser_failure",
                    "failureStage": browser_startup_stage,
                }
            )
        raise
    finally:
        had_error = sys.exc_info()[0] is not None
        if had_error and preserve_on_failure and browser_connection_is_alive(page):
            if not account_home_confirmed:
                for screenshot_path in generated_screenshot_paths:
                    screenshot_path.unlink(missing_ok=True)
            emit(
                {
                    "event": "status",
                    "status": "browser_preserved",
                    "failureStage": browser_startup_stage,
                    "preserved": True,
                }
            )
        elif not had_error and preserve_on_success and browser_connection_is_alive(page):
            pass
        else:
            try:
                page.quit()
            except Exception:
                for screenshot_path in generated_screenshot_paths:
                    screenshot_path.unlink(missing_ok=True)
                if not had_error:
                    raise
                emit({"event": "warning", "message": QUIT_FAILURE_REASON})
            else:
                if had_error:
                    for screenshot_path in generated_screenshot_paths:
                        screenshot_path.unlink(missing_ok=True)


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


def run_cli(argv: list[str]) -> int:
    try:
        return main(argv)
    except Exception as error:
        emit(
            {
                "event": "diagnostic",
                "kind": "python_exception",
                "failureStage": browser_startup_stage,
                "errorType": type(error).__name__,
                "errorClass": classify_browser_exception(error),
                "hasTraceback": True,
            }
        )
        result = {
            "event": "result",
            "success": False,
            "error": TOP_LEVEL_FAILURE_REASON,
        }
        if browser_broker_mode_enabled() and browser_startup_stage in BROWSER_STARTUP_STAGES:
            result["failureStage"] = browser_startup_stage
        emit(result)
        print(TOP_LEVEL_FAILURE_REASON, file=sys.stderr, flush=True)
        return 1
    finally:
        configure_diagnostic_secrets()


if __name__ == "__main__":
    raise SystemExit(run_cli(sys.argv[1:]))
