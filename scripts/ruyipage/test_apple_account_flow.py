import json
import io
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

RUYIPAGE_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if RUYIPAGE_SCRIPT_DIR not in sys.path:
    sys.path.insert(0, RUYIPAGE_SCRIPT_DIR)

import apple_account_flow as account_flow

from apple_account_flow import (
    browser_flow,
    click_trust_browser,
    click_two_factor_submit,
    collect_personal_info,
    detect_login_state,
    ensure_remember_checked,
    fill_security_code,
    find_first_element,
    human_click,
    input_and_verify,
    parse_args,
    pop_browser_credentials,
    request_two_factor_preparation,
    submit_element_with_enter,
    submit_with_enter,
    validate_apple_url,
    validate_apple_scope,
    validate_personal_info_result,
    wait_for_2fa_or_session,
    wait_for_signed_in,
)


class BrowserStageRecorderTests(unittest.TestCase):
    def test_records_only_a_fixed_stage_in_the_broker_report_directory(self):
        configure = getattr(account_flow, "configure_browser_stage_file", None)
        set_stage = getattr(account_flow, "set_browser_startup_stage", None)
        self.assertIsNotNone(configure)
        self.assertIsNotNone(set_stage)

        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            stage_path = report_dir / ".browser-stage.json"
            with patch.dict(
                os.environ,
                {"APPLE_AUTOMATION_BROWSER_STAGE_FILE": str(stage_path)},
                clear=False,
            ):
                configure(report_dir)
                set_stage("email_wait")
                self.assertEqual(
                    json.loads(stage_path.read_text(encoding="utf-8")),
                    {"version": 1, "stage": "email_wait"},
                )
                set_stage("password_wait")
                self.assertEqual(
                    json.loads(stage_path.read_text(encoding="utf-8")),
                    {"version": 1, "stage": "password_wait"},
                )
                self.assertEqual(list(report_dir.glob("*.tmp-*")), [])
                with self.assertRaisesRegex(RuntimeError, "stage is invalid"):
                    set_stage("secret-value")

        with patch.dict(os.environ, {}, clear=True):
            configure(Path("unused"))

    def test_rejects_a_stage_file_outside_the_report_directory(self):
        configure = getattr(account_flow, "configure_browser_stage_file", None)
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir) / "report"
            report_dir.mkdir()
            outside = Path(temp_dir) / ".browser-stage.json"
            with patch.dict(
                os.environ,
                {"APPLE_AUTOMATION_BROWSER_STAGE_FILE": str(outside)},
                clear=False,
            ), self.assertRaisesRegex(RuntimeError, "path is invalid"):
                configure(report_dir)

    def test_emits_fixed_browser_stage_events(self):
        set_stage = getattr(account_flow, "set_browser_startup_stage", None)
        self.assertIsNotNone(set_stage)
        with patch("apple_account_flow.emit") as emit_event:
            set_stage("email_wait")
            set_stage("password_input")

        self.assertEqual(
            [call.args[0] for call in emit_event.call_args_list],
            [
                {"event": "status", "status": "browser_stage", "stage": "email_wait"},
                {
                    "event": "status",
                    "status": "browser_stage",
                    "stage": "password_input",
                },
            ],
        )


class TwoFactorPreparationTests(unittest.TestCase):
    def test_accepts_only_two_factor_prepared_ack(self):
        with patch("apple_account_flow.emit") as emit_event, patch(
            "apple_account_flow.read_command",
            return_value={"type": "2fa_prepared"},
        ):
            request_two_factor_preparation()

        emit_event.assert_called_once_with({"event": "prepare_2fa"})

    def test_rejects_unexpected_preparation_command(self):
        with patch("apple_account_flow.emit"), patch(
            "apple_account_flow.read_command",
            return_value={"type": "2fa_code", "code": "123456"},
        ), self.assertRaisesRegex(RuntimeError, "2FA preparation"):
            request_two_factor_preparation()

    def test_two_factor_code_command_requires_the_exact_protocol_type(self):
        validator = getattr(account_flow, "validate_two_factor_code_command", None)
        self.assertIsNotNone(validator, "validate_two_factor_code_command() is missing")
        for command in (None, {}, {"type": "code", "code": "123456"}, {"code": "123456"}):
            with self.subTest(command=command):
                with self.assertRaisesRegex(RuntimeError, "2FA code command"):
                    validator(command, 1)
        self.assertEqual(
            validator(
                {"type": "2fa_code", "generation": 1, "code": "123456"},
                1,
            ),
            "123456",
        )

    def test_two_factor_code_command_requires_matching_supported_generation(self):
        validator = account_flow.validate_two_factor_code_command
        for expected, command in (
            (1, {"type": "2fa_code", "code": "123456"}),
            (1, {"type": "2fa_code", "generation": 2, "code": "123456"}),
            (1, {"type": "2fa_code", "generation": 0, "code": "123456"}),
            (1, {"type": "2fa_code", "generation": 3, "code": "123456"}),
            (3, {"type": "2fa_code", "generation": 3, "code": "123456"}),
        ):
            with self.subTest(expected=expected, command=command):
                with self.assertRaisesRegex(RuntimeError, "generation"):
                    validator(command, expected)

    def test_two_factor_code_command_requires_an_exact_six_digit_string(self):
        validator = account_flow.validate_two_factor_code_command
        for code in (123456, "12345", "1234567", "12 34 56", "code 123456"):
            with self.subTest(code=code):
                with self.assertRaisesRegex(RuntimeError, "six digits"):
                    validator(
                        {"type": "2fa_code", "generation": 1, "code": code},
                        1,
                    )


class FakeStates:
    def __init__(self, checked=False, displayed=True, enabled=True):
        self.is_checked = checked
        self.is_displayed = displayed
        self.is_enabled = enabled


class FakeScroll:
    def __init__(self, on_to_see=None):
        self.calls = []
        self.on_to_see = on_to_see

    def to_see(self):
        self.calls.append(("to_see",))
        if self.on_to_see is not None:
            self.on_to_see()


def serialize_scope_state(state):
    payload = dict(state)
    payload.setdefault("hasStrongTwoFactorText", bool(payload.get("twofa")))
    payload.setdefault("semanticTargetCount", 0)
    payload.setdefault("digitCellCount", 0)
    return json.dumps(payload)


class FakeElement:
    def __init__(
        self,
        text="",
        on_click=None,
        checked=False,
        displayed=True,
        enabled=True,
        attrs=None,
        location=None,
        size=None,
        focused=True,
        rendered_text="__value__",
        shared_id=None,
        on_scroll=None,
        prompt_semantics=None,
    ):
        self.text = text
        self.on_click = on_click
        self.states = FakeStates(checked=checked, displayed=displayed, enabled=enabled)
        self.inputs = []
        self.clicks = 0
        self.value = ""
        self.scope = None
        self.attrs = attrs or {}
        self.location = location or {"x": 0, "y": 0}
        self.size = size or {"width": 100, "height": 30}
        self.focused = focused
        self.rendered_text = rendered_text
        self.scroll = FakeScroll(on_scroll)
        self.prompt_semantics = prompt_semantics
        self.equality_key = (
            ("shared", shared_id) if shared_id is not None else ("instance", object())
        )

    def __eq__(self, other):
        if not isinstance(other, FakeElement):
            return NotImplemented
        return self.equality_key == other.equality_key

    def __hash__(self):
        return hash(self.equality_key)

    def click_self(self):
        self.clicks += 1
        if self.scope is not None:
            self.scope.actions.target = self
        if self.on_click:
            self.on_click()
        return self

    def input(self, value, clear=True):
        self.inputs.append((value, clear))
        self.value = value if clear else self.value + value
        return self

    def attr(self, name):
        return self.attrs.get(name)

    def run_js(self, script):
        if not str(script).lstrip().startswith("function"):
            raise RuntimeError("FirefoxElement.run_js requires a function declaration")
        if "const expectedPrompt = 'trust'" in script:
            if self.prompt_semantics is not None:
                return bool(self.prompt_semantics.get("trust"))
            return bool(self.scope and self.scope.state.get("trustPrompt"))
        if "const expectedPrompt = 'twofa'" in script:
            if self.prompt_semantics is not None:
                return bool(self.prompt_semantics.get("twofa"))
            return bool(
                self.scope
                and (
                    self.scope.state.get("twofa")
                    or int(self.scope.state.get("codeInputCount") or 0) > 0
                )
            )
        if "activeElement" in script:
            return self.focused
        if "tagName" in script:
            return self.attrs.get("tagName", "DIV").upper() not in ("INPUT", "TEXTAREA")
        if "innerText" in script or "textContent" in script:
            return self.value if self.rendered_text == "__value__" else self.rendered_text
        return None


class FakePage:
    def __init__(
        self,
        elements_by_selector=None,
        buttons=None,
        frames=None,
        shadow_roots=None,
        state=None,
        actions=None,
        parent=None,
        frame_results=None,
        shadow_error=None,
    ):
        self.elements_by_selector = elements_by_selector or {}
        self.buttons = buttons or []
        self.frames = frames or []
        self._shadow_roots = shadow_roots or []
        self.parent = parent
        self.frame_results = list(frame_results) if frame_results is not None else None
        self.shadow_error = shadow_error
        self.get_frames_calls = 0
        self.shadow_roots_calls = []
        self.eles_calls = []
        self.state = {
            "href": "https://idmsa.apple.com/appleauth/auth/signin",
            **(state or {}),
        }
        self.actions = actions or FakeActions()
        for elements in self.elements_by_selector.values():
            for element in elements:
                element.scope = self
        for button in self.buttons:
            button.scope = self

    def eles(self, selector, timeout=None):
        self.eles_calls.append((selector, timeout))
        if selector == "css:button":
            return self.buttons
        return self.elements_by_selector.get(selector, [])

    def get_frames(self):
        self.get_frames_calls += 1
        if self.frame_results is not None:
            result = (
                self.frame_results.pop(0)
                if len(self.frame_results) > 1
                else self.frame_results[0]
            )
            if isinstance(result, Exception):
                raise result
            return result
        return self.frames

    def shadow_roots(self, mode="all", include_frames=True):
        self.shadow_roots_calls.append((mode, include_frames))
        if self.shadow_error is not None:
            raise self.shadow_error
        return self._shadow_roots

    def run_js(self, _script):
        if "location.href" in _script and "JSON.stringify" not in _script:
            return self.state.get("href", "https://idmsa.apple.com/appleauth/auth/signin")
        if "strongTwoFactorText" in _script and "const shadowRoot = this" in _script:
            if not str(_script).lstrip().startswith("function"):
                raise RuntimeError("FirefoxElement.run_js requires a function declaration")
            return json.dumps(
                self.state.get(
                    "shadowEvidence",
                    {
                        "hasStrongText": bool(self.state.get("shadowTwofa")),
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                    },
                )
            )
        return serialize_scope_state(self.state)


class FakeActions:
    def __init__(self, apply_typed_text=True, coordinate_target=None):
        self.calls = []
        self.target = None
        self.pending_human_click = None
        self.pending_text = None
        self.select_all = False
        self.delete_selection = False
        self.apply_typed_text = apply_typed_text
        self.coordinate_target = coordinate_target
        self.coordinate_targets = (
            list(coordinate_target) if isinstance(coordinate_target, list) else None
        )

    def combo(self, *keys):
        self.calls.append(("combo", keys))
        if len(keys) == 2 and keys[1] == "a":
            self.select_all = True
        return self

    def press(self, key):
        self.calls.append(("press", key))
        if self.select_all:
            self.delete_selection = True
        return self

    def type(self, text, interval=0):
        self.calls.append(("type", text, interval))
        self.pending_text = text
        return self

    def human_click(self, element):
        self.calls.append(("human_click", element))
        if isinstance(element, dict) and self.coordinate_targets is not None:
            self.target = self.coordinate_targets.pop(0)
        elif isinstance(element, dict) and self.coordinate_target is not None:
            self.target = self.coordinate_target
        else:
            self.target = element
        self.pending_human_click = self.target
        return self

    def perform(self):
        self.calls.append(("perform",))
        if self.pending_human_click is not None:
            element = self.pending_human_click
            self.pending_human_click = None
            on_click = getattr(element, "on_click", None)
            if on_click:
                on_click()
        if self.target is not None and self.delete_selection:
            self.target.value = ""
            self.select_all = False
            self.delete_selection = False
        if self.target is not None and self.pending_text is not None:
            if self.apply_typed_text:
                self.target.value = self.pending_text
            self.pending_text = None
        return self


class FakeKeys:
    COMMAND = "COMMAND"
    DELETE = "DELETE"
    ENTER = "ENTER"


