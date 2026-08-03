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
import secrets
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, TextIO
from urllib.parse import urljoin, urlsplit


ACCOUNT_INFORMATION_URL = "https://account.apple.com/account/manage/section/information"
ACCOUNT_SECURITY_URL = "https://account.apple.com/account/manage/section/security"
DEVELOPER_ACCOUNT_URL = "https://developer.apple.com/account"
SMALL_BUSINESS_PROGRAM_ENROLL_URL = (
    "https://developer.apple.com/app-store/small-business-program/enroll/"
)
PERSONAL_INFORMATION_PATH = "/account/manage/section/information"
ACCOUNT_SECURITY_PATH = "/account/manage/section/security"
ACCOUNT_SIGN_IN_PATH = "/sign-in"
SMALL_BUSINESS_PROGRAM_ENROLL_PATH = "/app-store/small-business-program/enroll"
PROFILE_NAVIGATION_LINK_SELECTORS = (
    "css:a[href]",
    "css:a",
    "css:button",
    "css:[role='link']",
    "css:[role='link'][href]",
)
PROFILE_NAVIGATION_LABELS = frozenset(
    {
        "personal information",
        "\u4e2a\u4eba\u4fe1\u606f",
        "\u500b\u4eba\u8cc7\u6599",
    }
)
PROFILE_NAVIGATION_WAIT_TIMEOUT_S = 12.0
PROFILE_REAUTHENTICATION_LIMIT = 1
PROFILE_CARD_SELECTORS = (
    "css:button.button.button-bare",
    "css:button[class*='button-bare']",
    "css:.card",
    "css:button",
    "css:[role='button']",
)
PROFILE_NAME_CARD_SELECTORS = PROFILE_CARD_SELECTORS
PROFILE_NAME_MODAL_SELECTORS = (
    "css:[id^='modal-content-']",
    "css:[role='dialog']",
    "css:aside",
)
PROFILE_MODAL_CLOSE_SELECTORS = (
    "css:.modal-close button",
    "css:button[class*='modal-close']",
    "css:button[aria-label='Close']",
    "css:button[aria-label='关闭']",
    "css:button[aria-label='關閉']",
)
PROFILE_NAME_MODAL_CLEANUP_FAILURE_CLASSES = frozenset(
    {
        "profile_name_modal_close_control_unavailable",
        "profile_name_modal_close_action_failed",
        "profile_name_modal_close_context_lost",
        "profile_name_modal_close_query_failed",
        "profile_name_modal_close_unconfirmed",
    }
)
PROFILE_NAME_MODAL_UNAVAILABLE_OUTCOMES = frozenset(
    {
        "card_missing",
        "modal_missing",
        "timeout",
    }
)
PROFILE_CARD_WAIT_TIMEOUT_S = 35.0
PROFILE_MODAL_WAIT_TIMEOUT_S = 20.0
PROFILE_NAME_MODAL_OPEN_CLICK_ATTEMPTS = 2
PROFILE_NAME_MODAL_RETRY_WAIT_TIMEOUT_S = 3.0
PROFILE_MODAL_CLOSE_CLICK_ATTEMPTS = 2
PROFILE_VALUE_STABLE_OBSERVATIONS = 2
PROFILE_VALUE_MAX_LENGTHS = {"name": 256, "birthday": 128}
ACCOUNT_SECURITY_NAVIGATION_LABELS = frozenset(
    {
        "login and security",
        "login & security",
        "\u767b\u5f55\u4e0e\u5b89\u5168\u6027",
        "\u767b\u9304\u8207\u5b89\u5168\u6027",
    }
)
ACCOUNT_SECURITY_NAVIGATION_WAIT_TIMEOUT_S = 15.0
ACCOUNT_PASSWORD_CARD_SELECTORS = PROFILE_CARD_SELECTORS
ACCOUNT_PASSWORD_FIELD_SELECTORS = (
    "css:input[type='password']",
    "css:input[autocomplete='current-password']",
    "css:input[autocomplete='new-password']",
)
ACCOUNT_PASSWORD_SUBMIT_SELECTORS = (
    "css:button",
    "css:input[type='submit']",
    "css:[role='button']",
)
ACCOUNT_PASSWORD_CHANGE_WAIT_TIMEOUT_S = 35.0
ACCOUNT_PASSWORD_CHANGE_SUCCESS_TIMEOUT_S = 25.0
ACCOUNT_PASSWORD_LENGTH = 16
ACCOUNT_PASSWORD_SPECIAL_CHARACTERS = "!@#$%^&*_-+=?"
ACCOUNT_PASSWORD_UPPERCASE = "ABCDEFGHJKMNPQRSTUVWXYZ"
ACCOUNT_PASSWORD_LOWERCASE = "abcdefghjkmnpqrstuvwxyz"
ACCOUNT_PASSWORD_DIGITS = "23456789"
SMALL_BUSINESS_APPLICATION_WAIT_TIMEOUT_S = 35.0
SMALL_BUSINESS_SUBMISSION_SUCCESS_TIMEOUT_S = 35.0
SMALL_BUSINESS_ASSOCIATED_NO_COUNT = 4
SMALL_BUSINESS_CONTROL_SELECTORS = (
    "css:fieldset label",
    "css:section label",
    "css:label",
    "css:input[type='radio']",
    "css:input[type='checkbox']",
)
SMALL_BUSINESS_SUBMIT_SELECTORS = (
    "css:input#submit",
    "css:input[type='submit']",
    "css:button[type='submit']",
    "css:button",
)
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
PASSWORD_TARGET_STABLE_OBSERVATIONS = 3
PASSWORD_TARGET_SETTLE_MIN_MS = 650
PASSWORD_TARGET_SETTLE_MAX_MS = 950
PASSWORD_TARGET_REFRESH_TIMEOUT_S = 12
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
TRUST_BUTTON_RE = re.compile(
    r"^(trust(?: this browser)?|信任(?:此浏览器)?|信任此瀏覽器)$",
    re.IGNORECASE,
)
REJECT_TRUST_RE = re.compile(
    r"don't trust|do not trust|not now|later|cancel|不信任|取消|暂不|暫不|以后再说|以後再說|稍后|稍後",
    re.IGNORECASE,
)
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
ACCOUNT_SIGN_IN_HOSTS = frozenset({"account.apple.com", "appleid.apple.com"})
OPAQUE_TWO_FACTOR_FRAME_URLS = frozenset({"about:blank", "about:srcdoc"})
SCREENSHOT_CHECKPOINTS = frozenset(
    {"account_information", "developer_membership", "small_business_application"}
)
QUIT_FAILURE_REASON = "ruyipage_quit_failed"
TOP_LEVEL_FAILURE_REASON = "ruyipage_browser_flow_failed"
FOCUS_NOT_CONFIRMED_REASON = "ruyiPage input target focus was not confirmed"
# Apple can replace the authentication iframe before its account shell and
# profile data finish hydrating. Keep the submit transition bounded, but do
# not turn an ordinary slow account-page handoff into a false OTP failure.
TWO_FACTOR_SUBMIT_TRANSITION_TIMEOUT_S = 90.0
TRUST_PROMPT_HYDRATION_TIMEOUT_S = 20.0
TWO_FACTOR_TARGET_REFRESH_TIMEOUT_S = 5.0
TWO_FACTOR_EMPTY_CELL_FALLBACK_PROBE_TIMEOUT_S = 1.5
TWO_FACTOR_SHARED_ACQUISITION_TIMEOUT_S = 240.0
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
    "developer_account",
    "developer_login",
    "developer_membership",
    "account_navigation",
    "account_security",
    "password_change",
    "small_business_application",
    "small_business_login",
    "small_business_enrollment",
    "post_login_finalization",
    "result_emitting",
    "result_emitted",
}
browser_startup_stage = "not_started"
browser_stage_file: Path | None = None
diagnostic_secrets: list[str] = []
browser_failure_emitted = False
profile_name_modal_query_failure_emitted = False
BROWSER_BROKER_MODE_ENV = "APPLE_AUTOMATION_BROWSER_BROKER_MODE"
BROWSER_BROKER_CREDENTIALS_ERROR = "invalid browser broker credentials"
BROWSER_STAGE_FILE_ENV = "APPLE_AUTOMATION_BROWSER_STAGE_FILE"
BROWSER_PRESERVE_ON_FAILURE_ENV = "BROWSER_PRESERVE_ON_FAILURE"
BROWSER_PRESERVE_ON_SUCCESS_ENV = "BROWSER_PRESERVE_ON_SUCCESS"
BROWSER_ATTACH_EXISTING_ENV = "BROWSER_ATTACH_EXISTING"
BROWSER_ATTACH_ADDRESS_ENV = "BROWSER_ATTACH_ADDRESS"
DEVELOPER_MEMBERSHIP_GATE_ENV = "DEVELOPER_MEMBERSHIP_GATE"
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
        "trust_prompt_detected",
        "trust_click_sent",
        "transition_retry_requested",
        "transition_confirmed",
        "handoff_failed",
    }
)
BROWSER_OBSERVATION_CHECKPOINTS = frozenset(
    {
        "login_state",
        "twofa_wait",
        "twofa_transition",
        "account_home",
        "account_information",
        "profile_ready",
        "profile_capture_failed",
    }
)
BROWSER_PAGE_KINDS = frozenset(
    {
        "sign_in",
        "password",
        "two_factor",
        "trust_prompt",
        "account_manage",
        "account_information",
        "authentication_error",
        "unknown",
    }
)
PROFILE_CAPTURE_FAILURE_CLASSES = frozenset(
    {
        "developer_membership_gate",
        "profile_authentication_error",
        "profile_session_unconfirmed",
        "profile_element_unavailable",
        "profile_page_unready",
        "profile_card_ambiguous",
        "profile_card_identity_collision",
        "profile_reauthentication_exhausted",
        "profile_data_incomplete",
        "profile_name_modal_query_failed",
        "profile_name_modal_ambiguous",
        "profile_name_modal_unavailable",
        "profile_name_modal_cleanup_failed",
        "browser_connection_lost",
        "profile_capture_failed",
    }
)
PROFILE_CAPTURE_READINESS_OUTCOMES = frozenset(
    {
        "ready",
        "route_unready",
        "state_unavailable",
        "authentication_blocked",
        "card_missing",
        "card_ambiguous",
        "card_identity_collision",
        "card_query_failed",
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


def classify_browser_exception(
    error: Exception,
    failure_stage: str | None = None,
) -> str:
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
    if "live password input target did not stabilize" in message:
        return "password_target_unstable"
    if (
        "input target focus was not confirmed" in message
        and failure_stage in {"password_wait", "password_input", "password_submit"}
    ):
        return "password_focus_unconfirmed"
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


def classify_browser_page_kind(page: Any, state: dict[str, Any] | None) -> str:
    """Classify a page with fixed tokens only; never emit URLs or page text."""
    source = state if isinstance(state, dict) else {}
    try:
        current_url = scope_location_url(page)
        current_path = urlsplit(current_url).path.rstrip("/")
        information_path = urlsplit(ACCOUNT_INFORMATION_URL).path.rstrip("/")
    except Exception:
        current_url = ""
        current_path = ""
        information_path = ""
    if source.get("trustPrompt") is True:
        return "trust_prompt"
    if information_path and current_path == information_path:
        return "account_information"
    if current_url and is_account_manage_url(current_url):
        return "account_manage"
    if current_url and is_account_sign_in_url(current_url):
        return "sign_in"
    if current_url and is_developer_account_url(current_url):
        return "developer_account"
    if source.get("error") is True:
        return "authentication_error"
    if source.get("twofa") is True or source.get("twofaVisible") is True:
        return "two_factor"
    if source.get("password") is True:
        return "password"
    if source.get("email") is True:
        return "sign_in"
    return "unknown"


def emit_browser_observation(
    checkpoint: str,
    page: Any,
    state: dict[str, Any] | None,
    *,
    account_home_confirmed: bool,
    generation: int = 0,
) -> None:
    """Emit a fixed, non-secret browser checkpoint for audit correlation."""
    if checkpoint not in BROWSER_OBSERVATION_CHECKPOINTS:
        raise RuntimeError("browser observation checkpoint is invalid")
    if isinstance(generation, bool) or generation not in (0, 1, 2):
        raise RuntimeError("browser observation generation is invalid")
    source = state if isinstance(state, dict) else {}
    try:
        session_confirmed = has_confirmed_account_session(source)
    except Exception:
        session_confirmed = False
    code_input_count = source.get("codeInputCount")
    emit(
        {
            "event": "status",
            "status": "browser_observation",
            "checkpoint": checkpoint,
            "generation": generation,
            "pageKind": classify_browser_page_kind(page, source),
            "connectionAlive": browser_connection_is_alive(page),
            "inspectionAvailable": source.get("inspectionAvailable") is not False,
            "sessionConfirmed": session_confirmed,
            "accountHomeConfirmed": account_home_confirmed is True,
            "twofaVisible": bool(source.get("twofa") or source.get("twofaVisible")),
            "trustPrompt": source.get("trustPrompt") is True,
            "inputReady": source.get("inputReady") is True,
            "codeInputCount": code_input_count if code_input_count in (1, 6) else 0,
            "authenticationError": source.get("error") is True,
            "rootManageUrl": source.get("rootManageUrl") is True,
            "rootAccountMarker": source.get("rootAccountMarker") is True,
            "rootAuthenticationError": source.get("rootError") is True,
            "rootSecurityCopyOnly": source.get("rootSecurityCopyOnly") is True,
            "retiringChildError": source.get("retiringChildError") is True,
            "childAuthUiPresent": source.get("childAuthUiPresent") is True,
        }
    )


def classify_profile_capture_failure(error: Exception) -> str:
    """Use fixed failure classes instead of forwarding page or exception text."""
    message = str(error).lower()
    if (
        "repeated reauthentication" in message
        or "exhausted the 2fa generation limit" in message
    ):
        return "profile_reauthentication_exhausted"
    if "personal information page reported an authentication error" in message:
        return "profile_authentication_error"
    if "personal information page did not confirm" in message:
        return "profile_session_unconfirmed"
    if "browser connection was lost" in message:
        return "browser_connection_lost"
    if "page element did not appear" in message:
        return "profile_element_unavailable"
    if "profile card identity collision" in message:
        return "profile_card_identity_collision"
    if "card is ambiguous" in message:
        return "profile_card_ambiguous"
    if "personal information name modal query failed" in message:
        return "profile_name_modal_query_failed"
    if "personal information name modal is ambiguous" in message:
        return "profile_name_modal_ambiguous"
    if "personal information name modal is unavailable" in message:
        return "profile_name_modal_unavailable"
    if "personal information name modal cleanup failed" in message:
        return "profile_name_modal_cleanup_failed"
    if "name and birthday" in message:
        return "profile_data_incomplete"
    if "profile" in message or "personal information" in message:
        return "profile_page_unready"
    return "profile_capture_failed"


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


def developer_membership_gate_enabled() -> bool:
    """Require an active Developer membership before the Account module when set."""
    return os.environ.get(DEVELOPER_MEMBERSHIP_GATE_ENV, "0").strip() == "1"


def developer_membership_allows_account(
    developer_account: dict[str, Any],
    *,
    gate_enabled: bool,
) -> bool:
    """Require Developer authentication before evaluating the membership gate.

    Test mode relaxes membership only: authenticated ``unknown`` results may
    continue for regression coverage, but a visible Apple sign-in form or a
    failed Developer credential handoff cannot open the Account module.
    """
    if developer_account.get("authenticated") is not True:
        return False
    if not gate_enabled:
        return True
    return (
        developer_account.get("success") is True
        and developer_account.get("membershipStatus") == "active"
    )


def browser_connection_is_alive(page: Any) -> bool:
    """Confirm that ruyiPage can still reach the Firefox browsing context."""
    try:
        return bool(page.states.is_alive)
    except Exception:
        return False


def finalize_post_login_browser(
    page: Any,
    *,
    preserve_requested: bool,
    profile_capture_success: bool,
    required_pages: tuple[Any, ...] = (),
) -> dict[str, Any]:
    """Settle the post-login browser disposition before emitting the success result.

    A dead ruyiPage connection after account-home confirmation is useful
    observability, not a reason to rewrite a completed sign-in as a failure.
    """
    finalization = {
        "browserFinalizationCompleted": True,
        "browserPreservationRequested": preserve_requested is True,
        "browserSessionPreserved": False,
        "finalizationClass": "completed",
    }
    emit(
        {
            "event": "status",
            "status": "browser_finalization_started",
            "browserPreservationRequested": preserve_requested is True,
        }
    )
    if preserve_requested:
        required_pages_alive = all(
            required_page is not None
            and browser_connection_is_alive(required_page)
            for required_page in required_pages
        )
        if browser_connection_is_alive(page) and required_pages_alive:
            finalization["browserSessionPreserved"] = True
            emit(
                {
                    "event": "status",
                    "status": "browser_session_preserved",
                    "preserved": True,
                    "profileCaptureSuccess": profile_capture_success is True,
                }
            )
            emit(
                {
                    "event": "status",
                    "status": "browser_finalization_completed",
                    **finalization,
                }
            )
            return finalization

        finalization["browserFinalizationCompleted"] = False
        finalization["finalizationClass"] = "browser_connection_lost"
        emit(
            {
                "event": "status",
                "status": "browser_finalization_partial",
                **finalization,
            }
        )
        return finalization

    if not browser_connection_is_alive(page):
        finalization["browserFinalizationCompleted"] = False
        finalization["finalizationClass"] = "browser_connection_lost"
        emit(
            {
                "event": "status",
                "status": "browser_finalization_partial",
                **finalization,
            }
        )
        return finalization

    try:
        page.quit()
    except Exception:
        finalization["browserFinalizationCompleted"] = False
        finalization["finalizationClass"] = "browser_quit_failed"
        emit(
            {
                "event": "status",
                "status": "browser_finalization_partial",
                **finalization,
            }
        )
    else:
        emit(
            {
                "event": "status",
                "status": "browser_finalization_completed",
                **finalization,
            }
        )
    return finalization


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


def set_browser_startup_stage(stage: str, *, emit_transition: bool = True) -> None:
    global browser_startup_stage
    if stage not in BROWSER_STARTUP_STAGES:
        raise RuntimeError("browser startup stage is invalid")
    previous_stage = browser_startup_stage
    browser_startup_stage = stage
    if emit_transition:
        emit(
            {
                "event": "status",
                "status": "browser_stage",
                "stage": stage,
                "previousStage": previous_stage,
                "transition": "entered",
            }
        )
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


def emit_browser_result(result: dict[str, Any]) -> None:
    set_browser_startup_stage("result_emitting")
    emit(result)
    # The result event itself is the protocol evidence. Persist the completed
    # stage without emitting a second event after the terminal result.
    set_browser_startup_stage("result_emitted", emit_transition=False)


def begin_browser_flow_run() -> None:
    """Reset per-run state so every invocation has an independent audit trail."""
    global browser_failure_emitted, browser_startup_stage
    global profile_name_modal_query_failure_emitted
    browser_failure_emitted = False
    profile_name_modal_query_failure_emitted = False
    browser_startup_stage = "not_started"


def emit_browser_failure_once() -> None:
    """Publish one fixed terminal stage for direct and broker browser runs."""
    global browser_failure_emitted
    if browser_failure_emitted or browser_startup_stage not in BROWSER_STARTUP_STAGES:
        return
    browser_failure_emitted = True
    emit(
        {
            "event": "status",
            "status": "browser_failure",
            "failureStage": browser_startup_stage,
        }
    )


def emit_profile_name_modal_query_failure_once() -> None:
    global profile_name_modal_query_failure_emitted
    if profile_name_modal_query_failure_emitted:
        return
    profile_name_modal_query_failure_emitted = True
    emit(
        {
            "event": "status",
            "status": "profile_name_modal_query_failed",
        }
    )


def emit_profile_name_modal_unavailable(
    *,
    attempt_count: int,
    outcome: str,
) -> None:
    """Emit bounded diagnostics for a name modal that never materialized.

    The page and exception text can contain personal profile data.  Keep the
    audit event intentionally small: only a capped retry count and a fixed
    outcome enum are allowed through.
    """
    normalized_attempt_count = (
        attempt_count
        if isinstance(attempt_count, int) and not isinstance(attempt_count, bool)
        else 0
    )
    normalized_attempt_count = max(
        0,
        min(PROFILE_NAME_MODAL_OPEN_CLICK_ATTEMPTS, normalized_attempt_count),
    )
    normalized_outcome = (
        outcome
        if outcome in PROFILE_NAME_MODAL_UNAVAILABLE_OUTCOMES
        else "timeout"
    )
    emit(
        {
            "event": "status",
            "status": "profile_name_modal_unavailable",
            "attemptCount": normalized_attempt_count,
            "outcome": normalized_outcome,
        }
    )


def profile_name_modal_unavailable_outcome(error: Exception) -> str | None:
    """Map only known non-sensitive modal-open terminal errors to an outcome."""
    message = str(error).casefold()
    if "personal information name card was not found" in message:
        return "card_missing"
    if "personal information name modal was not found" in message:
        return "modal_missing"
    return None


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


def password_target_readiness(element: Any) -> dict[str, Any] | None:
    """Read non-secret readiness evidence for one painted password node."""
    if not element_is_interactable(element):
        return None
    try:
        raw = element.run_js(
            """
            function() {
              /* ruyipage-password-target-readiness */
              const registryKey = Symbol.for(
                'apple-automation-password-target-registry'
              );
              let registry = window[registryKey];
              if (!registry) {
                registry = { nextId: 0, identities: new WeakMap() };
                Object.defineProperty(window, registryKey, {
                  value: registry,
                  configurable: true
                });
              }
              let nodeIdentity = registry.identities.get(this);
              if (!nodeIdentity) {
                registry.nextId += 1;
                nodeIdentity = `password-${registry.nextId}`;
                registry.identities.set(this, nodeIdentity);
              }
              const rect = this.getBoundingClientRect();
              const style = window.getComputedStyle(this);
              return JSON.stringify({
                nodeIdentity,
                connected: this.isConnected === true,
                visible: rect.width > 2 && rect.height > 2 &&
                  this.getClientRects().length > 0 &&
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.opacity !== '0',
                editable: this.disabled !== true &&
                  this.readOnly !== true &&
                  this.getAttribute('aria-disabled') !== 'true',
                inputType: String(this.type || '').toLowerCase()
              });
            }
            """
        )
        state = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return None
    if not (
        isinstance(state, dict)
        and isinstance(state.get("nodeIdentity"), str)
        and bool(state.get("nodeIdentity"))
        and state.get("connected") is True
        and state.get("visible") is True
        and state.get("editable") is True
        and state.get("inputType") == "password"
    ):
        return None
    return state


def password_target_is_live(element: Any) -> bool:
    """Require the painted, editable password node instead of a hydration placeholder."""
    return password_target_readiness(element) is not None


def wait_for_password_target(
    page: Any,
    timeout_s: int = 45,
    pause: Callable[[int, int], None] | None = None,
) -> tuple[Any, Any]:
    """Resolve the latest live password wrapper after a bounded paint-stability dwell."""
    if pause is None:
        pause = human_pause
    deadline = time.monotonic() + max(0, timeout_s)
    while time.monotonic() < deadline:
        remaining = max(1, int(deadline - time.monotonic() + 0.999))
        scope, field = wait_for_element(
            page,
            PASSWORD_SELECTORS,
            timeout_s=remaining,
            stable_observations=PASSWORD_TARGET_STABLE_OBSERVATIONS,
            pause=pause,
        )
        readiness = password_target_readiness(field)
        if readiness is None:
            pause(260, 520)
            continue
        context_id = scope_browsing_context_id(scope)
        pause(PASSWORD_TARGET_SETTLE_MIN_MS, PASSWORD_TARGET_SETTLE_MAX_MS)
        current = find_first_scoped_element(page, PASSWORD_SELECTORS)
        if current is None:
            continue
        current_scope, current_field = current
        current_readiness = password_target_readiness(current_field)
        if (
            current_readiness is not None
            and scope_browsing_context_id(current_scope) == context_id
            and current_readiness["nodeIdentity"] == readiness["nodeIdentity"]
        ):
            return current_scope, current_field
    raise RuntimeError("live password input target did not stabilize")


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
    target_holder: dict[str, Any] | None = None,
) -> Any:
    root_page = root_page or scope
    if label == "password" and target_holder is not None:
        target_holder.update({"scope": scope, "field": field})
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
            emit_input_progress("password", "target_refresh_started", "owner")
            try:
                scope, field = wait_for_password_target(
                    root_page,
                    timeout_s=PASSWORD_TARGET_REFRESH_TIMEOUT_S,
                    pause=pause,
                )
            except Exception as refresh_error:
                raise RuntimeError("password input verification failed") from refresh_error
            emit_input_progress("password", "target_refresh_resolved", "owner")
            if target_holder is not None:
                target_holder.update({"scope": scope, "field": field})
            readable, actual = read_element_input_value(field)
            refresh_state = classify_input_read(readable, actual, value)
            emit_input_progress(
                "password",
                f"target_refresh_value_{refresh_state}",
                "owner",
            )
            if readable and str(actual) == value:
                emit_input_progress("password", "verified", "owner")
                return scope
            if not readable or str(actual) != "":
                raise RuntimeError("password input verification failed")
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

        if (
            scope is not root_page
            and action_scope is root_page
            and not (label == "password" and password_keyboard_retry_required)
        ):
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
            candidate_scope, candidate_element = wait_for_password_target(
                root_page,
                timeout_s=15,
                pause=pause,
            )
            refreshed_target: dict[str, Any] = {
                "scope": candidate_scope,
                "field": candidate_element,
            }
            input_and_verify(
                candidate_scope,
                candidate_element,
                password_value,
                "password",
                keys,
                pause=pause,
                root_page=root_page,
                target_holder=refreshed_target,
            )
            candidate_scope = refreshed_target["scope"]
            candidate_element = refreshed_target["field"]
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


def detect_shadow_root_state(root: Any) -> dict[str, Any]:
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
                  codeInputCount: 0,
                  password: false,
                  email: false,
                  trustPrompt: false,
                  otpRejected: false,
                  blocked: false,
                  assertiveAuthenticationError: false,
                  hardAuthenticationError: false,
                  genericAuthText: false,
                  securityFeatureCopy: false,
                  error: false
                });
              }
              const visible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = el.ownerDocument?.defaultView?.getComputedStyle(el);
                return rect.width > 2 && rect.height > 2 &&
                  style?.display !== 'none' && style?.visibility !== 'hidden' &&
                  !el.disabled && el.getAttribute('aria-disabled') !== 'true';
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
              const password = targets.some((el) =>
                el.tagName === 'INPUT' &&
                String(el.type || '').toLowerCase() === 'password'
              );
              const email = targets.some((el) => {
                const type = String(el.type || '').toLowerCase();
                const autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
                const name = String(el.getAttribute('name') || '').toLowerCase();
                const id = String(el.getAttribute('id') || '').toLowerCase();
                return (el.tagName === 'INPUT' && type === 'email') ||
                  autocomplete === 'username' ||
                  autocomplete === 'email' ||
                  /account[_-]?name|username/.test(`${name} ${id}`);
              });
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
              const hasStaticAccountSecurityFeatureCard = () => {
                const featurePattern = /two[-\s]?factor|two[-\s]?step|\u53cc\u91cd\u8ba4\u8bc1|\u96d9\u91cd\u9a57\u8b49|\u96d9\u91cd\u8a8d\u8b49/i;
                const contextPattern = /account security|trusted (?:phone|device)|\u8d26\u6237\u5b89\u5168|\u5e33\u6236\u5b89\u5168|\u53d7\u4fe1\u4efb(?:\u7535\u8bdd|\u96fb\u8a71|\u8bbe\u5907|\u8a2d\u5099)/i;
                const failurePattern = /\berror\b|something went wrong|incorrect|invalid|expired|wrong password|try again|unable to sign in|\u65e0\u6cd5\u767b\u5f55|\u7121\u6cd5\u767b\u5165|\u9519\u8bef|\u932f\u8aa4|\u4e0d\u6b63\u786e|\u4e0d\u6b63\u78ba|\u65e0\u6548|\u7121\u6548/i;
                const textFor = (el) => String(
                  typeof el?.innerText === 'string' ? el.innerText : (el?.textContent || '')
                ).replace(/\s+/g, ' ').trim();
                const isAssertive = (el) => {
                  let current = el;
                  for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
                    const role = String(current.getAttribute('role') || '').toLowerCase();
                    const live = String(current.getAttribute('aria-live') || '').toLowerCase();
                    if (role === 'alert' || live === 'assertive') return true;
                  }
                  return false;
                };
                return visibleTextElements.some((leaf) => {
                  if (!featurePattern.test(textFor(leaf))) return false;
                  let current = leaf;
                  for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
                    if (!visible(current) || isAssertive(current)) continue;
                    const cardText = textFor(current);
                    if (failurePattern.test(cardText)) continue;
                    if (featurePattern.test(cardText) && contextPattern.test(cardText)) return true;
                  }
                  return false;
                });
              };
              const normalizedBody = body.replace(/\s+/g, ' ');
              const otpRejected = /__OTP_REJECTION_PATTERN__/i.test(normalizedBody);
              const blocked = /captcha|locked|account locked|被锁定|被鎖定|账户锁定|帳戶鎖定/i.test(body);
              const assertiveAuthenticationError = visibleTextElements.some((el) => {
                const text = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
                if (!/unable to sign in|something went wrong|incorrect|invalid|expired|wrong password|try again|\u65e0\u6cd5\u767b\u5f55|\u7121\u6cd5\u767b\u5165|\u9519\u8bef|\u932f\u8aa4|\u4e0d\u6b63\u786e|\u4e0d\u6b63\u78ba|\u65e0\u6548|\u7121\u6548/i.test(text)) return false;
                let current = el;
                for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
                  const role = String(current.getAttribute('role') || '').toLowerCase();
                  const live = String(current.getAttribute('aria-live') || '').toLowerCase();
                  if (role === 'alert' || live === 'assertive') return true;
                }
                return false;
              });
              const unableToSignInPattern = /unable to sign in|\u65e0\u6cd5\u767b\u5f55|\u7121\u6cd5\u767b\u5165/i;
              const recoveryOnlyUnableToSignIn = /(?:unable to sign in)[\s\S]{0,180}\b(?:recover|recovery)\b|\u65e0\u6cd5\u767b\u5f55[\s\S]{0,60}(?:\u6062\u590d|\u5fa9\u539f)|\u7121\u6cd5\u767b\u5165[\s\S]{0,60}(?:\u6062\u5fa9|\u5fa9\u539f)/i;
              const recoveryContextFor = (el) => {
                const context = [];
                let current = el;
                for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
                  if (!visible(current)) continue;
                  const text = String(
                    typeof current.innerText === 'string' ? current.innerText : (current.textContent || '')
                  ).replace(/\s+/g, ' ').trim();
                  if (text && text.length <= 720) context.push(text);
                }
                for (const sibling of [el.previousElementSibling, el.nextElementSibling]) {
                  if (!sibling || !visible(sibling)) continue;
                  const text = String(
                    typeof sibling.innerText === 'string' ? sibling.innerText : (sibling.textContent || '')
                  ).replace(/\s+/g, ' ').trim();
                  if (text && text.length <= 240) context.push(text);
                }
                return context.join('\n');
              };
              const unableToSignInElements = visibleTextElements.filter((el) => {
                const text = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
                return unableToSignInPattern.test(text);
              });
              const unableToSignInLeaves = unableToSignInElements.filter((el) =>
                !unableToSignInElements.some((candidate) =>
                  candidate !== el && typeof el.contains === 'function' && el.contains(candidate)
                )
              );
              const nonRecoveryUnableToSignIn = unableToSignInLeaves.some((el) =>
                !recoveryOnlyUnableToSignIn.test(recoveryContextFor(el))
              );
              const hardAuthenticationError =
                /\berror\b|something went wrong|incorrect|invalid|expired|wrong password|try again|\u9519\u8bef|\u932f\u8aa4|\u4e0d\u6b63\u786e|\u4e0d\u6b63\u78ba|\u65e0\u6548|\u7121\u6548/i.test(body) ||
                assertiveAuthenticationError ||
                nonRecoveryUnableToSignIn;
              const genericAuthText =
                hardAuthenticationError ||
                unableToSignInPattern.test(body);
              const securityFeatureCopy = hasStaticAccountSecurityFeatureCard();
              return JSON.stringify({
                hasStrongText: strongTwoFactorText,
                semanticTargetCount: semanticTargets.length,
                digitCellCount: digitCells.length,
                codeInputCount: new Set([
                  ...semanticTargets,
                  ...(digitCells.length === 6 ? digitCells : [])
                ]).size,
                password,
                email,
                trustPrompt: /trust this browser|信任此浏览器|信任此瀏覽器/i.test(body),
                otpRejected,
                blocked,
                assertiveAuthenticationError,
                hardAuthenticationError,
                genericAuthText,
                securityFeatureCopy,
                error: otpRejected || blocked || genericAuthText
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
        semantic_target_count = int(evidence.get("semanticTargetCount") or 0)
        digit_cell_count = int(evidence.get("digitCellCount") or 0)
        raw_code_input_count = evidence.get("codeInputCount")
        code_input_count = (
            raw_code_input_count
            if type(raw_code_input_count) is int and raw_code_input_count >= 0
            else None
        )
        return {
            "twofa": classify_strong_two_factor(
                has_strong_text=evidence.get("hasStrongText") is True,
                semantic_target_count=semantic_target_count,
                digit_cell_count=digit_cell_count,
            ),
            "hasStrongText": evidence.get("hasStrongText") is True,
            "securityFeatureCopy": evidence.get("securityFeatureCopy") is True,
            "assertiveAuthenticationError": evidence.get("assertiveAuthenticationError")
            is True,
            "hardAuthenticationError": evidence.get("hardAuthenticationError")
            is True,
            "genericAuthText": evidence.get("genericAuthText") is True,
            "codeInputCount": code_input_count,
            "password": evidence.get("password") is True,
            "email": evidence.get("email") is True,
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
      if (expectedPrompt === 'trust') {
        // Apple's Trust action itself can live inside a fieldset which only
        // contains the buttons.  The title is often one or two containers
        // higher, so inspect a bounded chain of *visible* ancestors instead
        // of accepting the first closest fieldset.  Never fall through to
        // body/html: unrelated account text must not authorize a click.
        let current = this;
        for (let depth = 0; current && depth < 12; depth += 1) {
          const tag = String(current.tagName || '').toLowerCase();
          if (tag === 'body' || tag === 'html') break;
          if (visible(current)) {
            const text = String(current.innerText || current.textContent || '');
            if (/trust this browser|信任此浏览器|信任此瀏覽器/i.test(text)) {
              return true;
            }
          }
          current = current.parentElement;
        }
        return false;
      }
      const container = this.closest([
        'form', '[role="dialog"]', '[aria-modal="true"]', 'fieldset',
        '.si-container', '.signin-container', '.auth-content',
        '.security-code-input', '.form-security-code-inputs', 'hsa2-sk7'
      ].join(', '));
      if (!container || !visible(container)) return false;
      const text = container.innerText || '';
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
    candidates: list[tuple[Any, Any]] = []
    seen: set[tuple[int, int]] = set()
    for scope, root in current_element_search_roots(page):
        try:
            state = detect_scope_login_state(scope)
            trusted_scope_url = trusted_two_factor_scope_url(scope)
        except Exception:
            continue
        if state.get("trustPrompt") is not True:
            continue
        if trusted_scope_url is None:
            continue
        if scope is not page and not scope_has_live_frame_chain(page, scope):
            continue
        for selector in ("css:button",):
            for button in safe_elements(root, selector, timeout_s=0):
                if not element_is_interactable(button):
                    continue
                try:
                    text = str(button.text or "").strip()
                except Exception:
                    text = ""
                if not text:
                    for name in ("aria-label", "value", "title"):
                        try:
                            value = button.attr(name)
                        except Exception:
                            continue
                        if value is not None and str(value).strip():
                            text = str(value).strip()
                            break
                if REJECT_TRUST_RE.search(text) or not TRUST_BUTTON_RE.fullmatch(text):
                    continue
                if not button_has_prompt_semantics(button, "trust"):
                    continue
                identity = (id(scope), id(button))
                if identity in seen:
                    continue
                seen.add(identity)
                candidates.append((scope, button))
    if len(candidates) != 1:
        return False
    scope, button = candidates[0]
    pause(320, 760)
    human_click(scope, button, pause=pause)
    return True


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
          const visibleTextElements = [...document.querySelectorAll('*')]
            .filter(visible)
            .filter((el) => !['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(el.tagName));
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
          const password = inputs.some((el) =>
            String(el.type || '').toLowerCase() === 'password'
          );
          const email = inputs.some((el) => {
            const type = String(el.type || '').toLowerCase();
            const autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
            const name = String(el.getAttribute('name') || '').toLowerCase();
            const id = String(el.getAttribute('id') || '').toLowerCase();
            return type === 'email' ||
              autocomplete === 'username' ||
              autocomplete === 'email' ||
              /account[_-]?name|username/.test(`${name} ${id}`);
          });
          const hasStaticAccountSecurityFeatureCard = () => {
            const featurePattern = /two[-\s]?factor|two[-\s]?step|\u53cc\u91cd\u8ba4\u8bc1|\u96d9\u91cd\u9a57\u8b49|\u96d9\u91cd\u8a8d\u8b49/i;
            const contextPattern = /account security|trusted (?:phone|device)|\u8d26\u6237\u5b89\u5168|\u5e33\u6236\u5b89\u5168|\u53d7\u4fe1\u4efb(?:\u7535\u8bdd|\u96fb\u8a71|\u8bbe\u5907|\u8a2d\u5099)/i;
            const failurePattern = /\berror\b|something went wrong|incorrect|invalid|expired|wrong password|try again|unable to sign in|\u65e0\u6cd5\u767b\u5f55|\u7121\u6cd5\u767b\u5165|\u9519\u8bef|\u932f\u8aa4|\u4e0d\u6b63\u786e|\u4e0d\u6b63\u78ba|\u65e0\u6548|\u7121\u6548/i;
            const textFor = (el) => String(
              typeof el?.innerText === 'string' ? el.innerText : (el?.textContent || '')
            ).replace(/\s+/g, ' ').trim();
            const isAssertive = (el) => {
              let current = el;
              for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
                const role = String(current.getAttribute('role') || '').toLowerCase();
                const live = String(current.getAttribute('aria-live') || '').toLowerCase();
                if (role === 'alert' || live === 'assertive') return true;
              }
              return false;
            };
            return visibleTextElements.some((leaf) => {
              if (!featurePattern.test(textFor(leaf))) return false;
              let current = leaf;
              for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
                if (!visible(current) || isAssertive(current)) continue;
                const cardText = textFor(current);
                if (failurePattern.test(cardText)) continue;
                if (featurePattern.test(cardText) && contextPattern.test(cardText)) return true;
              }
              return false;
            });
          };
          const normalizedBody = body.replace(/\s+/g, ' ');
          const otpRejected = /__OTP_REJECTION_PATTERN__/i.test(normalizedBody);
          const blocked = /captcha|locked|account locked|被锁定|被鎖定|账户锁定|帳戶鎖定/i.test(body);
          const assertiveAuthenticationError = visibleTextElements.some((el) => {
            const text = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
            if (!/unable to sign in|something went wrong|incorrect|invalid|expired|wrong password|try again|\u65e0\u6cd5\u767b\u5f55|\u7121\u6cd5\u767b\u5165|\u9519\u8bef|\u932f\u8aa4|\u4e0d\u6b63\u786e|\u4e0d\u6b63\u78ba|\u65e0\u6548|\u7121\u6548/i.test(text)) return false;
            let current = el;
            for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
              const role = String(current.getAttribute('role') || '').toLowerCase();
              const live = String(current.getAttribute('aria-live') || '').toLowerCase();
              if (role === 'alert' || live === 'assertive') return true;
            }
            return false;
          });
          const unableToSignInPattern = /unable to sign in|\u65e0\u6cd5\u767b\u5f55|\u7121\u6cd5\u767b\u5165/i;
          const recoveryOnlyUnableToSignIn = /(?:unable to sign in)[\s\S]{0,180}\b(?:recover|recovery)\b|\u65e0\u6cd5\u767b\u5f55[\s\S]{0,60}(?:\u6062\u590d|\u5fa9\u539f)|\u7121\u6cd5\u767b\u5165[\s\S]{0,60}(?:\u6062\u5fa9|\u5fa9\u539f)/i;
          const recoveryContextFor = (el) => {
            const context = [];
            let current = el;
            for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
              if (!visible(current)) continue;
              const text = String(
                typeof current.innerText === 'string' ? current.innerText : (current.textContent || '')
              ).replace(/\s+/g, ' ').trim();
              if (text && text.length <= 720) context.push(text);
            }
            for (const sibling of [el.previousElementSibling, el.nextElementSibling]) {
              if (!sibling || !visible(sibling)) continue;
              const text = String(
                typeof sibling.innerText === 'string' ? sibling.innerText : (sibling.textContent || '')
              ).replace(/\s+/g, ' ').trim();
              if (text && text.length <= 240) context.push(text);
            }
            return context.join('\n');
          };
          const unableToSignInElements = visibleTextElements.filter((el) => {
            const text = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
            return unableToSignInPattern.test(text);
          });
          const unableToSignInLeaves = unableToSignInElements.filter((el) =>
            !unableToSignInElements.some((candidate) =>
              candidate !== el && typeof el.contains === 'function' && el.contains(candidate)
            )
          );
          const nonRecoveryUnableToSignIn = unableToSignInLeaves.some((el) =>
            !recoveryOnlyUnableToSignIn.test(recoveryContextFor(el))
          );
          const hardAuthenticationError =
            /\berror\b|something went wrong|incorrect|invalid|expired|wrong password|try again|\u9519\u8bef|\u932f\u8aa4|\u4e0d\u6b63\u786e|\u4e0d\u6b63\u78ba|\u65e0\u6548|\u7121\u6548/i.test(body) ||
            assertiveAuthenticationError ||
            nonRecoveryUnableToSignIn;
          const genericAuthText =
            hardAuthenticationError ||
            unableToSignInPattern.test(body);
          const error = otpRejected || blocked || genericAuthText;
          const strongTwoFactorText = /two-factor|verification code|security code|one-time code|\u53cc\u91cd\u8ba4\u8bc1|\u96d9\u91cd\u9a57\u8b49|\u96d9\u91cd\u8a8d\u8b49|\u9a8c\u8bc1\u7801|\u9a57\u8b49\u78bc/i.test(body);
          const securityFeatureCopy = hasStaticAccountSecurityFeatureCard();
          const trustPrompt = /trust this browser|\u4fe1\u4efb\u6b64\u6d4f\u89c8\u5668|\u4fe1\u4efb\u6b64\u700f\u89bd\u5668/i.test(body);
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
            assertiveAuthenticationError,
            hardAuthenticationError,
            genericAuthText,
            securityFeatureCopy,
            accountManage: (() => {
              const currentUrl = new URL(href);
              return currentUrl.protocol === 'https:' &&
                currentUrl.hostname === 'account.apple.com' &&
                (
                  currentUrl.pathname === '/account/manage' ||
                  currentUrl.pathname.startsWith('/account/manage/')
                );
            })(),
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
    state["securityFeatureCopy"] = state.get("securityFeatureCopy") is True
    if state.get("accountManage") is True:
        state = normalize_account_manage_security_copy_state(state)
    if "accountManage" in state:
        state["trusted"] = bool(
            state.get("accountManage")
            and state.get("accountMarker")
            and not state.get("password")
            and not state.get("email")
            and not state["twofa"]
            and not state.get("error")
            and not state.get("otpRejected")
            and not state.get("blocked")
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


def is_account_manage_root_url(url: str) -> bool:
    parsed = parse_valid_apple_url(url)
    return bool(
        parsed is not None
        and (parsed.hostname or "").lower() == "account.apple.com"
        and parsed.path == "/account/manage"
    )


def is_account_sign_in_url(url: str) -> bool:
    parsed = parse_valid_apple_url(url)
    return bool(
        parsed is not None
        and (parsed.hostname or "").lower() in ACCOUNT_SIGN_IN_HOSTS
        and parsed.path == ACCOUNT_SIGN_IN_PATH
    )


def is_developer_account_url(url: str) -> bool:
    parsed = urlsplit(str(url or "").strip())
    return bool(
        parsed.scheme == "https"
        and (parsed.hostname or "").lower() == "developer.apple.com"
        and parsed.username is None
        and parsed.password is None
        and parsed.port in (None, 443)
        and (
            parsed.path.rstrip("/") == "/account"
            or parsed.path.startswith("/account/")
        )
    )


def is_personal_information_url(url: str) -> bool:
    parsed = parse_valid_apple_url(url)
    return bool(
        parsed is not None
        and (parsed.hostname or "").lower() == "account.apple.com"
        and parsed.path == PERSONAL_INFORMATION_PATH
    )


def has_live_auth_controls(state: dict[str, Any]) -> bool:
    """Return whether a scope still exposes an editable authentication control."""
    code_input_count = state.get("codeInputCount")
    return bool(
        state.get("password")
        or state.get("email")
        or state.get("trustPrompt")
        or (type(code_input_count) is int and code_input_count > 0)
    )


def is_recoverable_account_sign_in_state(
    page: Any,
    state: dict[str, Any],
) -> bool:
    current_url = scope_location_url(page)
    developer_child_sign_in = bool(
        is_developer_account_url(current_url)
        and state.get("childAuthUiPresent") is True
    )
    return bool(
        (is_account_sign_in_url(current_url) or developer_child_sign_in)
        and (state.get("email") is True or state.get("password") is True)
        and state.get("blocked") is not True
        and state.get("otpRejected") is not True
        and state.get("activeBlocked") is not True
        and state.get("activeOtpRejected") is not True
    )


def normalize_account_manage_security_copy_state(state: dict[str, Any]) -> dict[str, Any]:
    """Ignore account-manage prose that merely describes security features."""
    has_security_copy = state.get("securityFeatureCopy") is True
    if not (
        has_security_copy
        and not state.get("hardAuthenticationError")
        and not state.get("otpRejected")
        and not state.get("blocked")
        and not has_live_auth_controls(state)
    ):
        return state
    return {
        **state,
        "twofa": False,
        "error": False,
        "securityCopyOnly": True,
    }


def is_retiring_post_otp_child_error(state: dict[str, Any]) -> bool:
    """Recognize an old idmsa error shell after the account root has won."""
    code_input_count = state.get("codeInputCount")
    return bool(
        (state.get("error") or state.get("otpRejected"))
        and not state.get("blocked")
        and not has_live_auth_controls(state)
        # A missing count is not proof that the widget has disappeared. This
        # fails closed so live Shadow DOM OTP cells can never be ignored.
        and type(code_input_count) is int
        and code_input_count == 0
    )


def confirmed_account_manage_state(
    page: Any,
    *,
    allow_retiring_child_errors: bool = False,
) -> dict[str, Any] | None:
    """Accept the account root redirect only when no live auth UI contradicts it."""
    if not browser_connection_is_alive(page):
        return None
    current_url = scope_location_url(page)
    if not is_account_manage_url(current_url):
        return None

    # The URL can change before account-page text has hydrated, so do not
    # require an account marker here. We still query the root again and every
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
    root_redirect_ready = False
    root_account_marker = False
    root_security_copy_only = False
    retiring_child_error = False
    child_auth_ui_present = False
    for scope in iter_page_scopes(page):
        try:
            state = detect_scope_login_state(scope)
        except Exception:
            if scope is page:
                return None
            continue
        if scope is page:
            root_state = state
            # This is the second independent root read after current_url above.
            # A matching account/manage URL plus no root blocker is the narrow
            # post-OTP redirect anchor, even before account HTML hydrates.
            if not is_account_manage_url(str(state.get("href") or "")):
                return None
            if any(bool(state.get(key)) for key in blockers):
                return None
            root_redirect_ready = True
            root_account_marker = bool(state.get("accountMarker"))
            root_security_copy_only = bool(state.get("securityCopyOnly"))
        else:
            if not is_trusted_two_factor_scope(scope, str(state.get("href") or "")):
                continue
            if not scope_has_live_frame_chain(page, scope):
                continue
            child_auth_ui_present = child_auth_ui_present or has_live_auth_controls(state)
            if state.get("blocked") or has_live_auth_controls(state):
                return None
            if state.get("error") or state.get("otpRejected"):
                retiring = is_retiring_post_otp_child_error(state)
                if not (
                    allow_retiring_child_errors
                    and root_redirect_ready
                    and retiring
                ):
                    return None
                retiring_child_error = True

        if not is_trusted_two_factor_scope(scope, str(state.get("href") or "")):
            continue
        try:
            shadow_roots = scope.shadow_roots(mode="all", include_frames=False)
        except Exception:
            shadow_roots = []
        for root in list(shadow_roots or []):
            shadow_state = detect_shadow_root_state(root)
            if scope is page:
                if root_redirect_ready:
                    shadow_state = normalize_account_manage_security_copy_state(shadow_state)
                    root_security_copy_only = (
                        root_security_copy_only
                        or shadow_state.get("securityCopyOnly") is True
                    )
                if any(bool(shadow_state.get(key)) for key in blockers):
                    return None
                continue
            if not scope_has_live_frame_chain(page, scope):
                continue
            child_auth_ui_present = child_auth_ui_present or has_live_auth_controls(shadow_state)
            if shadow_state.get("blocked") or has_live_auth_controls(shadow_state):
                return None
            if shadow_state.get("error") or shadow_state.get("otpRejected"):
                retiring = is_retiring_post_otp_child_error(shadow_state)
                if not (
                    allow_retiring_child_errors
                    and root_redirect_ready
                    and retiring
                ):
                    return None
                retiring_child_error = True

    if root_state is None or child_auth_ui_present:
        return None
    return {
        **root_state,
        "href": current_url,
        "accountManage": True,
        "rootManageUrl": True,
        "rootAccountMarker": root_account_marker,
        "rootSecurityCopyOnly": root_security_copy_only,
        "retiringChildError": retiring_child_error,
        "childAuthUiPresent": child_auth_ui_present,
        "rootSessionTrusted": True,
        "rootError": False,
        "trusted": True,
    }

def detect_login_state(page: Any) -> dict[str, Any]:
    scope_states: list[tuple[Any, dict[str, Any]]] = []
    root_state: dict[str, Any] | None = None
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
                    if scope is page and is_account_manage_url(
                        str(state.get("href") or "")
                    ):
                        shadow_state = normalize_account_manage_security_copy_state(
                            shadow_state
                        )
                    for key in (
                        "twofa",
                        "trustPrompt",
                        "otpRejected",
                        "blocked",
                        "error",
                        "hardAuthenticationError",
                        "password",
                        "email",
                    ):
                        if shadow_state.get(key):
                            state = {**state, key: True}
                    shadow_code_input_count = shadow_state.get("codeInputCount")
                    scope_code_input_count = state.get("codeInputCount")
                    if (
                        type(shadow_code_input_count) is int
                        and shadow_code_input_count > 0
                        and (
                            type(scope_code_input_count) is not int
                            or shadow_code_input_count > scope_code_input_count
                        )
                    ):
                        state = {**state, "codeInputCount": shadow_code_input_count}
                    if shadow_state.get("securityCopyOnly") is True:
                        state = {**state, "securityCopyOnly": True}
            scope_states.append((scope, state))
            # The top-level document is the only authoritative source for
            # rootManageUrl/rootError. A readable child cannot substitute for
            # an unreadable root and make the observation look complete.
            if scope is page:
                root_state = state

    if root_state is None:
        raise RuntimeError("unable to inspect login page state through ruyiPage")

    root_href = str(root_state.get("href") or "")
    root_is_account_manage = is_account_manage_url(root_href)
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
    root_hard_authentication_error = bool(root_state.get("hardAuthenticationError"))
    has_live_descendant_auth_controls = any(
        is_trusted_two_factor_scope(scope, str(state.get("href") or ""))
        and scope_has_live_frame_chain(page, scope)
        and has_live_auth_controls(state)
        for scope, state in scope_states
        if scope is not page
    )
    live_descendant_error_states = [
        state
        for scope, state in scope_states
        if scope is not page
        and is_trusted_two_factor_scope(scope, str(state.get("href") or ""))
        and scope_has_live_frame_chain(page, scope)
        and any(bool(state.get(key)) for key in ("error", "otpRejected", "blocked"))
    ]
    has_live_descendant_error = bool(live_descendant_error_states)
    active_auth_ui_present = bool(
        has_live_auth_controls(root_state)
        or has_live_descendant_auth_controls
    )
    active_otp_rejected = bool(
        root_state.get("otpRejected")
        or any(state.get("otpRejected") for state in live_descendant_error_states)
    )
    active_blocked = bool(
        root_state.get("blocked")
        or any(state.get("blocked") for state in live_descendant_error_states)
    )
    hard_authentication_error = bool(
        root_hard_authentication_error
        or any(
            scope is not page
            and is_trusted_two_factor_scope(scope, str(state.get("href") or ""))
            and scope_has_live_frame_chain(page, scope)
            and state.get("hardAuthenticationError")
            for scope, state in scope_states
        )
    )
    has_retiring_child_error = bool(live_descendant_error_states) and all(
        is_retiring_post_otp_child_error(state)
        for state in live_descendant_error_states
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
        and not has_live_descendant_auth_controls
        and not has_live_descendant_error
    )
    legacy_session_trusted = bool(
        not has_auth_ui
        and root_is_account_manage
        and has_apple_account_marker
        and not root_error
        and not has_live_descendant_auth_controls
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
        "hardAuthenticationError": hard_authentication_error,
        "rootHardAuthenticationError": root_hard_authentication_error,
        "activeAuthUiPresent": active_auth_ui_present,
        "activeOtpRejected": active_otp_rejected,
        "activeBlocked": active_blocked,
        "rootManageUrl": root_is_account_manage,
        "rootAccountMarker": bool(root_state.get("accountMarker")),
        "rootSecurityCopyOnly": root_state.get("securityCopyOnly") is True,
        "rootSessionTrusted": root_session_trusted,
        "retiringChildError": has_retiring_child_error,
        "childAuthUiPresent": has_live_descendant_auth_controls,
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


DEVELOPER_MEMBERSHIP_NAVIGATION_LABELS = frozenset(
    {
        "membership details",
        "\u4f1a\u5458\u8d44\u683c\u8be6\u7ec6\u4fe1\u606f",
        "\u4f1a\u5458\u8d44\u683c\u8be6\u60c5",
        "\u6703\u54e1\u8cc7\u683c\u8a73\u7d30\u8cc7\u8a0a",
        "\u6703\u54e1\u8cc7\u683c\u8a73\u60c5",
    }
)
DEVELOPER_NAVIGATION_SELECTORS = (
    "css:main li",
    "css:[class*='DeveloperTabNav'] li",
    "css:a",
    "css:button",
    "css:[role='link']",
    "css:[role='button']",
)
DEVELOPER_MEMBERSHIP_CARD_SELECTORS = (
    "css:[id*='MembershipDetailsCard']",
    "css:[id*='membershipDetailsCard']",
    "css:[class*='MembershipDetailsCard']",
    "css:[class*='membershipDetailsCard']",
    "css:[data-testid*='MembershipDetailsCard']",
    "css:[data-testid*='membershipDetailsCard']",
    "css:[id*='membership-details']",
    "css:[class*='membership-details']",
    "css:[data-testid*='membership-details']",
)
DEVELOPER_MEMBERSHIP_CARD_SCROLL_ATTEMPTS = 3


def developer_account_snapshot(page: Any) -> dict[str, bool | int]:
    """Return fixed Developer account evidence without exposing raw page text."""
    if not is_developer_account_url(scope_location_url(page)):
        return {
            "authenticated": False,
            "accountShell": False,
            "accountHeading": False,
            "navigationFeatureCount": 0,
            "tabNavigationSeen": False,
            "joinProgram": False,
            "membershipNavigation": False,
        }
    raw = page.run_js(
        r"""
        return JSON.stringify((() => {
          // ruyipage-developer-account-snapshot
          const visible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 2 && rect.height > 2 &&
              style.display !== 'none' && style.visibility !== 'hidden' &&
              el.getAttribute('aria-hidden') !== 'true';
          };
          const normalize = (value) => String(value || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLocaleLowerCase();
          const tabNavigation = [...document.querySelectorAll(
            '[class*="DeveloperTabNav"]'
          )].filter(visible);
          const semantic = [...new Set([
            ...document.querySelectorAll(
              'main [role="alert"], main h1, main h2, main h3, main li, main a, main button, ' +
              'main [role="link"], main [role="button"], h1, h2, h3, [role="heading"], [role="alert"], ' +
              '[class*="DeveloperTabNav"] li, [class*="DeveloperTabNav"] a, ' +
              '[class*="DeveloperTabNav"] button, [class*="DeveloperTabNav"] [role="link"], ' +
              '[class*="DeveloperTabNav"] [role="button"]'
            )
          ])].filter(visible);
          const labels = semantic.map((el) => normalize(
            el.getAttribute('aria-label') || el.innerText || el.textContent || ''
          )).filter(Boolean);
          const joinProgram = labels.some((label) =>
            label.includes('join apple developer program') ||
            label.includes('\u52a0\u5165 apple developer program')
          );
          const membershipLabels = new Set([
            'membership details',
            '\u4f1a\u5458\u8d44\u683c\u8be6\u7ec6\u4fe1\u606f',
            '\u4f1a\u5458\u8d44\u683c\u8be6\u60c5',
            '\u6703\u54e1\u8cc7\u683c\u8a73\u7d30\u8cc7\u8a0a',
            '\u6703\u54e1\u8cc7\u683c\u8a73\u60c5'
          ]);
          const membershipNavigation = labels.some((label) =>
            membershipLabels.has(label)
          );
          const accountHeading = labels.some((label) =>
            label === 'account' || label === '\u8d26\u6237' || label === '\u5e33\u6236'
          );
          const featureLabels = [
            [
              'tools and resources',
              'program resources',
              '\u8ba1\u5212\u8d44\u6e90',
              '\u5de5\u5177\u548c\u8d44\u6e90',
              '\u5de5\u5177\u8207\u8cc7\u6e90'
            ],
            ['personal details', '\u4e2a\u4eba\u8d44\u6599', '\u500b\u4eba\u8cc7\u6599'],
            ['email', '\u7535\u5b50\u90ae\u4ef6', '\u96fb\u5b50\u90f5\u4ef6'],
            ['agreements', '\u534f\u8bae', '\u5354\u8b70']
          ];
          const labelMatches = (label, expected) => expected.some((token) =>
            label === token ||
            label.startsWith(`${token} `) ||
            label.startsWith(`${token}:`) ||
            label.startsWith(`${token}\uFF1A`)
          );
          const featureCount = featureLabels.filter((expected) =>
            labels.some((label) => labelMatches(label, expected))
          ).length;
          const accountShell = (accountHeading || tabNavigation.length > 0) &&
            featureCount >= 2;
          return {
            authenticated: accountShell,
            accountShell,
            accountHeading,
            navigationFeatureCount: featureCount,
            tabNavigationSeen: tabNavigation.length > 0,
            joinProgram,
            membershipNavigation
          };
        })())
        """
    )
    try:
        result = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError, ValueError):
        result = None
    if not isinstance(result, dict):
        raise RuntimeError("developer account query returned an invalid result")
    return {
        "authenticated": result.get("authenticated") is True,
        "accountShell": result.get("accountShell") is True,
        "accountHeading": result.get("accountHeading") is True,
        "navigationFeatureCount": min(
            4,
            max(
                0,
                (
                    int(result.get("navigationFeatureCount") or 0)
                    if type(result.get("navigationFeatureCount")) is int
                    else 0
                ),
            ),
        ),
        "tabNavigationSeen": result.get("tabNavigationSeen") is True,
        "joinProgram": result.get("joinProgram") is True,
        "membershipNavigation": result.get("membershipNavigation") is True,
    }


def developer_state_has_auth_blocker(
    state: dict[str, Any],
    *,
    allow_text_only_error: bool,
) -> bool:
    """Classify one live Developer document or open Shadow DOM state."""
    if not state:
        return True
    if any(
        bool(state.get(key))
        for key in (
            "email",
            "password",
            "twofa",
            "trustPrompt",
            "otpRejected",
            "blocked",
        )
    ):
        return True
    # ``error`` alone is deliberately not enough to reject a verified
    # Developer shell: the page contains static recovery/security copy that
    # can match the broad classifier.  A visible assertive error is actual
    # live auth UI, even when its controls have not hydrated yet.
    if state.get("assertiveAuthenticationError") is True:
        return True
    return state.get("error") is True and not allow_text_only_error


def developer_scope_has_auth_blocker(
    page: Any,
    *,
    allow_root_text_only_error: bool = False,
    allow_retiring_child_text_only_error: bool = False,
) -> bool:
    """Reject live Developer auth UI across documents and open Shadow DOM."""
    root_is_developer_account = is_developer_account_url(scope_location_url(page))
    for scope in iter_page_scopes(page):
        href = scope_location_url(scope)
        if scope is not page:
            if (
                parse_valid_apple_url(href) is None
                and not is_opaque_two_factor_frame_url(href)
            ):
                continue
            if not scope_has_live_frame_chain(page, scope):
                continue
        try:
            state = detect_scope_login_state(scope)
        except Exception:
            return True
        allow_scope_text_only_error = bool(
            (allow_root_text_only_error and scope is page)
            or (
                allow_retiring_child_text_only_error
                and root_is_developer_account
                and scope is not page
                and is_retiring_post_otp_child_error(state)
            )
        )
        if developer_state_has_auth_blocker(
            state,
            allow_text_only_error=allow_scope_text_only_error,
        ):
            return True
        try:
            shadow_roots = scope.shadow_roots(mode="all", include_frames=False)
        except Exception:
            return True
        for root in list(shadow_roots or []):
            shadow_state = detect_shadow_root_state(root)
            allow_shadow_text_only_error = bool(
                allow_scope_text_only_error
                or (
                    allow_retiring_child_text_only_error
                    and root_is_developer_account
                    and scope is not page
                    and is_retiring_post_otp_child_error(shadow_state)
                )
            )
            if developer_state_has_auth_blocker(
                shadow_state,
                allow_text_only_error=allow_shadow_text_only_error,
            ):
                return True
    return False


def confirmed_developer_account_state(page: Any) -> dict[str, Any] | None:
    """Confirm the Developer shell while failing closed on live auth controls."""
    if not browser_connection_is_alive(page):
        return None
    try:
        snapshot = developer_account_snapshot(page)
    except Exception:
        return None
    if (
        snapshot.get("accountShell") is not True
        or developer_scope_has_auth_blocker(
            page,
            allow_root_text_only_error=True,
            allow_retiring_child_text_only_error=True,
        )
    ):
        return None
    return {
        "href": DEVELOPER_ACCOUNT_URL,
        "trusted": True,
        "rootSessionTrusted": True,
        "rootError": False,
        "developerAccount": True,
        "developerAccountShell": True,
        "joinProgram": snapshot["joinProgram"],
        "membershipNavigation": snapshot["membershipNavigation"],
    }


def developer_navigation_summary(element: Any) -> dict[str, Any]:
    raw = element.run_js(
        r"""
        function () {
          // ruyipage-developer-membership-navigation
          const rect = this.getBoundingClientRect();
          const style = window.getComputedStyle(this);
          return JSON.stringify({
            visible: rect.width > 2 && rect.height > 2 &&
              style.display !== 'none' && style.visibility !== 'hidden' &&
              this.getAttribute('aria-hidden') !== 'true',
            label: String(
              this.getAttribute('aria-label') ||
              this.innerText ||
              this.textContent ||
              ''
            ).replace(/\s+/g, ' ').trim().toLocaleLowerCase()
          });
        }
        """
    )
    try:
        result = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError, ValueError):
        result = None
    if not isinstance(result, dict):
        raise RuntimeError("developer membership navigation query returned an invalid result")
    return {
        "visible": result.get("visible") is True,
        "label": " ".join(str(result.get("label") or "").split()).casefold(),
    }


def resolve_developer_membership_navigation(page: Any) -> tuple[Any, Any] | None:
    if not is_developer_account_url(scope_location_url(page)):
        return None
    for selector in DEVELOPER_NAVIGATION_SELECTORS:
        matches: list[Any] = []
        for element in safe_elements(page, selector, timeout_s=0):
            if not element_is_interactable(element):
                continue
            try:
                summary = developer_navigation_summary(element)
            except Exception:
                continue
            if (
                summary["visible"]
                and summary["label"] in DEVELOPER_MEMBERSHIP_NAVIGATION_LABELS
            ):
                matches.append(element)
        if len(matches) == 1:
            return page, matches[0]
        if len(matches) > 1:
            return None
    return None


def developer_membership_details_snapshot(page: Any) -> dict[str, Any]:
    if not is_developer_account_url(scope_location_url(page)):
        return {
            "detailsPage": False,
            "appleDeveloperProgram": False,
            "renewalDate": False,
            "registrationIdentity": False,
            "registrationIdentityValue": None,
            "teamId": False,
            "membershipFieldCount": 0,
        }
    raw = page.run_js(
        r"""
        return JSON.stringify((() => {
          // ruyipage-developer-membership-details
          const visible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 2 && rect.height > 2 &&
              style.display !== 'none' && style.visibility !== 'hidden' &&
              el.getAttribute('aria-hidden') !== 'true';
          };
          const normalize = (value) => String(value || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLocaleLowerCase();
          const main = document.querySelector('main');
          const openShadowRoots = [];
          const seenShadowRoots = new Set();
          const collectOpenShadowRoots = (root) => {
            if (!root || seenShadowRoots.has(root)) return;
            seenShadowRoots.add(root);
            for (const element of [...root.querySelectorAll('*')]) {
              if (!element.shadowRoot) continue;
              openShadowRoots.push(element.shadowRoot);
              collectOpenShadowRoots(element.shadowRoot);
            }
          };
          collectOpenShadowRoots(document);
          const queryRoots = [document, ...openShadowRoots];
          const sourceTexts = new Set();
          const appendTextSource = (value) => {
            const text = String(value || '').trim();
            if (text) sourceTexts.add(text);
          };
          const textGroup = (value) => {
            const lines = String(value || '').split(/\r?\n/)
              .map(normalize)
              .filter(Boolean);
            return { lines, flatText: lines.join(' ') };
          };
          const textFromRoot = (root) => [...root.querySelectorAll('*')]
            .filter(visible)
            .filter((element) => !element.children || element.children.length === 0)
            .map((element) => String(element.innerText || element.textContent || '').trim())
            .filter(Boolean)
            .join('\n');
          // Keep each readable document/shadow-root source isolated.  Joining
          // sources before parsing lets a field label from the card borrow an
          // unrelated account-shell heading as its value at a source boundary.
          // Card-field evidence must have its label and value in the same source.
          appendTextSource(main && main.innerText);
          appendTextSource(document.body && document.body.innerText);
          for (const root of openShadowRoots) {
            appendTextSource(textFromRoot(root));
          }
          const sourceTextGroups = [...sourceTexts].map(textGroup);
          const lines = sourceTextGroups.flatMap((group) => group.lines);
          const hash = String(location.hash || '').toLocaleLowerCase();
          const detailsLabels = new Set([
            'membership details',
            '\u4f1a\u5458\u8d44\u683c\u8be6\u7ec6\u4fe1\u606f',
            '\u4f1a\u5458\u8d44\u683c\u8be6\u60c5',
            '\u6703\u54e1\u8cc7\u683c\u8a73\u7d30\u8cc7\u8a0a',
            '\u6703\u54e1\u8cc7\u683c\u8a73\u60c5'
          ]);
          const detailPageCandidates = queryRoots.flatMap((root) => [...root.querySelectorAll(
            'h1, h2, h3, h4, [role="heading"], [aria-current="page"], [aria-selected="true"]'
          )]).filter(visible);
          const detailPageLabels = detailPageCandidates.map((el) => normalize(
            el.getAttribute('aria-label') || el.innerText || el.textContent || ''
          )).filter(Boolean);
          const membershipCards = queryRoots.flatMap((root) =>
            [...root.querySelectorAll('[id], [class], [data-testid]')]
          ).filter(visible).filter((el) => [
            el.id,
            typeof el.className === 'string' ? el.className : '',
            el.getAttribute('data-testid') || ''
          ].join(' ').toLocaleLowerCase().includes('membershipdetailscard'));
          const cardTexts = new Set();
          for (const card of membershipCards) {
            const text = String(card.innerText || card.textContent || '').trim();
            if (text) cardTexts.add(text);
            if (card.shadowRoot) cardTexts.add(textFromRoot(card.shadowRoot));
          }
          const cardTextGroups = [...cardTexts]
            .filter(Boolean)
            .map(textGroup)
            .filter((group) => group.lines.length > 0);
          // An explicit MembershipDetailsCard is the strongest scope: field
          // evidence comes from it alone, not from surrounding account chrome.
          const evidenceTextGroups = cardTextGroups.length > 0
            ? cardTextGroups
            : sourceTextGroups;
          const evidenceLines = evidenceTextGroups.flatMap((group) => group.lines);
          const evidenceFlatText = evidenceTextGroups
            .map((group) => group.flatText)
            .filter(Boolean)
            .join(' ');
          const cardMarker = membershipCards.length > 0;
          const detailsPage = hash.includes('membershipdetailscard') ||
            hash.includes('membershipdetails') ||
            cardMarker ||
            detailPageLabels.some((label) => detailsLabels.has(label));
          const planPattern = /(?:^|\s)(?:plan|\u8ba1\u5212|\u65b9\u6848)\s*[:\uff1a]?\s*apple developer program(?:$|\s)/;
          const appleDeveloperProgram = evidenceLines.some((line) =>
            line === 'apple developer program' || planPattern.test(line)
          ) || planPattern.test(evidenceFlatText);
          const fieldLabels = {
            renewalDate: [
              /renewal date/,
              /renewed through/,
              /membership expiration/,
              /expiration date/,
              /expiry date/,
              /membership expires/,
              /\u7eed\u8ba2\u65e5\u671f/,
              /\u7e8c\u8a02\u65e5\u671f/,
              /\u7eed\u671f\u65e5\u671f/,
              /\u7e8c\u671f\u65e5\u671f/,
              /\u5230\u671f\u65e5\u671f/,
              /\u5230\u671f\u65e5/,
              /\u6709\u6548\u671f\u81f3/,
              /\u6709\u6548\u671f\u9650/
            ],
            registrationIdentity: [
              /registration identity/,
              /registered as/,
              /enrollment type/,
              /\u6ce8\u518c\u8eab\u4efd/,
              /\u8a3b\u518a\u8eab\u5206/,
              /\u6ce8\u518c\u7c7b\u578b/,
              /\u8a3b\u518a\u985e\u578b/
            ],
            teamId: [
              /team id/,
              /\u56e2\u961f\s*id/,
              /\u5718\u968a\s*id/
            ]
          };
          const allFieldLabels = [
            /plan/,
            /\u8ba1\u5212/,
            /\u65b9\u6848/,
            ...fieldLabels.renewalDate,
            ...fieldLabels.registrationIdentity,
            ...fieldLabels.teamId,
            /phone/,
            /\u7535\u8bdd/,
            /\u96fb\u8a71/,
            /street address/,
            /\u8857\u9053\u5730\u5740/,
            /annual fee/,
            /\u5e74\u8d39/,
            /\u5e74\u8cbb/,
            /device reset date/,
            /\u8bbe\u5907\u91cd\u7f6e\u65e5\u671f/,
            /\u8a2d\u5099\u91cd\u7f6e\u65e5\u671f/
          ];
          const placeholderValues = new Set([
            '-',
            '--',
            '–',
            '—',
            'n/a',
            'na',
            'none',
            'unavailable',
            '\u672a\u63d0\u4f9b',
            '\u65e0'
          ]);
          const normalizeMeaningfulValue = (value) => {
            const normalized = String(value || '')
              .replace(/^[\s:：\-–—]+|[\s:：\-–—]+$/g, '')
              .trim()
              .toLocaleLowerCase();
            return normalized && !placeholderValues.has(normalized)
              ? normalized
              : '';
          };
          const findLabeledValue = (patterns, { requireNumeric = false } = {}) => {
            const validValue = (value) => {
              const normalized = normalizeMeaningfulValue(value);
              return normalized && (!requireNumeric || /\d/.test(normalized))
                ? normalized
                : '';
            };
            for (const group of evidenceTextGroups) {
              for (let index = 0; index < group.lines.length; index += 1) {
                const line = group.lines[index];
                if (!patterns.some((pattern) => pattern.test(line))) continue;
                const remainder = patterns.reduce(
                  (value, pattern) => value.replace(pattern, ''),
                  line
                ).replace(/^[\s:：-]+|[\s:：-]+$/g, '').trim();
                const inlineValue = validValue(remainder);
                if (inlineValue && !allFieldLabels.some((pattern) => pattern.test(remainder))) {
                  return inlineValue;
                }
                // A following field label closes this field.  Do not skip over
                // it looking for a later unrelated shell heading.
                const candidate = group.lines[index + 1];
                const followingValue = validValue(candidate);
                if (followingValue && !allFieldLabels.some((pattern) => pattern.test(candidate))) {
                  return followingValue;
                }
              }
              // The Developer Account card is a responsive grid.  On narrower
              // Firefox layouts its visible text can be flattened into one long
              // line instead of one label/value pair per line.  In that form the
              // old remainder check always contained subsequent field labels and
              // rejected an otherwise valid value.  Bound the value by the next
              // known field label, within this same DOM-text source.
              for (const pattern of patterns) {
                let cursor = 0;
                while (cursor < group.flatText.length) {
                  const match = pattern.exec(group.flatText.slice(cursor));
                  if (!match) break;
                  const matchStart = cursor + match.index;
                  const valueStart = matchStart + match[0].length;
                  const remaining = group.flatText.slice(valueStart)
                    .replace(/^[\s:：-]+/, '');
                  const boundaries = allFieldLabels
                    .map((fieldPattern) => {
                      const boundary = fieldPattern.exec(remaining);
                      return boundary ? boundary.index : -1;
                    })
                    .filter((index) => index >= 0);
                  const value = normalizeMeaningfulValue(remaining.slice(
                    0,
                    boundaries.length ? Math.min(...boundaries) : remaining.length
                  ));
                  if (value && (!requireNumeric || /\d/.test(value))) return value;
                  cursor = valueStart;
                }
              }
            }
            return '';
          };
          const renewalDateValue = findLabeledValue(fieldLabels.renewalDate, { requireNumeric: true });
          const registrationIdentityValue = findLabeledValue(fieldLabels.registrationIdentity);
          const teamIdValue = findLabeledValue(fieldLabels.teamId);
          const renewalDate = Boolean(renewalDateValue);
          const registrationIdentity = Boolean(registrationIdentityValue);
          const teamId = Boolean(teamIdValue);
          const membershipFieldCount = [
            renewalDate,
            registrationIdentity,
            teamId,
            /annual fee|\u5e74\u8d39|\u5e74\u8cbb/.test(evidenceFlatText),
            /device reset date|\u8bbe\u5907\u91cd\u7f6e\u65e5\u671f|\u8a2d\u5099\u91cd\u7f6e\u65e5\u671f/.test(evidenceFlatText)
          ].filter(Boolean).length;
          return {
            detailsPage,
            appleDeveloperProgram,
            renewalDate,
            registrationIdentity,
            registrationIdentityValue: registrationIdentityValue || null,
            teamId,
            membershipFieldCount
          };
        })())
        """
    )
    try:
        result = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError, ValueError):
        result = None
    if not isinstance(result, dict):
        raise RuntimeError("developer membership details query returned an invalid result")
    return {
        "detailsPage": result.get("detailsPage") is True,
        "appleDeveloperProgram": result.get("appleDeveloperProgram") is True,
        "renewalDate": result.get("renewalDate") is True,
        "registrationIdentity": result.get("registrationIdentity") is True,
        "registrationIdentityValue": normalize_developer_registration_identity(
            result.get("registrationIdentityValue")
        ),
        "teamId": result.get("teamId") is True,
        "membershipFieldCount": normalize_membership_field_count(
            result.get("membershipFieldCount")
        ),
    }


