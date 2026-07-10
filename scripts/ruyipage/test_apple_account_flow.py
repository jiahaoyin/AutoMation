import json
import io
import os
import sys
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

RUYIPAGE_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if RUYIPAGE_SCRIPT_DIR not in sys.path:
    sys.path.insert(0, RUYIPAGE_SCRIPT_DIR)

from apple_account_flow import (
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
    submit_with_enter,
    validate_apple_url,
    validate_apple_scope,
    validate_personal_info_result,
    wait_for_2fa_or_session,
    wait_for_signed_in,
)


class FakeStates:
    def __init__(self, checked=False, displayed=True, enabled=True):
        self.is_checked = checked
        self.is_displayed = displayed
        self.is_enabled = enabled


class FakeElement:
    def __init__(self, text="", on_click=None, checked=False, displayed=True, enabled=True):
        self.text = text
        self.on_click = on_click
        self.states = FakeStates(checked=checked, displayed=displayed, enabled=enabled)
        self.inputs = []
        self.clicks = 0
        self.value = ""
        self.scope = None

    def click_self(self):
        self.clicks += 1
        if self.scope is not None:
            self.scope.actions.target = self
        if self.on_click:
            self.on_click()
        return self

    def input(self, value, clear=True):
        self.inputs.append((value, clear))
        return self


class FakePage:
    def __init__(self, elements_by_selector=None, buttons=None, frames=None, state=None, actions=None):
        self.elements_by_selector = elements_by_selector or {}
        self.buttons = buttons or []
        self.frames = frames or []
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

    def eles(self, selector):
        if selector == "css:button":
            return self.buttons
        return self.elements_by_selector.get(selector, [])

    def get_frames(self):
        return self.frames

    def run_js(self, _script):
        if "location.href" in _script and "JSON.stringify" not in _script:
            return self.state.get("href", "https://idmsa.apple.com/appleauth/auth/signin")
        return json.dumps(self.state)


class FakeActions:
    def __init__(self):
        self.calls = []
        self.target = None
        self.pending_human_click = None
        self.pending_text = None
        self.select_all = False
        self.delete_selection = False

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
        self.target = element
        self.pending_human_click = element
        return self

    def perform(self):
        self.calls.append(("perform",))
        if self.pending_human_click is not None:
            element = self.pending_human_click
            self.pending_human_click = None
            if element.on_click:
                element.on_click()
        if self.target is not None and self.delete_selection:
            self.target.value = ""
            self.select_all = False
            self.delete_selection = False
        if self.target is not None and self.pending_text is not None:
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

    def test_submit_enter_uses_the_element_scope_actions(self):
        root = FakePage()
        frame = FakePage()

        submit_with_enter(frame, FakeKeys, pause=lambda *_: None)

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


class SecurityCodeTests(unittest.TestCase):
    def test_fills_six_visible_digit_fields_individually(self):
        fields = [FakeElement() for _ in range(6)]
        frame = FakePage({"css:input[maxlength='1']": fields})
        page = FakePage(frames=[frame])

        fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.value for field in fields], list("123456"))
        self.assertTrue(all(not field.inputs for field in fields))
        self.assertTrue(all(field.clicks == 0 for field in fields))
        self.assertEqual(
            [call for call in frame.actions.calls if call[0] == "human_click"],
            [("human_click", field) for field in fields],
        )

    def test_ignores_outer_single_character_noise_before_six_digit_frame(self):
        outer_noise = FakeElement()
        fields = [FakeElement() for _ in range(6)]
        frame = FakePage({"css:input[maxlength='1']": fields})
        page = FakePage(
            {"css:input[maxlength='1']": [outer_noise]},
            frames=[frame],
        )

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
                return json.dumps(states.pop(0))
            return json.dumps(states[0])

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
                return json.dumps(states.pop(0))
            return json.dumps(states[0])

        page.run_js = next_state
        with patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_signed_in(page, timeout_s=1, submitted=True)

        self.assertTrue(state["trusted"])
        self.assertEqual(verify.clicks, 0)


class RememberAccountTests(unittest.TestCase):
    def test_checks_remember_account_and_verifies_state(self):
        field = FakeElement()
        field.on_click = lambda: setattr(field.states, "is_checked", True)
        page = FakePage(frames=[FakePage({"css:#remember-me": [field]})])

        self.assertTrue(ensure_remember_checked(page, pause=lambda *_: None))
        self.assertEqual(field.clicks, 0)
        self.assertIn(("human_click", field), field.scope.actions.calls)

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

    def test_2fa_wait_accepts_code_fields_discovered_inside_frame(self):
        fields = [FakeElement() for _ in range(6)]
        frame = FakePage({"css:input[maxlength='1']": fields})
        page = FakePage(frames=[frame], state={"twofa": False, "codeInputCount": 0})

        with patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_2fa_or_session(page, timeout_s=0.05)

        self.assertEqual(state["codeInputCount"], 6)

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
        self.assertIn("Verification code invalid", state["snippet"])

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
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=False,
        ):
            apple_id, password = pop_browser_credentials()

            self.assertEqual((apple_id, password), ("person@example.com", "secret"))
            self.assertNotIn("APPLE_ID", os.environ)
            self.assertNotIn("APPLE_PASSWORD", os.environ)

    def test_command_line_apple_id_is_not_supported(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parse_args(["--apple-id", "person@example.com"])


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