class InputTests(unittest.TestCase):
    def test_human_click_uses_ruyipage_actions_not_element_click_self(self):
        field = FakeElement()
        scope = FakePage({"css:input": [field]})

        human_click(scope, field, pause=lambda *_: None)

        self.assertEqual(field.clicks, 0)
        self.assertEqual(
            scope.actions.calls,
            [("human_click", field), ("perform",)],
        )

    def test_mac_input_clears_with_ruyipage_command_actions(self):
        field = FakeElement()
        field.value = "old@example.com"
        scope = FakePage({"css:input": [field]})
        actions = scope.actions

        input_and_verify(
            scope,
            field,
            "person@example.com",
            "email",
            FakeKeys,
            pause=lambda *_: None,
        )

        self.assertEqual(field.inputs, [])
        self.assertEqual(actions.calls[0], ("human_click", field))
        self.assertEqual(actions.calls[1], ("perform",))
        self.assertEqual(actions.calls[2], ("combo", ("COMMAND", "a")))
        self.assertEqual(actions.calls[3], ("press", "DELETE"))
        self.assertEqual(actions.calls[4], ("perform",))
        self.assertEqual(actions.calls[5][0:2], ("type", "person@example.com"))
        self.assertGreaterEqual(actions.calls[5][2], 40)
        self.assertLessEqual(actions.calls[5][2], 180)
        self.assertEqual(actions.calls[6], ("perform",))
        self.assertEqual(field.value, "person@example.com")

    def test_input_progress_records_route_and_verification_without_value(self):
        field = FakeElement()
        scope = FakePage({"css:input": [field]})

        with patch("apple_account_flow.emit") as emit_event:
            input_and_verify(
                scope,
                field,
                "person@example.com",
                "email",
                FakeKeys,
                pause=lambda *_: None,
            )

        events = [call.args[0] for call in emit_event.call_args_list]
        self.assertEqual(
            [event["step"] for event in events],
            [
                "focus_started",
                "focus_confirmed",
                "keyboard_cleared",
                "keyboard_typed",
                "value_matched",
                "verified",
            ],
        )
        self.assertEqual(events[1]["route"], "root")
        self.assertNotIn("person@example.com", json.dumps(events))

    def test_input_falls_back_to_element_bidi_input_when_actions_lose_focus(self):
        field = FakeElement()
        actions = FakeActions(apply_typed_text=False)
        scope = FakePage({"css:input": [field]}, actions=actions)

        input_and_verify(
            scope,
            field,
            "person@example.com",
            "email",
            FakeKeys,
            pause=lambda *_: None,
        )

        self.assertEqual(
            field.inputs,
            [("person@example.com", False)],
        )
        self.assertEqual(
            len([call for call in actions.calls if call[0] == "combo"]),
            2,
        )
        self.assertEqual(field.value, "person@example.com")

    def test_input_stops_before_fallback_if_first_attempt_loses_target(self):
        cases = (
            (
                "blurred",
                lambda field: setattr(field, "focused", False),
                "ruyiPage input target focus was not confirmed",
            ),
            (
                "disabled",
                lambda field: setattr(field.states, "is_enabled", False),
                "ruyiPage input target is not interactable",
            ),
        )
        for label, invalidate, expected_error in cases:
            with self.subTest(label=label):
                field = FakeElement()
                actions = FakeActions(apply_typed_text=False)
                scope = FakePage({"css:input": [field]}, actions=actions)
                pause_count = 0

                def pause(*_args):
                    nonlocal pause_count
                    pause_count += 1
                    if pause_count == 5:
                        invalidate(field)

                with self.assertRaisesRegex(RuntimeError, f"^{expected_error}$"):
                    input_and_verify(
                        scope,
                        field,
                        "person@example.com",
                        "email",
                        FakeKeys,
                        pause=pause,
                    )

                self.assertEqual(field.inputs, [])
                self.assertEqual(
                    len([call for call in actions.calls if call[0] == "type"]),
                    1,
                )

    def test_input_rechecks_focus_between_clear_and_type(self):
        field = FakeElement()

        class BlurAfterClearActions(FakeActions):
            def __init__(self):
                super().__init__()
                self.perform_count = 0

            def perform(self):
                result = super().perform()
                self.perform_count += 1
                if self.perform_count == 2:
                    field.focused = False
                return result

        actions = BlurAfterClearActions()
        scope = FakePage({"css:input": [field]}, actions=actions)

        with self.assertRaisesRegex(RuntimeError, "focus was not confirmed"):
            input_and_verify(
                scope,
                field,
                "person@example.com",
                "email",
                FakeKeys,
                pause=lambda *_: None,
            )

        self.assertEqual(
            [call for call in actions.calls if call[0] == "type"],
            [],
        )

    def test_frame_input_clicks_and_types_through_the_root_context(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin?state=test"
        iframe = FakeElement(
            attrs={"src": auth_url},
            location={"x": 150, "y": 378},
            size={"width": 980, "height": 411},
        )
        field = FakeElement(
            location={"x": 260, "y": 117},
            size={"width": 460, "height": 56},
        )
        root_actions = FakeActions(coordinate_target=field)
        root = FakePage(
            {"css:iframe": [iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=root_actions,
        )
        frame = FakePage(
            {"css:input": [field]},
            state={"href": auth_url},
            parent=root,
        )

        action_scope = input_and_verify(
            frame,
            field,
            "person@example.com",
            "email",
            FakeKeys,
            pause=lambda *_: None,
            root_page=root,
        )

        self.assertIs(action_scope, root)
        self.assertEqual(frame.actions.calls, [])
        self.assertEqual(
            root_actions.calls[0],
            ("human_click", {"x": 640, "y": 523}),
        )
        self.assertEqual(field.scroll.calls, [("to_see",)])
        self.assertEqual(iframe.scroll.calls, [("to_see",)])
        self.assertEqual(field.value, "person@example.com")

    def test_frame_input_falls_back_to_the_element_owner_context_for_focus(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin"
        iframe = FakeElement(attrs={"src": auth_url})
        field = FakeElement(
            focused=False,
            on_click=lambda: setattr(field, "focused", True),
        )
        root = FakePage(
            {"css:iframe": [iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=FakeActions(),
        )
        frame = FakePage(
            {"css:input": [field]},
            state={"href": auth_url},
            parent=root,
        )

        action_scope = input_and_verify(
            frame,
            field,
            "123456",
            "2FA code",
            FakeKeys,
            pause=lambda *_: None,
            root_page=root,
        )

        self.assertIs(action_scope, frame)
        self.assertEqual(
            [call[0] for call in root.actions.calls],
            ["human_click", "perform"],
        )
        self.assertEqual(
            frame.actions.calls[0:2],
            [("human_click", field), ("perform",)],
        )
        self.assertEqual(field.value, "123456")
        self.assertEqual(field.scroll.calls, [("to_see",)])
        self.assertEqual(iframe.scroll.calls, [("to_see",)])

    def test_frame_input_sends_no_keys_when_both_focus_routes_fail(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin"
        iframe = FakeElement(attrs={"src": auth_url})
        field = FakeElement(focused=False)
        root = FakePage(
            {"css:iframe": [iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=FakeActions(),
        )
        frame = FakePage(
            {"css:input": [field]},
            state={"href": auth_url},
            parent=root,
        )

        with self.assertRaisesRegex(RuntimeError, "focus"):
            input_and_verify(
                frame,
                field,
                "123456",
                "2FA code",
                FakeKeys,
                pause=lambda *_: None,
                root_page=root,
            )

        self.assertEqual(
            [call[0] for call in root.actions.calls],
            ["human_click", "perform"],
        )
        self.assertEqual(
            [call[0] for call in frame.actions.calls],
            ["human_click", "perform"],
        )

    def test_frame_input_does_not_fall_back_after_the_target_becomes_disabled(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin"
        iframe = FakeElement(attrs={"src": auth_url})
        field = FakeElement()
        field.on_click = lambda: setattr(field.states, "is_enabled", False)
        root = FakePage(
            {"css:iframe": [iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=FakeActions(coordinate_target=field),
        )
        frame = FakePage(
            {"css:input": [field]},
            state={"href": auth_url},
            parent=root,
        )

        with self.assertRaisesRegex(RuntimeError, "not interactable"):
            input_and_verify(
                frame,
                field,
                "123456",
                "2FA code",
                FakeKeys,
                pause=lambda *_: None,
                root_page=root,
            )

        self.assertEqual(frame.actions.calls, [])

    def test_frame_input_does_not_fall_back_after_navigation_leaves_apple(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin"
        iframe = FakeElement(attrs={"src": auth_url})
        field = FakeElement()
        frame = FakePage(
            {"css:input": [field]},
            state={"href": auth_url},
        )

        class NavigateAfterRootTyping(FakeActions):
            def perform(self):
                had_pending_text = self.pending_text is not None
                result = super().perform()
                if had_pending_text:
                    frame.state["href"] = "https://evil.example/sign-in"
                return result

        root = FakePage(
            {"css:iframe": [iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=NavigateAfterRootTyping(
                apply_typed_text=False,
                coordinate_target=field,
            ),
        )
        frame.parent = root

        with self.assertRaisesRegex(RuntimeError, "Apple HTTPS"):
            input_and_verify(
                frame,
                field,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
                root_page=root,
            )

        self.assertEqual(frame.actions.calls, [])

    def test_top_level_input_rechecks_target_state_and_focus_before_keys(self):
        class StaleStates:
            @property
            def is_displayed(self):
                raise RuntimeError("stale element")

        cases = (
            (
                "disabled after click",
                lambda field: setattr(field.states, "is_enabled", False),
                True,
                "ruyiPage input target is not interactable",
            ),
            (
                "stale after click",
                lambda field: setattr(field, "states", StaleStates()),
                True,
                "ruyiPage input target is not interactable",
            ),
            (
                "focus not acquired",
                lambda _field: None,
                False,
                "ruyiPage input target focus was not confirmed",
            ),
        )
        for label, after_click, focused, expected_error in cases:
            with self.subTest(label=label):
                field = FakeElement(focused=focused)
                field.on_click = lambda field=field: after_click(field)
                page = FakePage({"css:input": [field]})

                with self.assertRaisesRegex(
                    RuntimeError,
                    f"^{expected_error}$",
                ):
                    input_and_verify(
                        page,
                        field,
                        "person@example.com",
                        "email",
                        FakeKeys,
                        pause=lambda *_: None,
                    )

                self.assertEqual(
                    [call for call in page.actions.calls if call[0] in ("combo", "type")],
                    [],
                )

    def test_contenteditable_verification_requires_readable_rendered_text(self):
        field = FakeElement(
            attrs={"contenteditable": "true", "role": "textbox"},
            rendered_text=None,
        )
        page = FakePage({"css:[contenteditable='true']": [field]})

        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            input_and_verify(
                page,
                field,
                "123456",
                "2FA code",
                FakeKeys,
                pause=lambda *_: None,
            )

    def test_password_accepts_historical_unreadable_value_after_trusted_input(self):
        password = FakeElement(attrs={"type": "password"})
        page = FakePage({"css:input[type='password']": [password]})

        with patch(
            "apple_account_flow.read_element_input_value",
            return_value=(False, None),
        ):
            action_scope = input_and_verify(
                page,
                password,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
            )

        self.assertIs(action_scope, page)
        self.assertEqual(password.value, "secret")
        self.assertEqual(password.inputs, [("secret", False)])

    def test_password_value_never_falls_back_to_rendered_text(self):
        class PasswordElement(FakeElement):
            def run_js(self, script):
                if "tagName" in script:
                    raise RuntimeError("tag query unavailable")
                return super().run_js(script)

        password = PasswordElement(
            attrs={"type": "password", "role": "textbox"},
        )
        password.value = "secret"

        self.assertEqual(
            account_flow.read_element_input_value(password),
            (True, "secret"),
        )

    def test_contenteditable_with_a_text_type_keeps_rendered_text_semantics(self):
        field = FakeElement(
            attrs={
                "contenteditable": "true",
                "role": "textbox",
                "type": "text",
            },
            rendered_text="rendered value",
        )
        field.value = "raw value"

        self.assertEqual(
            account_flow.read_element_input_value(field),
            (True, "rendered value"),
        )

    def test_non_password_input_still_rejects_an_unreadable_value(self):
        email = FakeElement(attrs={"type": "email"})
        page = FakePage({"css:input[type='email']": [email]})

        with patch(
            "apple_account_flow.read_element_input_value",
            return_value=(False, None),
        ), self.assertRaisesRegex(RuntimeError, "email input verification failed"):
            input_and_verify(
                page,
                email,
                "person@example.com",
                "email",
                FakeKeys,
                pause=lambda *_: None,
            )

    def test_password_still_rejects_a_readable_wrong_value(self):
        password = FakeElement(attrs={"type": "password"})
        page = FakePage(
            {"css:input[type='password']": [password]},
            actions=FakeActions(apply_typed_text=False),
        )

        with patch(
            "apple_account_flow.read_element_input_value",
            side_effect=[(True, "wrong"), (False, None)],
        ), self.assertRaisesRegex(RuntimeError, "password input verification failed"):
            input_and_verify(
                page,
                password,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
            )

    def test_password_submit_refocuses_field_after_remember_checkbox_click(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin?state=test"
        password = FakeElement(
            location={"x": 260, "y": 117},
            size={"width": 460, "height": 56},
        )
        remember = FakeElement(
            location={"x": 260, "y": 200},
            size={"width": 24, "height": 24},
        )
        iframe = FakeElement(
            attrs={"src": auth_url},
            location={"x": 150, "y": 378},
            size={"width": 980, "height": 411},
        )
        root_actions = FakeActions(coordinate_target=password)
        root = FakePage(
            {"css:iframe": [iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=root_actions,
        )
        frame = FakePage(
            {
                "css:input[type='password']": [password],
                "css:#remember-me": [remember],
            },
            state={"href": auth_url},
            parent=root,
        )
        root.frames = [frame]

        root_actions.target = remember
        submit_element_with_enter(
            root,
            frame,
            password,
            FakeKeys,
            pause=lambda *_: None,
        )

        self.assertIs(root_actions.target, password)
        self.assertEqual(
            root_actions.calls[-4:],
            [
                ("human_click", {"x": 640, "y": 523}),
                ("perform",),
                ("press", "ENTER"),
                ("perform",),
            ],
        )

    def test_password_submit_falls_back_to_frame_context_for_enter(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin"
        iframe = FakeElement(attrs={"src": auth_url})
        password = FakeElement(focused=False)
        password.on_click = lambda: setattr(password, "focused", True)
        root = FakePage(
            {"css:iframe": [iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=FakeActions(),
        )
        frame = FakePage(
            {"css:input[type='password']": [password]},
            state={"href": auth_url},
            parent=root,
        )

        submit_element_with_enter(
            root,
            frame,
            password,
            FakeKeys,
            pause=lambda *_: None,
        )

        self.assertEqual(
            [call[0] for call in root.actions.calls],
            ["human_click", "perform"],
        )
        self.assertEqual(
            [call[0] for call in frame.actions.calls],
            ["human_click", "perform", "press", "perform"],
        )

    def test_submit_rechecks_focus_immediately_before_enter(self):
        field = FakeElement()
        page = FakePage({"css:input": [field]})
        pause_count = 0

        def blur_during_submit_pause(*_args):
            nonlocal pause_count
            pause_count += 1
            if pause_count == 2:
                field.focused = False

        with self.assertRaisesRegex(RuntimeError, "focus was not confirmed"):
            submit_element_with_enter(
                page,
                page,
                field,
                FakeKeys,
                pause=blur_during_submit_pause,
            )

        self.assertNotIn(("press", "ENTER"), page.actions.calls)

    def test_frame_input_maps_a_unique_apple_iframe_after_in_frame_navigation(self):
        iframe = FakeElement(
            attrs={"src": "https://idmsa.apple.com/appleauth/auth/signin"},
            location={"x": 150, "y": 378},
        )
        field = FakeElement(
            location={"x": 260, "y": 117},
            size={"width": 460, "height": 56},
        )
        root_actions = FakeActions(coordinate_target=field)
        root = FakePage(
            {"css:iframe": [iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=root_actions,
        )
        frame = FakePage(
            {"css:input": [field]},
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/authorize/verify/phone"
            },
            parent=root,
        )

        action_scope = input_and_verify(
            frame,
            field,
            "person@example.com",
            "email",
            FakeKeys,
            pause=lambda *_: None,
            root_page=root,
        )

        self.assertIs(action_scope, root)
        self.assertEqual(field.value, "person@example.com")

    def test_frame_input_prefers_an_exact_url_over_a_broader_path_match(self):
        frame_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin?state=test"
        broad_iframe = FakeElement(
            attrs={"src": "https://idmsa.apple.com/appleauth/auth"},
            location={"x": 600, "y": 100},
        )
        exact_iframe = FakeElement(
            attrs={"src": frame_url},
            location={"x": 150, "y": 378},
        )
        field = FakeElement(
            location={"x": 260, "y": 117},
            size={"width": 460, "height": 56},
        )
        root_actions = FakeActions(coordinate_target=field)
        root = FakePage(
            {"css:iframe": [broad_iframe, exact_iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=root_actions,
        )
        frame = FakePage(
            {"css:input": [field]},
            state={"href": frame_url},
            parent=root,
        )

        input_and_verify(
            frame,
            field,
            "person@example.com",
            "email",
            FakeKeys,
            pause=lambda *_: None,
            root_page=root,
        )

        self.assertEqual(
            root_actions.calls[0],
            ("human_click", {"x": 640, "y": 523}),
        )
        self.assertEqual(field.value, "person@example.com")

    def test_frame_input_refuses_an_ambiguous_same_host_iframe_mapping(self):
        iframes = [
            FakeElement(
                attrs={"src": f"https://idmsa.apple.com/appleauth/auth/signin/{index}"}
            )
            for index in range(2)
        ]
        field = FakeElement()
        root = FakePage(
            {"css:iframe": iframes},
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame = FakePage(
            {"css:input": [field]},
            state={"href": "https://idmsa.apple.com/appleauth/auth/verify/phone"},
            parent=root,
        )

        with self.assertRaisesRegex(RuntimeError, "unable to map"):
            input_and_verify(
                frame,
                field,
                "person@example.com",
                "email",
                FakeKeys,
                pause=lambda *_: None,
                root_page=root,
            )

        self.assertEqual(root.actions.calls, [])

    def test_submit_enter_uses_the_element_scope_actions(self):
        root = FakePage()
        frame = FakePage()
        field = FakeElement()

        submit_with_enter(frame, field, FakeKeys, pause=lambda *_: None)

        self.assertEqual(root.actions.calls, [])
        self.assertEqual(frame.actions.calls, [("press", "ENTER"), ("perform",)])

    def test_input_rejects_a_non_apple_frame_before_typing(self):
        field = FakeElement()
        scope = FakePage(
            {"css:input": [field]},
            state={"href": "https://evil.example/sign-in"},
        )

        with self.assertRaisesRegex(RuntimeError, "Apple HTTPS"):
            input_and_verify(
                scope,
                field,
                "person@example.com",
                "email",
                FakeKeys,
                pause=lambda *_: None,
            )

        self.assertEqual(field.clicks, 0)
        self.assertEqual(scope.actions.calls, [])


class BrowserFlowTests(unittest.TestCase):
    def test_password_resume_requires_password_without_email(self):
        cases = (
            ({"password": True, "email": False}, True),
            ({"password": True, "email": True}, False),
            ({"password": True}, False),
            ({"password": False, "email": False}, False),
        )
        for state, expected in cases:
            with self.subTest(state=state):
                self.assertIs(account_flow.should_resume_at_password(state), expected)

    def test_browser_flow_refocuses_password_after_remember_before_submit(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin?state=test"
        email = FakeElement()
        password = FakeElement(
            location={"x": 260, "y": 117},
            size={"width": 460, "height": 56},
        )
        remember = FakeElement(
            location={"x": 260, "y": 200},
            size={"width": 24, "height": 24},
        )
        remember.on_click = lambda: setattr(remember.states, "is_checked", True)
        iframe = FakeElement(
            attrs={"src": auth_url},
            location={"x": 150, "y": 378},
            size={"width": 980, "height": 411},
        )
        root_actions = FakeActions(coordinate_target=[password, remember, password])
        root = FakePage(
            {
                "css:#account_name_text_field": [email],
                "css:iframe": [iframe],
            },
            state={"href": "https://account.apple.com/sign-in"},
            actions=root_actions,
        )
        frame = FakePage(
            {
                "css:input[type='password']": [password],
                "css:#remember-me": [remember],
            },
            state={"href": auth_url},
            parent=root,
        )
        root.frames = [frame]
        root.get = lambda *_: None
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        def mark_prepared():
            root_actions.calls.append(("prepare",))

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: root, FakeKeys),
        ), patch(
            "apple_account_flow.detect_login_state",
            side_effect=[{"trusted": False}, {"trusted": True}],
        ), patch(
            "apple_account_flow.request_two_factor_preparation",
            side_effect=mark_prepared,
        ), patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value={"trusted": True},
        ), patch(
            "apple_account_flow.take_screenshot",
            return_value=None,
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"fullName": "Person", "birthday": None},
        ), patch(
            "apple_account_flow.human_pause",
            return_value=None,
        ), patch(
            "apple_account_flow.time.sleep",
            return_value=None,
        ), patch("apple_account_flow.emit"):
            self.assertEqual(browser_flow(args), 0)

        prepare_index = root_actions.calls.index(("prepare",))
        self.assertEqual(
            root_actions.calls[prepare_index - 2 : prepare_index + 5],
            [
                ("human_click", {"x": 422, "y": 590}),
                ("perform",),
                ("prepare",),
                ("human_click", {"x": 640, "y": 523}),
                ("perform",),
                ("press", "ENTER"),
                ("perform",),
            ],
        )
        self.assertIs(root_actions.target, password)

    def test_browser_flow_waits_for_a_fresh_otp_target_after_receiving_the_code(self):
        root = FakePage(state={"href": "https://account.apple.com/sign-in"})
        root.get = lambda *_: None
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None
        email = FakeElement()
        password = FakeElement()
        otp = FakeElement()
        target = [(root, otp)]
        calls = []

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        def wait_for_target(_page):
            calls.append("wait_for_otp_target")
            return target

        def fill_code(_page, code, _keys, **kwargs):
            calls.append(("fill_security_code", code, kwargs.get("fields")))

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: root, FakeKeys),
        ), patch(
            "apple_account_flow.detect_login_state",
            side_effect=[{"trusted": False}, {"trusted": True}],
        ), patch(
            "apple_account_flow.wait_for_element",
            side_effect=[(root, email), (root, password)],
        ), patch(
            "apple_account_flow.input_and_verify",
            return_value=root,
        ), patch(
            "apple_account_flow.submit_with_enter",
        ), patch(
            "apple_account_flow.ensure_remember_checked",
            return_value=True,
        ), patch(
            "apple_account_flow.request_two_factor_preparation",
        ), patch(
            "apple_account_flow.submit_element_with_enter",
        ), patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone?state=secret#step",
                "trusted": False,
                "twofa": True,
                "twofaVisible": True,
                "inputReady": False,
                "codeInputCount": 0,
            },
        ), patch(
            "apple_account_flow.read_command",
            return_value={
                "type": "2fa_code",
                "generation": 1,
                "code": "123456",
            },
        ), patch(
            "apple_account_flow.wait_for_otp_target",
            side_effect=wait_for_target,
        ), patch(
            "apple_account_flow.fill_security_code",
            side_effect=fill_code,
        ), patch(
            "apple_account_flow.click_two_factor_submit",
            return_value=False,
        ), patch(
            "apple_account_flow.wait_for_signed_in",
            return_value={"trusted": True},
        ), patch(
            "apple_account_flow.take_screenshot",
            return_value=None,
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"fullName": "Person", "birthday": None},
        ), patch(
            "apple_account_flow.human_pause",
            return_value=None,
        ), patch("apple_account_flow.emit") as emit_event:
            self.assertEqual(browser_flow(args), 0)

        self.assertEqual(
            calls,
            [
                "wait_for_otp_target",
                ("fill_security_code", "123456", target),
            ],
        )
        need_two_factor = next(
            call.args[0]
            for call in emit_event.call_args_list
            if call.args[0].get("event") == "need_2fa"
        )
        self.assertEqual(need_two_factor["generation"], 1)
        self.assertEqual(
            need_two_factor["state"],
            {
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofaVisible": True,
                "inputReady": False,
                "codeInputCount": 0,
                "elapsedMs": 0,
            },
        )

    def test_browser_flow_retries_once_after_an_explicit_first_code_rejection(self):
        root = FakePage(state={"href": "https://account.apple.com/sign-in"})
        root.get = lambda *_: None
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None
        email = FakeElement()
        password = FakeElement()
        otp = FakeElement()
        target = [(root, otp)]
        filled_codes = []

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        def fill_code(_page, code, _keys, **_kwargs):
            filled_codes.append(code)

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: root, FakeKeys),
        ), patch(
            "apple_account_flow.detect_login_state",
            side_effect=[{"trusted": False}, {"trusted": True}],
        ), patch(
            "apple_account_flow.wait_for_element",
            side_effect=[(root, email), (root, password)],
        ), patch("apple_account_flow.input_and_verify"), patch(
            "apple_account_flow.submit_element_with_enter"
        ), patch("apple_account_flow.ensure_remember_checked", return_value=True), patch(
            "apple_account_flow.request_two_factor_preparation"
        ), patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "trusted": False,
                "twofa": True,
                "twofaVisible": True,
                "inputReady": True,
                "codeInputCount": 1,
            },
        ), patch(
            "apple_account_flow.read_command",
            side_effect=[
                {"type": "2fa_code", "generation": 1, "code": "111111"},
                {"type": "2fa_code", "generation": 2, "code": "222222"},
            ],
        ) as read_code, patch(
            "apple_account_flow.wait_for_otp_target", return_value=target
        ), patch(
            "apple_account_flow.fill_security_code", side_effect=fill_code
        ), patch(
            "apple_account_flow.click_two_factor_submit", return_value=True
        ), patch(
            "apple_account_flow.wait_for_signed_in",
            side_effect=[
                {
                    "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                    "twofa": True,
                    "otpRejected": True,
                    "retry2FA": True,
                },
                {"trusted": True},
            ],
        ) as signed_in, patch(
            "apple_account_flow.take_screenshot", return_value=None
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"fullName": "Person", "birthday": None},
        ), patch("apple_account_flow.human_pause", return_value=None), patch(
            "apple_account_flow.emit"
        ) as emit_event:
            self.assertEqual(browser_flow(args), 0)

        generations = [
            call.args[0]["generation"]
            for call in emit_event.call_args_list
            if call.args[0].get("event") == "need_2fa"
        ]
        self.assertEqual(generations, [1, 2])
        self.assertEqual(filled_codes, ["111111", "222222"])
        self.assertEqual(read_code.call_count, 2)
        self.assertEqual(
            [call.kwargs.get("otp_generation") for call in signed_in.call_args_list],
            [1, 2],
        )

    def test_recovered_password_page_skips_email_and_resumes_login(self):
        root = FakePage(state={"href": "https://account.apple.com/sign-in"})
        root.get = lambda *_: None
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None
        password = FakeElement(attrs={"type": "password"})

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: root, FakeKeys),
        ), patch(
            "apple_account_flow.detect_login_state",
            side_effect=[
                {
                    "trusted": False,
                    "twofa": False,
                    "password": True,
                    "email": False,
                    "error": False,
                },
                {"trusted": True, "error": False},
            ],
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch(
            "apple_account_flow.wait_for_element",
            return_value=(root, password),
        ) as wait_for_element, patch(
            "apple_account_flow.input_and_verify",
        ) as input_and_verify, patch(
            "apple_account_flow.ensure_remember_checked",
            return_value=True,
        ), patch(
            "apple_account_flow.request_two_factor_preparation",
        ) as prepare_two_factor, patch(
            "apple_account_flow.submit_element_with_enter",
        ) as submit_password, patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value={"trusted": True},
        ), patch(
            "apple_account_flow.take_screenshot",
            return_value=None,
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"fullName": "Person", "birthday": None},
        ), patch(
            "apple_account_flow.human_pause",
            return_value=None,
        ), patch("apple_account_flow.emit"):
            self.assertEqual(browser_flow(args), 0)

        wait_for_element.assert_called_once_with(
            root,
            account_flow.PASSWORD_SELECTORS,
            timeout_s=45,
        )
        self.assertEqual(input_and_verify.call_args.args[3], "password")
        prepare_two_factor.assert_called_once_with()
        submit_password.assert_called_once()

    def test_recovered_two_factor_profile_skips_credentials_and_completes_two_generations(self):
        root = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "trusted": False,
                "twofa": True,
                "error": False,
            }
        )
        root.get = lambda *_: None
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None
        otp = FakeElement(attrs={"autocomplete": "one-time-code", "tagName": "INPUT"})
        target = [(root, otp)]
        filled_codes = []
        events = []

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: root, FakeKeys),
        ), patch(
            "apple_account_flow.detect_login_state",
            side_effect=[dict(root.state), {"trusted": True, "error": False}],
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch(
            "apple_account_flow.wait_for_element",
            side_effect=AssertionError("recovered 2FA must not search for credentials"),
        ) as credential_wait, patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "trusted": False,
                "twofa": True,
                "twofaVisible": True,
                "inputReady": True,
                "codeInputCount": 1,
            },
        ) as two_factor_wait, patch(
            "apple_account_flow.read_command",
            side_effect=[
                {"type": "2fa_prepared"},
                {"type": "2fa_code", "generation": 1, "code": "111111"},
                {"type": "2fa_code", "generation": 2, "code": "222222"},
            ],
        ) as read_command, patch(
            "apple_account_flow.wait_for_otp_target",
            return_value=target,
        ), patch(
            "apple_account_flow.fill_security_code",
            side_effect=lambda _page, code, _keys, **_kwargs: filled_codes.append(code),
        ), patch(
            "apple_account_flow.click_two_factor_submit",
            return_value=True,
        ), patch(
            "apple_account_flow.wait_for_signed_in",
            side_effect=[
                {
                    "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                    "twofa": True,
                    "otpRejected": True,
                    "retry2FA": True,
                },
                {"trusted": True},
            ],
        ), patch(
            "apple_account_flow.take_screenshot",
            return_value=None,
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"fullName": "Person", "birthday": None},
        ), patch(
            "apple_account_flow.human_pause",
            return_value=None,
        ), patch(
            "apple_account_flow.emit",
            side_effect=events.append,
        ):
            self.assertEqual(browser_flow(args), 0)

        credential_wait.assert_not_called()
        two_factor_wait.assert_called_once_with(root)
        self.assertEqual(read_command.call_count, 3)
        self.assertEqual(filled_codes, ["111111", "222222"])
        self.assertEqual(
            [event["event"] for event in events if event["event"] != "status"],
            ["ready", "prepare_2fa", "need_2fa", "need_2fa", "result"],
        )
        self.assertEqual(
            [event["generation"] for event in events if event["event"] == "need_2fa"],
            [1, 2],
        )
        result = events[-1]
        self.assertTrue(result["success"])
        self.assertTrue(result["browserLogin"]["accountHomeConfirmed"])
        self.assertFalse(result["browserLogin"]["skippedLogin"])
        self.assertFalse(result["browserLogin"]["skipped2FA"])

    def test_browser_flow_never_requests_a_third_code(self):
        root = FakePage(state={"href": "https://account.apple.com/sign-in"})
        root.get = lambda *_: None
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: root, FakeKeys),
        ), patch("apple_account_flow.detect_login_state", return_value={"trusted": False}), patch(
            "apple_account_flow.wait_for_element",
            side_effect=[(root, FakeElement()), (root, FakeElement())],
        ), patch("apple_account_flow.input_and_verify"), patch(
            "apple_account_flow.submit_element_with_enter"
        ), patch("apple_account_flow.ensure_remember_checked", return_value=True), patch(
            "apple_account_flow.request_two_factor_preparation"
        ), patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value={"trusted": False, "twofa": True},
        ), patch(
            "apple_account_flow.read_command",
            side_effect=[
                {"type": "2fa_code", "generation": 1, "code": "111111"},
                {"type": "2fa_code", "generation": 2, "code": "222222"},
                AssertionError("a third OTP command must never be read"),
            ],
        ) as read_code, patch(
            "apple_account_flow.wait_for_otp_target",
            return_value=[(root, FakeElement())],
        ), patch("apple_account_flow.fill_security_code"), patch(
            "apple_account_flow.click_two_factor_submit", return_value=True
        ), patch(
            "apple_account_flow.wait_for_signed_in",
            side_effect=[
                {"retry2FA": True},
                RuntimeError("2FA/login failed"),
            ],
        ), patch("apple_account_flow.human_pause", return_value=None), patch(
            "apple_account_flow.emit"
        ) as emit_event:
            with self.assertRaisesRegex(RuntimeError, "2FA/login failed"):
                browser_flow(args)

        generations = [
            call.args[0]["generation"]
            for call in emit_event.call_args_list
            if call.args[0].get("event") == "need_2fa"
        ]
        self.assertEqual(generations, [1, 2])
        self.assertEqual(read_code.call_count, 2)

    def test_browser_flow_scans_shadow_trust_before_initial_manage_shell_skip(self):
        trust = FakeElement("Trust this browser", prompt_semantics={"trust": True})
        shadow_root = FakePage(buttons=[trust])
        root = FakePage(
            shadow_roots=[shadow_root],
            state={
                "href": "https://account.apple.com/account/manage",
                "accountMarker": True,
                "trusted": True,
            },
        )
        trust.on_click = lambda: setattr(root, "_shadow_roots", [])
        root.get = lambda *_: None
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        def click_without_pause(page, **_kwargs):
            return click_trust_browser(page, pause=lambda *_: None)

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: root, FakeKeys),
        ), patch(
            "apple_account_flow.click_trust_browser", side_effect=click_without_pause
        ), patch("apple_account_flow.take_screenshot", return_value=None), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"fullName": "Person", "birthday": None},
        ), patch("apple_account_flow.human_pause", return_value=None), patch(
            "apple_account_flow.emit"
        ):
            self.assertEqual(browser_flow(args), 0)

        self.assertIn(("human_click", trust), root.actions.calls)

    def test_browser_flow_scans_shadow_trust_before_final_personal_info_acceptance(self):
        trust = FakeElement("Trust this browser", prompt_semantics={"trust": True})
        shadow_root = FakePage(buttons=[trust])
        root = FakePage(
            state={
                "href": "https://account.apple.com/account/manage",
                "accountMarker": True,
                "trusted": True,
            }
        )
        trust.on_click = lambda: setattr(root, "_shadow_roots", [])
        get_calls = []

        def navigate(url):
            get_calls.append(url)
            if len(get_calls) == 2:
                root._shadow_roots = [shadow_root]

        root.get = navigate
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        def click_without_pause(page, **_kwargs):
            return click_trust_browser(page, pause=lambda *_: None)

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: root, FakeKeys),
        ), patch(
            "apple_account_flow.click_trust_browser", side_effect=click_without_pause
        ), patch("apple_account_flow.take_screenshot", return_value=None), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"fullName": "Person", "birthday": None},
        ), patch("apple_account_flow.human_pause", return_value=None), patch(
            "apple_account_flow.emit"
        ):
            self.assertEqual(browser_flow(args), 0)

        self.assertIn(("human_click", trust), root.actions.calls)