def normalize_membership_field_count(value: Any) -> int:
    return min(5, max(0, value if type(value) is int else 0))


def normalize_developer_registration_identity(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split()).strip()
    if not normalized or len(normalized) > 64 or any(
        character in normalized for character in ("\r", "\n", "\x00")
    ):
        return None
    return normalized


def developer_membership_snapshot_is_active(snapshot: dict[str, Any]) -> bool:
    """Confirm the current program from the card's plan and renewal evidence.

    ``Registration identity`` is useful account metadata, but Apple does not
    render it consistently for every enrolled account/layout.  Do not turn a
    loaded Developer Program card with a meaningful renewal value into
    ``unknown`` merely because that supplemental field is absent.
    """
    return bool(
        snapshot.get("detailsPage") is True
        and snapshot.get("appleDeveloperProgram") is True
        and snapshot.get("renewalDate") is True
    )


def emit_developer_membership_probe(
    snapshot: dict[str, Any],
    *,
    route_matched: bool,
    auth_blocked: bool,
    stable_count: int,
) -> None:
    """Record a de-identified membership-readiness observation for diagnosis."""
    emit(
        {
            "event": "status",
            "status": "developer_membership_probe",
            "routeMatched": route_matched is True,
            "authBlocked": auth_blocked is True,
            "detailsPage": snapshot.get("detailsPage") is True,
            "appleDeveloperProgram": snapshot.get("appleDeveloperProgram") is True,
            "renewalDate": snapshot.get("renewalDate") is True,
            "registrationIdentity": snapshot.get("registrationIdentity") is True,
            "teamId": snapshot.get("teamId") is True,
            "membershipFieldCount": normalize_membership_field_count(
                snapshot.get("membershipFieldCount")
            ),
            "stableCount": min(2, max(0, stable_count)),
        }
    )


def developer_membership_details_route(url: str) -> bool:
    normalized = str(url or "").casefold()
    return bool(
        "#membershipdetailscard" in normalized
        or "#membershipdetails" in normalized
        or "/membership" in normalized
    )


def resolve_developer_membership_details_card(
    page: Any,
) -> tuple[Any, Any] | None:
    """Resolve the concrete details-card root for a viewport screenshot."""
    if not is_developer_account_url(scope_location_url(page)):
        return None
    seen: set[int] = set()
    for scope, root in current_element_search_roots(page):
        if scope is not page:
            continue
        for selector in DEVELOPER_MEMBERSHIP_CARD_SELECTORS:
            for card in safe_elements(root, selector, timeout_s=0):
                if id(card) in seen or not element_is_interactable(card):
                    continue
                seen.add(id(card))
                return scope, card
    return None


def scroll_developer_membership_details_card(
    page: Any,
    *,
    pause: Callable[[int, int], None] = human_pause,
) -> bool:
    """Scroll the exact details card, tolerating a bounded SPA replacement.

    The membership route can finish changing before its card root is mounted.
    Retrying this narrow lookup lets the native route scroll settle first, then
    gives ruyiPage's card-targeted scroll enough time to complete before a
    field probe or viewport screenshot continues.
    """
    for attempt in range(DEVELOPER_MEMBERSHIP_CARD_SCROLL_ATTEMPTS):
        resolved = resolve_developer_membership_details_card(page)
        if resolved is None:
            if attempt + 1 < DEVELOPER_MEMBERSHIP_CARD_SCROLL_ATTEMPTS:
                pause(220, 460)
                continue
            return False
        _scope, card = resolved
        try:
            card.scroll.to_see()
        except Exception:
            if attempt + 1 < DEVELOPER_MEMBERSHIP_CARD_SCROLL_ATTEMPTS:
                pause(220, 460)
                continue
            return False
        # Do not begin a DOM probe/screenshot in the middle of ruyiPage's
        # scroll animation. Re-resolve afterward because React can replace the
        # card wrapper while it hydrates its detail fields.
        pause(700, 1300)
        if resolve_developer_membership_details_card(page) is not None:
            return True
        if attempt + 1 < DEVELOPER_MEMBERSHIP_CARD_SCROLL_ATTEMPTS:
            pause(160, 360)
    return False