class SafeFailureBoundaryTests(unittest.TestCase):
    SECRET_SENTINEL = "?token=SECRET"

    class DiskScreenshotPage:
        def __init__(self, secret, *, quit_fails=False):
            self.secret = secret
            self.quit_fails = quit_fails
            self.wait = type(
                "FakeWait",
                (),
                {"doc_loaded": lambda *_args, **_kwargs: None},
            )()

        def get(self, _url):
            return None

        def screenshot(self, path, *, full_page):
            self.assert_full_page = full_page
            Path(path).write_text(self.secret, encoding="utf-8")

        def quit(self):
            if self.quit_fails:
                raise RuntimeError("quit failed")

    def run_late_flow(self, report_dir, page, final_state, personal_info, events):
        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        args = parse_args(["--report-dir", str(report_dir)])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: page, FakeKeys),
        ), patch(
            "apple_account_flow.detect_login_state",
            side_effect=[{"trusted": True, "error": False}, final_state],
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value=personal_info,
        ), patch(
            "apple_account_flow.human_pause",
            return_value=None,
        ), patch(
            "apple_account_flow.emit",
            side_effect=events.append,
        ):
            return browser_flow(args)

    def test_late_authentication_failure_removes_success_screenshot_from_disk(self):
        secret = "person@example.com OTP 123456"
        events = []
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            page = self.DiskScreenshotPage(secret)

            with self.assertRaisesRegex(RuntimeError, "authentication error"):
                self.run_late_flow(
                    report_dir,
                    page,
                    {"trusted": False, "error": True},
                    {"fullName": "Person", "birthday": None},
                    events,
                )

            self.assertEqual(list(report_dir.rglob("*.png")), [])
            self.assertNotIn(secret, json.dumps(events))

    def test_personal_info_parse_failure_removes_success_screenshot_from_disk(self):
        secret = "person@example.com OTP 123456"
        events = []
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            page = self.DiskScreenshotPage(secret)

            with self.assertRaisesRegex(RuntimeError, "name and birthday"):
                self.run_late_flow(
                    report_dir,
                    page,
                    {"trusted": True, "error": False},
                    {"fullName": None, "birthday": None},
                    events,
                )

            self.assertEqual(list(report_dir.rglob("*.png")), [])
            self.assertNotIn(secret, json.dumps(events))

    def test_quit_failure_removes_all_success_screenshots_from_disk(self):
        secret = "person@example.com OTP 123456"
        events = []
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            page = self.DiskScreenshotPage(secret, quit_fails=True)

            with self.assertRaisesRegex(RuntimeError, "quit failed"):
                self.run_late_flow(
                    report_dir,
                    page,
                    {"trusted": True, "error": False},
                    {"fullName": "Person", "birthday": None},
                    events,
                )

            self.assertEqual(list(report_dir.rglob("*.png")), [])
            self.assertNotIn(secret, json.dumps(events))

    def test_successful_flow_retains_fixed_success_screenshots(self):
        secret = "person@example.com OTP 123456"
        events = []
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            page = self.DiskScreenshotPage(secret)

            self.assertEqual(
                self.run_late_flow(
                    report_dir,
                    page,
                    {"trusted": True, "error": False},
                    {"fullName": "Person", "birthday": None},
                    events,
                ),
                0,
            )

            screenshots = sorted(path.name for path in report_dir.rglob("*.png"))
            self.assertEqual(
                screenshots,
                ["02-ruyipage-after-login.png", "03-account-manage.png"],
            )

    def test_early_failure_does_not_delete_fixed_screenshots_from_an_older_run(self):
        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        class FailingPage:
            def get(self, _url):
                raise RuntimeError("navigation failed")

            def quit(self):
                raise RuntimeError("quit failed")

        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            screenshots_dir = report_dir / "screenshots"
            screenshots_dir.mkdir(parents=True)
            older_files = (
                screenshots_dir / "02-ruyipage-after-login.png",
                screenshots_dir / "03-account-manage.png",
            )
            for path in older_files:
                path.write_text("older run", encoding="utf-8")

            args = parse_args(["--report-dir", str(report_dir)])
            with patch.dict(
                os.environ,
                {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
                clear=False,
            ), patch(
                "apple_account_flow.import_ruyipage",
                return_value=(FakeFirefoxOptions, lambda _opts: FailingPage(), FakeKeys),
            ), patch("apple_account_flow.emit"):
                with self.assertRaisesRegex(RuntimeError, "navigation failed"):
                    browser_flow(args)

            self.assertEqual(
                [path.read_text(encoding="utf-8") for path in older_files],
                ["older run", "older run"],
            )

    def test_screenshot_failure_emits_only_a_fixed_safe_reason(self):
        class FailingScreenshotPage:
            def screenshot(self, *_args, **_kwargs):
                raise RuntimeError(f"screenshot failed {self.SECRET_SENTINEL}")

            SECRET_SENTINEL = self.SECRET_SENTINEL

        class FakePath:
            parent = None

            def __init__(self):
                self.parent = self

            def mkdir(self, **_kwargs):
                return None

            def __str__(self):
                return "safe-screenshot.png"

        with patch("apple_account_flow.emit") as emit_event:
            result = account_flow.take_screenshot(FailingScreenshotPage(), FakePath())

        self.assertIsNone(result)
        self.assertEqual(
            emit_event.call_args.args[0],
            {"event": "warning", "message": "ruyipage_screenshot_failed"},
        )
        self.assertNotIn(self.SECRET_SENTINEL, json.dumps(emit_event.call_args.args[0]))

    def test_quit_failure_emits_only_a_fixed_safe_reason(self):
        secret = self.SECRET_SENTINEL

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        class FailingPage:
            def get(self, _url):
                raise RuntimeError(f"navigation failed {secret}")

            def quit(self):
                raise RuntimeError(f"quit failed {secret}")

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: FailingPage(), FakeKeys),
        ), patch(
            "apple_account_flow.take_screenshot",
            return_value=None,
        ), patch("apple_account_flow.emit") as emit_event:
            with self.assertRaises(RuntimeError):
                browser_flow(args)

        events = [call.args[0] for call in emit_event.call_args_list]
        self.assertIn(
            {"event": "warning", "message": "ruyipage_quit_failed"},
            events,
        )
        self.assertNotIn(secret, json.dumps(events))

    def test_authentication_failure_does_not_persist_a_failure_screenshot(self):
        order = []

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        class FailingAuthenticationPage:
            def get(self, _url):
                raise RuntimeError("authentication navigation failed")

            def quit(self):
                order.append("quit")
                return None

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {
                "APPLE_ID": "person@example.com",
                "APPLE_PASSWORD": "secret",
                "APPLE_AUTOMATION_BROWSER_BROKER_MODE": "1",
            },
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(
                FakeFirefoxOptions,
                lambda _opts: FailingAuthenticationPage(),
                FakeKeys,
            ),
        ), patch("apple_account_flow.take_screenshot") as take_screenshot, patch(
            "apple_account_flow.emit",
            side_effect=lambda event: order.append(("event", event)),
        ) as emit_event:
            with self.assertRaisesRegex(RuntimeError, "authentication navigation failed"):
                browser_flow(args)

        take_screenshot.assert_not_called()
        self.assertIn(
            {
                "event": "status",
                "status": "browser_failure",
                "failureStage": "login_navigation",
            },
            [call.args[0] for call in emit_event.call_args_list],
        )
        failure_event_index = next(
            index
            for index, item in enumerate(order)
            if isinstance(item, tuple)
            and item[0] == "event"
            and item[1].get("status") == "browser_failure"
        )
        self.assertLess(failure_event_index, order.index("quit"))

    def test_top_level_and_third_party_failures_use_one_fixed_safe_reason(self):
        run_cli = getattr(account_flow, "run_cli", None)
        if run_cli is None:
            self.fail("run_cli() is missing")

        stderr = io.StringIO()
        account_flow.configure_diagnostic_secrets(self.SECRET_SENTINEL)
        try:
            with patch(
                "apple_account_flow.main",
                side_effect=RuntimeError(
                    f"BiDi navigation failed {self.SECRET_SENTINEL} 123 456 "
                    "https://user:pw@example.invalid/path?token=secret#otp"
                ),
            ), patch("apple_account_flow.emit") as emit_event, redirect_stderr(stderr):
                return_code = run_cli([])
        finally:
            account_flow.configure_diagnostic_secrets()

        self.assertEqual(return_code, 1)
        events = [call.args[0] for call in emit_event.call_args_list]
        self.assertEqual(events[0]["event"], "diagnostic")
        self.assertEqual(events[0]["kind"], "python_exception")
        self.assertEqual(events[0]["errorType"], "RuntimeError")
        self.assertIn("RuntimeError", events[0]["traceback"])
        self.assertNotIn(self.SECRET_SENTINEL, json.dumps(events[0]))
        self.assertNotIn("123 456", json.dumps(events[0]))
        self.assertNotIn("user:pw@", json.dumps(events[0]))
        self.assertNotIn("?token=secret", json.dumps(events[0]))
        self.assertEqual(
            events[-1],
            {
                "event": "result",
                "success": False,
                "error": "ruyipage_browser_flow_failed",
            },
        )
        combined_output = json.dumps(emit_event.call_args.args[0]) + stderr.getvalue()
        self.assertNotIn(self.SECRET_SENTINEL, combined_output)
        self.assertEqual(stderr.getvalue().strip(), "ruyipage_browser_flow_failed")