def confirm_active_developer_membership(
    page: Any,
    *,
    timeout_s: float = 20.0,
    pause: Callable[[int, int], None] = human_pause,
    registration_identity_holder: dict[str, str | None] | None = None,
) -> bool:
    deadline = time.monotonic() + max(0.0, timeout_s)

    def wait_for_loaded_details(
        initial_snapshot: dict[str, Any] | None = None,
        *,
        settle_card_before_probe: bool = False,
    ) -> bool:
        if settle_card_before_probe:
            # A hash/nav action makes Apple scroll the details card
            # asynchronously. Give that native motion a chance to finish, then
            # scroll the concrete card once through ruyiPage before sampling
            # its lazy-hydrated fields.
            pause(700, 1300)
            scroll_developer_membership_details_card(page, pause=pause)
        stable_count = 0
        last_probe: tuple[bool | int, ...] | None = None
        pending_snapshot = initial_snapshot
        while time.monotonic() < deadline:
            if not browser_connection_is_alive(page):
                raise RuntimeError("developer browser connection was lost")
            if pending_snapshot is None:
                snapshot = developer_membership_details_snapshot(page)
            else:
                snapshot = pending_snapshot
                pending_snapshot = None
            try:
                auth_blocked = developer_scope_has_auth_blocker(
                    page,
                    # The already-confirmed Developer shell can retain static
                    # recovery/security text while the details card hydrates.
                    # Live email/password/2FA/trust/assertive controls still
                    # block through developer_state_has_auth_blocker().
                    allow_root_text_only_error=True,
                    allow_retiring_child_text_only_error=True,
                )
            except Exception:
                auth_blocked = True
            if not auth_blocked and developer_membership_snapshot_is_active(snapshot):
                stable_count += 1
            else:
                stable_count = 0
            route_matched = developer_membership_details_route(scope_location_url(page))
            probe = (
                route_matched,
                auth_blocked,
                snapshot.get("detailsPage") is True,
                snapshot.get("appleDeveloperProgram") is True,
                snapshot.get("renewalDate") is True,
                snapshot.get("registrationIdentity") is True,
                snapshot.get("teamId") is True,
                normalize_membership_field_count(snapshot.get("membershipFieldCount")),
                min(2, stable_count),
            )
            if probe != last_probe:
                emit_developer_membership_probe(
                    snapshot,
                    route_matched=route_matched,
                    auth_blocked=auth_blocked,
                    stable_count=stable_count,
                )
                last_probe = probe
            if auth_blocked:
                return False
            if stable_count >= 2:
                if registration_identity_holder is not None:
                    registration_identity_holder["value"] = (
                        normalize_developer_registration_identity(
                            snapshot.get("registrationIdentityValue")
                        )
                    )
                return True
            pause(250, 500)
        return False

    # Apple can land on the hash-routed details card before the nav items are
    # rendered. Keep polling the current page so a late hash/nav hydration is
    # not frozen into the initial ``membershipNavigation`` snapshot.  Its SPA
    # can also canonicalize the URL back to ``/account`` while retaining the
    # visible details card, so the live snapshot is an independent route cue.
    while time.monotonic() < deadline:
        current_url = scope_location_url(page)
        if developer_membership_details_route(current_url):
            return wait_for_loaded_details(settle_card_before_probe=True)
        try:
            snapshot = developer_membership_details_snapshot(page)
        except Exception:
            snapshot = None
        if isinstance(snapshot, dict) and snapshot.get("detailsPage") is True:
            return wait_for_loaded_details(
                initial_snapshot=snapshot,
                settle_card_before_probe=True,
            )
        navigation = resolve_developer_membership_navigation(page)
        if navigation is not None:
            scope, element = navigation
            try:
                element.scroll.to_see()
            except Exception:
                pass
            pause(250, 500)
            refreshed_navigation = resolve_developer_membership_navigation(page)
            if refreshed_navigation is not None:
                scope, element = refreshed_navigation
            human_click(scope, element, pause=pause)
            return wait_for_loaded_details(settle_card_before_probe=True)
        pause(250, 500)
    return False


def settle_trust_state(
    page: Any,
    state: dict[str, Any],
    *,
    deadline: float,
    pause: Callable[[int, int], None] | None = None,
    hydration_timeout_s: float = TRUST_PROMPT_HYDRATION_TIMEOUT_S,
    trust_click_state: dict[str, bool] | None = None,
    trust_progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    if pause is None:
        pause = human_pause
    if trust_click_state is None:
        trust_click_state = {}
    trust_click_state.setdefault("detected", False)
    trust_click_state.setdefault("clicked", False)

    def emit_trust_progress(phase: str) -> None:
        if trust_progress is not None:
            trust_progress(phase)

    hydration_deadline = min(deadline, time.monotonic() + hydration_timeout_s)
    scanned_current_state = False
    while True:
        if state.get("error"):
            return state
        if scanned_current_state and time.monotonic() >= hydration_deadline:
            if state.get("trustPrompt"):
                if trust_click_state["clicked"]:
                    raise RuntimeError(
                        "trust-browser prompt click did not transition before deadline"
                    )
                raise RuntimeError(
                    "trust-browser prompt detected but no matching button was found"
                )
            raise RuntimeError("trust-browser state did not settle before deadline")
        scanned_current_state = True
        if not state.get("trustPrompt"):
            return state
        if not trust_click_state["detected"]:
            trust_click_state["detected"] = True
            emit_trust_progress("trust_prompt_detected")
        if not trust_click_state["clicked"] and click_trust_browser(page, pause=pause):
            trust_click_state["clicked"] = True
            emit_trust_progress("trust_click_sent")
            pause(700, 1400)
            state = detect_login_state(page)
            continue
        if time.monotonic() >= hydration_deadline:
            if trust_click_state["clicked"]:
                raise RuntimeError(
                    "trust-browser prompt click did not transition before deadline"
                )
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


def wait_for_2fa_or_session(
    page: Any,
    timeout_s: int = 90,
    session_probe: Callable[[Any], dict[str, Any] | None] | None = None,
) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + timeout_s
    last_state: dict[str, Any] = {}
    while time.monotonic() < deadline:
        if session_probe is not None:
            confirmed_state = session_probe(page)
            if confirmed_state is not None:
                confirmed_state["trusted"] = True
                return confirmed_state
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
        if has_confirmed_account_session(last_state) and session_probe is None:
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
    timeout_s: int = 120,
    submitted: bool = False,
    otp_generation: int | None = None,
    submission_method: str | None = None,
    transition_observer: Callable[[dict[str, Any]], None] | None = None,
    session_probe: Callable[[Any], dict[str, Any] | None] | None = None,
) -> dict[str, Any]:
    """Wait for the signed-in root and surface redacted post-OTP observations."""
    if otp_generation is not None:
        validate_otp_generation(otp_generation)
    deadline = time.monotonic() + timeout_s
    submission_transition_deadline = (
        min(deadline, time.monotonic() + TWO_FACTOR_SUBMIT_TRANSITION_TIMEOUT_S)
        if submitted and submission_method in {"button", "enter", "automatic"}
        else None
    )
    last_state: dict[str, Any] = {}
    allow_post_otp_clicks = (
        session_probe is not None
        or not (submitted and submission_method == "automatic")
    )
    allow_retiring_child_errors = bool(
        submitted and submission_method == "automatic" and otp_generation is not None
    )
    trust_click_state: dict[str, bool] = {"detected": False, "clicked": False}

    def emit_developer_trust_progress(phase: str) -> None:
        if session_probe is not None and otp_generation is not None:
            emit_two_factor_progress(phase, generation=otp_generation)

    def observe_transition(state: dict[str, Any]) -> None:
        if transition_observer is not None:
            observation = dict(state) if isinstance(state, dict) else {}
            observation["inspectionAvailable"] = observation.get("inspectionAvailable") is not False
            observation["generation"] = otp_generation if otp_generation is not None else 0
            transition_observer(observation)

    while time.monotonic() < deadline:
        if session_probe is not None:
            direct_target_state = session_probe(page)
            if direct_target_state is not None:
                observe_transition(direct_target_state)
                return direct_target_state
        # A Developer-targeted flow must not complete on the transient generic
        # account.apple.com session that Apple can expose between the trust
        # click and the Developer account shell hydration.  In probe mode the
        # target probe is the only terminal success condition.
        if session_probe is None:
            direct_session_state = confirmed_account_manage_state(
                page,
                allow_retiring_child_errors=allow_retiring_child_errors,
            )
            if direct_session_state is not None:
                observe_transition(direct_session_state)
                return direct_session_state
        try:
            last_state = detect_login_state(page)
            if allow_post_otp_clicks:
                last_state = settle_trust_state(
                    page,
                    last_state,
                    deadline=deadline,
                    trust_click_state=trust_click_state,
                    trust_progress=emit_developer_trust_progress,
                )
        except RuntimeError as error:
            if str(error) != "unable to inspect login page state through ruyiPage":
                raise
            # Firefox can retire the old frame before ruyiPage exposes the
            # replacement. A single unreadable poll after OTP submission is
            # not evidence that the browser flow failed.
            observe_transition({"inspectionAvailable": False})
            if (
                submission_transition_deadline is not None
                and time.monotonic() >= submission_transition_deadline
            ):
                raise RuntimeError("2FA submit state could not be confirmed") from error
            human_pause(350, 700)
            continue
        observe_transition(last_state)
        top_level_url = scope_location_url(page)
        if (
            submitted
            and session_probe is not None
            and is_developer_account_url(top_level_url)
            and not developer_scope_has_auth_blocker(
                page,
                allow_root_text_only_error=True,
                allow_retiring_child_text_only_error=True,
            )
        ):
            # Apple can redirect the top-level tab to Developer before the
            # old idmsa iframe has fully retired. Allow a bounded hydration
            # poll only for the exact Developer target; a verified account
            # shell remains the sole success condition.
            human_pause(400, 800)
            hydrated_target_state = session_probe(page)
            if (
                hydrated_target_state is not None
                and hydrated_target_state.get("developerAccountShell") is True
            ):
                observe_transition(hydrated_target_state)
                return hydrated_target_state
            continue
        if otp_generation is not None and not is_apple_url(
            str(last_state.get("href") or "")
        ):
            raise RuntimeError("2FA state left the verified Apple HTTPS origin")
        if has_confirmed_account_session(last_state) and session_probe is None:
            # A retiring idmsa frame can still expose generic error text after
            # the top-level account shell has already established the session.
            # A root-page error remains terminal; only retired child-frame
            # evidence is allowed to lose to a confirmed root session.
            last_state["trusted"] = True
            return last_state
        if last_state.get("error"):
            if (
                allow_retiring_child_errors
                and is_account_manage_url(str(last_state.get("href") or ""))
                and not last_state.get("rootError")
                and submission_transition_deadline is not None
                and time.monotonic() < submission_transition_deadline
            ):
                # Account HTML can hydrate after the old idmsa child reports a
                # generic error. The direct root-session probe above remains
                # authoritative once the root redirect is stable.
                human_pause(350, 700)
                continue
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

def profile_navigation_link_summary(link: Any) -> dict[str, Any]:
    raw = link.run_js(
        r"""
        function () {
          // ruyipage-profile-navigation-link-summary
          const rect = this.getBoundingClientRect();
          const style = window.getComputedStyle(this);
          const visible = rect.width > 2 && rect.height > 2 &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            this.getAttribute('aria-hidden') !== 'true';
          const domIdentity = (() => {
            const parts = [];
            let current = this;
            for (let depth = 0; current && current.nodeType === 1 && depth < 12; depth += 1) {
              const parent = current.parentElement;
              const index = parent
                ? Array.prototype.indexOf.call(parent.children, current)
                : 0;
              parts.push(`${String(current.tagName || '').toLowerCase()}:${index}`);
              current = parent;
            }
            return parts.reverse().join('/');
          })();
          return JSON.stringify({
            visible,
            href: String(this.href || this.getAttribute('href') || ''),
            domIdentity,
            label: String(
              this.getAttribute('aria-label') ||
              this.innerText ||
              this.textContent ||
              ''
            ).replace(/\s+/g, ' ').trim().toLocaleLowerCase()
          });
        }
        """
    )
    result = parse_profile_query_result(raw, "navigation link")
    return {
        "visible": result.get("visible") is True,
        "href": str(result.get("href") or "").strip(),
        "domIdentity": str(result.get("domIdentity") or "").strip(),
        "label": " ".join(str(result.get("label") or "").split()).casefold(),
    }


def resolve_personal_information_navigation_link(
    page: Any,
) -> tuple[Any, Any] | None:
    if not is_account_manage_root_url(scope_location_url(page)):
        return None
    exact_candidates: list[tuple[Any, Any]] = []
    semantic_candidates: list[tuple[Any, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for scope, root in current_element_search_roots(page):
        if scope is not page:
            continue
        for selector in PROFILE_NAVIGATION_LINK_SELECTORS:
            for link in safe_elements(root, selector, timeout_s=0):
                if not element_is_interactable(link):
                    continue
                try:
                    summary = profile_navigation_link_summary(link)
                    identity = (
                        scope_browsing_context_id(scope),
                        summary["domIdentity"]
                        or element_stability_signature(scope, link),
                        summary["href"],
                        summary["label"],
                    )
                except Exception:
                    continue
                if identity in seen:
                    continue
                seen.add(identity)
                if summary["visible"] and is_personal_information_url(
                    summary["href"]
                ):
                    exact_candidates.append((scope, link))
                    continue
                if (
                    summary["visible"]
                    and summary["label"] in PROFILE_NAVIGATION_LABELS
                ):
                    semantic_candidates.append((scope, link))
    if len(exact_candidates) == 1:
        return exact_candidates[0]
    return semantic_candidates[0] if len(semantic_candidates) == 1 else None


def wait_for_profile_navigation_result(
    page: Any,
    timeout_s: float = PROFILE_NAVIGATION_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] | None = None,
) -> str:
    if pause is None:
        pause = human_pause
    deadline = time.monotonic() + max(0, timeout_s)
    while time.monotonic() < deadline:
        current_url = scope_location_url(page)
        if is_personal_information_url(current_url):
            return "account_information"
        if is_account_sign_in_url(current_url):
            return "sign_in"
        if not is_apple_url(current_url):
            raise RuntimeError(
                "personal information navigation left the verified Apple HTTPS origin"
            )
        pause(180, 420)
    return "unconfirmed"


def navigate_to_personal_information(
    page: Any,
    *,
    navigation_attempt: int,
) -> str:
    if isinstance(navigation_attempt, bool) or navigation_attempt not in (1, 2):
        raise RuntimeError("personal information navigation attempt is invalid")
    emit(
        {
            "event": "status",
            "status": "profile_navigation_started",
            "attempt": navigation_attempt,
        }
    )
    if is_personal_information_url(scope_location_url(page)):
        emit(
            {
                "event": "status",
                "status": "profile_navigation_arrived",
                "route": "existing",
                "attempt": navigation_attempt,
            }
        )
        return "account_information"

    resolved_link = resolve_personal_information_navigation_link(page)
    if resolved_link is not None:
        scope, link = resolved_link
        emit(
            {
                "event": "status",
                "status": "profile_navigation_sidebar_link_resolved",
                "attempt": navigation_attempt,
            }
        )
        human_click(scope, link)
        emit(
            {
                "event": "status",
                "status": "profile_navigation_sidebar_click_sent",
                "attempt": navigation_attempt,
            }
        )
        wait_for_document_settle(page)
        route = "sidebar"
        result = wait_for_profile_navigation_result(page)
        if result == "unconfirmed":
            emit(
                {
                    "event": "status",
                    "status": "profile_navigation_direct_fallback",
                    "attempt": navigation_attempt,
                    "after": "sidebar_unconfirmed",
                }
            )
            page.get(ACCOUNT_INFORMATION_URL)
            wait_for_document_settle(page, timeout_s=20)
            route = "sidebar_then_direct"
            result = wait_for_profile_navigation_result(page)
    else:
        emit(
            {
                "event": "status",
                "status": "profile_navigation_direct_fallback",
                "attempt": navigation_attempt,
            }
        )
        page.get(ACCOUNT_INFORMATION_URL)
        wait_for_document_settle(page, timeout_s=20)
        route = "direct"
        result = wait_for_profile_navigation_result(page)
    emit(
        {
            "event": "status",
            "status": (
                "profile_navigation_arrived"
                if result == "account_information"
                else "profile_navigation_sign_in_redirect"
                if result == "sign_in"
                else "profile_navigation_unconfirmed"
            ),
            "route": route,
            "attempt": navigation_attempt,
        }
    )
    return result


def is_personal_information_scope(page: Any, scope: Any) -> bool:
    if scope is not page or getattr(scope, "parent", None) is not None:
        return False
    return is_personal_information_url(scope_location_url(scope))


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
          const domIdentity = (element) => {
            const parts = [];
            let current = element;
            for (let depth = 0; current && depth < 32; depth += 1) {
              if (current.nodeType === 1) {
                const tag = String(current.tagName || '').toLocaleLowerCase();
                if (!tag) return '';
                let ordinal = 1;
                for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
                  if (sibling.tagName === current.tagName) ordinal += 1;
                }
                parts.push(`${tag}:${ordinal}`);
              }
              const parent = current.parentElement;
              if (parent) {
                current = parent;
                continue;
              }
              const root = current.getRootNode?.();
              if (root?.host && root.host !== current) {
                parts.push('shadow');
                current = root.host;
                continue;
              }
              break;
            }
            return parts.reverse().join('/');
          };
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
            birthdayValue,
            domIdentity: domIdentity(this),
            semanticActionTarget:
              String(this.tagName || '').toLocaleLowerCase() === 'button' ||
              normalize(this.getAttribute?.('role')) === 'button'
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
        "domIdentity": result.get("domIdentity"),
        "semanticActionTarget": result.get("semanticActionTarget") is True,
    }


def profile_card_dom_identity(summary: dict[str, Any]) -> str | None:
    value = summary.get("domIdentity")
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not re.fullmatch(r"[a-z0-9:/.-]{1,512}", normalized):
        return None
    return normalized


def profile_card_identity_is_ancestor(ancestor: str, descendant: str) -> bool:
    return descendant.startswith(f"{ancestor}/")


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
    seen: set[tuple[str, str]] = set()
    for scope, root in current_element_search_roots(page):
        if scope is not page:
            continue
        for selector in selectors:
            for card in safe_elements(root, selector):
                if not element_is_interactable(card):
                    continue
                try:
                    summary = profile_card_summary(card)
                    dom_identity = profile_card_dom_identity(summary)
                    context_id = scope_browsing_context_id(scope)
                except Exception:
                    continue
                if dom_identity is None:
                    continue
                identity = context_id, dom_identity
                if identity in seen:
                    continue
                seen.add(identity)
                if summary["visible"] and summary[kind] is True:
                    candidates.append((scope, card, summary))
    if kind == "birthday":
        ready_candidates = [
            candidate
            for candidate in candidates
            if profile_value_is_ready(
                candidate[2].get("birthdayValue"),
                "birthday",
            )
        ]
        if ready_candidates:
            candidates = ready_candidates
    semantic_action_candidates = [
        candidate
        for candidate in candidates
        if candidate[2].get("semanticActionTarget") is True
    ]
    if semantic_action_candidates:
        candidates = semantic_action_candidates
    identities = [
        (
            scope_browsing_context_id(scope),
            profile_card_dom_identity(summary),
        )
        for scope, _card, summary in candidates
    ]
    leaf_candidates: list[tuple[Any, Any, dict[str, Any]]] = []
    for index, candidate in enumerate(candidates):
        context_id, identity = identities[index]
        has_matching_descendant = any(
            context_id == other_context_id
            and identity is not None
            and other_identity is not None
            and profile_card_identity_is_ancestor(identity, other_identity)
            for other_index, (other_context_id, other_identity) in enumerate(identities)
            if other_index != index
        )
        if not has_matching_descendant:
            leaf_candidates.append(candidate)
    return leaf_candidates


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
                scope_browsing_context_id(_scope),
                profile_card_dom_identity(summary),
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


PROFILE_NAME_MODAL_SUMMARY_SCRIPT = r"""
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
  const normalize = (value) => String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
  const fieldSignals = (field) => {
    const labels = Array.from(field.labels || []).map(
      (label) => label.innerText || label.textContent || ''
    );
    const closest = field.closest('label')?.innerText || '';
    return [
      field.getAttribute('autocomplete'), field.getAttribute('name'),
      field.getAttribute('id'), field.getAttribute('aria-label'),
      field.getAttribute('placeholder'), closest, ...labels
    ].filter(Boolean).map(normalize);
  };
  const hasAsciiToken = (signals, aliases) => signals.some((signal) =>
    aliases.some((alias) =>
      signal === alias || signal.startsWith(`${alias}-`) ||
      signal.endsWith(`-${alias}`) || signal.includes(`-${alias}-`)
    )
  );
  const fields = Array.from(this.querySelectorAll('input')).filter((field) =>
    visible(field) && !field.disabled && !field.readOnly &&
    ['text', 'search'].includes(String(field.type || 'text').toLowerCase())
  );
  const classify = (field) => {
    const signals = fieldSignals(field);
    if (
      hasAsciiToken(signals, ['middle-name', 'middlename', 'additional-name', 'additionalname']) ||
      signals.some((signal) => signal.includes('\u4e2d\u95f4\u540d') || signal.includes('\u4e2d\u9593\u540d'))
    ) return 'middle';
    if (
      hasAsciiToken(signals, ['family-name', 'familyname', 'surname', 'last-name', 'lastname']) ||
      signals.some((signal) => signal.includes('\u59d3\u6c0f') || signal === '\u59d3')
    ) return 'family';
    if (
      hasAsciiToken(signals, ['given-name', 'givenname', 'first-name', 'firstname']) ||
      signals.some((signal) => signal.includes('\u540d\u5b57') || signal === '\u540d')
    ) return 'given';
    return null;
  };
  let given = null;
  let family = null;
  const orderedParts = [];
  for (const field of fields) {
    const value = String(field.value || '').trim();
    if (!value) continue;
    const kind = classify(field);
    if (kind === 'given' && given === null) {
      given = value;
      orderedParts.push(value);
    }
    if (kind === 'family' && family === null) {
      family = value;
      orderedParts.push(value);
    }
  }
  return JSON.stringify({
    visible: visible(this),
    fieldCount: fields.length,
    given,
    family,
    orderedParts
  });
}
"""


def profile_name_modal_summary(modal: Any) -> dict[str, Any]:
    raw = modal.run_js(PROFILE_NAME_MODAL_SUMMARY_SCRIPT)
    result = parse_profile_query_result(raw, "name modal")
    given = result.get("given")
    family = result.get("family")
    ordered_parts = result.get("orderedParts")
    if not isinstance(ordered_parts, list):
        ordered_parts = [part for part in (given, family) if part is not None]
    return {
        "visible": result.get("visible") is True,
        "fieldCount": int(result.get("fieldCount") or 0),
        "given": given,
        "family": family,
        "orderedParts": ordered_parts,
    }


def resolve_profile_name_modal(page: Any) -> tuple[Any, Any, dict[str, Any]] | None:
    if not is_personal_information_scope(page, page):
        return None
    for selector in PROFILE_NAME_MODAL_SELECTORS:
        visible_candidates: list[tuple[Any, Any, dict[str, Any]]] = []
        candidates: list[tuple[Any, Any, dict[str, Any]]] = []
        seen: dict[tuple[str, tuple[str, ...]], str] = {}
        for scope, root in current_element_search_roots(page):
            if scope is not page:
                continue
            for modal in safe_elements(root, selector):
                if not element_is_interactable(modal):
                    continue
                try:
                    summary = profile_name_modal_summary(modal)
                    identity = element_stability_signature(scope, modal)
                except Exception:
                    emit_profile_name_modal_query_failure_once()
                    continue
                previous_selector = seen.get(identity)
                if previous_selector is not None and previous_selector != selector:
                    continue
                seen.setdefault(identity, selector)
                if not (summary["visible"] and summary["fieldCount"] >= 2):
                    continue
                visible_candidates.append((scope, modal, summary))
                if profile_value_is_ready(
                    summary.get("given"), "name"
                ) and profile_value_is_ready(summary.get("family"), "name"):
                    candidates.append((scope, modal, summary))
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
                tuple(
                    normalize_profile_value(part, "name")
                    for part in summary.get("orderedParts", [])
                ),
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
    if profile_name_modal_query_failure_emitted:
        raise RuntimeError("personal information name modal query failed")
    raise RuntimeError("personal information name modal was not found")


def open_profile_name_modal(
    page: Any,
    *,
    timeout_s: float = PROFILE_MODAL_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] = human_pause,
) -> tuple[Any, Any, dict[str, Any], str]:
    """Open the name editor through a freshly stabilized card reference.

    Apple Account can replace its Personal Information cards while a React
    hydration/update is in flight.  The old flow kept a card reference across
    a human pause and clicked it once, which can be a no-op.  Re-resolve the
    card after the pause, then use one bounded modal-open retry when the first
    action races the update.
    """
    deadline = time.monotonic() + max(0.0, timeout_s)
    last_error: Exception | None = None
    attempted_clicks = 0
    for attempt in range(PROFILE_NAME_MODAL_OPEN_CLICK_ATTEMPTS):
        # A delayed first click can have opened the modal just after its short
        # probe elapsed.  Never issue a second card click while it is already
        # present.
        try:
            existing_modal = resolve_profile_name_modal(page)
        except Exception as error:
            if "personal information name modal is ambiguous" in str(error).casefold():
                raise
            existing_modal = None
        if existing_modal is not None:
            existing_scope, existing_modal_root, existing_summary = existing_modal
            return (
                existing_scope,
                existing_modal_root,
                existing_summary,
                profile_name_modal_selector(
                    page,
                    existing_scope,
                    existing_modal_root,
                ),
            )

        try:
            attempted_clicks = attempt + 1
            remaining_s = deadline - time.monotonic()
            if remaining_s <= 0:
                break
            # First wait proves the card is ready; the second one is the
            # authoritative reference used for the click after the pause.
            wait_for_profile_card(
                page,
                "name",
                timeout_s=min(PROFILE_CARD_WAIT_TIMEOUT_S, remaining_s),
                pause=pause,
            )
            pause(280, 620)
            remaining_s = deadline - time.monotonic()
            if remaining_s <= 0:
                break
            name_scope, name_card, _name_summary = wait_for_profile_card(
                page,
                "name",
                timeout_s=min(PROFILE_CARD_WAIT_TIMEOUT_S, remaining_s),
                pause=pause,
            )
            human_click(name_scope, name_card, pause=pause)
        except Exception as error:
            last_error = error
            if attempt + 1 < PROFILE_NAME_MODAL_OPEN_CLICK_ATTEMPTS:
                pause(160, 340)
                continue
            unavailable_outcome = profile_name_modal_unavailable_outcome(error)
            if unavailable_outcome is not None:
                emit_profile_name_modal_unavailable(
                    attempt_count=attempted_clicks,
                    outcome=unavailable_outcome,
                )
                raise RuntimeError(
                    "personal information name modal is unavailable"
                ) from error
            raise

        remaining_s = deadline - time.monotonic()
        if remaining_s <= 0:
            break
        modal_wait_timeout_s = (
            remaining_s
            if attempt + 1 == PROFILE_NAME_MODAL_OPEN_CLICK_ATTEMPTS
            else min(remaining_s, PROFILE_NAME_MODAL_RETRY_WAIT_TIMEOUT_S)
        )
        try:
            resolved_modal = wait_for_profile_name_modal(
                page,
                timeout_s=modal_wait_timeout_s,
                pause=pause,
            )
            modal_scope, modal, modal_summary = resolved_modal
            return (
                modal_scope,
                modal,
                modal_summary,
                profile_name_modal_selector(page, modal_scope, modal),
            )
        except Exception as error:
            last_error = error
            if attempt + 1 < PROFILE_NAME_MODAL_OPEN_CLICK_ATTEMPTS:
                pause(160, 340)
                continue
            unavailable_outcome = profile_name_modal_unavailable_outcome(error)
            if unavailable_outcome is not None:
                emit_profile_name_modal_unavailable(
                    attempt_count=attempted_clicks,
                    outcome=unavailable_outcome,
                )
                raise RuntimeError(
                    "personal information name modal is unavailable"
                ) from error
            raise
    if last_error is not None:
        unavailable_outcome = profile_name_modal_unavailable_outcome(last_error)
        if unavailable_outcome is not None:
            emit_profile_name_modal_unavailable(
                attempt_count=attempted_clicks,
                outcome=unavailable_outcome,
            )
            raise RuntimeError(
                "personal information name modal is unavailable"
            ) from last_error
        raise last_error
    emit_profile_name_modal_unavailable(
        attempt_count=attempted_clicks,
        outcome="timeout",
    )
    raise RuntimeError("personal information name modal is unavailable")


def profile_state_has_hard_authentication_blocker(state: dict[str, Any]) -> bool:
    has_active_state = all(
        key in state
        for key in (
            "activeAuthUiPresent",
            "activeOtpRejected",
            "activeBlocked",
        )
    )
    if has_active_state:
        return bool(
            state.get("activeAuthUiPresent")
            or state.get("activeOtpRejected")
            or state.get("activeBlocked")
        )
    return bool(
        has_live_auth_controls(state)
        or state.get("childAuthUiPresent")
        or state.get("otpRejected")
        or state.get("blocked")
        or state.get("hardAuthenticationError")
        or state.get("rootHardAuthenticationError")
    )


def confirmed_personal_information_state(
    state: dict[str, Any],
) -> dict[str, Any]:
    if profile_state_has_hard_authentication_blocker(state):
        raise RuntimeError(
            "personal information page reported an authentication error"
        )
    # The exact information route plus two stable visible profile cards is the
    # authoritative post-login anchor. Account-security prose left behind by
    # the SPA is text-only and must not turn that structural state into 2FA.
    return {
        **state,
        "trusted": True,
        "rootSessionTrusted": True,
        "rootManageUrl": True,
        "rootError": False,
        "error": False,
        "twofa": False,
        "twofaVisible": False,
    }


def profile_capture_card_snapshot(
    page: Any,
) -> tuple[tuple[Any, ...], tuple[Any, Any, dict[str, Any]], tuple[Any, Any, dict[str, Any]]] | None:
    if not is_personal_information_scope(page, page):
        return None
    birthday = resolve_profile_card(page, "birthday")
    name = resolve_profile_card(page, "name")
    if birthday is None or name is None or not is_personal_information_scope(page, page):
        return None
    birthday_scope, birthday_card, birthday_summary = birthday
    name_scope, name_card, _name_summary = name
    birthday_identity = profile_card_dom_identity(birthday_summary)
    name_identity = profile_card_dom_identity(_name_summary)
    if birthday_identity is None or name_identity is None:
        raise RuntimeError("personal information profile card identity is unavailable")
    birthday_signature = scope_browsing_context_id(birthday_scope), birthday_identity
    name_signature = scope_browsing_context_id(name_scope), name_identity
    if birthday_signature == name_signature:
        raise RuntimeError("personal information profile card identity collision")
    signature = (
        birthday_signature,
        normalize_profile_value(
            birthday_summary.get("birthdayValue"),
            "birthday",
        ),
        name_signature,
    )
    return signature, birthday, name


def profile_capture_snapshot_outcome(error: Exception) -> str:
    message = str(error).lower()
    if "identity collision" in message:
        return "card_identity_collision"
    if "card is ambiguous" in message or "birthday card is ambiguous" in message:
        return "card_ambiguous"
    return "card_query_failed"


def profile_capture_readiness_observation(
    page: Any,
    *,
    state_readable: bool,
    authentication_blocked: bool,
    snapshot_outcome: str,
    stable_observations: int,
) -> dict[str, Any]:
    """Emit only fixed structural facts, never card text or profile values."""
    route_confirmed = is_personal_information_scope(page, page)
    name_candidates: list[tuple[Any, Any, dict[str, Any]]] = []
    birthday_candidates: list[tuple[Any, Any, dict[str, Any]]] = []
    outcome = (
        snapshot_outcome
        if snapshot_outcome in PROFILE_CAPTURE_READINESS_OUTCOMES
        else "card_query_failed"
    )
    if route_confirmed:
        try:
            name_candidates = profile_card_candidates(page, "name")
            birthday_candidates = profile_card_candidates(page, "birthday")
        except Exception:
            outcome = "card_query_failed"
    name_identity = (
        profile_card_dom_identity(name_candidates[0][2])
        if len(name_candidates) == 1
        else None
    )
    birthday_identity = (
        profile_card_dom_identity(birthday_candidates[0][2])
        if len(birthday_candidates) == 1
        else None
    )
    return {
        "routeConfirmed": route_confirmed,
        "stateReadable": state_readable,
        "authenticationBlocked": authentication_blocked,
        "nameCardCount": min(3, len(name_candidates)),
        "birthdayCardCount": min(3, len(birthday_candidates)),
        "birthdayValueReady": any(
            profile_value_is_ready(summary.get("birthdayValue"), "birthday")
            for _scope, _card, summary in birthday_candidates
        ),
        "sameCardIdentity": bool(
            name_identity is not None
            and birthday_identity is not None
            and name_identity == birthday_identity
        ),
        "snapshotOutcome": outcome,
        "stableObservations": min(3, max(0, stable_observations)),
    }


def wait_for_profile_capture_ready(
    page: Any,
    timeout_s: float = PROFILE_CARD_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    if pause is None:
        pause = human_pause
    deadline = time.monotonic() + timeout_s
    previous_signature: tuple[Any, ...] | None = None
    stable_observations = 0
    authentication_blocked = False
    previous_observation: tuple[Any, ...] | None = None
    last_snapshot_outcome = "route_unready"
    while time.monotonic() < deadline:
        state: dict[str, Any] | None = None
        try:
            state = detect_login_state(page)
        except Exception:
            pass
        snapshot = None
        if state is None:
            authentication_blocked = False
            last_snapshot_outcome = "state_unavailable"
            previous_signature = None
            stable_observations = 0
        elif profile_state_has_hard_authentication_blocker(state):
            authentication_blocked = (
                profile_state_has_hard_authentication_blocker(state)
            )
            last_snapshot_outcome = "authentication_blocked"
            previous_signature = None
            stable_observations = 0
        else:
            authentication_blocked = False
            if not is_personal_information_scope(page, page):
                last_snapshot_outcome = "route_unready"
            else:
                try:
                    snapshot = profile_capture_card_snapshot(page)
                    last_snapshot_outcome = (
                        "ready" if snapshot is not None else "card_missing"
                    )
                except Exception as error:
                    last_snapshot_outcome = profile_capture_snapshot_outcome(error)
            if snapshot is not None:
                signature, _birthday, _name = snapshot
                stable_observations = (
                    stable_observations + 1
                    if signature == previous_signature
                    else 1
                )
                previous_signature = signature
            else:
                previous_signature = None
                stable_observations = 0
        observation = profile_capture_readiness_observation(
            page,
            state_readable=state is not None,
            authentication_blocked=authentication_blocked,
            snapshot_outcome=last_snapshot_outcome,
            stable_observations=stable_observations,
        )
        observation_key = tuple(observation.items())
        if observation_key != previous_observation:
            emit(
                {
                    "event": "status",
                    "status": "profile_capture_readiness",
                    **observation,
                }
            )
            previous_observation = observation_key
        if snapshot is not None and stable_observations >= PROFILE_VALUE_STABLE_OBSERVATIONS:
            return confirmed_personal_information_state(state)
        pause(180, 420)
    if authentication_blocked:
        raise RuntimeError(
            "personal information page reported an authentication error"
        )
    if last_snapshot_outcome == "card_identity_collision":
        raise RuntimeError("personal information profile card identity collision")
    if last_snapshot_outcome == "card_ambiguous":
        raise RuntimeError("personal information profile card is ambiguous")
    raise RuntimeError("personal information page was not ready")


def collect_personal_info(page: Any) -> dict[str, Any]:
    _birthday_scope, _birthday_card, birthday_summary = wait_for_profile_card(
        page,
        "birthday",
    )
    birthday = normalize_profile_value(birthday_summary.get("birthdayValue"), "birthday")
    emit({"event": "status", "status": "profile_birthday_collected"})

    set_browser_startup_stage("profile_name")
    modal_scope, modal, modal_summary, modal_selector = open_profile_name_modal(page)
    given = normalize_profile_value(modal_summary.get("given"), "name")
    family = normalize_profile_value(modal_summary.get("family"), "name")
    ordered_parts = [
        normalize_profile_value(part, "name")
        for part in modal_summary.get("orderedParts", [])
    ]
    if len(ordered_parts) != 2 or ordered_parts not in (
        [given, family],
        [family, given],
    ):
        raise RuntimeError("personal information name field order was not confirmed")
    name = normalize_profile_value(" ".join([given, family]), "name")
    emit({"event": "status", "status": "profile_name_collected"})
    cleanup = close_profile_name_modal(
        page,
        modal_scope,
        modal,
        modal_selector=modal_selector,
    )
    if cleanup["closed"] is not True:
        emit(
            {
                "event": "status",
                "status": "profile_name_modal_cleanup_failed",
                "failureClass": cleanup["failureClass"],
                "closeSearchScope": cleanup["closeSearchScope"],
            }
        )
        raise RuntimeError("personal information name modal cleanup failed")
    return {"name": name, "birthday": birthday}


def profile_modal_close_summary(button: Any) -> dict[str, Any]:
    raw = button.run_js(
        r"""
        function () {
          // ruyipage-profile-modal-close
          const rect = this.getBoundingClientRect();
          const style = window.getComputedStyle(this);
          const visible = rect.width > 2 && rect.height > 2 &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            this.getAttribute('aria-hidden') !== 'true';
          return JSON.stringify({
            visible,
            label: String(
              this.getAttribute('aria-label') ||
              this.innerText ||
              this.textContent ||
              ''
            ).replace(/\s+/g, ' ').trim().toLocaleLowerCase(),
            className: String(this.className || '').toLocaleLowerCase()
          });
        }
        """
    )
    result = parse_profile_query_result(raw, "profile modal close")
    return {
        "visible": result.get("visible") is True,
        "label": " ".join(str(result.get("label") or "").split()).casefold(),
        "className": " ".join(
            str(result.get("className") or "").split()
        ).casefold(),
    }


def profile_modal_close_elements(root: Any, selector: str) -> tuple[list[Any], bool]:
    """Resolve close candidates without flattening ruyiPage query errors."""
    try:
        return list(root.eles(selector, timeout=0) or []), False
    except Exception:
        return [], True


def profile_modal_close_button_in_root(root: Any) -> tuple[Any | None, bool]:
    query_failed = False
    for selector in PROFILE_MODAL_CLOSE_SELECTORS:
        elements, selector_failed = profile_modal_close_elements(root, selector)
        query_failed = query_failed or selector_failed
        candidates = [button for button in elements if element_is_interactable(button)]
        if candidates:
            return candidates[0], query_failed
    buttons, buttons_failed = profile_modal_close_elements(root, "css:button")
    query_failed = query_failed or buttons_failed
    for button in buttons:
        if not element_is_interactable(button):
            continue
        try:
            summary = profile_modal_close_summary(button)
        except Exception:
            query_failed = True
            continue
        if not summary["visible"]:
            continue
        if (
            "modal-close" in summary["className"]
            or summary["label"] in {"close", "关闭", "關閉"}
        ):
            return button, query_failed
    return None, query_failed


def profile_modal_associated_close_button_in_root(
    root: Any,
    modal_id: str,
) -> tuple[Any | None, bool]:
    """Find a semantically-close control explicitly linked to the active modal.

    Portal/shadow-root controls need both an explicit modal relationship and a
    close label/class.  That avoids a document-wide scan clicking an unrelated
    banner, or a non-close control that happens to reference the same dialog.
    """
    normalized_id = str(modal_id or "").strip()
    if not normalized_id:
        return None, False
    escaped_id = normalized_id.replace("\\", "\\\\").replace("'", "\\'")
    selectors = (
        f"css:button[aria-controls='{escaped_id}']",
        f"css:[role='button'][aria-controls='{escaped_id}']",
        f"css:button[data-modal-id='{escaped_id}']",
        f"css:[role='button'][data-modal-id='{escaped_id}']",
        f"css:button[data-target='#{escaped_id}']",
        f"css:[role='button'][data-target='#{escaped_id}']",
    )
    query_failed = False
    for selector in selectors:
        elements, selector_failed = profile_modal_close_elements(root, selector)
        query_failed = query_failed or selector_failed
        for button in elements:
            if not element_is_interactable(button):
                continue
            try:
                summary = profile_modal_close_summary(button)
            except Exception:
                query_failed = True
                continue
            if not summary["visible"]:
                continue
            if (
                "modal-close" in summary["className"]
                or summary["label"] in {"close", "关闭", "關閉"}
            ):
                return button, query_failed
    return None, query_failed


def profile_name_modal_close_search_roots(
    page: Any,
    modal_scope: Any,
    modal: Any,
) -> list[tuple[str, Any, Any]]:
    """Return only top-level modal/portal roots; never inspect child frames."""
    owner_scope = modal_scope or page
    roots: list[tuple[str, Any, Any]] = [("modal_content", owner_scope, modal)]
    seen = {id(modal)}
    page_roots = [
        (scope, root)
        for scope, root in current_element_search_roots(page)
        if scope is page
    ]
    for scope, root in page_roots:
        for selector in PROFILE_NAME_MODAL_SELECTORS:
            for overlay in safe_elements(root, selector, timeout_s=0):
                if id(overlay) in seen or not element_is_interactable(overlay):
                    continue
                try:
                    summary = profile_name_modal_summary(overlay)
                except Exception:
                    continue
                if not (summary["visible"] and summary["fieldCount"] >= 2):
                    continue
                seen.add(id(overlay))
                roots.append(("owner_overlay", scope, overlay))
    modal_id = ""
    try:
        modal_id = str(modal.attr("id") or "").strip()
    except Exception:
        modal_id = ""
    if modal_id:
        for scope, root in page_roots:
            if id(root) in seen:
                continue
            seen.add(id(root))
            roots.append(("portal_owner", scope, root))
    return roots


def resolve_profile_name_modal_close_button(
    page: Any,
    modal_scope: Any,
    modal: Any,
) -> tuple[tuple[str, Any, Any] | None, bool, str]:
    query_failed = False
    query_failure_scope = "none"
    for search_scope, scope, root in profile_name_modal_close_search_roots(
        page,
        modal_scope,
        modal,
    ):
        if search_scope == "portal_owner":
            try:
                modal_id = str(modal.attr("id") or "").strip()
            except Exception:
                modal_id = ""
            button, root_query_failed = profile_modal_associated_close_button_in_root(
                root,
                modal_id,
            )
        else:
            button, root_query_failed = profile_modal_close_button_in_root(root)
        if root_query_failed:
            query_failed = True
            if query_failure_scope == "none":
                query_failure_scope = search_scope
        if button is not None:
            return (search_scope, scope, button), False, "none"
    return None, query_failed, query_failure_scope


def profile_name_modal_identifier(modal: Any) -> str:
    try:
        return str(modal.attr("id") or "").strip()
    except Exception:
        return ""


def profile_name_modal_selector(
    page: Any,
    modal_scope: Any,
    modal: Any,
) -> str:
    """Remember the selector that identified the trusted name dialog root."""
    try:
        target_signature = element_stability_signature(modal_scope, modal)
    except Exception:
        target_signature = None
    for scope, root in current_element_search_roots(page):
        if scope is not modal_scope:
            continue
        for selector in PROFILE_NAME_MODAL_SELECTORS:
            for candidate in safe_elements(root, selector, timeout_s=0):
                same_wrapper = candidate is modal
                same_signature = False
                if target_signature is not None:
                    try:
                        same_signature = (
                            element_stability_signature(scope, candidate)
                            == target_signature
                        )
                    except Exception:
                        same_signature = False
                if same_wrapper or same_signature:
                    return selector
    return ""


def profile_name_modal_cleanup_state(
    page: Any,
    modal_id: str = "",
    *,
    modal_selector: str = "",
    modal_scope: Any | None = None,
) -> str:
    """Confirm that the active name dialog disappeared without leaving its view.

    ``resolve_profile_name_modal`` intentionally requires hydrated name values,
    so it is not a sufficient close proof on its own: an open dialog can be
    briefly unreadable during an SPA update.  A visible dialog with the exact
    original modal id remains open even when its fields have temporarily not
    rendered; unrelated dialogs still need the two-field name-modal signal.
    """
    if not is_personal_information_scope(page, page):
        return "context_lost"
    expected_modal_id = str(modal_id or "").strip()
    expected_modal_selector = (
        str(modal_selector or "").strip()
        if modal_selector in PROFILE_NAME_MODAL_SELECTORS
        else ""
    )
    expected_context_id = ""
    if modal_scope is not None:
        try:
            expected_context_id = scope_browsing_context_id(modal_scope)
        except Exception:
            expected_context_id = ""
    query_failed = False
    seen: set[int] = set()
    for scope, root in current_element_search_roots(page):
        if scope is not page:
            continue
        for selector in PROFILE_NAME_MODAL_SELECTORS:
            modals, selector_failed = profile_modal_close_elements(root, selector)
            query_failed = query_failed or selector_failed
            for candidate in modals:
                if id(candidate) in seen or not element_is_interactable(candidate):
                    continue
                seen.add(id(candidate))
                try:
                    summary = profile_name_modal_summary(candidate)
                    candidate_modal_id = profile_name_modal_identifier(candidate)
                except Exception:
                    query_failed = True
                    continue
                if not summary["visible"]:
                    continue
                candidate_context_id = ""
                try:
                    candidate_context_id = scope_browsing_context_id(scope)
                except Exception:
                    query_failed = True
                same_origin_selector = bool(
                    expected_modal_selector
                    and selector == expected_modal_selector
                    and (
                        not expected_context_id
                        or candidate_context_id == expected_context_id
                    )
                )
                if (
                    (expected_modal_id and candidate_modal_id == expected_modal_id)
                    or same_origin_selector
                    or summary["fieldCount"] >= 2
                ):
                    return "open"
    return "unconfirmed" if query_failed else "closed"


def close_profile_name_modal(
    page: Any,
    modal_scope: Any,
    modal: Any,
    *,
    timeout_s: float = PROFILE_MODAL_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] = human_pause,
    modal_selector: str = "",
) -> dict[str, Any]:
    deadline = time.monotonic() + max(0.0, timeout_s)
    last_search_scope = "none"
    active_modal_id = profile_name_modal_identifier(modal)
    active_modal_selector = (
        modal_selector
        if modal_selector in PROFILE_NAME_MODAL_SELECTORS
        else profile_name_modal_selector(page, modal_scope, modal)
    )
    for attempt in range(PROFILE_MODAL_CLOSE_CLICK_ATTEMPTS):
        # A React hydration/update can replace the inner dialog or close
        # target between discovery and click.  Retry only a failed click, and
        # refresh both the modal and its close control before doing so.
        if attempt:
            cleanup_state = profile_name_modal_cleanup_state(
                page,
                active_modal_id,
                modal_selector=active_modal_selector,
                modal_scope=modal_scope,
            )
            if cleanup_state == "closed":
                emit({"event": "status", "status": "profile_name_modal_closed"})
                return {
                    "closed": True,
                    "failureClass": "unknown",
                    "closeSearchScope": last_search_scope,
                }
            if cleanup_state == "context_lost":
                return {
                    "closed": False,
                    "failureClass": "profile_name_modal_close_context_lost",
                    "closeSearchScope": last_search_scope,
                }
            if cleanup_state == "unconfirmed":
                return {
                    "closed": False,
                    "failureClass": "profile_name_modal_close_query_failed",
                    "closeSearchScope": last_search_scope,
                }
            try:
                active_modal = resolve_profile_name_modal(page)
            except Exception:
                active_modal = None
            if active_modal is None:
                return {
                    "closed": False,
                    "failureClass": "profile_name_modal_close_action_failed",
                    "closeSearchScope": last_search_scope,
                }
            modal_scope, modal, _modal_summary = active_modal
            active_modal_selector = profile_name_modal_selector(
                page,
                modal_scope,
                modal,
            ) or active_modal_selector
            active_modal_id = profile_name_modal_identifier(modal) or active_modal_id

        resolved, close_query_failed, query_failure_scope = (
            resolve_profile_name_modal_close_button(page, modal_scope, modal)
        )
        if resolved is None:
            return {
                "closed": False,
                "failureClass": (
                    "profile_name_modal_close_query_failed"
                    if close_query_failed
                    else (
                        "profile_name_modal_close_action_failed"
                        if attempt
                        else "profile_name_modal_close_control_unavailable"
                    )
                ),
                "closeSearchScope": (
                    query_failure_scope if close_query_failed else last_search_scope
                ),
            }
        close_search_scope, close_scope, close_button = resolved
        last_search_scope = close_search_scope
        try:
            human_click(close_scope or modal_scope or page, close_button, pause=pause)
        except Exception:
            if attempt + 1 < PROFILE_MODAL_CLOSE_CLICK_ATTEMPTS:
                pause(120, 260)
                continue
            return {
                "closed": False,
                "failureClass": "profile_name_modal_close_action_failed",
                "closeSearchScope": close_search_scope,
            }

        # A dispatched close action receives the full confirmation window;
        # only an exception above is eligible for a fresh-target retry.
        while time.monotonic() < deadline:
            cleanup_state = profile_name_modal_cleanup_state(
                page,
                active_modal_id,
                modal_selector=active_modal_selector,
                modal_scope=modal_scope,
            )
            if cleanup_state == "closed":
                emit({"event": "status", "status": "profile_name_modal_closed"})
                return {
                    "closed": True,
                    "failureClass": "unknown",
                    "closeSearchScope": close_search_scope,
                }
            if cleanup_state == "context_lost":
                return {
                    "closed": False,
                    "failureClass": "profile_name_modal_close_context_lost",
                    "closeSearchScope": close_search_scope,
                }
            if cleanup_state == "unconfirmed":
                return {
                    "closed": False,
                    "failureClass": "profile_name_modal_close_query_failed",
                    "closeSearchScope": close_search_scope,
                }
            pause(120, 260)
        return {
            "closed": False,
            "failureClass": "profile_name_modal_close_unconfirmed",
            "closeSearchScope": close_search_scope,
        }
    return {
        "closed": False,
        "failureClass": "profile_name_modal_close_action_failed",
        "closeSearchScope": last_search_scope,
    }


def normalize_account_security_label(value: Any) -> str:
    return " ".join(str(value or "").split()).casefold()


def is_account_security_url(url: str) -> bool:
    parsed = parse_valid_apple_url(url)
    return bool(
        parsed is not None
        and (parsed.hostname or "").lower() == "account.apple.com"
        and parsed.path == ACCOUNT_SECURITY_PATH
    )


def parse_account_security_query_result(raw: Any, label: str) -> dict[str, Any]:
    value = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(value, dict):
        raise RuntimeError(f"account security {label} query returned an invalid result")
    return value