class StrongTwoFactorClassifierTests(unittest.TestCase):
    def test_classifies_only_strong_two_factor_evidence(self):
        classifier = getattr(account_flow, "classify_strong_two_factor", None)
        if classifier is None:
            self.fail("classify_strong_two_factor() is missing")

        cases = (
            ("one numeric field", False, 0, 1, False),
            ("strong text", True, 0, 0, True),
            ("semantic target", False, 1, 0, True),
            ("exactly six digit cells", False, 0, 6, True),
        )
        for label, has_text, semantic_count, digit_count, expected in cases:
            with self.subTest(label=label):
                self.assertIs(
                    classifier(
                        has_strong_text=has_text,
                        semantic_target_count=semantic_count,
                        digit_cell_count=digit_count,
                    ),
                    expected,
                )

    def test_scope_detection_delegates_the_strong_decision_to_the_classifier(self):
        class EvidenceScope:
            def run_js(self, _script):
                return json.dumps(
                    {
                        "href": "https://idmsa.apple.com/appleauth/auth/signin",
                        "twofa": True,
                        "hasStrongTwoFactorText": True,
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                    }
                )

        with patch.object(
            account_flow,
            "classify_strong_two_factor",
            create=True,
            return_value=False,
        ) as classifier:
            state = account_flow.detect_scope_login_state(EvidenceScope())

        classifier.assert_called_once_with(
            has_strong_text=True,
            semantic_target_count=0,
            digit_cell_count=0,
        )
        self.assertFalse(state["twofa"])