def resolve_account_security_navigation_link(
    page: Any,
) -> tuple[Any, Any] | None:
    if not is_account_manage_url(scope_location_url(page)):
        return None
    exact_candidates: list[tuple[Any, Any]] = []
    semantic_candidates: list[tuple[Any, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for scope, root in current_element_search_roots(page):
        if scope is not page:
            continue
        for selector in PROFILE_NAVIGATION_LINK_SELECTORS:
            for link in safe_elements(root, selector, timeout_s=0):
                if not element_is_interactable(link):
                    continue
                try:
                    summary = profile_navigation_link_summary(link)
                    identity = (
                        scope_browsing_context_id(scope),
                        summary["domIdentity"]
                        or element_stability_signature(scope, link),
                        summary["href"],
                        summary["label"],
                    )
                except Exception:
                    continue
                if identity in seen:
                    continue
                seen.add(identity)
                if not summary["visible"]:
                    continue
                if is_account_security_url(summary["href"]):
                    exact_candidates.append((scope, link))
                elif summary["label"] in ACCOUNT_SECURITY_NAVIGATION_LABELS:
                    semantic_candidates.append((scope, link))
    if len(exact_candidates) == 1:
        return exact_candidates[0]
    return semantic_candidates[0] if len(semantic_candidates) == 1 else None


def wait_for_account_security_navigation_result(
    page: Any,
    timeout_s: float = ACCOUNT_SECURITY_NAVIGATION_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] = human_pause,
) -> str:
    deadline = time.monotonic() + max(0.0, timeout_s)
    while time.monotonic() < deadline:
        current_url = scope_location_url(page)
        if is_account_security_url(current_url):
            return "account_security"
        if is_account_sign_in_url(current_url):
            return "sign_in"
        if not is_apple_url(current_url):
            raise RuntimeError(
                "account security navigation left the verified Apple HTTPS origin"
            )
        pause(180, 420)
    return "unconfirmed"


def navigate_to_account_security(
    page: Any,
    *,
    navigation_attempt: int,
    pause: Callable[[int, int], None] = human_pause,
) -> str:
    if isinstance(navigation_attempt, bool) or navigation_attempt not in (1, 2):
        raise RuntimeError("account security navigation attempt is invalid")
    emit(
        {
            "event": "status",
            "status": "account_security_navigation_started",
            "attempt": navigation_attempt,
        }
    )
    if is_account_security_url(scope_location_url(page)):
        emit(
            {
                "event": "status",
                "status": "account_security_navigation_arrived",
                "route": "existing",
                "attempt": navigation_attempt,
            }
        )
        return "account_security"

    resolved_link = resolve_account_security_navigation_link(page)
    if resolved_link is not None:
        scope, link = resolved_link
        emit(
            {
                "event": "status",
                "status": "account_security_navigation_link_resolved",
                "attempt": navigation_attempt,
            }
        )
        human_click(scope, link, pause=pause)
        emit(
            {
                "event": "status",
                "status": "account_security_navigation_sidebar_click_sent",
                "attempt": navigation_attempt,
            }
        )
        wait_for_document_settle(page)
        route = "sidebar"
        result = wait_for_account_security_navigation_result(page, pause=pause)
        if result == "unconfirmed":
            emit(
                {
                    "event": "status",
                    "status": "account_security_navigation_direct_fallback",
                    "attempt": navigation_attempt,
                    "after": "sidebar_unconfirmed",
                }
            )
            page.get(ACCOUNT_SECURITY_URL)
            wait_for_document_settle(page, timeout_s=20)
            route = "sidebar_then_direct"
            result = wait_for_account_security_navigation_result(page, pause=pause)
    else:
        emit(
            {
                "event": "status",
                "status": "account_security_navigation_direct_fallback",
                "attempt": navigation_attempt,
            }
        )
        page.get(ACCOUNT_SECURITY_URL)
        wait_for_document_settle(page, timeout_s=20)
        route = "direct"
        result = wait_for_account_security_navigation_result(page, pause=pause)
    status = (
        "account_security_navigation_arrived"
        if result == "account_security"
        else "account_security_navigation_sign_in_redirect"
        if result == "sign_in"
        else "account_security_navigation_unconfirmed"
    )
    emit(
        {
            "event": "status",
            "status": status,
            "route": route,
            "attempt": navigation_attempt,
        }
    )
    return result


def account_security_page_snapshot(page: Any) -> dict[str, Any]:
    if not is_account_security_url(scope_location_url(page)):
        return {
            "securityPage": False,
            "passwordCard": False,
            "passwordForm": False,
            "passwordFieldCount": 0,
            "passwordChanged": False,
        }
    raw = page.run_js(
        r"""
        return JSON.stringify((() => {
          // ruyipage-account-security-page-snapshot
          const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 2 && rect.height > 2 &&
              style.display !== 'none' && style.visibility !== 'hidden' &&
              element.getAttribute('aria-hidden') !== 'true';
          };
          const normalize = (value) => String(value || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLocaleLowerCase();
          const text = normalize(
            document.querySelector('main')?.innerText ||
            document.body?.innerText ||
            ''
          );
          const fields = [...document.querySelectorAll('input[type="password"]')]
            .filter(visible)
            .filter((field) => !field.disabled && !field.readOnly);
          return {
            securityPage: location.pathname === '/account/manage/section/security',
            passwordCard: /(?:^|\s)(?:password|\u5bc6\u7801|\u5bc6\u78bc)(?:\s|$)/.test(text) &&
              /(?:last updated|\u4e0a\u6b21\u66f4\u65b0|\u4e0a\u6b21\u66f4\u65b0)/.test(text),
            passwordForm: fields.length >= 3,
            passwordFieldCount: Math.min(5, fields.length),
            passwordChanged: /(?:your password has been changed|password has been changed|\u4f60\u7684\u5bc6\u7801\u5df2\u66f4\u6539|\u5bc6\u7801\u5df2\u66f4\u6539|\u5bc6\u78bc\u5df2\u66f4\u6539)/.test(text)
          };
        })())
        """
    )
    result = parse_account_security_query_result(raw, "page snapshot")
    return {
        "securityPage": result.get("securityPage") is True,
        "passwordCard": result.get("passwordCard") is True,
        "passwordForm": result.get("passwordForm") is True,
        "passwordFieldCount": min(
            5,
            max(
                0,
                result.get("passwordFieldCount")
                if type(result.get("passwordFieldCount")) is int
                else 0,
            ),
        ),
        "passwordChanged": result.get("passwordChanged") is True,
    }


def account_password_card_summary(card: Any) -> dict[str, Any]:
    raw = card.run_js(
        r"""
        function () {
          // ruyipage-account-password-card
          const rect = this.getBoundingClientRect();
          const style = window.getComputedStyle(this);
          const visible = rect.width > 2 && rect.height > 2 &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            this.getAttribute('aria-hidden') !== 'true';
          const text = String(this.innerText || this.textContent || '')
            .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
          const domIdentity = (() => {
            const parts = [];
            let current = this;
            for (let depth = 0; current && current.nodeType === 1 && depth < 12; depth += 1) {
              const parent = current.parentElement;
              const index = parent
                ? Array.prototype.indexOf.call(parent.children, current)
                : 0;
              parts.push(`${String(current.tagName || '').toLowerCase()}:${index}`);
              current = parent;
            }
            return parts.reverse().join('/');
          })();
          return JSON.stringify({
            visible,
            passwordCard: /(?:^|\s)(?:password|\u5bc6\u7801|\u5bc6\u78bc)(?:\s|$)/.test(text),
            lastUpdated: /(?:last updated|\u4e0a\u6b21\u66f4\u65b0|\u4e0a\u6b21\u66f4\u65b0)/.test(text),
            domIdentity
          });
        }
        """
    )
    result = parse_account_security_query_result(raw, "password card")
    return {
        "visible": result.get("visible") is True,
        "passwordCard": result.get("passwordCard") is True,
        "lastUpdated": result.get("lastUpdated") is True,
        "domIdentity": str(result.get("domIdentity") or "").strip(),
    }


def resolve_account_password_card(page: Any) -> tuple[Any, Any] | None:
    if not is_account_security_url(scope_location_url(page)):
        return None
    candidates: list[tuple[Any, Any, dict[str, Any]]] = []
    seen: set[tuple[Any, ...]] = set()
    for scope, root in current_element_search_roots(page):
        if scope is not page:
            continue
        for selector in ACCOUNT_PASSWORD_CARD_SELECTORS:
            for card in safe_elements(root, selector, timeout_s=0):
                if not element_is_interactable(card):
                    continue
                try:
                    summary = account_password_card_summary(card)
                    identity = (
                        scope_browsing_context_id(scope),
                        summary["domIdentity"] or element_stability_signature(scope, card),
                    )
                except Exception:
                    continue
                if identity in seen:
                    continue
                seen.add(identity)
                if summary["visible"] and summary["passwordCard"] and summary["lastUpdated"]:
                    candidates.append((scope, card, summary))
    if len(candidates) != 1:
        return None
    return candidates[0][0], candidates[0][1]


def wait_for_account_password_card(
    page: Any,
    timeout_s: float = ACCOUNT_PASSWORD_CHANGE_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] = human_pause,
) -> tuple[Any, Any]:
    deadline = time.monotonic() + max(0.0, timeout_s)
    previous_identity: tuple[Any, ...] | None = None
    stable_count = 0
    while time.monotonic() < deadline:
        resolved = resolve_account_password_card(page)
        if resolved is not None:
            scope, card = resolved
            identity = (
                scope_browsing_context_id(scope),
                element_stability_signature(scope, card),
            )
            stable_count = stable_count + 1 if identity == previous_identity else 1
            previous_identity = identity
            if stable_count >= PROFILE_VALUE_STABLE_OBSERVATIONS:
                return resolved
        else:
            previous_identity = None
            stable_count = 0
        pause(180, 420)
    raise RuntimeError("account password card was not found")


def password_change_field_summary(field: Any) -> dict[str, Any]:
    raw = field.run_js(
        r"""
        function () {
          // ruyipage-account-password-change-field
          const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 2 && rect.height > 2 &&
              style.display !== 'none' && style.visibility !== 'hidden' &&
              element.getAttribute('aria-hidden') !== 'true';
          };
          const field = this;
          const labels = Array.from(field.labels || []).map(
            (label) => label.innerText || label.textContent || ''
          );
          const parentText = field.parentElement?.innerText || '';
          const signals = [
            field.getAttribute('autocomplete'),
            field.getAttribute('name'),
            field.getAttribute('id'),
            field.getAttribute('aria-label'),
            field.getAttribute('placeholder'),
            ...labels,
            parentText
          ].filter(Boolean).map((value) => String(value).replace(/\s+/g, ' ').trim());
          const domIdentity = (() => {
            const parts = [];
            let current = field;
            for (let depth = 0; current && current.nodeType === 1 && depth < 12; depth += 1) {
              const parent = current.parentElement;
              const index = parent
                ? Array.prototype.indexOf.call(parent.children, current)
                : 0;
              parts.push(`${String(current.tagName || '').toLowerCase()}:${index}`);
              current = parent;
            }
            return parts.reverse().join('/');
          })();
          return JSON.stringify({
            visible: visible(field),
            editable: !field.disabled && !field.readOnly,
            inputType: String(field.type || '').toLowerCase(),
            signals,
            domIdentity
          });
        }
        """
    )
    result = parse_account_security_query_result(raw, "password field")
    signals = [
        " ".join(str(value or "").split()).casefold()
        for value in result.get("signals", [])
        if str(value or "").strip()
    ]
    joined = " ".join(signals)
    kind = "unknown"
    if any(token in joined for token in ("current-password", "current password", "\u5f53\u524d\u5bc6\u7801", "\u7576\u524d\u5bc6\u78bc")):
        kind = "current"
    elif any(token in joined for token in ("confirm-password", "confirm password", "confirmation", "\u786e\u8ba4\u65b0\u5bc6\u7801", "\u78ba\u8a8d\u65b0\u5bc6\u78bc")):
        kind = "confirm"
    elif any(token in joined for token in ("new-password", "new password", "\u65b0\u5bc6\u7801", "\u65b0\u5bc6\u78bc")):
        kind = "new"
    return {
        "visible": result.get("visible") is True,
        "editable": result.get("editable") is True,
        "inputType": str(result.get("inputType") or "").casefold(),
        "signals": signals,
        "kind": kind,
        "domIdentity": str(result.get("domIdentity") or "").strip(),
    }


def resolve_account_password_change_fields(
    page: Any,
) -> dict[str, tuple[Any, Any]] | None:
    if not is_account_security_url(scope_location_url(page)):
        return None
    candidates: list[tuple[Any, Any, dict[str, Any]]] = []
    seen: set[tuple[Any, ...]] = set()
    for scope, root in current_element_search_roots(page):
        if scope is not page:
            continue
        for selector in ACCOUNT_PASSWORD_FIELD_SELECTORS:
            for field in safe_elements(root, selector, timeout_s=0):
                if not element_is_interactable(field):
                    continue
                try:
                    summary = password_change_field_summary(field)
                    identity = (
                        scope_browsing_context_id(scope),
                        summary["domIdentity"] or element_stability_signature(scope, field),
                    )
                except Exception:
                    continue
                if identity in seen:
                    continue
                seen.add(identity)
                if (
                    summary["visible"]
                    and summary["editable"]
                    and summary["inputType"] == "password"
                ):
                    candidates.append((scope, field, summary))
    if len(candidates) < 3:
        return None
    classified = {
        summary["kind"]: (scope, field)
        for scope, field, summary in candidates
        if summary["kind"] in {"current", "new", "confirm"}
    }
    if {"current", "new", "confirm"} <= classified.keys():
        return {
            "current": classified["current"],
            "new": classified["new"],
            "confirm": classified["confirm"],
        }
    if len(candidates) == 3:
        return {
            "current": (candidates[0][0], candidates[0][1]),
            "new": (candidates[1][0], candidates[1][1]),
            "confirm": (candidates[2][0], candidates[2][1]),
        }
    return None


def wait_for_account_password_change_form(
    page: Any,
    timeout_s: float = ACCOUNT_PASSWORD_CHANGE_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] = human_pause,
) -> dict[str, tuple[Any, Any]]:
    deadline = time.monotonic() + max(0.0, timeout_s)
    previous_identity: tuple[Any, ...] | None = None
    stable_count = 0
    while time.monotonic() < deadline:
        snapshot = account_security_page_snapshot(page)
        fields = resolve_account_password_change_fields(page)
        if snapshot["passwordForm"] and fields is not None:
            identity = tuple(
                element_stability_signature(scope, field)
                for scope, field in fields.values()
            )
            stable_count = stable_count + 1 if identity == previous_identity else 1
            previous_identity = identity
            if stable_count >= PROFILE_VALUE_STABLE_OBSERVATIONS:
                return fields
        else:
            previous_identity = None
            stable_count = 0
        pause(180, 420)
    raise RuntimeError("account password change form was not ready")


def account_password_submit_summary(button: Any) -> dict[str, Any]:
    raw = button.run_js(
        r"""
        function () {
          // ruyipage-account-password-submit
          const rect = this.getBoundingClientRect();
          const style = window.getComputedStyle(this);
          const visible = rect.width > 2 && rect.height > 2 &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            this.getAttribute('aria-hidden') !== 'true';
          return JSON.stringify({
            visible,
            enabled: !this.disabled && this.getAttribute('aria-disabled') !== 'true',
            label: String(
              this.getAttribute('aria-label') ||
              this.innerText ||
              this.textContent ||
              ''
            ).replace(/\s+/g, ' ').trim().toLocaleLowerCase()
          });
        }
        """
    )
    result = parse_account_security_query_result(raw, "password submit")
    label = normalize_account_security_label(result.get("label"))
    return {
        "visible": result.get("visible") is True,
        "enabled": result.get("enabled") is True,
        "label": label,
        "changePassword": label in {
            "change password",
            "\u66f4\u6539\u5bc6\u7801",
            "\u66f4\u6539\u5bc6\u78bc",
        },
    }


def resolve_account_password_change_submit(page: Any) -> tuple[Any, Any] | None:
    if not is_account_security_url(scope_location_url(page)):
        return None
    candidates: list[tuple[Any, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for scope, root in current_element_search_roots(page):
        if scope is not page:
            continue
        for selector in ACCOUNT_PASSWORD_SUBMIT_SELECTORS:
            for button in safe_elements(root, selector, timeout_s=0):
                if not element_is_interactable(button):
                    continue
                try:
                    summary = account_password_submit_summary(button)
                    identity = (
                        scope_browsing_context_id(scope),
                        element_stability_signature(scope, button),
                    )
                except Exception:
                    continue
                if identity in seen:
                    continue
                seen.add(identity)
                if summary["visible"] and summary["enabled"] and summary["changePassword"]:
                    candidates.append((scope, button))
    return candidates[0] if len(candidates) == 1 else None


def wait_for_account_password_change_submit(
    page: Any,
    timeout_s: float = ACCOUNT_PASSWORD_CHANGE_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] = human_pause,
) -> tuple[Any, Any]:
    deadline = time.monotonic() + max(0.0, timeout_s)
    while time.monotonic() < deadline:
        resolved = resolve_account_password_change_submit(page)
        if resolved is not None:
            return resolved
        pause(180, 420)
    raise RuntimeError("account password change submit button was not ready")


def wait_for_account_password_change_success(
    page: Any,
    timeout_s: float = ACCOUNT_PASSWORD_CHANGE_SUCCESS_TIMEOUT_S,
    pause: Callable[[int, int], None] = human_pause,
) -> None:
    deadline = time.monotonic() + max(0.0, timeout_s)
    stable_count = 0
    while time.monotonic() < deadline:
        snapshot = account_security_page_snapshot(page)
        if snapshot["passwordChanged"]:
            stable_count += 1
            if stable_count >= PROFILE_VALUE_STABLE_OBSERVATIONS:
                return
        else:
            stable_count = 0
        pause(180, 420)
    raise RuntimeError("account password change confirmation was not found")


def generate_account_password(length: int = ACCOUNT_PASSWORD_LENGTH) -> str:
    if length != ACCOUNT_PASSWORD_LENGTH:
        raise RuntimeError("generated account password length is invalid")
    random_source = secrets.SystemRandom()
    password = [
        random_source.choice(ACCOUNT_PASSWORD_UPPERCASE),
        random_source.choice(ACCOUNT_PASSWORD_LOWERCASE),
        random_source.choice(ACCOUNT_PASSWORD_DIGITS),
        random_source.choice(ACCOUNT_PASSWORD_SPECIAL_CHARACTERS),
    ]
    alphabet = (
        ACCOUNT_PASSWORD_UPPERCASE
        + ACCOUNT_PASSWORD_LOWERCASE
        + ACCOUNT_PASSWORD_DIGITS
        + ACCOUNT_PASSWORD_SPECIAL_CHARACTERS
    )
    password.extend(
        random_source.choice(alphabet)
        for _ in range(length - len(password))
    )
    random_source.shuffle(password)
    return "".join(password)


def classify_account_password_change_failure(error: Exception) -> str:
    message = str(error).casefold()
    if "navigation" in message or "security" in message:
        return "password_change_navigation_failed"
    if "form" in message or "field" in message or "card" in message:
        return "password_change_form_unready"
    if "submit" in message:
        return "password_change_submit_unconfirmed"
    if "confirmation" in message or "changed" in message:
        return "password_change_confirmation_missing"
    return "password_change_failed"


def change_account_password(
    page: Any,
    current_password: str,
    Keys: Any,
    *,
    pause: Callable[[int, int], None] = human_pause,
) -> dict[str, Any]:
    if not isinstance(current_password, str) or not current_password:
        raise RuntimeError("account current password is invalid")
    set_browser_startup_stage("account_security")
    emit({"event": "status", "status": "password_change_started"})
    try:
        route = navigate_to_account_security(page, navigation_attempt=1, pause=pause)
        if route == "sign_in":
            raise RuntimeError("account security navigation redirected to sign in")
        if route != "account_security":
            raise RuntimeError("account security navigation was not confirmed")
        emit({"event": "status", "status": "password_change_page_ready"})

        set_browser_startup_stage("password_change")
        card_scope, card = wait_for_account_password_card(page, pause=pause)
        human_click(card_scope, card, pause=pause)
        fields = wait_for_account_password_change_form(page, pause=pause)
        emit(
            {
                "event": "status",
                "status": "password_change_form_ready",
                "fieldCount": 3,
            }
        )
        new_password = generate_account_password()
        for kind, value in (
            ("current", current_password),
            ("new", new_password),
            ("confirm", new_password),
        ):
            scope, field = fields[kind]
            input_and_verify(
                scope,
                field,
                value,
                "password",
                Keys,
                pause=pause,
                root_page=page,
            )
        submit_scope, submit_button = wait_for_account_password_change_submit(
            page,
            pause=pause,
        )
        human_click(submit_scope, submit_button, pause=pause)
        emit({"event": "status", "status": "password_change_submitted"})
        wait_for_account_password_change_success(page, pause=pause)
        emit(
            {
                "event": "status",
                "status": "password_change_completed",
                "newPassword": new_password,
                "passwordLength": len(new_password),
            }
        )
        return {
            "success": True,
            "attempted": True,
            "passwordLength": len(new_password),
            "newPassword": new_password,
            "failureStage": "unknown",
            "failureClass": "unknown",
            "browserAlive": browser_connection_is_alive(page),
            "browserPreserved": False,
            "browserPreservationRequested": False,
        }
    except Exception as error:
        failure_stage = browser_startup_stage
        failure_class = classify_account_password_change_failure(error)
        emit(
            {
                "event": "status",
                "status": "password_change_failed",
                "failureStage": failure_stage,
                "failureClass": failure_class,
            }
        )
        raise


def normalize_small_business_text(value: Any) -> str:
    return " ".join(str(value or "").split()).casefold()


def small_business_text_blob(summary: dict[str, Any]) -> str:
    return normalize_small_business_text(
        " ".join(
            str(summary.get(key) or "")
            for key in (
                "label",
                "text",
                "groupText",
                "sectionId",
                "className",
                "id",
                "name",
                "value",
            )
        )
    )


def parse_small_business_query_result(raw: Any, label: str) -> dict[str, Any]:
    value = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(value, dict):
        raise RuntimeError(
            f"small business application {label} query returned an invalid result"
        )
    return value


def is_small_business_program_enroll_url(url: str) -> bool:
    parsed = urlsplit(str(url or "").strip())
    return bool(
        parsed.scheme == "https"
        and (parsed.hostname or "").lower() == "developer.apple.com"
        and parsed.username is None
        and parsed.password is None
        and parsed.port in (None, 443)
        and parsed.path.rstrip("/") == SMALL_BUSINESS_PROGRAM_ENROLL_PATH
    )


def small_business_enrollment_snapshot(page: Any) -> dict[str, Any]:
    if not is_small_business_program_enroll_url(scope_location_url(page)):
        return {
            "enrollPage": False,
            "thankYou": False,
            "formReady": False,
            "paidAgreementYes": False,
            "associatedNoCount": 0,
            "revenueCertification": False,
            "submitAvailable": False,
        }
    raw = page.run_js(
        r"""
        return JSON.stringify((() => {
          // ruyipage-small-business-enrollment-snapshot
          const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 2 && rect.height > 2 &&
              style.display !== 'none' && style.visibility !== 'hidden' &&
              element.getAttribute('aria-hidden') !== 'true';
          };
          const normalize = (value) => String(value || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLocaleLowerCase();
          const textFor = (element) => normalize([
            element?.innerText,
            element?.textContent,
            element?.value,
            element?.getAttribute?.('aria-label'),
            element?.getAttribute?.('title')
          ].filter(Boolean).join(' '));
          const labelsFor = (input) => Array.from(input?.labels || [])
            .map((label) => textFor(label));
          const inputVisible = (input) =>
            visible(input) || labelsFor(input).some((text) => text);
          const enabled = (element) =>
            element && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
          const bodyText = normalize(
            document.querySelector('main')?.innerText ||
            document.body?.innerText ||
            ''
          );
          const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
            .filter((input) => inputVisible(input) && enabled(input));
          const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
            .filter((input) => inputVisible(input) && enabled(input));
          const radioText = (input) => normalize([
            ...labelsFor(input),
            input.value,
            input.name,
            input.id,
            input.closest('fieldset')?.innerText || ''
          ].filter(Boolean).join(' '));
          const labelOnly = (input) => normalize([
            ...labelsFor(input),
            input.value
          ].filter(Boolean).join(' ')).replace(/^[\s.。:：]+|[\s.。:：]+$/g, '');
          const paidAgreementYes = radios.some((input) => {
            const text = radioText(input);
            return /(paid applications agreement|paid apps agreement|\u4ed8\u8d39\u5e94\u7528|\u4ed8\u8cbb\u61c9\u7528)/i.test(text) &&
              /(yes,? i have accepted|i have accepted|\u6211\u5df2\u63a5\u53d7|\u6211\u5df2\u540c\u610f|\u5df2\u63a5\u53d7|\u5df2\u540c\u610f)/i.test(text);
          });
          const noRadios = radios.filter((input) => {
            const label = labelOnly(input);
            const text = radioText(input);
            if (/(paid applications agreement|paid apps agreement|\u4ed8\u8d39\u5e94\u7528|\u4ed8\u8cbb\u61c9\u7528)/i.test(text)) {
              return false;
            }
            return /^(no|\u5426|\u4e0d\u662f|\u6ca1\u6709|\u6c92\u6709)$/i.test(label);
          });
          const revenueCertification = checkboxes.some((input) => {
            const text = normalize([
              ...labelsFor(input),
              input.value,
              input.name,
              input.id,
              input.className,
              input.closest('section')?.id || '',
              input.closest('section')?.innerText || '',
              input.closest('fieldset')?.innerText || ''
            ].filter(Boolean).join(' '));
            return /best of your knowledge|associated developer accounts earned|1,000,000|1000000|usd|\u636e\u4f60\u6240\u77e5|\u64da\u4f60\u6240\u77e5|\u5173\u8054\u5f00\u53d1\u8005|\u95dc\u806f\u958b\u767c\u8005|\u7f8e\u5143|\u6536\u5165|\u6536\u76ca|paid-apps-agreement-chkbox|chkpolicyagree/i.test(text);
          });
          const submitAvailable = Array.from(
            document.querySelectorAll('input#submit,input[type="submit"],button[type="submit"],button')
          ).some((button) => {
            const text = normalize([
              button.value,
              button.innerText,
              button.textContent,
              button.getAttribute('aria-label'),
              button.id,
              button.name
            ].filter(Boolean).join(' '));
            return visible(button) && enabled(button) &&
              /^(submit|continue|\u63d0\u4ea4|\u9001\u51fa|\u7ee7\u7eed|\u7e7c\u7e8c)$|submit|\u63d0\u4ea4|\u9001\u51fa/.test(text);
          });
          return {
            enrollPage: location.protocol === 'https:' &&
              location.hostname === 'developer.apple.com' &&
              location.pathname.replace(/\/+$/, '') === '/app-store/small-business-program/enroll',
            thankYou: /thank you for your submission|thanks for your submission|\u611f\u8c22(?:\u60a8)?\u7684?\u63d0\u4ea4|\u611f\u8b1d(?:\u60a8)?\u7684?\u63d0\u4ea4|\u5df2\u6536\u5230.*(?:\u7533\u8bf7|\u7533\u8acb)|\u63d0\u4ea4\u6210\u529f/.test(bodyText),
            formReady: paidAgreementYes && noRadios.length >= 4 &&
              revenueCertification,
            paidAgreementYes,
            associatedNoCount: Math.min(8, noRadios.length),
            revenueCertification,
            submitAvailable
          };
        })())
        """
    )
    result = parse_small_business_query_result(raw, "snapshot")
    return {
        "enrollPage": result.get("enrollPage") is True,
        "thankYou": result.get("thankYou") is True,
        "formReady": result.get("formReady") is True,
        "paidAgreementYes": result.get("paidAgreementYes") is True,
        "associatedNoCount": min(
            8,
            max(
                0,
                result.get("associatedNoCount")
                if type(result.get("associatedNoCount")) is int
                else 0,
            ),
        ),
        "revenueCertification": result.get("revenueCertification") is True,
        "submitAvailable": result.get("submitAvailable") is True,
    }


def small_business_scope_has_auth_blocker(page: Any) -> bool:
    for scope in iter_page_scopes(page):
        try:
            state = detect_scope_login_state(scope)
        except Exception:
            if scope is page:
                return True
            continue
        if any(
            state.get(key) is True
            for key in (
                "password",
                "email",
                "twofa",
                "trustPrompt",
                "error",
                "otpRejected",
                "blocked",
                "hardAuthenticationError",
            )
        ):
            return True
    return False


def confirmed_small_business_application_state(page: Any) -> dict[str, Any] | None:
    if not browser_connection_is_alive(page):
        return None
    try:
        snapshot = small_business_enrollment_snapshot(page)
    except Exception:
        return None
    if snapshot["enrollPage"] is not True:
        return None
    if small_business_scope_has_auth_blocker(page):
        return None
    if not (snapshot["thankYou"] or snapshot["formReady"]):
        return None
    return {
        "trusted": True,
        "rootSessionTrusted": True,
        "rootError": False,
        "smallBusinessApplication": True,
        "smallBusinessSubmitted": snapshot["thankYou"],
        "smallBusinessFormReady": snapshot["formReady"],
        "inspectionAvailable": True,
        "twofa": False,
        "twofaVisible": False,
        "trustPrompt": False,
        "inputReady": False,
        "codeInputCount": 0,
        "password": False,
        "email": False,
        "error": False,
        "otpRejected": False,
        "blocked": False,
    }


def small_business_control_summary(element: Any) -> dict[str, Any]:
    raw = element.run_js(
        r"""
        function () {
          // ruyipage-small-business-control-summary
          const visible = (candidate) => {
            if (!candidate) return false;
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return rect.width > 2 && rect.height > 2 &&
              style.display !== 'none' && style.visibility !== 'hidden' &&
              candidate.getAttribute('aria-hidden') !== 'true';
          };
          const normalize = (value) => String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
          const element = this;
          const resolveControl = () => {
            if (element.matches?.('input,button')) return element;
            const nested = element.querySelector?.(
              'input[type="radio"],input[type="checkbox"],input[type="submit"],button'
            );
            if (nested) return nested;
            if (String(element.tagName || '').toUpperCase() === 'LABEL') {
              const htmlFor = element.getAttribute('for');
              if (htmlFor) return document.getElementById(htmlFor) || element;
            }
            return element;
          };
          const control = resolveControl();
          const labels = control?.labels
            ? Array.from(control.labels).map((label) =>
                normalize(label.innerText || label.textContent || '')
              )
            : [];
          const closestLabel = element.closest?.('label');
          const closestFieldset = element.closest?.('fieldset');
          const closestSection = element.closest?.('section');
          const label = normalize([
            element.innerText,
            element.textContent,
            control?.value,
            control?.getAttribute?.('aria-label'),
            control?.getAttribute?.('title'),
            ...labels
          ].filter(Boolean).join(' '));
          const domIdentity = (() => {
            const parts = [];
            let current = element;
            for (let depth = 0; current && current.nodeType === 1 && depth < 14; depth += 1) {
              const parent = current.parentElement;
              const index = parent
                ? Array.prototype.indexOf.call(parent.children, current)
                : 0;
              parts.push(`${String(current.tagName || '').toLowerCase()}:${index}`);
              current = parent;
            }
            return parts.reverse().join('/');
          })();
          const domOrder = Array.prototype.indexOf.call(
            document.querySelectorAll('label,input,button'),
            element
          );
          return JSON.stringify({
            visible: visible(element) || visible(control) ||
              labels.some((text) => text.length > 0),
            enabled: Boolean(control) &&
              !control.disabled &&
              !control.readOnly &&
              control.getAttribute?.('aria-disabled') !== 'true',
            tagName: String(element.tagName || '').toLowerCase(),
            inputType: String(control?.type || '').toLowerCase(),
            checked: control?.checked === true,
            label,
            text: normalize([
              element.innerText,
              element.textContent,
              closestLabel?.innerText,
              closestLabel?.textContent
            ].filter(Boolean).join(' ')),
            groupText: normalize([
              closestFieldset?.innerText,
              closestSection?.innerText
            ].filter(Boolean).join(' ')),
            sectionId: normalize(closestSection?.id || ''),
            className: normalize([
              element.className,
              control?.className
            ].filter(Boolean).join(' ')),
            id: normalize(control?.id || element.id || ''),
            name: normalize(control?.name || element.getAttribute?.('name') || ''),
            value: normalize(control?.value || element.getAttribute?.('value') || ''),
            domIdentity,
            controlIdentity: [
              String(control?.tagName || element.tagName || '').toLowerCase(),
              String(control?.type || '').toLowerCase(),
              normalize(control?.id || ''),
              normalize(control?.name || ''),
              normalize(control?.value || ''),
              domIdentity
            ].join('|'),
            domOrder: domOrder < 0 ? 999999 : domOrder
          });
        }
        """
    )
    result = parse_small_business_query_result(raw, "control")
    label = normalize_small_business_text(result.get("label"))
    return {
        "visible": result.get("visible") is True,
        "enabled": result.get("enabled") is True,
        "tagName": normalize_small_business_text(result.get("tagName")),
        "inputType": normalize_small_business_text(result.get("inputType")),
        "checked": result.get("checked") is True,
        "label": label,
        "text": normalize_small_business_text(result.get("text")),
        "groupText": normalize_small_business_text(result.get("groupText")),
        "sectionId": normalize_small_business_text(result.get("sectionId")),
        "className": normalize_small_business_text(result.get("className")),
        "id": normalize_small_business_text(result.get("id")),
        "name": normalize_small_business_text(result.get("name")),
        "value": normalize_small_business_text(result.get("value")),
        "domIdentity": str(result.get("domIdentity") or "").strip(),
        "controlIdentity": str(result.get("controlIdentity") or "").strip(),
        "domOrder": (
            result.get("domOrder")
            if type(result.get("domOrder")) is int
            and 0 <= result.get("domOrder") <= 1_000_000
            else 1_000_000
        ),
    }


def small_business_control_candidates(
    page: Any,
    selectors: tuple[str, ...],
) -> list[tuple[Any, Any, dict[str, Any]]]:
    if not is_small_business_program_enroll_url(scope_location_url(page)):
        return []
    candidates: list[tuple[Any, Any, dict[str, Any]]] = []
    seen_elements: set[tuple[Any, ...]] = set()
    for scope, root in current_element_search_roots(page):
        if scope is not page:
            continue
        for selector in selectors:
            for element in safe_elements(root, selector, timeout_s=0):
                if not element_is_interactable(element):
                    continue
                try:
                    summary = small_business_control_summary(element)
                    identity = (
                        scope_browsing_context_id(scope),
                        summary["domIdentity"]
                        or element_stability_signature(scope, element),
                    )
                except Exception:
                    continue
                if identity in seen_elements:
                    continue
                seen_elements.add(identity)
                if summary["visible"] and summary["enabled"]:
                    candidates.append((scope, element, summary))
    candidates.sort(key=lambda candidate: candidate[2]["domOrder"])
    return candidates


def small_business_distinct_controls(
    candidates: list[tuple[Any, Any, dict[str, Any]]],
) -> list[tuple[Any, Any, dict[str, Any]]]:
    distinct: list[tuple[Any, Any, dict[str, Any]]] = []
    seen: set[tuple[Any, ...]] = set()
    for scope, element, summary in candidates:
        identity = (
            scope_browsing_context_id(scope),
            summary.get("controlIdentity") or summary.get("domIdentity"),
        )
        if identity in seen:
            continue
        seen.add(identity)
        distinct.append((scope, element, summary))
    return distinct


def small_business_is_paid_agreement_yes(summary: dict[str, Any]) -> bool:
    if summary.get("inputType") != "radio":
        return False
    text = small_business_text_blob(summary)
    return bool(
        (
            "paid applications agreement" in text
            or "paid apps agreement" in text
            or "\u4ed8\u8d39\u5e94\u7528" in text
            or "\u4ed8\u8cbb\u61c9\u7528" in text
        )
        and (
            "yes, i have accepted" in text
            or "yes i have accepted" in text
            or "i have accepted" in text
            or "\u6211\u5df2\u63a5\u53d7" in text
            or "\u6211\u5df2\u540c\u610f" in text
            or "\u5df2\u63a5\u53d7" in text
            or "\u5df2\u540c\u610f" in text
        )
    )


def small_business_is_no_radio(summary: dict[str, Any]) -> bool:
    if summary.get("inputType") != "radio":
        return False
    text = small_business_text_blob(summary)
    if (
        "paid applications agreement" in text
        or "paid apps agreement" in text
        or "\u4ed8\u8d39\u5e94\u7528" in text
        or "\u4ed8\u8cbb\u61c9\u7528" in text
    ):
        return False
    label = normalize_small_business_text(summary.get("label")).strip(" .。:：")
    return label in {"no", "\u5426", "\u4e0d\u662f", "\u6ca1\u6709", "\u6c92\u6709"}


def small_business_is_revenue_certification(summary: dict[str, Any]) -> bool:
    if summary.get("inputType") != "checkbox":
        return False
    text = small_business_text_blob(summary)
    return bool(
        "best of your knowledge" in text
        or "associated developer accounts earned" in text
        or "1,000,000" in text
        or "1000000" in text
        or "usd" in text
        or "\u636e\u4f60\u6240\u77e5" in text
        or "\u64da\u4f60\u6240\u77e5" in text
        or "\u5173\u8054\u5f00\u53d1\u8005" in text
        or "\u95dc\u806f\u958b\u767c\u8005" in text
        or "\u7f8e\u5143" in text
        or "\u6536\u5165" in text
        or "\u6536\u76ca" in text
        or "paid-apps-agreement-chkbox" in text
        or "chkpolicyagree" in text
    )


def small_business_is_submit(summary: dict[str, Any]) -> bool:
    if summary.get("inputType") not in {"submit", "button"} and summary.get("tagName") != "button":
        return False
    label = normalize_small_business_text(
        summary.get("label") or summary.get("value") or summary.get("text")
    ).strip(" .。:：")
    return bool(
        label in {
            "submit",
            "continue",
            "\u63d0\u4ea4",
            "\u9001\u51fa",
            "\u7ee7\u7eed",
            "\u7e7c\u7e8c",
        }
        or "submit" in label
        or "\u63d0\u4ea4" in label
        or "\u9001\u51fa" in label
    )


def resolve_small_business_paid_agreement_yes(page: Any) -> tuple[Any, Any, dict[str, Any]] | None:
    candidates = [
        candidate
        for candidate in small_business_distinct_controls(
            small_business_control_candidates(page, SMALL_BUSINESS_CONTROL_SELECTORS)
        )
        if small_business_is_paid_agreement_yes(candidate[2])
    ]
    return candidates[0] if candidates else None


def resolve_small_business_associated_no_options(
    page: Any,
) -> list[tuple[Any, Any, dict[str, Any]]]:
    candidates = [
        candidate
        for candidate in small_business_distinct_controls(
            small_business_control_candidates(page, SMALL_BUSINESS_CONTROL_SELECTORS)
        )
        if small_business_is_no_radio(candidate[2])
    ]
    return (
        candidates[:SMALL_BUSINESS_ASSOCIATED_NO_COUNT]
        if len(candidates) >= SMALL_BUSINESS_ASSOCIATED_NO_COUNT
        else []
    )


def resolve_small_business_revenue_certification(page: Any) -> tuple[Any, Any, dict[str, Any]] | None:
    candidates = [
        candidate
        for candidate in small_business_distinct_controls(
            small_business_control_candidates(page, SMALL_BUSINESS_CONTROL_SELECTORS)
        )
        if small_business_is_revenue_certification(candidate[2])
    ]
    return candidates[0] if candidates else None


def resolve_small_business_submit(page: Any) -> tuple[Any, Any, dict[str, Any]] | None:
    candidates = [
        candidate
        for candidate in small_business_distinct_controls(
            small_business_control_candidates(page, SMALL_BUSINESS_SUBMIT_SELECTORS)
        )
        if small_business_is_submit(candidate[2])
    ]
    return candidates[0] if candidates else None


def wait_for_small_business_control(
    resolver: Callable[[Any], Any],
    page: Any,
    *,
    description: str,
    timeout_s: float = SMALL_BUSINESS_APPLICATION_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] = human_pause,
) -> Any:
    deadline = time.monotonic() + max(0.0, timeout_s)
    while time.monotonic() < deadline:
        resolved = resolver(page)
        if resolved:
            return resolved
        snapshot = small_business_enrollment_snapshot(page)
        if snapshot["thankYou"]:
            return resolved
        pause(180, 420)
    raise RuntimeError(f"small business application {description} was not ready")


def wait_for_small_business_enrollment_page(
    page: Any,
    timeout_s: float = SMALL_BUSINESS_APPLICATION_WAIT_TIMEOUT_S,
    pause: Callable[[int, int], None] = human_pause,
) -> None:
    deadline = time.monotonic() + max(0.0, timeout_s)
    stable_count = 0
    while time.monotonic() < deadline:
        snapshot = small_business_enrollment_snapshot(page)
        if snapshot["enrollPage"] and (snapshot["formReady"] or snapshot["thankYou"]):
            stable_count += 1
            if stable_count >= PROFILE_VALUE_STABLE_OBSERVATIONS:
                return
        else:
            stable_count = 0
        pause(180, 420)
    raise RuntimeError("small business application form was not ready")


def wait_for_small_business_submission_success(
    page: Any,
    timeout_s: float = SMALL_BUSINESS_SUBMISSION_SUCCESS_TIMEOUT_S,
    pause: Callable[[int, int], None] = human_pause,
) -> None:
    deadline = time.monotonic() + max(0.0, timeout_s)
    stable_count = 0
    while time.monotonic() < deadline:
        snapshot = small_business_enrollment_snapshot(page)
        if snapshot["enrollPage"] and snapshot["thankYou"]:
            stable_count += 1
            if stable_count >= PROFILE_VALUE_STABLE_OBSERVATIONS:
                return
        else:
            stable_count = 0
        pause(180, 420)
    raise RuntimeError("small business application submission confirmation was not found")


def open_small_business_application_tab(page: Any) -> Any:
    set_browser_startup_stage("small_business_application")
    emit({"event": "status", "status": "small_business_application_started"})
    try:
        small_business_page = page.new_tab(SMALL_BUSINESS_PROGRAM_ENROLL_URL)
    except Exception as error:
        raise RuntimeError(
            "new small business application tab could not be created"
        ) from error
    if small_business_page is None or not browser_connection_is_alive(small_business_page):
        raise RuntimeError("new small business application tab could not be created")
    emit({"event": "status", "status": "small_business_application_tab_created"})
    try:
        small_business_page.wait.doc_loaded(timeout=20)
    except Exception:
        if not browser_connection_is_alive(small_business_page):
            raise RuntimeError(
                "small business browser connection was lost while opening enrollment page"
            )
    human_pause(700, 1400)
    return small_business_page


def classify_small_business_application_failure(error: Exception) -> str:
    message = str(error).casefold()
    if "new small business" in message or "opening" in message or "navigation" in message:
        return "small_business_navigation_failed"
    if "2fa" in message or "authentication" in message or "login" in message or "sign in" in message:
        return "small_business_login_unconfirmed"
    if (
        "form" in message
        or "agreement" in message
        or "associated" in message
        or "certification" in message
        or "control" in message
    ):
        return "small_business_form_unready"
    if "submit" in message or "submission" in message or "confirmation" in message:
        return "small_business_submission_unconfirmed"
    return "small_business_application_failed"


def apply_small_business_program(
    page: Any,
    apple_id: str,
    password: str,
    Keys: Any,
    authentication_context: dict[str, Any],
    screenshot_path: Path,
    *,
    pause: Callable[[int, int], None] = human_pause,
) -> tuple[dict[str, Any], Any, str | None]:
    if not isinstance(password, str) or not password:
        raise RuntimeError("small business authentication password is invalid")
    small_business_page = open_small_business_application_tab(page)
    try:
        set_browser_startup_stage("small_business_login")
        authentication = complete_account_authentication(
            small_business_page,
            apple_id,
            password,
            Keys,
            account_home_confirmed=True,
            authentication_context=authentication_context,
            session_probe=confirmed_small_business_application_state,
        )
        confirmed_state = authentication["confirmedState"]
        if confirmed_state.get("smallBusinessApplication") is not True:
            raise RuntimeError(
                "small business application page was not confirmed after authentication"
            )
        emit({"event": "status", "status": "small_business_application_authenticated"})

        set_browser_startup_stage("small_business_enrollment")
        wait_for_small_business_enrollment_page(small_business_page, pause=pause)
        emit({"event": "status", "status": "small_business_enrollment_page_ready"})
        if small_business_enrollment_snapshot(small_business_page)["thankYou"]:
            screenshot = take_screenshot(
                small_business_page,
                screenshot_path,
                checkpoint="small_business_application",
                full_page=False,
            )
            emit({"event": "status", "status": "small_business_application_completed"})
            return (
                {
                    "success": True,
                    "attempted": True,
                    "submitted": True,
                    "failureStage": "unknown",
                    "failureClass": "unknown",
                    "browserAlive": browser_connection_is_alive(small_business_page),
                    "browserPreserved": False,
                    "browserPreservationRequested": False,
                },
                small_business_page,
                screenshot,
            )

        paid_scope, paid_yes, paid_summary = wait_for_small_business_control(
            resolve_small_business_paid_agreement_yes,
            small_business_page,
            description="paid applications agreement choice",
            pause=pause,
        )
        if paid_summary.get("checked") is not True:
            human_click(paid_scope, paid_yes, pause=pause)
        emit(
            {
                "event": "status",
                "status": "small_business_paid_agreement_accepted",
            }
        )

        no_options = wait_for_small_business_control(
            resolve_small_business_associated_no_options,
            small_business_page,
            description="associated developer account answers",
            pause=pause,
        )
        if len(no_options) < SMALL_BUSINESS_ASSOCIATED_NO_COUNT:
            raise RuntimeError(
                "small business associated developer account answers were not ready"
            )
        for no_scope, no_choice, no_summary in no_options:
            if no_summary.get("checked") is not True:
                human_click(no_scope, no_choice, pause=pause)
        emit(
            {
                "event": "status",
                "status": "small_business_associated_accounts_answered",
                "answerCount": SMALL_BUSINESS_ASSOCIATED_NO_COUNT,
            }
        )

        checkbox_scope, checkbox, checkbox_summary = wait_for_small_business_control(
            resolve_small_business_revenue_certification,
            small_business_page,
            description="revenue certification checkbox",
            pause=pause,
        )
        if checkbox_summary.get("checked") is not True:
            human_click(checkbox_scope, checkbox, pause=pause)
        emit(
            {
                "event": "status",
                "status": "small_business_revenue_certification_checked",
            }
        )

        submit_scope, submit, _submit_summary = wait_for_small_business_control(
            resolve_small_business_submit,
            small_business_page,
            description="submit button",
            pause=pause,
        )
        human_click(submit_scope, submit, pause=pause)
        emit({"event": "status", "status": "small_business_application_submitted"})
        wait_for_small_business_submission_success(small_business_page, pause=pause)
        screenshot = take_screenshot(
            small_business_page,
            screenshot_path,
            checkpoint="small_business_application",
            full_page=False,
        )
        emit({"event": "status", "status": "small_business_application_completed"})
        return (
            {
                "success": True,
                "attempted": True,
                "submitted": True,
                "failureStage": "unknown",
                "failureClass": "unknown",
                "browserAlive": browser_connection_is_alive(small_business_page),
                "browserPreserved": False,
                "browserPreservationRequested": False,
            },
            small_business_page,
            screenshot,
        )
    except Exception as error:
        failure_stage = browser_startup_stage
        failure_class = classify_small_business_application_failure(error)
        emit(
            {
                "event": "status",
                "status": "small_business_application_failed",
                "failureStage": failure_stage,
                "failureClass": failure_class,
                "submitted": False,
            }
        )
        raise


def default_post_login_small_business_application(
    page: Any | None = None,
    *,
    failure_stage: str = "small_business_application",
    failure_class: str = "small_business_not_attempted",
    browser_preservation_requested: bool = False,
) -> dict[str, Any]:
    return {
        "success": False,
        "attempted": False,
        "submitted": False,
        "failureStage": failure_stage,
        "failureClass": failure_class,
        "browserAlive": bool(
            page is not None and browser_connection_is_alive(page)
        ),
        "browserPreserved": False,
        "browserPreservationRequested": browser_preservation_requested,
    }


def validate_personal_info_result(
    login_state: dict[str, Any],
    personal_info: dict[str, Any],
) -> None:
    if not login_state.get("trusted"):
        raise RuntimeError("personal information page did not confirm an authenticated Apple session")
    if not (personal_info.get("name") and personal_info.get("birthday")):
        raise RuntimeError("personal information page loaded but name and birthday were not parsed")


def take_screenshot(
    page: Any,
    path: Path,
    *,
    checkpoint: str,
    full_page: bool = True,
) -> str | None:
    safe_checkpoint = checkpoint if checkpoint in SCREENSHOT_CHECKPOINTS else "unknown"
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if hasattr(path.parent, "chmod"):
            path.parent.chmod(0o700)
        page.screenshot(str(path), full_page=full_page)
        if hasattr(path, "chmod"):
            path.chmod(0o600)
        emit(
            {
                "event": "status",
                "status": "screenshot_capture",
                "checkpoint": safe_checkpoint,
            }
        )
        return str(path)
    except Exception:
        emit(
            {
                "event": "status",
                "status": "screenshot_failed",
                "checkpoint": safe_checkpoint,
            }
        )
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


def ensure_two_factor_preparation(
    authentication_context: dict[str, Any],
) -> None:
    if authentication_context.get("twofaPrepared") is True:
        return
    request_two_factor_preparation()
    authentication_context["twofaPrepared"] = True


def ensure_two_factor_generation_available(
    authentication_context: dict[str, Any],
    generation: int,
) -> None:
    """Fail before asking the shared collector for an impossible generation."""
    validate_otp_generation(generation)
    if generation != 2:
        return
    started_at = authentication_context.get("twofaAcquisitionStartedAt")
    if (
        isinstance(started_at, (int, float))
        and not isinstance(started_at, bool)
        and time.monotonic() - float(started_at)
        >= TWO_FACTOR_SHARED_ACQUISITION_TIMEOUT_S
    ):
        raise RuntimeError("2FA shared acquisition deadline exhausted")