class TwoFactorStateTests(unittest.TestCase):
    def test_first_generation_explicit_apple_otp_rejection_allows_one_retry(self):
        state = {
            "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
            "twofa": True,
            "error": True,
            "otpRejected": True,
            "blocked": False,
            "trusted": False,
        }

        with patch("apple_account_flow.detect_login_state", return_value=state):
            result = wait_for_signed_in(
                FakePage(),
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
            )

        self.assertTrue(result["retry2FA"])

    def test_second_generation_otp_rejection_fails_closed(self):
        state = {
            "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
            "twofa": True,
            "error": True,
            "otpRejected": True,
            "blocked": False,
            "trusted": False,
        }

        with patch("apple_account_flow.detect_login_state", return_value=state):
            with self.assertRaisesRegex(RuntimeError, "2FA/login failed"):
                wait_for_signed_in(
                    FakePage(),
                    timeout_s=0.05,
                    submitted=True,
                    otp_generation=2,
                )

    def test_non_apple_otp_rejection_never_allows_retry(self):
        state = {
            "href": "https://evil.example/apple-lookalike",
            "twofa": True,
            "error": True,
            "otpRejected": True,
            "blocked": False,
            "trusted": False,
        }

        with patch("apple_account_flow.detect_login_state", return_value=state):
            with self.assertRaisesRegex(RuntimeError, "Apple HTTPS"):
                wait_for_signed_in(
                    FakePage(),
                    timeout_s=0.05,
                    submitted=True,
                    otp_generation=1,
                )

    def test_otp_wait_stops_immediately_on_a_non_apple_root(self):
        state = {
            "href": "https://evil.example/apple-lookalike",
            "twofa": False,
            "error": False,
            "trusted": False,
        }

        with patch("apple_account_flow.detect_login_state", return_value=state), patch(
            "apple_account_flow.human_pause",
            side_effect=AssertionError("non-Apple OTP state must not be polled"),
        ):
            with self.assertRaisesRegex(RuntimeError, "Apple HTTPS"):
                wait_for_signed_in(
                    FakePage(),
                    timeout_s=1,
                    submitted=True,
                    otp_generation=1,
                )

    def test_unknown_or_blocked_error_never_allows_otp_retry(self):
        states = (
            {
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "error": True,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
            },
            {
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "error": True,
                "otpRejected": True,
                "blocked": True,
                "trusted": False,
            },
        )
        for state in states:
            with self.subTest(state=state), patch(
                "apple_account_flow.detect_login_state", return_value=state
            ):
                with self.assertRaisesRegex(RuntimeError, "2FA/login failed"):
                    wait_for_signed_in(
                        FakePage(),
                        timeout_s=0.05,
                        submitted=True,
                        otp_generation=1,
                    )

    def test_login_state_aggregates_otp_rejection_and_blocked_only_from_apple_scopes(self):
        apple_frame = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "error": True,
                "otpRejected": True,
                "blocked": True,
            }
        )
        hostile_frame = FakePage(
            state={
                "href": "https://evil.example/verify",
                "twofa": True,
                "error": True,
                "otpRejected": True,
                "blocked": True,
            }
        )
        page = FakePage(
            frames=[hostile_frame, apple_frame],
            state={"href": "https://account.apple.com/sign-in"},
        )

        state = detect_login_state(page)

        self.assertTrue(state["otpRejected"])
        self.assertTrue(state["blocked"])

    def test_scope_state_detects_only_explicit_localized_otp_rejection_text(self):
        scripts = {}

        class CapturingScope:
            def run_js(self, script):
                scripts["dom"] = script
                return json.dumps({"href": "https://idmsa.apple.com/"})

        class CapturingShadowRoot:
            def run_js(self, script):
                scripts["shadow"] = script
                return json.dumps(
                    {
                        "hasStrongText": False,
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                        "trustPrompt": False,
                        "otpRejected": False,
                        "blocked": False,
                        "error": False,
                    }
                )

        account_flow.detect_scope_login_state(CapturingScope())
        account_flow.detect_shadow_root_state(CapturingShadowRoot())

        patterns = {}
        for scope_name, script in scripts.items():
            match = re.search(
                r"const otpRejected = /(.+)/i\.test\(normalizedBody\);",
                script,
            )
            self.assertIsNotNone(match, f"{scope_name} OTP rejection regex is missing")
            patterns[scope_name] = match.group(1)

        self.assertEqual(patterns["dom"], patterns["shadow"])
        classifier = re.compile(patterns["dom"], re.IGNORECASE)
        samples = (
            ("This verification code is invalid", True),
            ("The verification code you entered is incorrect", True),
            ("验证码不正确", True),
            ("驗證碼已過期", True),
            ("Verification Code This sign-in request is invalid.", False),
            ("验证码 此登录请求无效。", False),
            ("驗證碼 此登入要求無效。", False),
        )
        for text, expected in samples:
            with self.subTest(text=text):
                normalized = re.sub(r"\s+", " ", text)
                self.assertEqual(bool(classifier.search(normalized)), expected)

    def test_wait_returns_when_apple_two_factor_state_is_visible_without_known_fields(self):
        page = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "trusted": False,
                "error": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "Two-Factor Authentication",
            }
        )

        with patch("apple_account_flow.human_pause", lambda *_: None):
            try:
                state = wait_for_2fa_or_session(page, timeout_s=0.01)
            except RuntimeError as exc:
                self.fail(f"visible Apple 2FA state timed out: {exc}")

        self.assertTrue(state["twofa"])
        self.assertEqual(state["codeInputCount"], 0)
        self.assertTrue(state.get("twofaVisible"))
        self.assertFalse(state.get("inputReady"))
        self.assertIsInstance(state.get("elapsedMs"), int)
        self.assertGreaterEqual(state["elapsedMs"], 0)
        self.assertLessEqual(state["elapsedMs"], 10)
        self.assertTrue(page.eles_calls)
        self.assertTrue(all(timeout == 0 for _selector, timeout in page.eles_calls))

    def test_non_apple_frame_does_not_make_two_factor_phase_visible(self):
        frame = FakePage(
            state={
                "href": "https://evil.example/verify",
                "twofa": True,
                "trusted": False,
                "error": False,
                "codeInputCount": 6,
                "snippet": "Verification code",
            }
        )
        page = FakePage(
            frames=[frame],
            state={
                "href": "https://account.apple.com/sign-in",
                "twofa": False,
                "trusted": False,
                "error": False,
                "codeInputCount": 0,
                "snippet": "",
            },
        )

        state = detect_login_state(page)

        self.assertFalse(state["twofa"])
        self.assertEqual(state["codeInputCount"], 0)

    def test_scope_script_requires_strong_text_semantics_or_exactly_six_cells(self):
        scripts = []

        class CapturingScope:
            def run_js(self, script):
                scripts.append(script)
                return json.dumps({"href": "https://idmsa.apple.com/", "twofa": False})

        account_flow.detect_scope_login_state(CapturingScope())

        self.assertIn("strongTwoFactorText", scripts[0])
        self.assertIn("digitCells.length === 6", scripts[0])
        self.assertNotIn("codeInputs.length >= 1", scripts[0])

    def test_security_question_semantics_do_not_trigger_two_factor(self):
        def has_standalone_security(script):
            return "|security|" in script

        class SecurityQuestionScope:
            def __init__(self):
                self.script = ""

            def run_js(self, script):
                self.script = script
                return json.dumps(
                    {
                        "href": "https://idmsa.apple.com/appleauth/auth/signin",
                        "hasStrongTwoFactorText": False,
                        "semanticTargetCount": int(has_standalone_security(script)),
                        "digitCellCount": 0,
                    }
                )

        class SecurityQuestionShadow:
            def __init__(self):
                self.script = ""

            def run_js(self, script):
                self.script = script
                return json.dumps(
                    {
                        "hasStrongText": False,
                        "semanticTargetCount": int(has_standalone_security(script)),
                        "digitCellCount": 0,
                    }
                )

        class SecurityQuestionButton:
            def __init__(self):
                self.script = ""

            def run_js(self, script):
                self.script = script
                return has_standalone_security(script)

        scope = SecurityQuestionScope()
        shadow = SecurityQuestionShadow()
        button = SecurityQuestionButton()
        cases = (
            (
                "page scope",
                account_flow.detect_scope_login_state(scope)["twofa"],
                scope.script,
            ),
            (
                "shadow root",
                account_flow.shadow_root_has_two_factor_marker(shadow),
                shadow.script,
            ),
            (
                "two-factor button container",
                account_flow.button_has_prompt_semantics(button, "twofa"),
                button.script,
            ),
        )
        for label, detected, script in cases:
            with self.subTest(label=label):
                self.assertFalse(detected)
                self.assertNotIn("|security|", script)

    def test_shadow_only_marker_makes_two_factor_phase_visible_without_returning_text(self):
        shadow = FakePage(state={"shadowTwofa": True})
        page = FakePage(
            shadow_roots=[shadow],
            state={"twofa": False, "trusted": False, "error": False},
        )

        state = detect_login_state(page)

        self.assertTrue(state["twofaVisible"])
        self.assertNotIn("snippet", state)

    def test_shadow_hidden_or_template_text_does_not_create_two_factor_evidence(self):
        class HiddenTextShadowRoot:
            def __init__(self):
                self.script = ""

            def run_js(self, script):
                self.script = script
                if not str(script).lstrip().startswith("function"):
                    raise RuntimeError("FirefoxElement.run_js requires a function declaration")
                if "shadowRoot.textContent" in script:
                    return True
                return json.dumps(
                    {
                        "hasStrongText": False,
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                    }
                )

        shadow = HiddenTextShadowRoot()

        self.assertFalse(account_flow.shadow_root_has_two_factor_marker(shadow))
        self.assertNotIn("shadowRoot.textContent", shadow.script)

    def test_shadow_visible_rendered_text_creates_two_factor_evidence(self):
        class VisibleTextShadowRoot:
            def run_js(self, script):
                if not str(script).lstrip().startswith("function"):
                    raise RuntimeError("FirefoxElement.run_js requires a function declaration")
                uses_visible_rendered_text = (
                    ".filter(visible)" in script
                    and "innerText" in script
                    and "shadowRoot.textContent" not in script
                )
                if not uses_visible_rendered_text:
                    return False
                return json.dumps(
                    {
                        "hasStrongText": True,
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                    }
                )

        self.assertTrue(
            account_flow.shadow_root_has_two_factor_marker(VisibleTextShadowRoot())
        )

    def test_secret_bearing_snippet_is_never_returned_or_placed_in_errors(self):
        secret = "person@example.com code=123456 TOP-SECRET"
        page = FakePage(
            state={
                "twofa": False,
                "trusted": False,
                "error": True,
                "snippet": secret,
            }
        )

        state = detect_login_state(page)
        self.assertNotIn("snippet", state)
        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaises(RuntimeError) as caught:
                wait_for_2fa_or_session(page, timeout_s=0.01)
        self.assertNotIn(secret, str(caught.exception))


class OtpTargetWaitTests(unittest.TestCase):
    def wait_for_target(self, page, timeout_s=0.02):
        wait_for_otp_target = getattr(account_flow, "wait_for_otp_target", None)
        self.assertIsNotNone(wait_for_otp_target, "wait_for_otp_target() is missing")
        with patch("apple_account_flow.human_pause", lambda *_: None):
            try:
                return wait_for_otp_target(page, timeout_s=timeout_s)
            except RuntimeError as exc:
                self.fail(f"OTP target was not discovered: {exc}")

    def test_wait_for_otp_target_returns_an_existing_strong_field(self):
        field = FakeElement()
        page = FakePage(
            {"css:input[autocomplete='one-time-code']": [field]},
            state={
                "twofa": True,
                "trusted": False,
                "error": False,
                "password": False,
                "email": False,
            },
        )
        fields = self.wait_for_target(page)

        self.assertEqual(fields, [(page, field)])

    def test_wait_finds_semantic_role_textbox_in_shadow_root(self):
        field = FakeElement(attrs={"role": "textbox", "aria-label": "Verification code"})
        shadow_root = FakePage({"css:[role='textbox']": [field]})
        page = FakePage(
            shadow_roots=[shadow_root],
            state={"twofa": True, "trusted": False, "error": False},
        )

        fields = self.wait_for_target(page)

        self.assertEqual(fields, [(page, field)])
        self.assertEqual(page.shadow_roots_calls, [("all", False)])

    def test_wait_rediscovers_frame_after_a_stale_iteration(self):
        field = FakeElement(
            attrs={
                "contenteditable": "true",
                "aria-label": "Security code",
            }
        )
        shadow_root = FakePage({"css:[contenteditable='true']": [field]})
        frame = FakePage(
            shadow_roots=[shadow_root],
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "trusted": False,
                "error": False,
            },
        )
        page = FakePage(
            frame_results=[RuntimeError("stale browsing context"), [frame]],
            state={"twofa": False, "trusted": False, "error": False},
        )
        frame.parent = page

        fields = self.wait_for_target(page, timeout_s=0.05)

        self.assertEqual(fields, [(frame, field)])
        self.assertGreaterEqual(page.get_frames_calls, 2)
        self.assertEqual(frame.shadow_roots_calls, [("all", False)])

    def test_shadow_enumeration_failure_keeps_ordinary_scope_available(self):
        field = FakeElement(attrs={"aria-label": "One-time verification code"})
        page = FakePage(
            {"css:input": [field]},
            state={"twofa": True, "trusted": False, "error": False},
            shadow_error=RuntimeError("shadow serialization unavailable"),
        )

        fields = self.wait_for_target(page)

        self.assertEqual(fields, [(page, field)])
        self.assertEqual(page.shadow_roots_calls, [("all", False)])

    def test_wait_rejects_a_strong_otp_field_in_a_non_apple_frame(self):
        field = FakeElement()
        frame = FakePage(
            {"css:input[autocomplete='one-time-code']": [field]},
            state={
                "href": "https://evil.example/verify",
                "twofa": True,
                "trusted": False,
                "error": False,
            },
        )
        page = FakePage(
            frames=[frame],
            state={"twofa": False, "trusted": False, "error": False},
        )

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "OTP target"):
                account_flow.wait_for_otp_target(page, timeout_s=0.01)

        self.assertEqual(page.actions.calls, [])
        self.assertEqual(frame.actions.calls, [])

    def test_wait_rejects_unrelated_custom_text_targets(self):
        role_field = FakeElement(attrs={"role": "textbox", "aria-label": "Decode value"})
        editable_field = FakeElement(attrs={"contenteditable": "true"})
        shadow_root = FakePage(
            {
                "css:[role='textbox']": [role_field],
                "css:[contenteditable='true']": [editable_field],
            }
        )
        page = FakePage(
            shadow_roots=[shadow_root],
            state={"twofa": True, "trusted": False, "error": False},
        )

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "OTP target"):
                account_flow.wait_for_otp_target(page, timeout_s=0.01)

        self.assertEqual(page.actions.calls, [])
        self.assertEqual(shadow_root.actions.calls, [])

    def test_security_question_fields_are_not_otp_targets_or_typed(self):
        cases = (
            ("aria-label", "Security answer"),
            ("name", "securityQuestion"),
            ("placeholder", "Security question"),
        )
        for attribute, value in cases:
            with self.subTest(attribute=attribute):
                field = FakeElement(attrs={attribute: value})
                page = FakePage(
                    {"css:input": [field]},
                    state={
                        "href": "https://idmsa.apple.com/appleauth/auth/signin",
                        "twofa": False,
                    },
                )

                semantic = account_flow.element_has_otp_semantics(field)
                fields = account_flow.security_code_fields(page)
                error = None
                try:
                    fill_security_code(
                        page,
                        "123456",
                        FakeKeys,
                        pause=lambda *_: None,
                    )
                except RuntimeError as exc:
                    error = exc

                self.assertFalse(semantic)
                self.assertEqual(fields, [])
                self.assertEqual(
                    str(error),
                    "2FA code input was not detected; refusing unfocused typing",
                )
                self.assertEqual(field.value, "")
                self.assertEqual(page.actions.calls, [])

    def test_verification_method_radio_is_never_an_otp_target(self):
        ordinary_radio = FakeElement(
            attrs={
                "type": "radio",
                "name": "verificationMethod",
                "tagName": "INPUT",
            }
        )
        ordinary_page = FakePage(
            {"css:input": [ordinary_radio]},
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "twofa": True,
            },
        )
        shadow_radio = FakeElement(
            attrs={
                "type": "radio",
                "name": "verificationMethod",
                "tagName": "INPUT",
            }
        )
        shadow_root = FakePage({"css:input": [shadow_radio]})
        shadow_page = FakePage(
            shadow_roots=[shadow_root],
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "twofa": True,
            },
        )

        for label, page, radio in (
            ("ordinary", ordinary_page, ordinary_radio),
            ("shadow", shadow_page, shadow_radio),
        ):
            with self.subTest(scope=label):
                self.assertEqual(account_flow.security_code_fields(page), [])
                with self.assertRaisesRegex(RuntimeError, "2FA code input"):
                    fill_security_code(
                        page,
                        "123456",
                        FakeKeys,
                        pause=lambda *_: None,
                    )
                self.assertEqual(radio.value, "")
                self.assertEqual(page.actions.calls, [])

    def test_verification_method_radio_does_not_mark_ordinary_state(self):
        class RadioOnlyStateScope:
            def __init__(self):
                self.script = ""

            def run_js(self, script):
                self.script = script
                guarded = "isEditableTextInput" in script
                return serialize_scope_state(
                    {
                        "href": "https://idmsa.apple.com/appleauth/auth/verify",
                        "twofa": False,
                        "semanticTargetCount": 0 if guarded else 1,
                    }
                )

        state_scope = RadioOnlyStateScope()
        self.assertFalse(account_flow.detect_scope_login_state(state_scope)["twofa"])
        self.assertIn("isEditableTextInput", state_scope.script)

    def test_verification_method_radio_does_not_mark_shadow_state(self):
        class RadioOnlyShadowRoot:
            def __init__(self):
                self.script = ""

            def run_js(self, script):
                self.script = script
                guarded = "isEditableTextInput" in script
                return json.dumps(
                    {
                        "hasStrongText": False,
                        "semanticTargetCount": 0 if guarded else 1,
                        "digitCellCount": 0,
                    }
                )

        marker_root = RadioOnlyShadowRoot()
        self.assertFalse(account_flow.shadow_root_has_two_factor_marker(marker_root))
        self.assertIn("isEditableTextInput", marker_root.script)

    def test_verification_method_radio_does_not_validate_submit_prompt(self):
        class RadioOnlyPromptButton:
            def __init__(self):
                self.script = ""

            def run_js(self, script):
                self.script = script
                return "isEditableTextInput" not in script

        prompt_button = RadioOnlyPromptButton()
        self.assertFalse(
            account_flow.button_has_prompt_semantics(prompt_button, "twofa")
        )
        self.assertIn("isEditableTextInput", prompt_button.script)

    def test_explicit_otp_semantics_remain_supported(self):
        values = (
            "one-time token",
            "verification",
            "OTP",
            "passcode",
            "code",
            "security code",
        )
        for value in values:
            with self.subTest(value=value):
                field = FakeElement(attrs={"aria-label": value})

                self.assertTrue(account_flow.element_has_otp_semantics(field))

    def test_wait_rejects_six_unrelated_role_textboxes(self):
        fields = [FakeElement(attrs={"role": "textbox"}) for _ in range(6)]
        shadow_root = FakePage({"css:[role='textbox']": fields})
        page = FakePage(
            shadow_roots=[shadow_root],
            state={"twofa": True, "trusted": False, "error": False},
        )

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "OTP target"):
                account_flow.wait_for_otp_target(page, timeout_s=0.01)
        self.assertEqual(page.actions.calls, [])

    def test_wait_rejects_two_one_time_code_fields_split_across_shadow_roots(self):
        first = FakeElement(attrs={"autocomplete": "one-time-code"})
        second = FakeElement(attrs={"autocomplete": "one-time-code"})
        page = FakePage(
            shadow_roots=[
                FakePage({"css:input[autocomplete='one-time-code']": [first]}),
                FakePage({"css:input[autocomplete='one-time-code']": [second]}),
            ],
            state={"twofa": True, "trusted": False, "error": False},
        )

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "OTP target"):
                account_flow.wait_for_otp_target(page, timeout_s=0.01)

    def test_wait_rejects_two_otp_targets_split_across_apple_iframes(self):
        first = FakeElement(attrs={"autocomplete": "one-time-code"})
        second = FakeElement(attrs={"autocomplete": "one-time-code"})
        first_frame = FakePage(
            {"css:input[autocomplete='one-time-code']": [first]},
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/first",
                "twofa": True,
            },
        )
        second_frame = FakePage(
            {"css:input[autocomplete='one-time-code']": [second]},
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/second",
                "twofa": True,
            },
        )
        page = FakePage(
            frames=[first_frame, second_frame],
            state={"href": "https://account.apple.com/sign-in", "twofa": False},
        )

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "OTP target"):
                account_flow.wait_for_otp_target(page, timeout_s=0.01)

        self.assertEqual(page.actions.calls, [])
        self.assertEqual(first_frame.actions.calls, [])
        self.assertEqual(second_frame.actions.calls, [])

    def test_wait_deduplicates_wrappers_through_public_equality_and_hash(self):
        shared_id = "otp-shared"
        first = FakeElement(
            attrs={"autocomplete": "one-time-code"},
            shared_id=shared_id,
        )
        second = FakeElement(
            attrs={"autocomplete": "one-time-code"},
            shared_id=shared_id,
        )
        page = FakePage(
            {
                "css:input[autocomplete='one-time-code']": [first],
                "css:.security-code-input input": [second],
            },
            state={"twofa": True, "trusted": False, "error": False},
        )

        fields = self.wait_for_target(page)

        self.assertEqual(len(fields), 1)
        self.assertIs(fields[0][0], page)
        self.assertIs(fields[0][1], first)
        self.assertEqual(first, second)
        self.assertEqual(hash(first), hash(second))
        self.assertFalse(hasattr(first, "_shared_id"))

    def test_wait_rejects_distinct_shared_ids_as_two_targets(self):
        first = FakeElement(
            attrs={"autocomplete": "one-time-code"},
            shared_id="otp-1",
        )
        second = FakeElement(
            attrs={"autocomplete": "one-time-code"},
            shared_id="otp-2",
        )
        page = FakePage(
            {
                "css:input[autocomplete='one-time-code']": [first],
                "css:.security-code-input input": [second],
            },
            state={"twofa": True, "trusted": False, "error": False},
        )

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "OTP target"):
                account_flow.wait_for_otp_target(page, timeout_s=0.01)

    def test_wait_rejects_stale_and_aria_disabled_elements(self):
        class StaleStates:
            @property
            def is_displayed(self):
                raise RuntimeError("stale")

        stale = FakeElement(attrs={"autocomplete": "one-time-code"})
        stale.states = StaleStates()
        disabled = FakeElement(
            attrs={"autocomplete": "one-time-code", "aria-disabled": "true"}
        )
        page = FakePage(
            {"css:input[autocomplete='one-time-code']": [stale, disabled]},
            state={"twofa": True, "trusted": False, "error": False},
        )

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "OTP target"):
                account_flow.wait_for_otp_target(page, timeout_s=0.01)

    def test_wait_rejects_seven_strong_digit_fields(self):
        fields = [FakeElement() for _ in range(7)]
        page = FakePage(
            {"css:input[maxlength='1']": fields},
            state={"twofa": True, "trusted": False, "error": False},
        )

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "OTP target"):
                account_flow.wait_for_otp_target(page, timeout_s=0.01)

        self.assertEqual(page.actions.calls, [])


class SecurityCodeTests(unittest.TestCase):
    def test_rejects_supplied_target_counts_other_than_one_or_six_without_input(self):
        page = FakePage(state={"twofa": True, "trusted": False, "error": False})
        fields = [(page, FakeElement()), (page, FakeElement())]

        with self.assertRaisesRegex(RuntimeError, "one or six"):
            fill_security_code(
                page,
                "123456",
                FakeKeys,
                pause=lambda *_: None,
                fields=fields,
            )

        self.assertEqual(page.actions.calls, [])

    def test_fills_single_contenteditable_target_through_trusted_actions(self):
        field = FakeElement(
            attrs={"contenteditable": "true", "aria-label": "Verification code"}
        )
        shadow_root = FakePage({"css:[contenteditable='true']": [field]})
        page = FakePage(
            shadow_roots=[shadow_root],
            state={"twofa": True, "trusted": False, "error": False},
        )

        fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual(field.value, "123456")
        self.assertEqual(field.inputs, [])
        self.assertEqual(field.clicks, 0)
        self.assertIn(("human_click", field), page.actions.calls)
        self.assertIn(("type", "123456", page.actions.calls[-2][2]), page.actions.calls)

    def test_fills_six_role_textboxes_through_trusted_actions(self):
        fields = [
            FakeElement(
                attrs={
                    "role": "textbox",
                    "maxlength": "1",
                    "aria-label": f"Verification code digit {index + 1}",
                }
            )
            for index in range(6)
        ]
        shadow_root = FakePage({"css:[role='textbox']": fields})
        page = FakePage(
            shadow_roots=[shadow_root],
            state={"twofa": True, "trusted": False, "error": False},
        )

        fill_security_code(page, "654321", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.value for field in fields], list("654321"))
        self.assertTrue(all(not field.inputs for field in fields))
        self.assertTrue(all(field.clicks == 0 for field in fields))
        self.assertEqual(
            len([call for call in page.actions.calls if call[0] == "human_click"]),
            6,
        )

    def test_fills_six_visible_digit_fields_individually(self):
        fields = [
            FakeElement(location={"x": 20 + index * 45, "y": 30})
            for index in range(6)
        ]
        frame = FakePage({"css:input[maxlength='1']": fields})
        iframe = FakeElement(
            attrs={"src": frame.state["href"]},
            location={"x": 100, "y": 200},
        )
        page = FakePage(
            {"css:iframe": [iframe]},
            frames=[frame],
            actions=FakeActions(coordinate_target=fields),
        )
        frame.parent = page

        fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.value for field in fields], list("123456"))
        self.assertTrue(all(not field.inputs for field in fields))
        self.assertTrue(all(field.clicks == 0 for field in fields))
        self.assertEqual(frame.actions.calls, [])
        self.assertEqual(
            len([call for call in page.actions.calls if call[0] == "human_click"]),
            6,
        )

    def test_ignores_outer_single_character_noise_before_six_digit_frame(self):
        outer_noise = FakeElement()
        fields = [
            FakeElement(location={"x": 20 + index * 45, "y": 30})
            for index in range(6)
        ]
        frame = FakePage({"css:input[maxlength='1']": fields})
        iframe = FakeElement(
            attrs={"src": frame.state["href"]},
            location={"x": 100, "y": 200},
        )
        page = FakePage(
            {
                "css:input[maxlength='1']": [outer_noise],
                "css:iframe": [iframe],
            },
            frames=[frame],
            actions=FakeActions(coordinate_target=fields),
        )
        frame.parent = page

        fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual(outer_noise.clicks, 0)
        self.assertEqual([field.value for field in fields], list("123456"))

    def test_fills_one_time_code_field_as_a_single_value(self):
        field = FakeElement()
        page = FakePage({"css:input[autocomplete='one-time-code']": [field]})

        fill_security_code(page, "654321", FakeKeys, pause=lambda *_: None)

        self.assertEqual(field.value, "654321")
        self.assertEqual(field.inputs, [])
        self.assertEqual(field.clicks, 0)
        self.assertIn(("human_click", field), page.actions.calls)

    def test_refuses_to_type_without_a_detected_code_field(self):
        with self.assertRaisesRegex(RuntimeError, "2FA code input"):
            fill_security_code(FakePage(), "123456", FakeKeys, pause=lambda *_: None)

    def test_refuses_a_single_generic_numeric_field(self):
        field = FakeElement()
        page = FakePage({"css:input[inputmode='numeric']": [field]})

        with self.assertRaisesRegex(RuntimeError, "2FA code input"):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

    def test_refuses_a_single_generic_maxlength_one_field(self):
        field = FakeElement()
        page = FakePage({"css:input[maxlength='1']": [field]})

        with self.assertRaisesRegex(RuntimeError, "2FA code input"):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

    def test_rejects_codes_with_more_than_six_digits(self):
        field = FakeElement()
        page = FakePage({"css:input[autocomplete='one-time-code']": [field]})

        with self.assertRaisesRegex(RuntimeError, "exactly six digits"):
            fill_security_code(page, "1234567", FakeKeys, pause=lambda *_: None)

        self.assertEqual(field.clicks, 0)
        self.assertEqual(field.inputs, [])


class TrustBrowserTests(unittest.TestCase):
    def test_clicks_only_a_matching_trust_button(self):
        cancel = FakeElement("Cancel")
        trust = FakeElement("Trust this browser")
        page = FakePage(
            buttons=[cancel, trust],
            state={"trustPrompt": True},
        )

        clicked = click_trust_browser(
            page,
            pause=lambda *_: None,
        )

        self.assertTrue(clicked)
        self.assertEqual(cancel.clicks, 0)
        self.assertEqual(trust.clicks, 0)
        self.assertIn(("human_click", trust), page.actions.calls)

    def test_trust_skips_unrelated_continue_outside_prompt_container(self):
        unrelated_continue = FakeElement(
            "Continue",
            prompt_semantics={"trust": False},
        )
        prompt_continue = FakeElement(
            "Continue",
            prompt_semantics={"trust": True},
        )
        page = FakePage(
            buttons=[unrelated_continue, prompt_continue],
            state={"trustPrompt": True},
        )

        self.assertTrue(click_trust_browser(page, pause=lambda *_: None))

        self.assertNotIn(("human_click", unrelated_continue), page.actions.calls)
        self.assertIn(("human_click", prompt_continue), page.actions.calls)

    def test_trust_clicks_shadow_button_through_its_owner_scope(self):
        trust = FakeElement(
            "Trust this browser",
            prompt_semantics={"trust": True},
        )
        shadow_root = FakePage(buttons=[trust])
        page = FakePage(
            shadow_roots=[shadow_root],
            state={"trustPrompt": False},
        )

        self.assertTrue(click_trust_browser(page, pause=lambda *_: None))

        self.assertEqual(page.shadow_roots_calls, [("all", False)])
        self.assertIn(("human_click", trust), page.actions.calls)
        self.assertEqual(shadow_root.actions.calls, [])

    def test_never_clicks_a_dont_trust_button(self):
        reject = FakeElement("Don't Trust")
        trust = FakeElement("Trust")
        page = FakePage(
            buttons=[reject, trust],
            state={"trustPrompt": True},
        )

        clicked = click_trust_browser(
            page,
            pause=lambda *_: None,
        )

        self.assertTrue(clicked)
        self.assertEqual(reject.clicks, 0)
        self.assertEqual(trust.clicks, 0)
        self.assertNotIn(("human_click", reject), page.actions.calls)
        self.assertIn(("human_click", trust), page.actions.calls)

    def test_two_factor_submit_clicks_only_a_matching_button_in_its_frame(self):
        cancel = FakeElement("Cancel")
        unrelated_continue = FakeElement("Continue")
        verify = FakeElement("Verify")
        frame = FakePage(buttons=[verify], state={"twofa": True, "codeInputCount": 6})
        page = FakePage(
            buttons=[cancel, unrelated_continue],
            frames=[frame],
            state={"twofa": False, "codeInputCount": 0},
        )

        clicked = click_two_factor_submit(page, pause=lambda *_: None)

        self.assertTrue(clicked)
        self.assertEqual(cancel.clicks, 0)
        self.assertEqual(unrelated_continue.clicks, 0)
        self.assertEqual(verify.clicks, 0)
        self.assertIn(("human_click", verify), frame.actions.calls)

    def test_two_factor_submit_skips_unrelated_continue_outside_prompt_container(self):
        unrelated_continue = FakeElement(
            "Continue",
            prompt_semantics={"twofa": False},
        )
        verify = FakeElement(
            "Verify",
            prompt_semantics={"twofa": True},
        )
        page = FakePage(
            buttons=[unrelated_continue, verify],
            state={"twofa": True, "codeInputCount": 1},
        )

        self.assertTrue(click_two_factor_submit(page, pause=lambda *_: None))

        self.assertNotIn(("human_click", unrelated_continue), page.actions.calls)
        self.assertIn(("human_click", verify), page.actions.calls)

    def test_two_factor_submit_clicks_frame_shadow_button_through_owner_scope(self):
        verify = FakeElement("Verify", prompt_semantics={"twofa": True})
        shadow_root = FakePage(buttons=[verify])
        frame = FakePage(
            shadow_roots=[shadow_root],
            state={"twofa": False, "codeInputCount": 0},
        )
        page = FakePage(
            frames=[frame],
            state={"twofa": False, "codeInputCount": 0},
        )
        frame.parent = page

        self.assertTrue(click_two_factor_submit(page, pause=lambda *_: None))

        self.assertEqual(frame.shadow_roots_calls, [("all", False)])
        self.assertIn(("human_click", verify), frame.actions.calls)
        self.assertEqual(page.actions.calls, [])
        self.assertEqual(shadow_root.actions.calls, [])

    def test_trust_click_stays_inside_the_detected_prompt_frame(self):
        unrelated_continue = FakeElement("Continue")
        trust = FakeElement("Trust")
        frame = FakePage(buttons=[trust], state={"trustPrompt": True})
        page = FakePage(
            buttons=[unrelated_continue],
            frames=[frame],
            state={"trustPrompt": False},
        )

        clicked = click_trust_browser(page, pause=lambda *_: None)

        self.assertTrue(clicked)
        self.assertEqual(unrelated_continue.clicks, 0)
        self.assertEqual(trust.clicks, 0)
        self.assertNotIn(("human_click", unrelated_continue), page.actions.calls)
        self.assertIn(("human_click", trust), frame.actions.calls)

    def test_trust_click_rejects_a_non_apple_prompt_frame(self):
        trust = FakeElement("Trust")
        frame = FakePage(
            buttons=[trust],
            state={
                "href": "https://evil.example/trust",
                "trustPrompt": True,
            },
        )

        clicked = click_trust_browser(FakePage(frames=[frame]), pause=lambda *_: None)

        self.assertFalse(clicked)
        self.assertEqual(trust.clicks, 0)

    def test_two_factor_submit_rejects_a_non_apple_frame(self):
        verify = FakeElement("Verify")
        frame = FakePage(
            buttons=[verify],
            state={
                "href": "https://evil.example/verify",
                "twofa": True,
                "codeInputCount": 1,
            },
        )

        clicked = click_two_factor_submit(FakePage(frames=[frame]), pause=lambda *_: None)

        self.assertFalse(clicked)
        self.assertEqual(verify.clicks, 0)

    def test_signed_in_wait_handles_a_shadow_only_trust_prompt(self):
        trust = FakeElement(
            "Trust this browser",
            prompt_semantics={"trust": True},
        )
        shadow_root = FakePage(buttons=[trust])
        page = FakePage(
            shadow_roots=[shadow_root],
            state={
                "trustPrompt": False,
                "twofa": False,
                "trusted": False,
                "error": False,
                "password": False,
                "email": False,
            },
        )

        def mark_signed_in():
            page.state.update(
                {
                    "href": "https://account.apple.com/account/manage",
                    "trusted": True,
                    "accountMarker": True,
                }
            )
            page._shadow_roots = []

        trust.on_click = mark_signed_in

        def click_without_pause(current_page, **_kwargs):
            return click_trust_browser(current_page, pause=lambda *_: None)

        with patch(
            "apple_account_flow.click_trust_browser",
            side_effect=click_without_pause,
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            try:
                state = wait_for_signed_in(page, timeout_s=0.05)
            except RuntimeError as exc:
                self.fail(f"shadow-only Trust prompt was not handled: {exc}")

        self.assertTrue(state["trusted"])
        self.assertIn(("human_click", trust), page.actions.calls)
        self.assertEqual(shadow_root.actions.calls, [])

    def test_signed_in_wait_handles_shadow_trust_before_accepting_manage_shell(self):
        trust = FakeElement(
            "Trust this browser",
            prompt_semantics={"trust": True},
        )
        shadow_root = FakePage(buttons=[trust])
        page = FakePage(
            shadow_roots=[shadow_root],
            state={
                "href": "https://account.apple.com/account/manage",
                "accountMarker": True,
                "trustPrompt": False,
                "twofa": False,
                "error": False,
                "password": False,
                "email": False,
            },
        )
        trust.on_click = lambda: setattr(page, "_shadow_roots", [])

        def click_without_pause(current_page, **_kwargs):
            return click_trust_browser(current_page, pause=lambda *_: None)

        with patch(
            "apple_account_flow.click_trust_browser",
            side_effect=click_without_pause,
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_signed_in(page, timeout_s=0.05)

        self.assertTrue(state["trusted"])
        self.assertIn(("human_click", trust), page.actions.calls)
        self.assertEqual(page._shadow_roots, [])
        self.assertEqual(shadow_root.actions.calls, [])

    def test_two_factor_wait_handles_shadow_trust_before_accepting_manage_shell(self):
        trust = FakeElement(
            "Trust this browser",
            prompt_semantics={"trust": True},
        )
        shadow_root = FakePage(buttons=[trust])
        page = FakePage(
            shadow_roots=[shadow_root],
            state={
                "href": "https://account.apple.com/account/manage",
                "accountMarker": True,
                "trustPrompt": False,
                "twofa": False,
                "error": False,
                "password": False,
                "email": False,
            },
        )
        trust.on_click = lambda: setattr(page, "_shadow_roots", [])

        def click_without_pause(current_page, **_kwargs):
            return click_trust_browser(current_page, pause=lambda *_: None)

        with patch(
            "apple_account_flow.click_trust_browser",
            side_effect=click_without_pause,
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_2fa_or_session(page, timeout_s=0.05)

        self.assertTrue(state["trusted"])
        self.assertIn(("human_click", trust), page.actions.calls)

    def test_explicit_trust_prompt_allows_button_hydration_before_failing(self):
        page = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "trustPrompt": True,
                "twofa": False,
                "trusted": False,
                "error": False,
            }
        )
        scans = []

        def hydrated_on_second_scan(_page, **_kwargs):
            scans.append(len(scans) + 1)
            if len(scans) < 2:
                return False
            if len(scans) == 2:
                page.state.update(
                    {
                        "href": "https://account.apple.com/account/manage",
                        "accountMarker": True,
                        "trustPrompt": False,
                    }
                )
                return True
            return False

        with patch(
            "apple_account_flow.click_trust_browser",
            side_effect=hydrated_on_second_scan,
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_signed_in(page, timeout_s=0.05)

        self.assertTrue(state["trusted"])
        self.assertGreaterEqual(len(scans), 2)

    def test_shadow_trust_prompt_hydrates_before_manage_shell_is_accepted(self):
        shadow_root = FakePage(
            state={
                "shadowEvidence": {
                    "hasStrongText": False,
                    "semanticTargetCount": 0,
                    "digitCellCount": 0,
                    "trustPrompt": True,
                    "otpRejected": False,
                    "blocked": False,
                    "error": False,
                }
            }
        )
        page = FakePage(
            shadow_roots=[shadow_root],
            state={
                "href": "https://account.apple.com/account/manage",
                "accountMarker": True,
                "trustPrompt": False,
                "twofa": False,
                "error": False,
            },
        )
        scans = []

        def hydrate_on_second_scan(_page, **_kwargs):
            scans.append(len(scans) + 1)
            if len(scans) == 2:
                page._shadow_roots = []
                return True
            return False

        with patch(
            "apple_account_flow.click_trust_browser",
            side_effect=hydrate_on_second_scan,
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_signed_in(page, timeout_s=0.05)

        self.assertTrue(state["trusted"])
        self.assertGreaterEqual(len(scans), 2)

    def test_explicit_trust_prompt_is_rescanned_until_hydration_deadline(self):
        page = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "trustPrompt": True,
                "twofa": False,
                "trusted": False,
                "error": False,
            }
        )

        with patch(
            "apple_account_flow.click_trust_browser",
            return_value=False,
        ) as scan, patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "trust-browser prompt"):
                wait_for_signed_in(page, timeout_s=0.01)

        self.assertGreater(scan.call_count, 1)

    def test_a_nonsettling_trust_click_cannot_reset_the_hydration_deadline(self):
        state = {
            "href": "https://idmsa.apple.com/appleauth/auth/verify",
            "trustPrompt": True,
            "twofa": False,
            "trusted": False,
            "error": False,
        }

        with patch(
            "apple_account_flow.click_trust_browser",
            side_effect=[True, AssertionError("Trust click escaped its deadline")],
        ), patch("apple_account_flow.detect_login_state", return_value=state):
            with self.assertRaisesRegex(RuntimeError, "trust-browser prompt"):
                account_flow.settle_trust_state(
                    FakePage(),
                    state,
                    deadline=0,
                    pause=lambda *_: None,
                )

    def test_shadow_trust_cannot_be_clicked_again_after_deadline_when_state_omits_prompt(self):
        initial_state = {
            "href": "https://idmsa.apple.com/appleauth/auth/verify",
            "trustPrompt": False,
            "twofa": False,
            "trusted": False,
            "error": False,
        }
        post_click_state = dict(initial_state)

        with patch(
            "apple_account_flow.click_trust_browser",
            side_effect=[True, AssertionError("Trust was clicked after its deadline")],
        ) as click_trust, patch(
            "apple_account_flow.detect_login_state",
            return_value=post_click_state,
        ), patch(
            "apple_account_flow.time.monotonic",
            side_effect=[0.0, 1.0],
        ):
            with self.assertRaisesRegex(RuntimeError, "trust-browser state did not settle"):
                account_flow.settle_trust_state(
                    FakePage(),
                    initial_state,
                    deadline=0.5,
                    hydration_timeout_s=5.0,
                    pause=lambda *_: None,
                )

        click_trust.assert_called_once()

    def test_session_error_stops_before_shadow_trust_scan(self):
        page = FakePage(
            state={
                "href": "https://account.apple.com/account/manage",
                "accountMarker": True,
                "trustPrompt": True,
                "error": True,
            }
        )

        with patch("apple_account_flow.click_trust_browser") as scan:
            with self.assertRaisesRegex(RuntimeError, "failed"):
                wait_for_signed_in(page, timeout_s=0.05)

        scan.assert_not_called()

    def test_signed_in_wait_submits_two_factor_only_once(self):
        verify = FakeElement("Verify")
        page = FakePage(
            buttons=[verify],
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "twofa": True,
                "trustPrompt": False,
                "error": False,
                "trusted": False,
                "password": False,
                "email": False,
                "codeInputCount": 1,
                "snippet": "Verification code",
            },
        )
        states = [
            page.state,
            page.state,
            {
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "trusted": True,
                "accountMarker": True,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "Personal Information",
            },
        ]

        def next_state(_script):
            if len(states) > 1:
                return serialize_scope_state(states.pop(0))
            return serialize_scope_state(states[0])

        page.run_js = next_state
        with patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_signed_in(page, timeout_s=1)

        self.assertTrue(state["trusted"])
        self.assertEqual(verify.clicks, 0)
        self.assertIn(("human_click", verify), page.actions.calls)

    def test_signed_in_wait_does_not_resubmit_an_already_submitted_code(self):
        verify = FakeElement("Verify")
        page = FakePage(
            buttons=[verify],
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "twofa": True,
                "trustPrompt": False,
                "error": False,
                "trusted": False,
                "password": False,
                "email": False,
                "codeInputCount": 1,
                "snippet": "Verification code",
            },
        )
        states = [
            page.state,
            {
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "trusted": True,
                "accountMarker": True,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "Personal Information",
            },
        ]

        def next_state(_script):
            if len(states) > 1:
                return serialize_scope_state(states.pop(0))
            return serialize_scope_state(states[0])

        page.run_js = next_state
        with patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_signed_in(page, timeout_s=1, submitted=True)

        self.assertTrue(state["trusted"])
        self.assertEqual(verify.clicks, 0)