def complete_account_authentication(
    page: Any,
    apple_id: str,
    password: str,
    Keys: Any,
    *,
    account_home_confirmed: bool,
    authentication_context: dict[str, Any],
    session_probe: Callable[[Any], dict[str, Any] | None] | None = None,
) -> dict[str, Any]:
    initial_target_state = session_probe(page) if session_probe is not None else None
    initial_state = initial_target_state
    if initial_state is None:
        initial_state = detect_login_state(page)
        initial_state = settle_trust_state(
            page,
            initial_state,
            deadline=time.monotonic() + TRUST_PROMPT_HYDRATION_TIMEOUT_S,
        )
    emit_browser_observation(
        "login_state",
        page,
        initial_state,
        account_home_confirmed=account_home_confirmed,
    )
    recoverable_sign_in = is_recoverable_account_sign_in_state(page, initial_state)
    if initial_state.get("error") and not has_confirmed_account_session(
        initial_state
    ) and not recoverable_sign_in:
        raise RuntimeError("login page reported an authentication error")
    if recoverable_sign_in:
        initial_state = {
            **initial_state,
            "error": False,
            "rootError": False,
            "twofa": False,
            "twofaVisible": False,
        }
    if (
        session_probe is not None
        and initial_target_state is None
        and has_confirmed_account_session(initial_state)
    ):
        # The target tab can temporarily visit account.apple.com/manage after
        # its session is restored.  Keep waiting for the caller's target-shell
        # probe instead of treating that generic session as a completed
        # Developer login.
        initial_state = wait_for_2fa_or_session(
            page,
            session_probe=session_probe,
        )
    set_browser_startup_stage("login_state_detected")
    skipped_login = has_confirmed_account_session(initial_state)
    confirmed_login_state = initial_state
    if skipped_login:
        initial_state["trusted"] = True
    skipped_2fa = skipped_login
    remember_checked: bool | None = None

    if not skipped_login:
        if initial_state.get("twofa"):
            set_browser_startup_stage("twofa_prepare")
            ensure_two_factor_preparation(authentication_context)
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
            password_scope, password_field = wait_for_password_target(
                page,
                timeout_s=45,
            )
            set_browser_startup_stage("password_input")
            password_target: dict[str, Any] = {
                "scope": password_scope,
                "field": password_field,
            }
            input_and_verify(
                password_scope,
                password_field,
                password,
                "password",
                Keys,
                root_page=page,
                target_holder=password_target,
            )
            password_scope = password_target["scope"]
            password_field = password_target["field"]
            set_browser_startup_stage("remember_account")
            remember_checked = ensure_remember_checked(page)
            set_browser_startup_stage("twofa_prepare")
            ensure_two_factor_preparation(authentication_context)
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
        if session_probe is None:
            login_state = wait_for_2fa_or_session(page)
        else:
            login_state = wait_for_2fa_or_session(
                page,
                session_probe=session_probe,
            )
        emit_browser_observation(
            "twofa_wait",
            page,
            login_state,
            account_home_confirmed=account_home_confirmed,
        )
        if login_state.get("trusted"):
            skipped_2fa = True
            confirmed_login_state = login_state
            set_browser_startup_stage("signed_in")
        else:
            next_generation = authentication_context.get("nextGeneration")
            if isinstance(next_generation, bool) or next_generation not in (1, 2):
                raise RuntimeError("2FA generation limit exhausted")
            for generation in range(next_generation, 3):
                ensure_two_factor_generation_available(
                    authentication_context,
                    generation,
                )
                if (
                    generation == 1
                    and "twofaAcquisitionStartedAt" not in authentication_context
                ):
                    authentication_context["twofaAcquisitionStartedAt"] = (
                        time.monotonic()
                    )
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
                try:
                    command = read_command()
                except Exception as error:
                    raise RuntimeError(
                        f"2FA collector unavailable for generation {generation}"
                    ) from error
                code = validate_two_factor_code_command(command, generation)
                authentication_context["nextGeneration"] = generation + 1
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
                    # Apple submits a verified code as soon as the final digit
                    # lands. A second click or Enter can interrupt the redirect.
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
                    wait_for_signed_in_kwargs: dict[str, Any] = {
                        "submitted": True,
                        "otp_generation": generation,
                        "submission_method": "automatic",
                        "transition_observer": lambda transition_state: emit_browser_observation(
                            "twofa_transition",
                            page,
                            transition_state,
                            account_home_confirmed=account_home_confirmed,
                            generation=generation,
                        ),
                    }
                    if session_probe is not None:
                        wait_for_signed_in_kwargs["session_probe"] = session_probe
                    signed_in_state = wait_for_signed_in(
                        page,
                        **wait_for_signed_in_kwargs,
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
                confirmed_login_state = signed_in_state
                set_browser_startup_stage("signed_in")
                break
    else:
        set_browser_startup_stage("signed_in")

    return {
        "confirmedState": confirmed_login_state,
        "skippedLogin": skipped_login,
        "skipped2FA": skipped_2fa,
        "rememberAccount": remember_checked,
    }


def reach_personal_information_page(
    page: Any,
    apple_id: str,
    password: str,
    Keys: Any,
    authentication_context: dict[str, Any],
) -> dict[str, Any] | None:
    reauthentication_count = 0
    reauthentication: dict[str, Any] | None = None
    for navigation_attempt in (1, 2):
        navigation_result = navigate_to_personal_information(
            page,
            navigation_attempt=navigation_attempt,
        )
        if navigation_result == "account_information":
            return reauthentication
        if navigation_result != "sign_in":
            raise RuntimeError(
                "personal information navigation did not confirm the target page"
            )
        if reauthentication_count >= PROFILE_REAUTHENTICATION_LIMIT:
            emit(
                {
                    "event": "status",
                    "status": "profile_reauthentication_exhausted",
                    "attempt": reauthentication_count,
                }
            )
            raise RuntimeError(
                "personal information navigation required repeated reauthentication"
            )
        reauthentication_count += 1
        emit(
            {
                "event": "status",
                "status": "profile_reauthentication_started",
                "attempt": reauthentication_count,
            }
        )
        try:
            reauthentication = complete_account_authentication(
                page,
                apple_id,
                password,
                Keys,
                account_home_confirmed=True,
                authentication_context=authentication_context,
            )
        except RuntimeError as reauthentication_error:
            if str(reauthentication_error) == "2FA generation limit exhausted":
                emit(
                    {
                        "event": "status",
                        "status": "profile_reauthentication_twofa_exhausted",
                        "attempt": reauthentication_count,
                    }
                )
                raise RuntimeError(
                    "personal information reauthentication exhausted the 2FA generation limit"
                ) from reauthentication_error
            raise
        emit(
            {
                "event": "status",
                "status": "profile_reauthentication_completed",
                "attempt": reauthentication_count,
            }
        )
        emit_browser_observation(
            "account_home",
            page,
            reauthentication["confirmedState"],
            account_home_confirmed=True,
        )
    raise RuntimeError(
        "personal information navigation did not confirm the target page"
    )


def classify_developer_account_failure(error: Exception) -> str:
    message = str(error).lower()
    if any(
        marker in message
        for marker in (
            "2fa generation limit exhausted",
            "2fa shared acquisition deadline exhausted",
            "2fa collector unavailable",
        )
    ):
        return "developer_twofa_unavailable"
    if "connection" in message:
        return "developer_connection_lost"
    if "new developer account tab" in message or "opening developer account" in message:
        return "developer_navigation_failed"
    if "membership" in message:
        return "developer_membership_unknown"
    if "session was not confirmed" in message or "login" in message:
        return "developer_login_unconfirmed"
    if "authentication" in message or "2fa" in message:
        return "developer_authentication_error"
    return "developer_account_failed"


def collect_developer_account_membership(
    page: Any,
    apple_id: str,
    password: str,
    Keys: Any,
    authentication_context: dict[str, Any],
    screenshot_path: Path,
    page_holder: dict[str, Any] | None = None,
    *,
    open_in_new_tab: bool = True,
) -> tuple[dict[str, Any], Any, str | None]:
    """Resolve the fixed Developer membership state in a new or current tab."""
    set_browser_startup_stage("developer_account")
    emit({"event": "status", "status": "developer_account_started"})
    if open_in_new_tab:
        try:
            developer_page = page.new_tab(DEVELOPER_ACCOUNT_URL)
        except Exception as error:
            raise RuntimeError("new developer account tab could not be created") from error
    else:
        developer_page = page
    if page_holder is not None:
        page_holder["page"] = developer_page
    if developer_page is None or not browser_connection_is_alive(developer_page):
        raise RuntimeError("developer account page could not be opened")
    if open_in_new_tab:
        emit({"event": "status", "status": "developer_account_tab_created"})
    else:
        try:
            developer_page.get(DEVELOPER_ACCOUNT_URL)
        except Exception as error:
            raise RuntimeError("opening developer account failed") from error
    try:
        developer_page.wait.doc_loaded(timeout=20)
    except Exception:
        if not browser_connection_is_alive(developer_page):
            raise RuntimeError(
                "developer browser connection was lost while opening developer account"
            )
    human_pause(700, 1400)

    set_browser_startup_stage("developer_login")
    emit(
        {
            "event": "status",
            "status": "developer_account_authentication_started",
        }
    )
    authentication = complete_account_authentication(
        developer_page,
        apple_id,
        password,
        Keys,
        account_home_confirmed=False,
        authentication_context=authentication_context,
        session_probe=confirmed_developer_account_state,
    )
    confirmed_state = authentication["confirmedState"]
    if confirmed_state.get("developerAccountShell") is not True:
        raise RuntimeError(
            "developer account shell was not confirmed after authentication"
        )
    emit({"event": "status", "status": "developer_account_authenticated"})

    set_browser_startup_stage("developer_membership")
    membership_status = "unknown"
    registration_identity_value: str | None = None
    screenshot: str | None = None
    if confirmed_state.get("joinProgram") is True:
        membership_status = "not_enrolled"
    else:
        # The account shell snapshot can race the hash-routed membership card.
        # Re-read the live page instead of freezing the initial nav boolean.
        if confirm_active_developer_membership(developer_page):
            membership_status = "active"
            try:
                registration_identity_value = normalize_developer_registration_identity(
                    developer_membership_details_snapshot(developer_page).get(
                        "registrationIdentityValue"
                    )
                )
            except Exception:
                registration_identity_value = None
            if scroll_developer_membership_details_card(developer_page):
                screenshot = take_screenshot(
                    developer_page,
                    screenshot_path,
                    checkpoint="developer_membership",
                    full_page=False,
                )
            else:
                emit(
                    {
                        "event": "status",
                        "status": "developer_membership_card_unavailable",
                    }
                )
    emit(
        {
            "event": "status",
            "status": "developer_membership_checked",
            "membershipStatus": membership_status,
            "registrationIdentityValue": registration_identity_value,
        }
    )
    emit({"event": "status", "status": "developer_account_completed"})
    return (
        {
            "success": True,
            "authenticated": True,
            "membershipStatus": membership_status,
            "registrationIdentityValue": registration_identity_value,
            "failureStage": "unknown",
            "failureClass": "unknown",
            "browserAlive": browser_connection_is_alive(developer_page),
            "browserPreserved": False,
            "browserPreservationRequested": False,
        },
        developer_page,
        screenshot,
    )


def open_account_module_tab(developer_page: Any, sign_in_url: str) -> Any:
    """Create the Account module tab only after the Developer decision."""
    set_browser_startup_stage("account_navigation")
    emit({"event": "status", "status": "account_module_started"})
    try:
        account_page = developer_page.new_tab(sign_in_url)
    except Exception as error:
        raise RuntimeError("new account module tab could not be created") from error
    if account_page is None or not browser_connection_is_alive(account_page):
        raise RuntimeError("new account module tab could not be created")
    emit({"event": "status", "status": "account_module_tab_created"})
    try:
        account_page.wait.doc_loaded(timeout=20)
    except Exception:
        if not browser_connection_is_alive(account_page):
            raise RuntimeError(
                "account browser connection was lost while opening account module"
            )
    human_pause(900, 1800)
    set_browser_startup_stage("login_page_loaded")
    return account_page


def browser_flow(args: argparse.Namespace) -> int:
    begin_browser_flow_run()
    try:
        return _browser_flow(args)
    except Exception:
        # Covers pre-browser failures such as credential, URL, or runtime setup.
        emit_browser_failure_once()
        raise


def inspect_profile_failure_state(page: Any) -> dict[str, Any]:
    """Best-effort current-page evidence for a profile-stage failure."""
    if not browser_connection_is_alive(page):
        return {"inspectionAvailable": False}
    try:
        state = detect_login_state(page)
        state = settle_trust_state(
            page,
            state,
            deadline=time.monotonic() + 1.0,
            hydration_timeout_s=1.0,
        )
    except Exception:
        return {"inspectionAvailable": False}
    if not isinstance(state, dict):
        return {"inspectionAvailable": False}
    return {**state, "inspectionAvailable": True}


def default_post_login_password_change(
    page: Any | None = None,
    *,
    failure_stage: str = "password_change",
    failure_class: str = "password_change_not_attempted",
    browser_preservation_requested: bool = False,
) -> dict[str, Any]:
    return {
        "success": False,
        "attempted": False,
        "passwordStored": False,
        "passwordLength": 0,
        "failureStage": failure_stage,
        "failureClass": failure_class,
        "browserAlive": bool(
            page is not None and browser_connection_is_alive(page)
        ),
        "browserPreserved": False,
        "browserPreservationRequested": browser_preservation_requested,
    }


def public_post_login_password_change_result(
    password_change_result: dict[str, Any],
) -> dict[str, Any]:
    public_result = dict(password_change_result)
    public_result.pop("newPassword", None)
    public_result.setdefault("passwordStored", False)
    return public_result


def _browser_flow(args: argparse.Namespace) -> int:
    report_dir = Path(args.report_dir)
    configure_browser_stage_file(report_dir)
    set_browser_startup_stage("not_started")
    apple_id, password = load_browser_credentials()
    configure_diagnostic_secrets(apple_id, password)
    broker_mode = browser_broker_mode_enabled()
    set_browser_startup_stage("credentials_received")
    if broker_mode:
        emit({"event": "status", "status": "broker_credentials_received"})
    sign_in_url = args.sign_in_url

    set_browser_startup_stage("runtime_importing")
    FirefoxOptions, FirefoxPage, Keys = import_ruyipage()
    set_browser_startup_stage("runtime_imported")
    if broker_mode:
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
    success_screenshot_path = screenshots_dir / "02-account-information.png"
    developer_screenshot_path = screenshots_dir / "03-developer-membership.png"
    small_business_screenshot_path = (
        screenshots_dir / "04-small-business-application.png"
    )
    generated_screenshot_paths: list[Path] = []
    screenshots: dict[str, str | None] = {}
    account_home_confirmed = False
    preserve_after_flow = preserve_on_success
    post_login_browser_finalized = False
    set_browser_startup_stage("browser_constructing")
    if broker_mode:
        emit({"event": "status", "status": "browser_constructing"})
    page, browser_route = try_attach_existing_browser_for_flow(apple_id, args.profile_dir)
    attached_existing_browser = browser_route == "account_session"
    if page is None:
        if should_attach_existing_browser() and firefox_profile_has_active_lock(args.profile_dir):
            emit({"event": "status", "status": "browser_profile_attach_required"})
            raise RuntimeError("active Firefox profile could not be attached through ruyiPage")
        page = construct_firefox_page(FirefoxPage, opts)
    persist_browser_attach_address(page, args.profile_dir)
    set_browser_startup_stage("browser_ready")
    try:
        emit({"event": "ready", "mode": "ruyipage-only"})
        authentication_context: dict[str, Any] = {
            "twofaPrepared": False,
            "nextGeneration": 1,
        }
        post_login_developer_account: dict[str, Any] = {
            "success": False,
            "authenticated": False,
            "membershipStatus": "unknown",
            "registrationIdentityValue": None,
            "failureStage": "developer_account",
            "failureClass": "developer_result_missing",
            "browserAlive": browser_connection_is_alive(page),
            "browserPreserved": False,
            "browserPreservationRequested": False,
        }
        post_login_password_change: dict[str, Any] = default_post_login_password_change(
            page
        )
        post_login_small_business_application: dict[str, Any] = (
            default_post_login_small_business_application(page)
        )
        current_browser_password = password
        developer_page = page
        small_business_page = None
        developer_page_holder: dict[str, Any] = {}
        try:
            (
                post_login_developer_account,
                developer_page,
                screenshots["developerMembership"],
            ) = collect_developer_account_membership(
                page,
                apple_id,
                password,
                Keys,
                authentication_context,
                developer_screenshot_path,
                page_holder=developer_page_holder,
                open_in_new_tab=False,
            )
            if screenshots["developerMembership"] is not None:
                generated_screenshot_paths.append(developer_screenshot_path)
        except Exception as developer_error:
            developer_page = developer_page_holder.get("page", page)
            failure_stage = browser_startup_stage
            failure_class = classify_developer_account_failure(developer_error)
            browser_alive = browser_connection_is_alive(developer_page)
            post_login_developer_account = {
                "success": False,
                "authenticated": failure_stage == "developer_membership",
                "membershipStatus": "unknown",
                "registrationIdentityValue": None,
                "failureStage": failure_stage,
                "failureClass": failure_class,
                "browserAlive": browser_alive,
                "browserPreserved": False,
                "browserPreservationRequested": (
                    preserve_on_success or preserve_on_failure
                ),
            }
            emit(
                {
                    "event": "status",
                    "status": "developer_account_failed",
                    "failureStage": failure_stage,
                    "failureClass": failure_class,
                    "authenticated": failure_stage == "developer_membership",
                    "membershipStatus": "unknown",
                }
            )

        if post_login_developer_account["authenticated"] is not True:
            # The disabled membership gate is only for exercising both modules
            # after a valid Developer login. It must never turn a visible Apple
            # sign-in page into an ``unknown`` membership decision and then
            # open the Account tab.
            raise RuntimeError(
                "developer account authentication did not complete before account module"
            )

        membership_gate_enabled = developer_membership_gate_enabled()
        membership_gate_passed = developer_membership_allows_account(
            post_login_developer_account,
            gate_enabled=membership_gate_enabled,
        )
        account_module = {
            "attempted": membership_gate_passed,
            "skipped": not membership_gate_passed,
            "skipReason": (
                "unknown" if membership_gate_passed else "developer_membership_gate"
            ),
            "membershipGateEnabled": membership_gate_enabled,
            "membershipGatePassed": membership_gate_passed,
        }
        if not membership_gate_passed:
            emit(
                {
                    "event": "status",
                    "status": "developer_membership_gate_blocked",
                    "membershipStatus": post_login_developer_account["membershipStatus"],
                    "gateEnabled": True,
                    "developerResultSucceeded": post_login_developer_account["success"]
                    is True,
                }
            )
            post_login_profile_capture: dict[str, Any] = {
                "success": False,
                "failureStage": "developer_membership",
                "failureClass": "developer_membership_gate",
                "browserAlive": browser_connection_is_alive(developer_page),
                "browserPreserved": False,
                "browserPreservationRequested": preserve_on_success,
            }
            preserve_after_flow = preserve_on_success or (
                post_login_developer_account["success"] is False and preserve_on_failure
            )
            post_login_profile_capture["browserPreservationRequested"] = (
                preserve_after_flow
            )
            post_login_developer_account["browserPreservationRequested"] = (
                preserve_after_flow
            )
            post_login_developer_account["browserAlive"] = browser_connection_is_alive(
                developer_page
            )
            set_browser_startup_stage("post_login_finalization")
            post_login_finalization = finalize_post_login_browser(
                developer_page,
                preserve_requested=preserve_after_flow,
                profile_capture_success=False,
            )
            post_login_browser_finalized = True
            post_login_profile_capture["browserPreserved"] = post_login_finalization[
                "browserSessionPreserved"
            ]
            post_login_password_change["browserAlive"] = browser_connection_is_alive(
                developer_page
            )
            post_login_password_change["browserPreservationRequested"] = (
                preserve_after_flow
            )
            post_login_password_change["browserPreserved"] = post_login_finalization[
                "browserSessionPreserved"
            ]
            post_login_small_business_application["browserAlive"] = (
                browser_connection_is_alive(developer_page)
            )
            post_login_small_business_application["browserPreservationRequested"] = (
                preserve_after_flow
            )
            post_login_small_business_application["browserPreserved"] = (
                post_login_finalization["browserSessionPreserved"]
            )
            post_login_developer_account["browserPreserved"] = (
                post_login_finalization["browserSessionPreserved"]
            )
            emit_browser_result(
                {
                    "event": "result",
                    "success": True,
                    "browserLogin": {
                        "success": False,
                        "backend": "ruyipage",
                        "accountHomeConfirmed": False,
                        "skippedLogin": False,
                        "skipped2FA": False,
                        "sessionReused": False,
                        "rememberAccount": None,
                    },
                    "postLoginProfileCapture": post_login_profile_capture,
                    "postLoginDeveloperAccount": post_login_developer_account,
                    "postLoginPasswordChange": post_login_password_change,
                    "postLoginSmallBusinessApplication": (
                        post_login_small_business_application
                    ),
                    "postLoginFinalization": post_login_finalization,
                    "accountModule": account_module,
                    "personalInfo": {},
                    "screenshots": screenshots,
                }
            )
            return 0

        sign_in_url = validate_apple_url(sign_in_url)
        set_browser_startup_stage("url_validated")
        if broker_mode:
            emit({"event": "status", "status": "browser_url_validated"})
        account_tab_source = (
            developer_page
            if browser_connection_is_alive(developer_page)
            else page
        )
        page = open_account_module_tab(account_tab_source, sign_in_url)
        if attached_existing_browser:
            emit({"event": "status", "status": "browser_session_attached"})
        elif browser_route == "empty_tab":
            emit({"event": "status", "status": "browser_blank_tab_attached"})
        elif browser_route == "new_tab":
            emit({"event": "status", "status": "browser_login_tab_created"})
        authentication = complete_account_authentication(
            page,
            apple_id,
            password,
            Keys,
            account_home_confirmed=False,
            authentication_context=authentication_context,
        )
        confirmed_login_state = authentication["confirmedState"]
        skipped_login = authentication["skippedLogin"]
        skipped_2fa = authentication["skipped2FA"]
        remember_checked = authentication["rememberAccount"]

        emit({"event": "status", "status": "account_home_confirmed"})
        account_home_confirmed = True
        emit_browser_observation(
            "account_home",
            page,
            confirmed_login_state,
            account_home_confirmed=True,
        )
        personal_info: dict[str, str] = {}
        profile_state: dict[str, Any] = {"inspectionAvailable": False}
        post_login_profile_capture: dict[str, Any] = {
            "success": False,
            "failureStage": "unknown",
            "failureClass": "unknown",
            "browserAlive": False,
            "browserPreserved": False,
            "browserPreservationRequested": False,
        }
        post_login_password_change = default_post_login_password_change(page)
        try:
            set_browser_startup_stage("account_information")
            emit({"event": "status", "status": "profile_capture_started"})
            reauthentication = reach_personal_information_page(
                page,
                apple_id,
                password,
                Keys,
                authentication_context,
            )
            if reauthentication is not None:
                confirmed_login_state = reauthentication["confirmedState"]
                if (
                    remember_checked is None
                    and reauthentication["rememberAccount"] is not None
                ):
                    remember_checked = reauthentication["rememberAccount"]

            human_pause(700, 1400)
            profile_state = detect_login_state(page)
            profile_state = settle_trust_state(
                page,
                profile_state,
                deadline=time.monotonic() + TRUST_PROMPT_HYDRATION_TIMEOUT_S,
            )
            emit_browser_observation(
                "account_information",
                page,
                profile_state,
                account_home_confirmed=True,
            )
            set_browser_startup_stage("profile_capture")
            ready_state = wait_for_profile_capture_ready(page)
            profile_state = (
                ready_state
                if isinstance(ready_state, dict)
                else confirmed_personal_information_state(profile_state)
            )
            emit({"event": "status", "status": "profile_page_ready"})
            emit_browser_observation(
                "profile_ready",
                page,
                profile_state,
                account_home_confirmed=True,
            )
            screenshots["personalInformation"] = take_screenshot(
                page,
                success_screenshot_path,
                checkpoint="account_information",
            )
            if screenshots["personalInformation"] is not None:
                generated_screenshot_paths.append(success_screenshot_path)
                emit({"event": "status", "status": "profile_screenshot_saved"})
            set_browser_startup_stage("profile_birthday")
            personal_info = collect_personal_info(page)
            validate_personal_info_result(profile_state, personal_info)
            post_login_profile_capture = {
                "success": True,
                "failureStage": "unknown",
                "failureClass": "unknown",
                "browserAlive": browser_connection_is_alive(page),
                "browserPreserved": False,
                "browserPreservationRequested": False,
            }
            emit(
                {
                    "event": "status",
                    "status": "profile_capture_completed",
                }
            )
            try:
                internal_password_change_result = change_account_password(
                    page,
                    current_browser_password,
                    Keys,
                )
                rotated_password = internal_password_change_result.get("newPassword")
                if (
                    internal_password_change_result.get("success") is True
                    and isinstance(rotated_password, str)
                    and rotated_password
                ):
                    current_browser_password = rotated_password
                    add_diagnostic_secret(rotated_password)
                post_login_password_change = public_post_login_password_change_result(
                    internal_password_change_result
                )
            except Exception as password_error:
                failure_stage = browser_startup_stage
                failure_class = classify_account_password_change_failure(
                    password_error
                )
                post_login_password_change = {
                    "success": False,
                    "attempted": True,
                    "passwordStored": False,
                    "passwordLength": 0,
                    "failureStage": failure_stage,
                    "failureClass": failure_class,
                    "browserAlive": browser_connection_is_alive(page),
                    "browserPreserved": False,
                    "browserPreservationRequested": (
                        preserve_on_success or preserve_on_failure
                    ),
                }
            if post_login_password_change["success"] is True:
                try:
                    (
                        post_login_small_business_application,
                        small_business_page,
                        screenshots["smallBusinessApplication"],
                    ) = apply_small_business_program(
                        page,
                        apple_id,
                        current_browser_password,
                        Keys,
                        authentication_context,
                        small_business_screenshot_path,
                    )
                    if screenshots["smallBusinessApplication"] is not None:
                        generated_screenshot_paths.append(
                            small_business_screenshot_path
                        )
                except Exception as small_business_error:
                    failure_stage = browser_startup_stage
                    failure_class = classify_small_business_application_failure(
                        small_business_error
                    )
                    target_page = (
                        small_business_page
                        if small_business_page is not None
                        else page
                    )
                    post_login_small_business_application = {
                        "success": False,
                        "attempted": True,
                        "submitted": False,
                        "failureStage": failure_stage,
                        "failureClass": failure_class,
                        "browserAlive": browser_connection_is_alive(target_page),
                        "browserPreserved": False,
                        "browserPreservationRequested": (
                            preserve_on_success or preserve_on_failure
                        ),
                    }
        except Exception as profile_error:
            failure_stage = browser_startup_stage
            failure_class = classify_profile_capture_failure(profile_error)
            profile_state = inspect_profile_failure_state(page)
            browser_alive = browser_connection_is_alive(page)
            browser_preservation_requested = (
                preserve_on_success or preserve_on_failure
            )
            post_login_profile_capture = {
                "success": False,
                "failureStage": failure_stage,
                "failureClass": failure_class,
                "browserAlive": browser_alive,
                "browserPreserved": False,
                "browserPreservationRequested": browser_preservation_requested,
            }
            emit(
                {
                    "event": "status",
                    "status": "profile_capture_failed",
                    "failureStage": failure_stage,
                    "failureClass": failure_class,
                    "browserAlive": browser_alive,
                    "browserPreservationRequested": browser_preservation_requested,
                }
            )
            emit_browser_observation(
                "profile_capture_failed",
                page,
                profile_state,
                account_home_confirmed=True,
            )

        preserve_after_flow = preserve_on_success or (
            post_login_profile_capture["success"] is False and preserve_on_failure
        ) or (
            post_login_password_change["success"] is False
            and post_login_password_change["attempted"] is True
            and preserve_on_failure
        ) or (
            post_login_small_business_application["success"] is False
            and post_login_small_business_application["attempted"] is True
            and preserve_on_failure
        ) or (
            post_login_developer_account["success"] is False and preserve_on_failure
        )
        post_login_profile_capture["browserPreservationRequested"] = (
            preserve_after_flow
        )
        post_login_password_change["browserPreservationRequested"] = (
            preserve_after_flow
        )
        post_login_password_change["browserAlive"] = browser_connection_is_alive(page)
        post_login_small_business_application["browserPreservationRequested"] = (
            preserve_after_flow
        )
        post_login_small_business_application["browserAlive"] = (
            browser_connection_is_alive(
                small_business_page if small_business_page is not None else page
            )
        )
        post_login_developer_account["browserAlive"] = browser_connection_is_alive(
            developer_page
        )
        required_pages = tuple(
            required_page
            for required_page in (developer_page, small_business_page)
            if required_page is not None
        )
        set_browser_startup_stage("post_login_finalization")
        post_login_finalization = finalize_post_login_browser(
            page,
            preserve_requested=preserve_after_flow,
            profile_capture_success=post_login_profile_capture["success"],
            required_pages=required_pages,
        )
        post_login_browser_finalized = True
        post_login_profile_capture["browserPreserved"] = post_login_finalization[
            "browserSessionPreserved"
        ]
        post_login_password_change["browserPreserved"] = post_login_finalization[
            "browserSessionPreserved"
        ]
        post_login_small_business_application["browserPreserved"] = (
            post_login_finalization["browserSessionPreserved"]
        )
        post_login_developer_account["browserPreservationRequested"] = (
            preserve_after_flow
        )
        post_login_developer_account["browserPreserved"] = post_login_finalization[
            "browserSessionPreserved"
        ]

        emit_browser_result(
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
                "postLoginProfileCapture": post_login_profile_capture,
                "postLoginDeveloperAccount": post_login_developer_account,
                "postLoginPasswordChange": post_login_password_change,
                "postLoginSmallBusinessApplication": (
                    post_login_small_business_application
                ),
                "postLoginFinalization": post_login_finalization,
                "accountModule": account_module,
                "personalInfo": personal_info
                if post_login_profile_capture["success"] is True
                else {},
                "screenshots": screenshots,
            }
        )
        return 0
    except Exception:
        emit_browser_failure_once()
        raise
    finally:
        had_error = sys.exc_info()[0] is not None
        if had_error and preserve_on_failure and browser_connection_is_alive(page):
            if not account_home_confirmed:
                if success_screenshot_path in generated_screenshot_paths:
                    success_screenshot_path.unlink(missing_ok=True)
            emit(
                {
                    "event": "status",
                    "status": "browser_preserved",
                    "failureStage": browser_startup_stage,
                    "preserved": True,
                }
            )
        elif post_login_browser_finalized:
            pass
        else:
            try:
                page.quit()
            except Exception:
                if success_screenshot_path in generated_screenshot_paths:
                    success_screenshot_path.unlink(missing_ok=True)
                if not had_error:
                    raise
                emit({"event": "warning", "message": QUIT_FAILURE_REASON})
            else:
                if had_error:
                    if success_screenshot_path in generated_screenshot_paths:
                        success_screenshot_path.unlink(missing_ok=True)


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
    begin_browser_flow_run()
    try:
        return main(argv)
    except Exception as error:
        emit_browser_failure_once()
        emit(
            {
                "event": "diagnostic",
                "kind": "python_exception",
                "failureStage": browser_startup_stage,
                "errorType": type(error).__name__,
                "errorClass": classify_browser_exception(
                    error,
                    browser_startup_stage,
                ),
                "hasTraceback": True,
            }
        )
        result = {
            "event": "result",
            "success": False,
            "error": TOP_LEVEL_FAILURE_REASON,
        }
        if browser_startup_stage in BROWSER_STARTUP_STAGES:
            result["failureStage"] = browser_startup_stage
        emit(result)
        print(TOP_LEVEL_FAILURE_REASON, file=sys.stderr, flush=True)
        return 1
    finally:
        configure_diagnostic_secrets()


if __name__ == "__main__":
    raise SystemExit(run_cli(sys.argv[1:]))