class RememberAccountTests(unittest.TestCase):
    def test_checks_remember_account_and_verifies_state(self):
        field = FakeElement()
        field.on_click = lambda: setattr(field.states, "is_checked", True)
        page = FakePage({"css:#remember-me": [field]})

        self.assertTrue(ensure_remember_checked(page, pause=lambda *_: None))
        self.assertEqual(field.clicks, 0)
        self.assertIn(("human_click", field), page.actions.calls)

    def test_remember_progress_records_checked_state(self):
        field = FakeElement()
        field.on_click = lambda: setattr(field.states, "is_checked", True)
        page = FakePage({"css:#remember-me": [field]})

        with patch("apple_account_flow.emit") as emit_event:
            self.assertTrue(ensure_remember_checked(page, pause=lambda *_: None))

        events = [call.args[0] for call in emit_event.call_args_list]
        self.assertEqual(
            [event["step"] for event in events],
            ["search_started", "target_found", "click_started", "checked"],
        )
        self.assertEqual(events[2]["route"], "root")

    def test_clicks_hidden_custom_checkbox_label_through_root_context(self):
        checkbox = FakeElement(displayed=False)
        label = FakeElement(
            on_click=lambda: setattr(checkbox.states, "is_checked", True),
            location={"x": 20, "y": 30},
            size={"width": 100, "height": 30},
        )
        frame = FakePage(
            {
                "css:#remember-me": [checkbox],
                "css:#remember-me-label": [label],
            }
        )
        iframe = FakeElement(
            attrs={"src": frame.state["href"]},
            location={"x": 100, "y": 200},
        )
        root = FakePage(
            {"css:iframe": [iframe]},
            frames=[frame],
            actions=FakeActions(coordinate_target=label),
        )
        frame.parent = root

        self.assertTrue(
            ensure_remember_checked(root, pause=lambda *_: None)
        )
        self.assertEqual(checkbox.clicks, 0)
        self.assertEqual(frame.actions.calls, [])
        self.assertIn(("human_click", {"x": 170, "y": 245}), root.actions.calls)

    def test_iframe_remember_scrolls_target_and_host_before_recomputing_coordinates(self):
        checkbox = FakeElement(
            location={"x": 20, "y": 4000},
            size={"width": 100, "height": 30},
            on_scroll=lambda: setattr(
                checkbox,
                "location",
                {"x": 20, "y": 100},
            ),
        )
        checkbox.on_click = lambda: setattr(checkbox.states, "is_checked", True)
        frame = FakePage(
            {"css:#remember-me": [checkbox]},
            state={"href": "https://idmsa.apple.com/appleauth/auth/signin"},
        )
        iframe = FakeElement(
            attrs={"src": frame.state["href"]},
            location={"x": 0, "y": 0},
            on_scroll=lambda: setattr(
                iframe,
                "location",
                {"x": 100, "y": 300},
            ),
        )
        root = FakePage(
            {"css:iframe": [iframe]},
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
            actions=FakeActions(coordinate_target=checkbox),
        )
        frame.parent = root

        self.assertTrue(ensure_remember_checked(root, pause=lambda *_: None))

        self.assertEqual(checkbox.scroll.calls, [("to_see",)])
        self.assertEqual(iframe.scroll.calls, [("to_see",)])
        self.assertIn(("human_click", {"x": 170, "y": 415}), root.actions.calls)
        self.assertNotIn(("human_click", {"x": 70, "y": 4015}), root.actions.calls)

    def test_refuses_to_continue_when_checkbox_is_missing(self):
        with self.assertRaisesRegex(RuntimeError, "remember-account checkbox"):
            ensure_remember_checked(FakePage(), pause=lambda *_: None)

    def test_does_not_treat_an_unidentified_checkbox_as_remember_account(self):
        unrelated = FakeElement()
        page = FakePage({"css:input[type='checkbox']": [unrelated]})

        with self.assertRaisesRegex(RuntimeError, "remember-account checkbox"):
            ensure_remember_checked(page, pause=lambda *_: None)

        self.assertEqual(unrelated.clicks, 0)

    def test_refuses_a_remember_checkbox_in_a_non_apple_frame(self):
        field = FakeElement()
        field.on_click = lambda: setattr(field.states, "is_checked", True)
        frame = FakePage(
            {"css:#remember-me": [field]},
            state={"href": "https://evil.example/sign-in"},
        )

        with self.assertRaisesRegex(RuntimeError, "Apple HTTPS"):
            ensure_remember_checked(FakePage(frames=[frame]), pause=lambda *_: None)

        self.assertEqual(field.clicks, 0)


class FrameLocationTests(unittest.TestCase):
    def test_finds_interactable_element_inside_nested_frame(self):
        hidden = FakeElement(displayed=False)
        target = FakeElement()
        nested = FakePage({"css:#target": [target]})
        frame = FakePage({"css:#target": [hidden]}, frames=[nested])

        self.assertIs(find_first_element(FakePage(frames=[frame]), ("css:#target",)), target)

    def test_finds_credential_element_inside_frame_shadow_root(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin"
        password = FakeElement(attrs={"type": "password"})
        shadow_root = FakePage({"css:input[type='password']": [password]})
        frame = FakePage(
            shadow_roots=[shadow_root],
            state={"href": auth_url},
        )
        iframe = FakeElement(attrs={"src": auth_url})
        page = FakePage(
            {"css:iframe": [iframe]},
            frames=[frame],
            actions=FakeActions(
                apply_typed_text=False,
                coordinate_target=password,
            ),
        )
        frame.parent = page

        found = account_flow.find_first_scoped_element(
            page,
            account_flow.PASSWORD_SELECTORS,
        )

        self.assertEqual(found, (frame, password))
        self.assertEqual(frame.shadow_roots_calls, [("all", False)])
        self.assertIn(("css:input[type='password']", 0), shadow_root.eles_calls)

        action_scope = input_and_verify(
            found[0],
            found[1],
            "test-password",
            "password",
            FakeKeys,
            pause=lambda *_: None,
            root_page=page,
        )

        self.assertIs(action_scope, frame)
        self.assertEqual(password.value, "test-password")

    def test_password_lookup_ignores_a_component_host_with_the_legacy_id(self):
        host = FakeElement(attrs={"tagName": "DIV"})
        password = FakeElement(attrs={"type": "password", "tagName": "INPUT"})
        shadow_root = FakePage(
            {
                "css:#password_text_field": [host],
                "css:input[type='password']": [password],
            }
        )
        page = FakePage(shadow_roots=[shadow_root])

        found = account_flow.find_first_scoped_element(
            page,
            account_flow.PASSWORD_SELECTORS,
        )

        self.assertEqual(found, (page, password))
        self.assertNotIn(("css:#password_text_field", 0), shadow_root.eles_calls)

    def test_finds_credential_element_inside_top_level_shadow_root(self):
        password = FakeElement(attrs={"type": "password"})
        shadow_root = FakePage({"css:input[type='password']": [password]})
        page = FakePage(shadow_roots=[shadow_root])

        found = account_flow.find_first_scoped_element(
            page,
            account_flow.PASSWORD_SELECTORS,
        )

        self.assertEqual(found, (page, password))
        self.assertEqual(page.shadow_roots_calls, [("all", False)])

    def test_hidden_document_credential_does_not_mask_shadow_credential(self):
        hidden = FakeElement(displayed=False, attrs={"type": "password"})
        password = FakeElement(attrs={"type": "password"})
        shadow_root = FakePage({"css:input[type='password']": [password]})
        page = FakePage(
            {"css:input[type='password']": [hidden]},
            shadow_roots=[shadow_root],
        )

        self.assertEqual(
            account_flow.find_first_scoped_element(
                page,
                account_flow.PASSWORD_SELECTORS,
            ),
            (page, password),
        )

    def test_shadow_enumeration_failure_keeps_document_credentials_available(self):
        password = FakeElement(attrs={"type": "password"})
        page = FakePage(
            {"css:input[type='password']": [password]},
            shadow_error=RuntimeError("shadow serialization unavailable"),
        )

        found = account_flow.find_first_scoped_element(
            page,
            account_flow.PASSWORD_SELECTORS,
        )

        self.assertEqual(found, (page, password))
        self.assertIn(("css:input[type='password']", 0), page.eles_calls)

    def test_wait_rediscovers_frame_and_shadow_root_after_navigation(self):
        password = FakeElement(attrs={"type": "password"})
        shadow_root = FakePage({"css:input[type='password']": [password]})
        navigated_frame = FakePage(shadow_roots=[shadow_root])
        page = FakePage(
            frame_results=[RuntimeError("stale browsing context"), [navigated_frame]]
        )
        navigated_frame.parent = page

        with patch("apple_account_flow.human_pause", lambda *_: None):
            found = account_flow.wait_for_element(
                page,
                account_flow.PASSWORD_SELECTORS,
                timeout_s=0.05,
            )

        self.assertEqual(found, (navigated_frame, password))
        self.assertGreaterEqual(page.get_frames_calls, 2)
        self.assertEqual(navigated_frame.shadow_roots_calls, [("all", False)])

    def test_2fa_wait_accepts_code_fields_discovered_inside_frame(self):
        fields = [FakeElement() for _ in range(6)]
        frame = FakePage({"css:input[maxlength='1']": fields})
        page = FakePage(frames=[frame], state={"twofa": False, "codeInputCount": 0})

        with patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_2fa_or_session(page, timeout_s=0.05)

        self.assertEqual(state["codeInputCount"], 6)
        self.assertTrue(state.get("twofaVisible"))
        self.assertTrue(state.get("inputReady"))

    def test_login_state_includes_nested_frame_prompts_and_errors(self):
        frame = FakePage(
            state={
                "href": "https://idmsa.apple.com/frame",
                "twofa": True,
                "trustPrompt": True,
                "error": True,
                "trusted": False,
                "password": False,
                "email": False,
                "codeInputCount": 6,
                "snippet": "Verification code invalid",
            }
        )
        page = FakePage(
            frames=[frame],
            state={
                "href": "https://appleid.apple.com/sign-in",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "trusted": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "",
            },
        )

        state = detect_login_state(page)

        self.assertTrue(state["twofa"])
        self.assertTrue(state["trustPrompt"])
        self.assertTrue(state["error"])
        self.assertEqual(state["codeInputCount"], 6)
        self.assertNotIn("snippet", state)

    def test_manage_shell_with_login_frame_is_not_trusted(self):
        frame = FakePage(
            state={
                "href": "https://idmsa.apple.com/frame",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "trusted": False,
                "accountMarker": False,
                "password": True,
                "email": True,
                "codeInputCount": 0,
                "snippet": "Sign in",
            }
        )
        page = FakePage(
            frames=[frame],
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "trusted": True,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "",
            },
        )

        self.assertFalse(detect_login_state(page)["trusted"])

    def test_manage_shell_with_trust_prompt_frame_is_not_trusted(self):
        frame = FakePage(
            state={
                "href": "https://idmsa.apple.com/frame",
                "twofa": False,
                "trustPrompt": True,
                "error": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "Trust this browser",
            }
        )
        page = FakePage(
            frames=[frame],
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "trusted": True,
                "accountMarker": True,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "Personal Information",
            },
        )

        self.assertFalse(detect_login_state(page)["trusted"])

    def test_manage_shell_with_account_content_frame_is_trusted(self):
        frame = FakePage(
            state={
                "href": "https://account.apple.com/frame",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "trusted": False,
                "accountMarker": True,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "Personal Information",
            }
        )
        page = FakePage(
            frames=[frame],
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "",
            },
        )

        self.assertTrue(detect_login_state(page)["trusted"])

    def test_non_apple_manage_url_is_not_trusted(self):
        page = FakePage(
            state={
                "href": "https://evil.example/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "trusted": True,
                "accountMarker": True,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "Personal Information",
            },
        )

        self.assertFalse(detect_login_state(page)["trusted"])

    def test_non_apple_marker_frame_does_not_trust_account_shell(self):
        frame = FakePage(
            state={
                "href": "https://evil.example/account-content",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "trusted": False,
                "accountMarker": True,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "Personal Information",
            }
        )
        page = FakePage(
            frames=[frame],
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
                "snippet": "",
            },
        )

        self.assertFalse(detect_login_state(page)["trusted"])


class CredentialBoundaryTests(unittest.TestCase):
    def assert_broker_credentials_rejected(self, frame_text):
        with patch.dict(
            os.environ,
            {account_flow.BROWSER_BROKER_MODE_ENV: "1"},
            clear=True,
        ):
            with self.assertRaises(RuntimeError) as raised:
                account_flow.load_browser_credentials(io.StringIO(frame_text))

        self.assertEqual(
            str(raised.exception),
            account_flow.BROWSER_BROKER_CREDENTIALS_ERROR,
        )

    def test_test_module_is_importable_from_repository_root(self):
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        self.assertIn(
            os.path.join(repo_root, "scripts", "ruyipage"),
            [os.path.abspath(path) for path in sys.path],
        )

    def test_accepts_only_https_apple_hosts(self):
        self.assertEqual(
            validate_apple_url("https://appleid.apple.com/sign-in"),
            "https://appleid.apple.com/sign-in",
        )
        self.assertEqual(
            validate_apple_url("https://idmsa.apple.com/appleauth/auth/signin"),
            "https://idmsa.apple.com/appleauth/auth/signin",
        )
        for url in (
            "http://appleid.apple.com/sign-in",
            "https://apple.com.evil.example/sign-in",
            "https://user:pass@appleid.apple.com/sign-in",
            "javascript:alert(1)",
        ):
            with self.subTest(url=url):
                with self.assertRaisesRegex(RuntimeError, "Apple HTTPS"):
                    validate_apple_url(url)

    def test_validates_the_actual_ruyipage_scope_origin(self):
        self.assertEqual(
            validate_apple_scope(
                FakePage(state={"href": "https://idmsa.apple.com/appleauth/auth/signin"})
            ),
            "https://idmsa.apple.com/appleauth/auth/signin",
        )
        with self.assertRaisesRegex(RuntimeError, "Apple HTTPS"):
            validate_apple_scope(FakePage(state={"href": "https://evil.example/sign-in"}))

    def test_pops_credentials_from_environment_before_browser_launch(self):
        with patch.dict(
            os.environ,
            {
                account_flow.BROWSER_BROKER_MODE_ENV: "0",
                "APPLE_ID": "person@example.com",
                "APPLE_PASSWORD": "secret",
            },
            clear=True,
        ):
            apple_id, password = pop_browser_credentials()

            self.assertEqual((apple_id, password), ("person@example.com", "secret"))
            self.assertNotIn("APPLE_ID", os.environ)
            self.assertNotIn("APPLE_PASSWORD", os.environ)

    def test_broker_credentials_frame_is_consumed_once(self):
        next_command = {"type": "2fa_prepared"}
        stream = io.StringIO(
            json.dumps(
                {
                    "type": "credentials",
                    "appleId": "person@example.com",
                    "password": "secret",
                }
            )
            + "\n"
            + json.dumps(next_command)
            + "\n"
        )

        with patch.dict(
            os.environ,
            {account_flow.BROWSER_BROKER_MODE_ENV: "1"},
            clear=True,
        ):
            credentials = account_flow.load_browser_credentials(stream)
            remaining_command = account_flow.read_command(stream)

        self.assertEqual(credentials, ("person@example.com", "secret"))
        self.assertEqual(remaining_command, next_command)

    def test_broker_credentials_reject_wrong_schema_and_types(self):
        invalid_frames = (
            "",
            "not-json\n",
            "[]\n",
            json.dumps({"type": "credentials", "appleId": "person@example.com"}) + "\n",
            json.dumps(
                {
                    "type": "wrong",
                    "appleId": "person@example.com",
                    "password": "secret",
                }
            )
            + "\n",
            json.dumps(
                {"type": "credentials", "appleId": 7, "password": "secret"}
            )
            + "\n",
            json.dumps(
                {
                    "type": "credentials",
                    "appleId": "person@example.com",
                    "password": False,
                }
            )
            + "\n",
            '{"type":"credentials","appleId":"first","appleId":"second","password":"secret"}\n',
        )

        for frame_text in invalid_frames:
            with self.subTest(frame_text=frame_text[:40]):
                self.assert_broker_credentials_rejected(frame_text)

    def test_broker_credentials_reject_extra_fields(self):
        self.assert_broker_credentials_rejected(
            json.dumps(
                {
                    "type": "credentials",
                    "appleId": "person@example.com",
                    "password": "secret",
                    "extra": "not-allowed",
                }
            )
            + "\n"
        )

    def test_broker_credentials_reject_empty_and_overlong_values(self):
        invalid_credentials = (
            ("", "secret"),
            ("   ", "secret"),
            ("person@example.com", ""),
            ("person@example.com", "\t"),
            ("a" * (account_flow.BROKER_APPLE_ID_MAX_LENGTH + 1), "secret"),
            (
                "person@example.com",
                "p" * (account_flow.BROKER_PASSWORD_MAX_LENGTH + 1),
            ),
        )

        for apple_id, password in invalid_credentials:
            with self.subTest(apple_id_length=len(apple_id), password_length=len(password)):
                self.assert_broker_credentials_rejected(
                    json.dumps(
                        {
                            "type": "credentials",
                            "appleId": apple_id,
                            "password": password,
                        }
                    )
                    + "\n"
                )

    def test_broker_mode_uses_complete_environment_without_reading_stdin(self):
        stream = io.StringIO("must remain unread")
        with patch.dict(
            os.environ,
            {
                account_flow.BROWSER_BROKER_MODE_ENV: "1",
                "APPLE_ID": "person@example.com",
                "APPLE_PASSWORD": "secret",
            },
            clear=True,
        ):
            credentials = account_flow.load_browser_credentials(stream)

        self.assertEqual(credentials, ("person@example.com", "secret"))
        self.assertEqual(stream.tell(), 0)

    def test_broker_mode_replaces_partial_environment_from_the_first_frame(self):
        stream = io.StringIO(
            json.dumps(
                {
                    "type": "credentials",
                    "appleId": "person@example.com",
                    "password": "secret",
                }
            )
            + "\n"
        )
        with patch.dict(
            os.environ,
            {
                account_flow.BROWSER_BROKER_MODE_ENV: "1",
                "APPLE_ID": "incomplete-environment-value",
            },
            clear=True,
        ):
            credentials = account_flow.load_browser_credentials(stream)
            self.assertNotIn("APPLE_ID", os.environ)
            self.assertNotIn("APPLE_PASSWORD", os.environ)

        self.assertEqual(credentials, ("person@example.com", "secret"))

    def test_invalid_broker_frame_stops_before_ruyipage_import(self):
        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {account_flow.BROWSER_BROKER_MODE_ENV: "1"},
            clear=True,
        ), patch("apple_account_flow.sys.stdin", io.StringIO("invalid\n")), patch(
            "apple_account_flow.import_ruyipage"
        ) as import_ruyipage:
            with self.assertRaisesRegex(
                RuntimeError,
                f"^{account_flow.BROWSER_BROKER_CREDENTIALS_ERROR}$",
            ):
                browser_flow(args)

        import_ruyipage.assert_not_called()

    def test_command_line_apple_id_is_not_supported(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parse_args(["--apple-id", "person@example.com"])


class BrowserBrokerLaunchTests(unittest.TestCase):
    @staticmethod
    def fake_browser_module(popen):
        runtime_subprocess = type("FakeSubprocess", (), {})()
        runtime_subprocess.Popen = popen
        browser_module = type("FakeBrowserModule", (), {})()
        browser_module.subprocess = runtime_subprocess
        return browser_module, runtime_subprocess

    def test_broker_mode_removes_new_session_only_during_macos_construction(self):
        popen_calls = []

        def original_popen(*args, **kwargs):
            popen_calls.append((args, kwargs))
            return object()

        browser_module, runtime_subprocess = self.fake_browser_module(original_popen)
        page = object()

        def FirefoxPage(opts):
            self.assertEqual(opts, "options")
            self.assertIsNot(runtime_subprocess.Popen, original_popen)
            runtime_subprocess.Popen(["firefox"], start_new_session=True)
            return page

        with patch.dict(
            os.environ,
            {account_flow.BROWSER_BROKER_MODE_ENV: "1"},
            clear=True,
        ), patch.object(sys, "platform", "darwin"), patch(
            "apple_account_flow.importlib.import_module",
            return_value=browser_module,
        ) as import_module:
            result = account_flow.construct_firefox_page(FirefoxPage, "options")

        self.assertIs(result, page)
        import_module.assert_called_once_with("ruyipage._base.browser")
        self.assertNotIn("start_new_session", popen_calls[0][1])
        self.assertIs(runtime_subprocess.Popen, original_popen)

    def test_process_group_patch_is_disabled_outside_broker_macos(self):
        for mode, platform in (("0", "darwin"), ("1", "win32")):
            with self.subTest(mode=mode, platform=platform):
                popen_calls = []

                def original_popen(*args, **kwargs):
                    popen_calls.append((args, kwargs))
                    return object()

                browser_module, runtime_subprocess = self.fake_browser_module(
                    original_popen
                )

                def FirefoxPage(_opts):
                    runtime_subprocess.Popen(
                        ["firefox"],
                        start_new_session=True,
                    )
                    return object()

                with patch.dict(
                    os.environ,
                    {account_flow.BROWSER_BROKER_MODE_ENV: mode},
                    clear=True,
                ), patch.object(sys, "platform", platform), patch(
                    "apple_account_flow.importlib.import_module"
                ) as import_module:
                    account_flow.construct_firefox_page(FirefoxPage, "options")

                import_module.assert_not_called()
                self.assertTrue(popen_calls[0][1]["start_new_session"])
                self.assertIs(runtime_subprocess.Popen, original_popen)

    def test_process_group_patch_is_restored_when_construction_fails(self):
        def original_popen(*_args, **_kwargs):
            raise OSError("launch failed")

        browser_module, runtime_subprocess = self.fake_browser_module(original_popen)

        def FailingFirefoxPage(_opts):
            self.assertIsNot(runtime_subprocess.Popen, original_popen)
            runtime_subprocess.Popen(["firefox"], start_new_session=True)

        with patch.dict(
            os.environ,
            {account_flow.BROWSER_BROKER_MODE_ENV: "1"},
            clear=True,
        ), patch.object(sys, "platform", "darwin"), patch(
            "apple_account_flow.importlib.import_module",
            return_value=browser_module,
        ):
            with self.assertRaisesRegex(OSError, "launch failed"):
                account_flow.construct_firefox_page(FailingFirefoxPage, "options")

        self.assertIs(runtime_subprocess.Popen, original_popen)


class PersonalInformationTests(unittest.TestCase):
    def test_personal_info_ignores_non_apple_frames(self):
        evil_frame = FakePage(
            state={
                "href": "https://evil.example/account",
                "fullName": "Wrong Person",
                "birthday": "2000-01-01",
                "title": "Fake",
            }
        )
        apple_frame = FakePage(
            state={
                "href": "https://account.apple.com/frame",
                "fullName": "Right Person",
                "birthday": None,
                "title": "Apple Account",
            }
        )
        page = FakePage(
            frames=[evil_frame, apple_frame],
            state={
                "href": "https://account.apple.com/account/manage",
                "fullName": None,
                "birthday": None,
                "title": "Apple Account",
            },
        )

        self.assertEqual(collect_personal_info(page)["fullName"], "Right Person")

    def test_personal_info_sanitizes_apple_root_and_iframe_urls(self):
        secret = "SECRET"
        root_page = FakePage(
            state={
                "href": f"https://account.apple.com/account/manage?token={secret}#fragment",
                "fullName": "Root Person",
                "birthday": None,
                "title": "Apple Account",
            }
        )
        evil_frame = FakePage(
            state={
                "href": f"https://evil.example/account?token={secret}#fragment",
                "fullName": "Wrong Person",
                "birthday": "2000-01-01",
                "title": "Fake",
            }
        )
        apple_frame = FakePage(
            state={
                "href": f"https://idmsa.apple.com/appleauth/auth/profile?token={secret}#fragment",
                "fullName": "Frame Person",
                "birthday": None,
                "title": "Apple Account",
            }
        )
        framed_page = FakePage(
            frames=[evil_frame, apple_frame],
            state={
                "href": f"https://evil.example/root?token={secret}#fragment",
                "fullName": "Wrong Root Person",
                "birthday": "1999-01-01",
                "title": "Fake Root",
            },
        )

        cases = (
            (
                "apple root page",
                root_page,
                "Root Person",
                "https://account.apple.com/account/manage",
            ),
            (
                "apple iframe after non-Apple scopes",
                framed_page,
                "Frame Person",
                "https://idmsa.apple.com/appleauth/auth/profile",
            ),
        )
        for label, page, expected_name, expected_href in cases:
            with self.subTest(label=label):
                result = collect_personal_info(page)

                self.assertEqual(result["fullName"], expected_name)
                self.assertEqual(result["href"], expected_href)
                self.assertNotIn(secret, json.dumps(result))

    def test_requires_authenticated_state_and_at_least_one_parsed_field(self):
        with self.assertRaisesRegex(RuntimeError, "authenticated"):
            validate_personal_info_result(
                {"trusted": False},
                {"fullName": "Person", "birthday": None},
            )
        with self.assertRaisesRegex(RuntimeError, "name and birthday"):
            validate_personal_info_result(
                {"trusted": True},
                {"fullName": None, "birthday": None},
            )

        validate_personal_info_result(
            {"trusted": True},
            {"fullName": "Person", "birthday": None},
        )


if __name__ == "__main__":
    unittest.main()
