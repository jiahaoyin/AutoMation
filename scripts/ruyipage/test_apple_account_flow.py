import json
import io
import os
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import ANY, Mock, patch

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
        with patch.object(account_flow, "browser_startup_stage", "not_started"), patch(
            "apple_account_flow.emit"
        ) as emit_event:
            set_stage("email_wait")
            set_stage("password_input")

        self.assertEqual(
            [call.args[0] for call in emit_event.call_args_list],
            [
                {
                    "event": "status",
                    "status": "browser_stage",
                    "stage": "email_wait",
                    "previousStage": "not_started",
                    "transition": "entered",
                },
                {
                    "event": "status",
                    "status": "browser_stage",
                    "stage": "password_input",
                    "previousStage": "email_wait",
                    "transition": "entered",
                },
            ],
        )

class BrowserExceptionClassificationTests(unittest.TestCase):
    def test_classifies_focus_failure_by_the_fixed_browser_stage(self):
        error = RuntimeError("ruyiPage input target focus was not confirmed")

        self.assertEqual(
            account_flow.classify_browser_exception(error, "password_input"),
            "password_focus_unconfirmed",
        )
        self.assertEqual(
            account_flow.classify_browser_exception(error, "twofa_input"),
            "twofa_focus_unconfirmed",
        )
        self.assertEqual(
            account_flow.classify_browser_exception(
                RuntimeError("live password input target did not stabilize"),
                "password_wait",
            ),
            "password_target_unstable",
        )


class BrowserObservationTests(unittest.TestCase):
    def test_emits_only_fixed_non_secret_browser_observation(self):
        page = object()
        state = {
            "trusted": True,
            "twofa": False,
            "inputReady": False,
            "codeInputCount": 6,
            "error": False,
            "email": "person@example.com",
            "otp": "123456",
        }
        with patch(
            "apple_account_flow.scope_location_url",
            return_value=account_flow.ACCOUNT_INFORMATION_URL,
        ), patch(
            "apple_account_flow.browser_connection_is_alive", return_value=True
        ), patch("apple_account_flow.emit") as emit_event:
            account_flow.emit_browser_observation(
                "profile_ready",
                page,
                state,
                account_home_confirmed=True,
            )

        self.assertEqual(
            emit_event.call_args.args[0],
            {
                "event": "status",
                "status": "browser_observation",
                "checkpoint": "profile_ready",
                "generation": 0,
                "pageKind": "account_information",
                "connectionAlive": True,
                "inspectionAvailable": True,
                "sessionConfirmed": True,
                "accountHomeConfirmed": True,
                "twofaVisible": False,
                "trustPrompt": False,
                "inputReady": False,
                "codeInputCount": 6,
                "authenticationError": False,
                "rootManageUrl": False,
                "rootAccountMarker": False,
                "rootAuthenticationError": False,
                "rootSecurityCopyOnly": False,
                "retiringChildError": False,
                "childAuthUiPresent": False,
            },
        )
        self.assertNotIn("person@example.com", json.dumps(emit_event.call_args.args[0]))
        self.assertNotIn("123456", json.dumps(emit_event.call_args.args[0]))

    def test_transition_observation_accepts_only_fixed_non_secret_flags(self):
        page = object()
        state = {
            "trusted": False,
            "rootManageUrl": True,
            "rootAccountMarker": False,
            "rootError": False,
            "rootSecurityCopyOnly": True,
            "retiringChildError": True,
            "childAuthUiPresent": True,
            "inspectionAvailable": False,
            "email": "person@example.com",
            "otp": "123456",
        }
        with patch(
            "apple_account_flow.scope_location_url",
            return_value="https://account.apple.com/account/manage",
        ), patch(
            "apple_account_flow.browser_connection_is_alive", return_value=True
        ), patch("apple_account_flow.emit") as emit_event:
            account_flow.emit_browser_observation(
                "twofa_transition",
                page,
                state,
                account_home_confirmed=False,
                generation=1,
            )

        event = emit_event.call_args.args[0]
        self.assertEqual(event["checkpoint"], "twofa_transition")
        self.assertEqual(event["generation"], 1)
        self.assertFalse(event["inspectionAvailable"])
        self.assertTrue(event["rootManageUrl"])
        self.assertFalse(event["rootAccountMarker"])
        self.assertFalse(event["rootAuthenticationError"])
        self.assertTrue(event["rootSecurityCopyOnly"])
        self.assertTrue(event["retiringChildError"])
        self.assertTrue(event["childAuthUiPresent"])
        self.assertFalse(event["trustPrompt"])
        self.assertNotIn("person@example.com", json.dumps(event))
        self.assertNotIn("123456", json.dumps(event))

    def test_trust_prompt_observation_uses_a_fixed_page_kind_and_boolean_only(self):
        page = object()
        state = {
            "trustPrompt": True,
            "twofa": True,
            "pageCopy": "Trust this browser for person@example.com code 123456",
        }
        with patch(
            "apple_account_flow.scope_location_url",
            return_value="https://idmsa.apple.com/IDMSWebAuth/signin?query=secret",
        ), patch(
            "apple_account_flow.browser_connection_is_alive", return_value=True
        ), patch("apple_account_flow.emit") as emit_event:
            account_flow.emit_browser_observation(
                "twofa_transition",
                page,
                state,
                account_home_confirmed=False,
                generation=1,
            )

        event = emit_event.call_args.args[0]
        self.assertEqual(event["pageKind"], "trust_prompt")
        self.assertTrue(event["trustPrompt"])
        serialized = json.dumps(event)
        self.assertNotIn("person@example.com", serialized)
        self.assertNotIn("123456", serialized)
        self.assertNotIn("query=secret", serialized)


class ExistingBrowserAttachTests(unittest.TestCase):
    def test_reuses_the_persisted_ruyipage_address_before_process_scanning(self):
        attached = object()

        class RuyiPageModule:
            attach_calls = []

            @classmethod
            def attach_exist_browser(cls, *, address, latest_tab):
                cls.attach_calls.append((address, latest_tab))
                return attached

            @staticmethod
            def auto_attach_exist_browser_by_process(*_args, **_kwargs):
                raise AssertionError("process scan should not run after a saved address attaches")

        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            state_path = account_flow.browser_attach_state_path(str(profile_dir))
            self.assertIsNotNone(state_path)
            state_path.write_text(
                json.dumps({"version": 1, "address": "127.0.0.1:19456"}),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "APPLE_AUTOMATION_BROWSER_BROKER_MODE": "0",
                    "BROWSER_ATTACH_EXISTING": "1",
                    "BROWSER_ATTACH_ADDRESS": "",
                },
                clear=False,
            ), patch(
                "apple_account_flow.browser_connection_is_alive",
                return_value=True,
            ), patch(
                "apple_account_flow.importlib.import_module",
                return_value=RuyiPageModule,
            ):
                page = account_flow.try_attach_existing_browser(str(profile_dir))

        self.assertIs(page, attached)
        self.assertEqual(RuyiPageModule.attach_calls, [("127.0.0.1:19456", True)])

    def test_persists_only_a_valid_local_ruyipage_address(self):
        page = type(
            "AttachedPage",
            (), {"browser": type("Browser", (), {"address": "127.0.0.1:19457"})()},
        )()
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            self.assertEqual(
                account_flow.persist_browser_attach_address(page, str(profile_dir)),
                "127.0.0.1:19457",
            )
            self.assertEqual(
                account_flow.read_browser_attach_address(str(profile_dir)),
                "127.0.0.1:19457",
            )

    def test_macos_stale_regular_profile_lock_allows_new_browser_when_firefox_is_closed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            (profile_dir / "parent.lock").write_text("stale", encoding="utf-8")
            with patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.macos_firefox_process_uses_profile",
                return_value=False,
            ):
                self.assertFalse(account_flow.firefox_profile_has_active_lock(str(profile_dir)))

    def test_macos_stale_plus_pid_profile_lock_does_not_block_startup(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            lock_path = profile_dir / "parent.lock"
            with patch(
                "apple_account_flow.os.path.lexists",
                side_effect=lambda candidate: Path(candidate) == lock_path,
            ), patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.macos_firefox_process_uses_profile",
                return_value=False,
            ):
                self.assertFalse(account_flow.firefox_profile_has_active_lock(str(profile_dir)))

    def test_macos_empty_firefox_process_scan_allows_new_browser_with_a_stale_lock(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            (profile_dir / "parent.lock").write_text("stale", encoding="utf-8")
            no_firefox = type(
                "PsResult", (), {"returncode": 0, "stdout": "1 /sbin/launchd\n"}
            )()
            with patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.subprocess.run",
                return_value=no_firefox,
            ):
                self.assertFalse(account_flow.firefox_profile_has_active_lock(str(profile_dir)))

    def test_macos_live_plus_pid_profile_lock_blocks_startup(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            lock_path = profile_dir / "parent.lock"
            with patch(
                "apple_account_flow.os.path.lexists",
                side_effect=lambda candidate: Path(candidate) == lock_path,
            ), patch.object(
                Path,
                "is_symlink",
                return_value=True,
            ), patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.macos_firefox_process_uses_profile",
                return_value=True,
            ):
                self.assertTrue(account_flow.firefox_profile_has_active_lock(str(profile_dir)))

    def test_macos_unparseable_profile_symlink_does_not_permanently_block_startup(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            lock_path = profile_dir / "parent.lock"
            with patch(
                "apple_account_flow.os.path.lexists",
                side_effect=lambda candidate: Path(candidate) == lock_path,
            ), patch.object(
                Path,
                "is_symlink",
                return_value=True,
            ), patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.macos_firefox_process_uses_profile",
                return_value=False,
            ):
                self.assertFalse(account_flow.firefox_profile_has_active_lock(str(profile_dir)))

    def test_macos_process_probe_matches_only_the_exact_firefox_profile(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile with spaces"
            profile_dir.mkdir()
            other_profile = Path(temp_dir) / "other-profile"
            firefox = "/Applications/Firefox.app/Contents/MacOS/firefox"
            matching = type(
                "PsResult",
                (), {
                    "returncode": 0,
                    "stdout": "123 /Applications/Firefox.app/Contents/MacOS/firefox\n",
                },
            )()
            matching_details = type(
                "PsResult",
                (), {
                    "returncode": 0,
                    "stdout": (
                        f"123 {firefox} {firefox} --profile {profile_dir} "
                        "--width=1280 --height=960\n"
                    ),
                },
            )()
            other = type(
                "PsResult",
                (), {
                    "returncode": 0,
                    "stdout": "456 /Applications/Firefox.app/Contents/MacOS/firefox\n",
                },
            )()
            other_details = type(
                "PsResult",
                (), {
                    "returncode": 0,
                    "stdout": (
                        f"456 {firefox} {firefox} -profile {other_profile} "
                        "--width=1280 --height=960\n"
                    ),
                },
            )()
            with patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.subprocess.run",
                side_effect=[matching, matching_details],
            ):
                self.assertTrue(account_flow.macos_firefox_process_uses_profile(profile_dir))
            with patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.subprocess.run",
                side_effect=[other, other_details],
            ):
                self.assertFalse(account_flow.macos_firefox_process_uses_profile(profile_dir))

    def test_macos_profile_command_rejects_unknown_trailing_option(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            profile_path = account_flow.normalized_profile_path(profile_dir)
            self.assertIsNotNone(profile_path)
            command = f"/Applications/Firefox.app/Contents/MacOS/firefox --profile {profile_dir} --mystery"
            self.assertIsNone(
                account_flow.raw_firefox_command_uses_profile(command, profile_path)
            )

    def test_macos_profile_command_keeps_scanning_known_boundaries(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile --width=1280"
            profile_dir.mkdir()
            profile_path = account_flow.normalized_profile_path(profile_dir)
            self.assertIsNotNone(profile_path)
            command = (
                "/Applications/Firefox.app/Contents/MacOS/firefox --profile "
                f"{profile_dir} --width=1280 --height=960"
            )
            self.assertTrue(
                account_flow.raw_firefox_command_uses_profile(command, profile_path)
            )

    def test_macos_profile_probe_failure_keeps_an_existing_lock_blocked(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            (profile_dir / "parent.lock").write_text("unverified", encoding="utf-8")
            failed = type("PsResult", (), {"returncode": 1, "stdout": ""})()
            with patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.subprocess.run",
                return_value=failed,
            ):
                self.assertTrue(account_flow.firefox_profile_has_active_lock(str(profile_dir)))

    def test_macos_firefox_detail_probe_failure_keeps_an_existing_lock_blocked(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            (profile_dir / "parent.lock").write_text("unverified", encoding="utf-8")
            firefox = "/Applications/Firefox.app/Contents/MacOS/firefox"
            listing = type("PsResult", (), {"returncode": 0, "stdout": f"123 {firefox}\n"})()
            failed_details = type("PsResult", (), {"returncode": 1, "stdout": ""})()
            with patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.subprocess.run",
                side_effect=[listing, failed_details],
            ):
                self.assertTrue(account_flow.firefox_profile_has_active_lock(str(profile_dir)))

    def test_macos_firefox_that_exits_after_listing_does_not_block_startup(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            firefox = "/Applications/Firefox.app/Contents/MacOS/firefox"
            listing = type("PsResult", (), {"returncode": 0, "stdout": f"123 {firefox}\n"})()
            exited_details = type("PsResult", (), {"returncode": 0, "stdout": ""})()
            with patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.subprocess.run",
                side_effect=[listing, exited_details],
            ):
                self.assertFalse(account_flow.macos_firefox_process_uses_profile(profile_dir))

    def test_prefers_the_authenticated_manage_tab_when_multiple_account_tabs_exist(self):
        sign_in_tab = object()
        manage_tab = object()

        class Candidate:
            def __init__(self):
                self.url_query = None

            def get_tabs(self, *, url):
                self.url_query = url
                return [sign_in_tab, manage_tab]

        candidate = Candidate()

        class RuyiPageModule:
            @staticmethod
            def auto_attach_exist_browser_by_process():
                return candidate

        with patch.dict(
            os.environ,
            {
                "APPLE_AUTOMATION_BROWSER_BROKER_MODE": "0",
                "BROWSER_ATTACH_EXISTING": "1",
            },
            clear=False,
        ), patch(
            "apple_account_flow.browser_connection_is_alive",
            return_value=True,
        ), patch(
            "apple_account_flow.scope_location_url",
            side_effect=[
                "https://account.apple.com/account/sign-in",
                "https://account.apple.com/account/manage",
            ],
        ), patch(
            "apple_account_flow.attached_account_matches_apple_id",
            return_value=True,
        ), patch(
            "apple_account_flow.importlib.import_module",
            return_value=RuyiPageModule,
        ):
            attached = account_flow.try_attach_existing_account_page("person@example.com")

        self.assertIs(attached, manage_tab)
        self.assertEqual(candidate.url_query, "account.apple.com")

    def test_rejects_an_attached_manage_tab_for_a_different_account(self):
        manage_tab = object()

        class Candidate:
            def get_tabs(self, *, url):
                self.url_query = url
                return [manage_tab]

        class RuyiPageModule:
            @staticmethod
            def auto_attach_exist_browser_by_process():
                return Candidate()

        with patch.dict(
            os.environ,
            {
                "APPLE_AUTOMATION_BROWSER_BROKER_MODE": "0",
                "BROWSER_ATTACH_EXISTING": "1",
            },
            clear=False,
        ), patch(
            "apple_account_flow.browser_connection_is_alive",
            return_value=True,
        ), patch(
            "apple_account_flow.scope_location_url",
            return_value="https://account.apple.com/account/manage",
        ), patch(
            "apple_account_flow.attached_account_matches_apple_id",
            return_value=False,
        ), patch(
            "apple_account_flow.importlib.import_module",
            return_value=RuyiPageModule,
        ):
            attached = account_flow.try_attach_existing_account_page("person@example.com")

        self.assertIsNone(attached)

    def test_reuses_a_blank_attached_tab_for_sign_in(self):
        blank_tab = object()

        class Candidate:
            latest_tab = blank_tab

            def get_tabs(self, *, url):
                self.url_query = url
                return []

        candidate = Candidate()

        with patch(
            "apple_account_flow.try_attach_existing_browser",
            return_value=candidate,
        ), patch(
            "apple_account_flow.browser_connection_is_alive",
            return_value=True,
        ), patch(
            "apple_account_flow.scope_location_url",
            return_value="about:newtab",
        ):
            page, route = account_flow.try_attach_existing_browser_for_flow(
                "person@example.com"
            )

        self.assertIs(page, blank_tab)
        self.assertEqual(route, "empty_tab")
        self.assertEqual(candidate.url_query, "account.apple.com")

    def test_opens_a_new_blank_tab_when_attached_tab_has_other_content(self):
        other_tab = object()
        new_tab = object()

        class Candidate:
            latest_tab = other_tab

            def __init__(self):
                self.opened_url = None

            def get_tabs(self, *, url):
                self.url_query = url
                return []

            def new_tab(self, url):
                self.opened_url = url
                return new_tab

        candidate = Candidate()

        with patch(
            "apple_account_flow.try_attach_existing_browser",
            return_value=candidate,
        ), patch(
            "apple_account_flow.browser_connection_is_alive",
            return_value=True,
        ), patch(
            "apple_account_flow.scope_location_url",
            return_value="https://example.test/work",
        ):
            page, route = account_flow.try_attach_existing_browser_for_flow(
                "person@example.com"
            )

        self.assertIs(page, new_tab)
        self.assertEqual(route, "new_tab")
        self.assertEqual(candidate.opened_url, "about:blank")

    def test_opens_a_new_blank_tab_when_attached_tab_url_is_unreadable(self):
        current_tab = object()
        new_tab = object()

        class Candidate:
            latest_tab = current_tab

            def get_tabs(self, *, url):
                return []

            def new_tab(self, url):
                self.opened_url = url
                return new_tab

        candidate = Candidate()
        with patch(
            "apple_account_flow.try_attach_existing_browser",
            return_value=candidate,
        ), patch(
            "apple_account_flow.browser_connection_is_alive",
            return_value=True,
        ), patch(
            "apple_account_flow.scope_location_url",
            return_value="",
        ):
            page, route = account_flow.try_attach_existing_browser_for_flow(
                "person@example.com"
            )

        self.assertIs(page, new_tab)
        self.assertEqual(route, "new_tab")
        self.assertEqual(candidate.opened_url, "about:blank")

    def test_attached_account_identity_requires_an_exact_single_match(self):
        class IdentityScope:
            def __init__(self, values):
                self.values = values
                self.script = ""

            def run_js(self, script):
                self.script = script
                return json.dumps(self.values)

        matching = IdentityScope(["person@example.com"])
        self.assertTrue(
            account_flow.attached_account_matches_apple_id(
                matching,
                "Person@Example.com",
            )
        )
        self.assertIn("ruyipage-account-session-identity", matching.script)
        self.assertFalse(
            account_flow.attached_account_matches_apple_id(
                IdentityScope(["other@example.com"]),
                "person@example.com",
            )
        )
        self.assertFalse(
            account_flow.attached_account_matches_apple_id(
                IdentityScope(["person@example.com", "other@example.com"]),
                "person@example.com",
            )
        )


class PageTransitionWaitTests(unittest.TestCase):
    def test_document_settle_reports_a_dead_ruyipage_connection(self):
        page = FakePage()
        page.states = FakeStates(alive=False)
        page.wait = type(
            "FailingWait",
            (),
            {"doc_loaded": lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("lost"))},
        )()

        with self.assertRaisesRegex(RuntimeError, "browser connection was lost"):
            account_flow.wait_for_document_settle(page, pause=lambda *_: None)

    def test_password_wait_uses_the_second_freshly_discovered_target(self):
        first = FakeElement(attrs={"type": "password", "id": "password_text_field"})
        fresh = FakeElement(attrs={"type": "password", "id": "password_text_field"})
        selector = account_flow.PASSWORD_SELECTORS[0]

        class RehydratingPasswordPage(FakePage):
            def __init__(self):
                super().__init__()
                self.password_targets = [first, fresh]
                self.password_queries = 0
                first.scope = self
                fresh.scope = self

            def eles(self, candidate, timeout=None):
                self.eles_calls.append((candidate, timeout))
                if candidate == selector:
                    self.password_queries += 1
                    return [self.password_targets.pop(0)]
                return []

        page = RehydratingPasswordPage()
        scope, field = account_flow.wait_for_element(
            page,
            (selector,),
            timeout_s=1,
            stable_observations=2,
            pause=lambda *_: None,
        )

        self.assertIs(scope, page)
        self.assertIs(field, fresh)
        self.assertEqual(page.password_queries, 2)

    def test_password_target_wait_rejects_a_prepaint_placeholder(self):
        placeholder = FakeElement(
            attrs={
                "type": "password",
                "passwordTargetReadiness": {
                    "connected": False,
                    "visible": False,
                    "editable": True,
                    "inputType": "password",
                },
            }
        )

        live = FakeElement(attrs={"type": "password"})
        selector = account_flow.PASSWORD_SELECTORS[0]

        class PasswordPage(FakePage):
            def __init__(self):
                super().__init__()
                self.password_targets = [placeholder] * 3 + [live] * 4
                self.password_queries = 0
                placeholder.scope = self
                live.scope = self

            def eles(self, candidate, timeout=None):
                self.eles_calls.append((candidate, timeout))
                if candidate == selector:
                    self.password_queries += 1
                    return [
                        self.password_targets.pop(0)
                        if self.password_targets
                        else live
                    ]
                return []

        page = PasswordPage()
        scope, field = account_flow.wait_for_password_target(
            page,
            timeout_s=1,
            pause=lambda *_: None,
        )

        self.assertIs(scope, page)
        self.assertIs(field, live)
        self.assertEqual(page.password_queries, 7)

    def test_password_target_wait_restarts_when_hydration_replaces_the_node(self):
        first = FakeElement(attrs={"type": "password"})
        fresh = FakeElement(attrs={"type": "password"})
        selector = account_flow.PASSWORD_SELECTORS[0]

        class RehydratingPasswordPage(FakePage):
            def __init__(self):
                super().__init__()
                self.password_targets = [first] * 3 + [fresh] * 4
                self.password_queries = 0
                first.scope = self
                fresh.scope = self

            def eles(self, candidate, timeout=None):
                self.eles_calls.append((candidate, timeout))
                if candidate == selector:
                    self.password_queries += 1
                    return [
                        self.password_targets.pop(0)
                        if self.password_targets
                        else fresh
                    ]
                return []

        page = RehydratingPasswordPage()
        scope, field = account_flow.wait_for_password_target(
            page,
            timeout_s=1,
            pause=lambda *_: None,
        )

        self.assertIs(scope, page)
        self.assertIs(field, fresh)
        self.assertEqual(page.password_queries, 8)


class TwoFactorPreparationTests(unittest.TestCase):
    def test_accepts_only_two_factor_prepared_ack(self):
        with patch("apple_account_flow.emit") as emit_event, patch(
            "apple_account_flow.read_command",
            return_value={"type": "2fa_prepared"},
        ):
            request_two_factor_preparation()

        emit_event.assert_called_once_with({"event": "prepare_2fa"})

    def test_broker_mode_emits_fixed_command_acknowledgements(self):
        with patch("apple_account_flow.emit") as emit_event, patch(
            "apple_account_flow.read_command",
            return_value={"type": "2fa_prepared"},
        ), patch("apple_account_flow.browser_broker_mode_enabled", return_value=True):
            request_two_factor_preparation()
            self.assertEqual(
                account_flow.validate_two_factor_code_command(
                    {"type": "2fa_code", "generation": 1, "code": "123456"},
                    1,
                ),
                "123456",
            )

        self.assertEqual(
            [call.args[0] for call in emit_event.call_args_list],
            [
                {"event": "prepare_2fa"},
                {"event": "2fa_command_ack", "command": "2fa_prepared"},
                {
                    "event": "2fa_command_ack",
                    "command": "2fa_code",
                    "generation": 1,
                },
            ],
        )

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
    def __init__(self, checked=False, displayed=True, enabled=True, alive=True):
        self.is_checked = checked
        self.is_displayed = displayed
        self.is_enabled = enabled
        self.is_alive = alive


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
        self._default_profile_modal_close = None
        self.password_target_identity = (
            self.attrs.get("passwordTargetIdentity") or f"test-password:{id(self)}"
        )
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

    def eles(self, selector, timeout=None):
        elements_by_selector = self.attrs.get("elementsBySelector", {})
        if selector in elements_by_selector:
            elements = elements_by_selector.get(selector, [])
            for element in elements:
                element.scope = self.scope
            return elements
        if selector in account_flow.PROFILE_MODAL_CLOSE_SELECTORS and "profileModal" in self.attrs:
            if self._default_profile_modal_close is None:
                self._default_profile_modal_close = FakeElement(
                    text="关闭",
                    on_click=lambda: setattr(self.states, "is_displayed", False),
                    attrs={
                        "profileModalClose": {
                            "visible": True,
                            "label": "关闭",
                            "className": "modal-close",
                        }
                    },
                )
            self._default_profile_modal_close.scope = self.scope
            return [self._default_profile_modal_close]
        return []

    def run_js(self, script):
        if not str(script).lstrip().startswith("function"):
            raise RuntimeError("FirefoxElement.run_js requires a function declaration")
        if "ruyipage-profile-card-summary" in script:
            summary = dict(
                self.attrs.get(
                    "profileCard",
                    {
                        "visible": self.states.is_displayed,
                        "name": False,
                        "birthday": False,
                        "birthdayValue": None,
                    },
                )
            )
            summary.setdefault(
                "domIdentity",
                self.attrs.get("profileDomIdentity")
                or f"test:{self.attrs.get('id') or id(self)}",
            )
            summary.setdefault(
                "semanticActionTarget",
                str(self.attrs.get("tagName") or "").upper() == "BUTTON"
                or str(self.attrs.get("role") or "").lower() == "button",
            )
            return json.dumps(summary)
        if "ruyipage-profile-name-modal" in script:
            summary = dict(
                self.attrs.get(
                    "profileModal",
                    {
                        "visible": self.states.is_displayed,
                        "fieldCount": 0,
                        "given": None,
                        "family": None,
                    },
                )
            )
            summary["visible"] = summary.get("visible") is True and self.states.is_displayed
            summary.setdefault(
                "orderedParts",
                [
                    part
                    for part in (summary.get("given"), summary.get("family"))
                    if part is not None
                ],
            )
            return json.dumps(summary)
        if "ruyipage-profile-modal-close" in script:
            return json.dumps(
                self.attrs.get(
                    "profileModalClose",
                    {
                        "visible": self.states.is_displayed,
                        "label": self.text,
                        "className": self.attrs.get("className", ""),
                    },
                )
            )
        if "ruyipage-profile-navigation-link-summary" in script:
            return json.dumps(
                self.attrs.get(
                    "profileNavigationLink",
                    {
                        "visible": self.states.is_displayed,
                        "href": self.attrs.get("href", ""),
                        "label": self.text,
                    },
                )
            )
        if "ruyipage-account-password-card" in script:
            summary = dict(
                self.attrs.get(
                    "accountPasswordCard",
                    {
                        "visible": self.states.is_displayed,
                        "passwordCard": "密码" in self.text or "password" in self.text.lower(),
                        "lastUpdated": "上次更新" in self.text or "last updated" in self.text.lower(),
                    },
                )
            )
            summary.setdefault("domIdentity", f"password-card:{self.attrs.get('id') or id(self)}")
            return json.dumps(summary)
        if "ruyipage-account-password-change-field" in script:
            summary = dict(
                self.attrs.get(
                    "passwordChangeField",
                    {
                        "visible": self.states.is_displayed,
                        "editable": self.states.is_enabled,
                        "inputType": str(self.attrs.get("type") or "password").lower(),
                        "signals": [],
                    },
                )
            )
            summary.setdefault("domIdentity", f"password-field:{self.attrs.get('id') or id(self)}")
            return json.dumps(summary)
        if "ruyipage-account-password-submit" in script:
            return json.dumps(
                self.attrs.get(
                    "accountPasswordSubmit",
                    {
                        "visible": self.states.is_displayed,
                        "enabled": self.states.is_enabled,
                        "label": self.text,
                    },
                )
            )
        if "ruyipage-small-business-control-summary" in script:
            summary = dict(
                self.attrs.get(
                    "smallBusinessControl",
                    {
                        "visible": self.states.is_displayed,
                        "enabled": self.states.is_enabled,
                        "tagName": self.attrs.get("tagName", "label"),
                        "inputType": self.attrs.get("type", "radio"),
                        "checked": self.states.is_checked,
                        "label": self.text,
                        "text": self.text,
                        "groupText": self.attrs.get("groupText", ""),
                        "sectionId": self.attrs.get("sectionId", ""),
                        "className": self.attrs.get("className", ""),
                        "id": self.attrs.get("id", ""),
                        "name": self.attrs.get("name", ""),
                        "value": self.attrs.get("value", ""),
                    },
                )
            )
            summary.setdefault("checked", self.states.is_checked)
            summary.setdefault("domIdentity", f"small-business:{self.attrs.get('id') or id(self)}")
            summary.setdefault(
                "controlIdentity",
                f"small-business-control:{self.attrs.get('id') or id(self)}",
            )
            summary.setdefault("domOrder", int(self.attrs.get("domOrder") or 0))
            return json.dumps(summary)
        if "ruyipage-developer-membership-navigation" in script:
            return json.dumps(
                self.attrs.get(
                    "developerMembershipNavigation",
                    {
                        "visible": self.states.is_displayed,
                        "label": self.text,
                    },
                )
            )
        if "ruyipage-password-target-readiness" in script:
            readiness = dict(
                self.attrs.get(
                    "passwordTargetReadiness",
                    {
                        "connected": True,
                        "visible": self.states.is_displayed,
                        "editable": self.states.is_enabled,
                        "inputType": str(self.attrs.get("type") or "").lower(),
                    },
                )
            )
            readiness.setdefault("nodeIdentity", self.password_target_identity)
            return json.dumps(readiness)
        if "ruyipage-otp-length-check" in script:
            expected = re.search(r"value\.length === (\d+)", script)
            return bool(expected and len(str(self.value)) == int(expected.group(1)))
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
        tab_id=None,
    ):
        self.elements_by_selector = elements_by_selector or {}
        self.buttons = buttons or []
        self.frames = frames or []
        self._shadow_roots = shadow_roots or []
        self.parent = parent
        self.tab_id = tab_id or f"fake-context-{id(self)}"
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
        if "ruyipage-account-security-page-snapshot" in _script:
            return json.dumps(
                {
                    "securityPage": bool(
                        self.state.get("securityPage")
                        or self.state.get("href") == account_flow.ACCOUNT_SECURITY_URL
                    ),
                    "passwordCard": bool(self.state.get("passwordCard")),
                    "passwordForm": bool(self.state.get("passwordForm")),
                    "passwordFieldCount": int(self.state.get("passwordFieldCount") or 0),
                    "passwordChanged": bool(self.state.get("passwordChanged")),
                }
            )
        if "ruyipage-small-business-enrollment-snapshot" in _script:
            return json.dumps(
                {
                    "enrollPage": bool(
                        self.state.get("smallBusinessEnrollPage")
                        or self.state.get("href")
                        == account_flow.SMALL_BUSINESS_PROGRAM_ENROLL_URL
                    ),
                    "thankYou": bool(self.state.get("smallBusinessThankYou")),
                    "formReady": bool(self.state.get("smallBusinessFormReady")),
                    "paidAgreementYes": bool(self.state.get("smallBusinessPaidAgreementYes")),
                    "associatedNoCount": int(self.state.get("smallBusinessNoCount") or 0),
                    "revenueCertification": bool(self.state.get("smallBusinessRevenueCertification")),
                    "submitAvailable": bool(self.state.get("smallBusinessSubmitAvailable")),
                }
            )
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


class DeveloperFakePage(FakePage):
    def __init__(
        self,
        *args,
        account_snapshot=None,
        membership_details=None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self.account_snapshot = account_snapshot or {
            "authenticated": False,
            "accountShell": False,
            "joinProgram": False,
            "membershipNavigation": False,
        }
        self.membership_details_sequence = (
            list(membership_details)
            if isinstance(membership_details, (list, tuple))
            else None
        )
        self.membership_details = membership_details or {
            "detailsPage": False,
            "appleDeveloperProgram": False,
        }
        self.developer_scripts = []

    def run_js(self, script):
        if "ruyipage-developer-account-snapshot" in script:
            self.developer_scripts.append(script)
            return json.dumps(self.account_snapshot)
        if "ruyipage-developer-membership-details" in script:
            self.developer_scripts.append(script)
            if self.membership_details_sequence is not None:
                result = (
                    self.membership_details_sequence.pop(0)
                    if len(self.membership_details_sequence) > 1
                    else self.membership_details_sequence[0]
                )
            else:
                result = self.membership_details
            return json.dumps(result)
        return super().run_js(script)


class FakeActions:
    def __init__(
        self,
        apply_typed_text=True,
        coordinate_target=None,
        auto_advance_targets=None,
    ):
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
        self.auto_advance_targets = list(auto_advance_targets or [])

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
                if self.auto_advance_targets:
                    for field, digit in zip(self.auto_advance_targets, self.pending_text):
                        field.value = digit
                else:
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

    def test_otp_input_uses_the_owner_context_for_a_trusted_opaque_frame(self):
        field = FakeElement(
            attrs={
                "type": "text",
                "maxlength": "1",
                "autocomplete": "one-time-code",
            }
        )
        root = FakePage(
            state={"href": "https://account.apple.com/sign-in"},
            actions=FakeActions(),
        )
        frame = FakePage(
            {"css:input[autocomplete='one-time-code']": [field]},
            state={"href": "about:blank", "twofa": True},
            parent=root,
        )

        action_scope = input_and_verify(
            frame,
            field,
            "7",
            "2FA digit",
            FakeKeys,
            pause=lambda *_: None,
            root_page=root,
        )

        self.assertIs(action_scope, frame)
        self.assertEqual(root.actions.calls, [])
        self.assertEqual(field.value, "7")

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

    def test_password_uses_owner_bidi_input_when_focus_probe_is_unavailable(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin"
        iframe = FakeElement(attrs={"src": auth_url})
        password = FakeElement(attrs={"type": "password"}, focused=False)
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

        with patch("apple_account_flow.emit") as emit_event:
            action_scope = input_and_verify(
                frame,
                password,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
                root_page=root,
            )

        self.assertIs(action_scope, frame)
        self.assertEqual(password.inputs, [("secret", True)])
        self.assertEqual(
            [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)],
            [
                "owner_bidi_fallback_started",
                "owner_bidi_typed",
                "owner_bidi_value_matched",
                "verified",
            ],
        )

    def test_password_uses_bidi_input_before_keyboard_typing_can_interrupt(self):
        password = FakeElement(attrs={"type": "password"})
        actions = FakeActions(apply_typed_text=False)
        page = FakePage(
            {"css:input[type='password']": [password]},
            actions=actions,
        )

        action_scope = input_and_verify(
            page,
            password,
            "secret",
            "password",
            FakeKeys,
            pause=lambda *_: None,
        )

        self.assertIs(action_scope, page)
        self.assertEqual(password.inputs, [("secret", True)])
        self.assertEqual(
            [call for call in actions.calls if call[0] in ("combo", "type")],
            [],
        )

    def test_password_retries_keyboard_when_owner_bidi_reads_empty(self):
        class EmptyBidiPassword(FakeElement):
            def input(self, value, clear=True):
                self.inputs.append((value, clear))
                return self

        password = EmptyBidiPassword(attrs={"type": "password"})
        actions = FakeActions()
        page = FakePage(
            {"css:input[type='password']": [password]},
            actions=actions,
        )

        with patch("apple_account_flow.emit") as emit_event:
            action_scope = input_and_verify(
                page,
                password,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
            )

        self.assertIs(action_scope, page)
        self.assertEqual(password.inputs, [("secret", True)])
        self.assertEqual(password.value, "secret")
        self.assertIn(("type", "secret", ANY), actions.calls)
        self.assertIn(
            "owner_bidi_value_empty",
            [call.args[0]["step"] for call in emit_event.call_args_list],
        )
        self.assertIn(
            "owner_bidi_keyboard_retry",
            [call.args[0]["step"] for call in emit_event.call_args_list],
        )

    def test_password_refreshes_a_replaced_target_before_keyboard_recovery(self):
        class EmptyBidiPassword(FakeElement):
            def input(self, value, clear=True):
                self.inputs.append((value, clear))
                return self

        stale = EmptyBidiPassword(attrs={"type": "password"})
        fresh = FakeElement(attrs={"type": "password"})
        page = FakePage(
            {"css:input[type='password']": [fresh]},
            actions=FakeActions(),
        )
        target_holder = {}

        action_scope = input_and_verify(
            page,
            stale,
            "secret",
            "password",
            FakeKeys,
            pause=lambda *_: None,
            root_page=page,
            target_holder=target_holder,
        )

        self.assertIs(action_scope, page)
        self.assertEqual(stale.inputs, [("secret", True)])
        self.assertEqual(stale.value, "")
        self.assertEqual(fresh.value, "secret")
        self.assertIs(target_holder["scope"], page)
        self.assertIs(target_holder["field"], fresh)
        self.assertIn(("type", "secret", ANY), page.actions.calls)

    def test_password_keyboard_recovery_does_not_repeat_in_the_owner_frame(self):
        class EmptyBidiPassword(FakeElement):
            def input(self, value, clear=True):
                self.inputs.append((value, clear))
                return self

        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin"
        iframe = FakeElement(
            attrs={"src": auth_url},
            location={"x": 120, "y": 220},
            size={"width": 700, "height": 420},
        )
        stale = EmptyBidiPassword(attrs={"type": "password"})
        fresh = FakeElement(
            attrs={"type": "password"},
            location={"x": 80, "y": 96},
            size={"width": 460, "height": 56},
        )
        root = FakePage(
            {"css:iframe": [iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=FakeActions(apply_typed_text=False, coordinate_target=fresh),
        )
        frame = FakePage(
            {"css:input[type='password']": [fresh]},
            state={"href": auth_url},
            parent=root,
        )
        root.frames = [frame]

        with patch(
            "apple_account_flow.wait_for_password_target",
            return_value=(frame, fresh),
        ), self.assertRaisesRegex(RuntimeError, "password input verification failed"):
            input_and_verify(
                frame,
                stale,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
                root_page=root,
            )

        self.assertEqual(stale.inputs, [("secret", True)])
        self.assertEqual(
            [call[1] for call in root.actions.calls if call[0] == "type"],
            ["secret"],
        )
        self.assertEqual(
            [call for call in frame.actions.calls if call[0] == "type"],
            [],
        )

    def test_password_refresh_stops_on_a_nonempty_mismatched_target(self):
        class EmptyBidiPassword(FakeElement):
            def input(self, value, clear=True):
                self.inputs.append((value, clear))
                return self

        stale = EmptyBidiPassword(attrs={"type": "password"})
        fresh = FakeElement(attrs={"type": "password"})
        fresh.value = "other"
        page = FakePage(
            {"css:input[type='password']": [fresh]},
            actions=FakeActions(),
        )
        target_holder = {}

        with self.assertRaisesRegex(RuntimeError, "password input verification failed"):
            input_and_verify(
                page,
                stale,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
                root_page=page,
                target_holder=target_holder,
            )

        self.assertEqual(stale.inputs, [("secret", True)])
        self.assertEqual(fresh.value, "other")
        self.assertIs(target_holder["field"], fresh)
        self.assertNotIn(("type", "secret", ANY), page.actions.calls)

    def test_password_empty_after_keyboard_retry_fails_before_2fa(self):
        class EmptyBidiPassword(FakeElement):
            def input(self, value, clear=True):
                self.inputs.append((value, clear))
                return self

        password = EmptyBidiPassword(attrs={"type": "password"})
        page = FakePage(
            {"css:input[type='password']": [password]},
            actions=FakeActions(apply_typed_text=False),
        )

        with self.assertRaisesRegex(RuntimeError, "password input verification failed"):
            input_and_verify(
                page,
                password,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
            )

    def test_password_keyboard_retry_failure_does_not_reuse_bidi(self):
        class SecondBidiWouldMatchPassword(FakeElement):
            def input(self, value, clear=True):
                self.inputs.append((value, clear))
                if len(self.inputs) > 1:
                    self.value = value
                return self

        password = SecondBidiWouldMatchPassword(attrs={"type": "password"})
        page = FakePage(
            {"css:input[type='password']": [password]},
            actions=FakeActions(apply_typed_text=False),
        )

        with self.assertRaisesRegex(RuntimeError, "password input verification failed"):
            input_and_verify(
                page,
                password,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
            )

        self.assertEqual(password.inputs, [("secret", True)])

    def test_password_does_not_reuse_bidi_after_keyboard_focus_failure(self):
        class EmptyBidiPassword(FakeElement):
            def input(self, value, clear=True):
                self.inputs.append((value, clear))
                return self

        password = EmptyBidiPassword(attrs={"type": "password"}, focused=False)
        page = FakePage({"css:input[type='password']": [password]})

        with self.assertRaisesRegex(RuntimeError, "focus was not confirmed"):
            input_and_verify(
                page,
                password,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
            )

        self.assertEqual(password.inputs, [("secret", True)])

    def test_password_unreadable_then_unreadable_retry_fails_before_2fa(self):
        password = FakeElement(attrs={"type": "password"})
        page = FakePage(
            {"css:input[type='password']": [password]},
            actions=FakeActions(),
        )

        with patch(
            "apple_account_flow.read_element_input_value",
            side_effect=[(False, None), (False, None), (False, None)],
        ), self.assertRaisesRegex(RuntimeError, "password input verification failed"):
            input_and_verify(
                page,
                password,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
            )

    def test_password_bidi_input_failure_emits_only_a_fixed_failed_event(self):
        password = FakeElement(attrs={"type": "password"})
        page = FakePage({"css:input[type='password']": [password]})

        def input_raises(*_args, **_kwargs):
            raise RuntimeError("synthetic input failure")

        password.input = input_raises
        with patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "synthetic input failure",
        ):
            input_and_verify(
                page,
                password,
                "secret",
                "password",
                FakeKeys,
                pause=lambda *_: None,
            )

        self.assertEqual(
            [call.args[0] for call in emit_event.call_args_list],
            [
                {
                    "event": "status",
                    "status": "input_progress",
                    "field": "password",
                    "step": "owner_bidi_fallback_started",
                    "route": "owner",
                },
                {
                    "event": "status",
                    "status": "input_progress",
                    "field": "password",
                    "step": "failed",
                },
            ],
        )

    def test_password_submit_never_sends_enter_when_focus_probe_is_unavailable(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin"
        iframe = FakeElement(attrs={"src": auth_url})
        password = FakeElement(attrs={"type": "password"}, focused=False)
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

        with patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError, "focus was not confirmed"
        ):
            submit_element_with_enter(
                root,
                frame,
                password,
                FakeKeys,
                pause=lambda *_: None,
            )

        self.assertNotIn(("press", "ENTER"), frame.actions.calls)
        self.assertEqual(
            [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)],
            ["submit_focus_unconfirmed"],
        )

    def test_password_submit_refreshes_target_before_enter_after_focus_loss(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin"
        iframe = FakeElement(attrs={"src": auth_url})
        stale = FakeElement(attrs={"type": "password"}, focused=False)
        fresh = FakeElement(attrs={"type": "password"})
        refreshed = FakeElement(attrs={"type": "password"})
        root = FakePage(
            {"css:iframe": [iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=FakeActions(),
        )
        frame = FakePage(
            {"css:input[type='password']": [fresh]},
            state={"href": auth_url},
            parent=root,
        )

        def retype(_scope, _field, _value, _label, _keys, **kwargs):
            kwargs["target_holder"].update({"scope": frame, "field": refreshed})
            return frame

        with patch(
            "apple_account_flow.wait_for_password_target", return_value=(frame, fresh)
        ) as rediscover, patch(
            "apple_account_flow.input_and_verify", side_effect=retype
        ) as retype_input, patch(
            "apple_account_flow.submit_with_enter"
        ) as submit_with_enter, patch("apple_account_flow.emit") as emit_event:
            submit_element_with_enter(
                root,
                frame,
                stale,
                FakeKeys,
                pause=lambda *_: None,
                password_value="secret",
            )

        rediscover.assert_called_once_with(
            root, timeout_s=15, pause=unittest.mock.ANY
        )
        retype_input.assert_called_once_with(
            frame,
            fresh,
            "secret",
            "password",
            FakeKeys,
            pause=unittest.mock.ANY,
            root_page=root,
            target_holder=unittest.mock.ANY,
        )
        self.assertIs(submit_with_enter.call_args.args[1], refreshed)
        self.assertEqual(
            [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)],
            ["submit_target_refreshed"],
        )

    def test_otp_digit_uses_owner_bidi_input_after_focus_is_lost(self):
        field = FakeElement(
            attrs={
                "type": "text",
                "inputmode": "numeric",
                "maxlength": "1",
                "autocomplete": "one-time-code",
            }
        )

        class LoseFocusAfterClearActions(FakeActions):
            def __init__(self):
                super().__init__()
                self.perform_count = 0

            def perform(self):
                result = super().perform()
                self.perform_count += 1
                if self.perform_count == 2:
                    field.focused = False
                return result

        page = FakePage({"css:input": [field]}, actions=LoseFocusAfterClearActions())

        with patch("apple_account_flow.emit") as emit_event:
            action_scope = input_and_verify(
                page,
                field,
                "7",
                "2FA digit",
                FakeKeys,
                pause=lambda *_: None,
            )

        self.assertIs(action_scope, page)
        self.assertEqual(field.inputs, [("7", True)])
        self.assertEqual(
            [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)],
            [
                "focus_started",
                "focus_confirmed",
                "keyboard_cleared",
                "owner_focus_unconfirmed",
                "owner_bidi_fallback_started",
                "owner_bidi_typed",
                "owner_bidi_value_matched",
                "verified",
            ],
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
        field = FakeElement(attrs={"type": "password"})
        frame = FakePage(
            {"css:input": [field]},
            state={"href": auth_url},
        )

        original_input = field.input

        def input_and_navigate(value, clear=True):
            result = original_input(value, clear)
            frame.state["href"] = "https://evil.example/sign-in"
            return result

        field.input = input_and_navigate

        root = FakePage(
            {"css:iframe": [iframe]},
            state={"href": "https://account.apple.com/sign-in"},
            actions=FakeActions(coordinate_target=field),
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

    def test_contenteditable_otp_keeps_trusted_input_when_readback_is_unreadable(self):
        field = FakeElement(
            attrs={"contenteditable": "true", "role": "textbox"},
            rendered_text=None,
        )
        page = FakePage({"css:[contenteditable='true']": [field]})

        with patch("apple_account_flow.emit") as emit_event:
            action_scope = input_and_verify(
                page,
                field,
                "123456",
                "2FA code",
                FakeKeys,
                pause=lambda *_: None,
            )

        self.assertIs(action_scope, page)
        self.assertEqual(field.value, "123456")
        self.assertEqual(field.inputs, [])
        self.assertEqual(
            [call[1] for call in page.actions.calls if call[0] == "type"],
            ["123456"],
        )
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("keyboard_unverified_continue", steps)
        self.assertNotIn("element_fallback_started", steps)

    def test_password_refresh_accepts_a_fresh_matching_value_after_unreadable_input(self):
        password = FakeElement(attrs={"type": "password"})
        page = FakePage({"css:input[type='password']": [password]})

        with patch(
            "apple_account_flow.read_element_input_value",
            side_effect=[(False, None), (True, "secret")],
        ), patch("apple_account_flow.emit") as emit_event:
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
        self.assertEqual(password.inputs, [("secret", True)])
        self.assertNotIn(("type", "secret", ANY), page.actions.calls)
        self.assertIn(
            "target_refresh_value_matched",
            [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)],
        )

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
            attrs={"type": "password"},
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
    def setUp(self):
        def completed_developer_membership(page, *_args, **kwargs):
            page_holder = kwargs.get("page_holder")
            if isinstance(page_holder, dict):
                page_holder["page"] = page
            return (
                {
                    "success": True,
                    "authenticated": True,
                    "membershipStatus": "active",
                    "failureStage": "unknown",
                    "failureClass": "unknown",
                    "browserAlive": True,
                    "browserPreserved": False,
                    "browserPreservationRequested": False,
                },
                page,
                None,
            )

        self._developer_membership_patch = patch(
            "apple_account_flow.collect_developer_account_membership",
            side_effect=completed_developer_membership,
        )
        self._account_tab_patch = patch(
            "apple_account_flow.open_account_module_tab",
            side_effect=lambda page, _url: page,
        )
        self._developer_membership_mock = self._developer_membership_patch.start()
        self._account_tab_mock = self._account_tab_patch.start()

    def tearDown(self):
        self._account_tab_patch.stop()
        self._developer_membership_patch.stop()

    def test_direct_mode_emits_complete_early_browser_stage_sequence(self):
        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        root = FakePage(state={"href": "https://account.apple.com/sign-in"})
        root.get = lambda url: root.state.__setitem__("href", url)
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None
        args = parse_args(["--report-dir", "test-report"])
        events = []
        with patch.dict(
            os.environ,
            {
                "APPLE_ID": "person@example.com",
                "APPLE_PASSWORD": "secret",
                account_flow.BROWSER_BROKER_MODE_ENV: "0",
            },
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: root, FakeKeys),
        ), patch(
            "apple_account_flow.detect_login_state",
            side_effect=[{"trusted": True, "error": False}, {"trusted": True, "error": False}],
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch(
            "apple_account_flow.take_screenshot",
            return_value=None,
        ), patch(
            "apple_account_flow.wait_for_profile_capture_ready",
            return_value=None,
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"name": "Test Given Test Family", "birthday": "2000-01-02"},
        ), patch("apple_account_flow.human_pause", return_value=None), patch(
            "apple_account_flow.emit", side_effect=events.append
        ):
            self.assertEqual(browser_flow(args), 0)

        stages = [
            event["stage"]
            for event in events
            if event.get("event") == "status" and event.get("status") == "browser_stage"
        ]
        self.assertEqual(
            stages[:6],
            [
                "not_started",
                "credentials_received",
                "runtime_importing",
                "runtime_imported",
                "browser_constructing",
                "browser_ready",
            ],
        )
        self.assertGreater(stages.index("url_validated"), stages.index("browser_ready"))
        self.assertFalse(
            any(
                event.get("status") in {
                    "broker_credentials_received",
                    "browser_url_validated",
                    "browser_runtime_imported",
                }
                for event in events
            )
        )

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

    def test_browser_flow_stops_before_2fa_when_password_input_fails(self):
        root = FakePage(state={"href": "https://account.apple.com/sign-in"})
        root.get = lambda url: root.state.__setitem__("href", url)
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None
        email = FakeElement()
        password = FakeElement(attrs={"type": "password"})

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        def input_or_fail(_scope, _field, _value, label, _keys, **_kwargs):
            if label == "password":
                raise RuntimeError("password input verification failed")

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {
                "APPLE_ID": "person@example.com",
                "APPLE_PASSWORD": "secret",
            },
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: root, FakeKeys),
        ), patch(
            "apple_account_flow.detect_login_state",
            return_value={"trusted": False},
        ), patch(
            "apple_account_flow.wait_for_element",
            return_value=(root, email),
        ), patch(
            "apple_account_flow.wait_for_password_target",
            return_value=(root, password),
        ), patch(
            "apple_account_flow.input_and_verify",
            side_effect=input_or_fail,
        ), patch(
            "apple_account_flow.submit_element_with_enter",
            return_value=None,
        ), patch(
            "apple_account_flow.ensure_remember_checked",
            return_value=True,
        ) as remember_account, patch(
            "apple_account_flow.request_two_factor_preparation",
            return_value=None,
        ) as prepare_2fa, patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value={"trusted": True},
        ) as wait_2fa, patch(
            "apple_account_flow.human_pause",
            return_value=None,
        ), patch(
            "apple_account_flow.time.sleep",
            return_value=None,
        ), patch("apple_account_flow.emit"):
            with self.assertRaisesRegex(RuntimeError, "password input verification failed"):
                browser_flow(args)

        remember_account.assert_not_called()
        prepare_2fa.assert_not_called()
        wait_2fa.assert_not_called()

    def test_browser_flow_refocuses_password_after_remember_before_submit(self):
        auth_url = "https://idmsa.apple.com/appleauth/auth/authorize/signin?state=test"
        email = FakeElement()
        password = FakeElement(
            attrs={"type": "password"},
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
        root_actions = FakeActions(coordinate_target=[remember, password])
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
        root.get = lambda url: root.state.__setitem__("href", url)
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
            {
                "APPLE_ID": "person@example.com",
                "APPLE_PASSWORD": "secret",
            },
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
            "apple_account_flow.wait_for_profile_capture_ready",
            return_value=None,
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"name": "Test Given Test Family", "birthday": "2000-01-02"},
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
        root.get = lambda url: root.state.__setitem__("href", url)
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None
        email = FakeElement()
        password = FakeElement(attrs={"type": "password"})
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
            return target

        def confirm_signed_in(*_args, **kwargs):
            confirmed_state = {
                "trusted": True,
                "rootManageUrl": True,
                "rootAccountMarker": True,
                "rootError": False,
                "rootSecurityCopyOnly": True,
                "retiringChildError": True,
                "childAuthUiPresent": False,
            }
            root.state["href"] = "https://account.apple.com/account/manage"
            observer = kwargs.get("transition_observer")
            self.assertTrue(callable(observer))
            observer(confirmed_state)
            return confirmed_state

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
            return_value=(root, email),
        ), patch(
            "apple_account_flow.wait_for_password_target",
            return_value=(root, password),
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
        ) as click_submit, patch(
            "apple_account_flow.wait_for_signed_in",
            side_effect=confirm_signed_in,
        ) as wait_signed_in, patch(
            "apple_account_flow.take_screenshot",
            return_value=None,
        ), patch(
            "apple_account_flow.wait_for_profile_capture_ready",
            return_value=None,
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"name": "Test Given Test Family", "birthday": "2000-01-02"},
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
        twofa_progress = [
            call.args[0]
            for call in emit_event.call_args_list
            if call.args[0].get("event") == "status"
            and call.args[0].get("status") == "twofa_progress"
        ]
        self.assertEqual(
            [event["phase"] for event in twofa_progress],
            [
                "code_received",
                "target_waiting",
                "target_resolved",
                "input_started",
                "input_completed",
                "submit_started",
                "submit_sent",
                "transition_waiting",
                "transition_confirmed",
            ],
        )
        self.assertTrue(all(event["generation"] == 1 for event in twofa_progress))
        self.assertEqual(twofa_progress[2]["targetCount"], 1)
        self.assertIs(twofa_progress[6]["submitted"], True)
        self.assertIs(twofa_progress[7]["submitted"], True)
        click_submit.assert_not_called()
        wait_signed_in.assert_called_once()
        self.assertEqual(wait_signed_in.call_args.args, (root,))
        self.assertEqual(
            {
                key: value
                for key, value in wait_signed_in.call_args.kwargs.items()
                if key != "transition_observer"
            },
            {
                "submitted": True,
                "otp_generation": 1,
                "submission_method": "automatic",
            },
        )
        self.assertTrue(callable(wait_signed_in.call_args.kwargs["transition_observer"]))
        transition_observation = next(
            call.args[0]
            for call in emit_event.call_args_list
            if call.args[0].get("event") == "status"
            and call.args[0].get("status") == "browser_observation"
            and call.args[0].get("checkpoint") == "twofa_transition"
        )
        self.assertEqual(
            transition_observation,
            {
                "event": "status",
                "status": "browser_observation",
                "checkpoint": "twofa_transition",
                "generation": 1,
                "pageKind": "account_manage",
                "connectionAlive": False,
                "inspectionAvailable": True,
                "sessionConfirmed": True,
                "accountHomeConfirmed": False,
                "twofaVisible": False,
                "trustPrompt": False,
                "inputReady": False,
                "codeInputCount": 0,
                "authenticationError": False,
                "rootManageUrl": True,
                "rootAccountMarker": True,
                "rootAuthenticationError": False,
                "rootSecurityCopyOnly": True,
                "retiringChildError": True,
                "childAuthUiPresent": False,
            },
        )
        account_home_observation = next(
            call.args[0]
            for call in emit_event.call_args_list
            if call.args[0].get("event") == "status"
            and call.args[0].get("status") == "browser_observation"
            and call.args[0].get("checkpoint") == "account_home"
        )
        self.assertEqual(
            account_home_observation,
            {
                "event": "status",
                "status": "browser_observation",
                "checkpoint": "account_home",
                "generation": 0,
                "pageKind": "account_manage",
                "connectionAlive": False,
                "inspectionAvailable": True,
                "sessionConfirmed": True,
                "accountHomeConfirmed": True,
                "twofaVisible": False,
                "trustPrompt": False,
                "inputReady": False,
                "codeInputCount": 0,
                "authenticationError": False,
                "rootManageUrl": True,
                "rootAccountMarker": True,
                "rootAuthenticationError": False,
                "rootSecurityCopyOnly": True,
                "retiringChildError": True,
                "childAuthUiPresent": False,
            },
        )

    def test_browser_flow_does_not_launch_a_second_browser_for_an_active_profile(self):
        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            (profile_dir / "parent.lock").write_text("active", encoding="utf-8")
            args = parse_args(
                ["--report-dir", "test-report", "--profile-dir", str(profile_dir)]
            )
            with patch.dict(
                os.environ,
                {
                    "APPLE_ID": "person@example.com",
                    "APPLE_PASSWORD": "secret",
                    "APPLE_AUTOMATION_BROWSER_BROKER_MODE": "0",
                    "BROWSER_ATTACH_EXISTING": "1",
                },
                clear=False,
            ), patch(
                "apple_account_flow.import_ruyipage",
                return_value=(FakeFirefoxOptions, object(), FakeKeys),
            ), patch(
                "apple_account_flow.try_attach_existing_browser_for_flow",
                return_value=(None, "new_browser"),
            ), patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.macos_firefox_process_uses_profile",
                return_value=True,
            ), patch(
                "apple_account_flow.construct_firefox_page",
            ) as construct_page, patch("apple_account_flow.emit") as emit_event:
                with self.assertRaisesRegex(RuntimeError, "active Firefox profile"):
                    browser_flow(args)

        construct_page.assert_not_called()
        self.assertIn(
            {"event": "status", "status": "browser_profile_attach_required"},
            [call.args[0] for call in emit_event.call_args_list],
        )

    def test_browser_flow_launches_when_a_stale_lock_has_no_live_firefox(self):
        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        with tempfile.TemporaryDirectory() as temp_dir:
            profile_dir = Path(temp_dir) / "profile"
            profile_dir.mkdir()
            (profile_dir / "parent.lock").write_text("stale", encoding="utf-8")
            args = parse_args(
                ["--report-dir", "test-report", "--profile-dir", str(profile_dir)]
            )
            no_firefox = type(
                "PsResult", (), {"returncode": 0, "stdout": "1 /sbin/launchd\n"}
            )()
            with patch.dict(
                os.environ,
                {
                    "APPLE_ID": "person@example.com",
                    "APPLE_PASSWORD": "secret",
                    "APPLE_AUTOMATION_BROWSER_BROKER_MODE": "0",
                    "BROWSER_ATTACH_EXISTING": "1",
                },
                clear=False,
            ), patch(
                "apple_account_flow.import_ruyipage",
                return_value=(FakeFirefoxOptions, object(), FakeKeys),
            ), patch(
                "apple_account_flow.try_attach_existing_browser_for_flow",
                return_value=(None, "new_browser"),
            ), patch.object(account_flow.sys, "platform", "darwin"), patch(
                "apple_account_flow.subprocess.run",
                return_value=no_firefox,
            ), patch(
                "apple_account_flow.construct_firefox_page",
                side_effect=RuntimeError("new Firefox launch requested"),
            ) as construct_page, patch("apple_account_flow.emit"):
                with self.assertRaisesRegex(RuntimeError, "new Firefox launch requested"):
                    browser_flow(args)

        construct_page.assert_called_once()

    def test_browser_flow_retries_once_after_an_explicit_first_code_rejection(self):
        root = FakePage(state={"href": "https://account.apple.com/sign-in"})
        root.get = lambda url: root.state.__setitem__("href", url)
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
            return_value=(root, email),
        ), patch(
            "apple_account_flow.wait_for_password_target",
            return_value=(root, password),
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
            "apple_account_flow.wait_for_profile_capture_ready", return_value=None
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"name": "Test Given Test Family", "birthday": "2000-01-02"},
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

    def test_browser_flow_does_not_submit_when_twofa_input_cannot_be_verified(self):
        root = FakePage(state={"href": "https://account.apple.com/sign-in"})
        root.get = lambda url: root.state.__setitem__("href", url)
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
        ), patch(
            "apple_account_flow.detect_login_state", return_value={"trusted": False}
        ), patch(
            "apple_account_flow.wait_for_element",
            return_value=(root, FakeElement()),
        ), patch(
            "apple_account_flow.wait_for_password_target",
            return_value=(root, FakeElement(attrs={"type": "password"})),
        ), patch("apple_account_flow.input_and_verify"), patch(
            "apple_account_flow.submit_element_with_enter"
        ), patch("apple_account_flow.ensure_remember_checked", return_value=True), patch(
            "apple_account_flow.request_two_factor_preparation"
        ), patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value={"trusted": False, "twofa": True},
        ), patch(
            "apple_account_flow.read_command",
            return_value={"type": "2fa_code", "generation": 1, "code": "123456"},
        ), patch(
            "apple_account_flow.wait_for_otp_target",
            return_value=[(root, FakeElement())],
        ), patch(
            "apple_account_flow.fill_security_code",
            side_effect=RuntimeError("2FA digit input verification failed"),
        ), patch("apple_account_flow.click_two_factor_submit") as submit_two_factor, patch(
            "apple_account_flow.human_pause", return_value=None
        ), patch("apple_account_flow.emit"):
            with self.assertRaisesRegex(RuntimeError, "2FA digit input verification failed"):
                browser_flow(args)

        self.assertEqual(account_flow.browser_startup_stage, "twofa_input")
        submit_two_factor.assert_not_called()

    def test_recovered_password_page_skips_email_and_resumes_login(self):
        root = FakePage(state={"href": "https://account.apple.com/sign-in"})
        root.get = lambda url: root.state.__setitem__("href", url)
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
            "apple_account_flow.wait_for_password_target",
            return_value=(root, password),
        ) as wait_for_password_target, patch(
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
            "apple_account_flow.wait_for_profile_capture_ready",
            return_value=None,
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"name": "Test Given Test Family", "birthday": "2000-01-02"},
        ), patch(
            "apple_account_flow.human_pause",
            return_value=None,
        ), patch("apple_account_flow.emit"):
            self.assertEqual(browser_flow(args), 0)

        wait_for_password_target.assert_called_once_with(
            root,
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
        root.get = lambda url: root.state.__setitem__("href", url)
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
            "apple_account_flow.wait_for_profile_capture_ready",
            return_value=None,
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"name": "Test Given Test Family", "birthday": "2000-01-02"},
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
        root.get = lambda url: root.state.__setitem__("href", url)
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
            return_value=(root, FakeElement()),
        ), patch(
            "apple_account_flow.wait_for_password_target",
            return_value=(root, FakeElement(attrs={"type": "password"})),
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
                "trustPrompt": True,
            },
        )
        trust.on_click = lambda: (
            root.state.__setitem__("trustPrompt", False),
            setattr(root, "_shadow_roots", []),
        )
        root.get = lambda url: (
            root.state.__setitem__("href", url)
            if url == account_flow.ACCOUNT_INFORMATION_URL
            else None
        )
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
            "apple_account_flow.wait_for_profile_capture_ready", return_value=None
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"name": "Test Given Test Family", "birthday": "2000-01-02"},
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
        trust.on_click = lambda: (
            root.state.__setitem__("trustPrompt", False),
            setattr(root, "_shadow_roots", []),
        )
        get_calls = []

        def navigate(url):
            get_calls.append(url)
            if len(get_calls) == 2:
                root.state["href"] = url
                root.state["trustPrompt"] = True
                root._shadow_roots = [shadow_root]

        root.get = navigate
        root.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        root.quit = lambda: None

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        def click_without_pause(page, **_kwargs):
            return click_trust_browser(page, pause=lambda *_: None)

        def open_account_tab(page, url):
            page.get(url)
            return page

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
        ), patch(
            "apple_account_flow.open_account_module_tab", side_effect=open_account_tab
        ), patch("apple_account_flow.take_screenshot", return_value=None), patch(
            "apple_account_flow.wait_for_profile_capture_ready", return_value=None
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"name": "Test Given Test Family", "birthday": "2000-01-02"},
        ), patch("apple_account_flow.human_pause", return_value=None), patch(
            "apple_account_flow.emit"
        ):
            self.assertEqual(browser_flow(args), 0)

        self.assertIn(("human_click", trust), root.actions.calls)


class DeveloperFirstSequencingTests(unittest.TestCase):
    @staticmethod
    def _page(url="about:blank"):
        page = FakePage(state={"href": url})
        page.states = FakeStates(alive=True)
        page.wait = type("FakeWait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        page.quit = lambda: None
        page.get_calls = []

        def get(target):
            page.get_calls.append(target)
            page.state["href"] = target

        page.get = get
        return page

    @staticmethod
    def _developer_result(status="active"):
        return {
            "success": True,
            "authenticated": True,
            "membershipStatus": status,
            "failureStage": "unknown",
            "failureClass": "unknown",
            "browserAlive": True,
            "browserPreserved": False,
            "browserPreservationRequested": False,
        }

    @staticmethod
    def _account_authentication_result():
        return {
            "confirmedState": {"trusted": True, "error": False},
            "skippedLogin": True,
            "skipped2FA": True,
            "rememberAccount": None,
        }

    def _run_with_pages(
        self,
        developer_page,
        account_page,
        *,
        developer_result=None,
        developer_error=None,
        gate="0",
        expected_error: str | None = None,
        preserve_on_failure="0",
    ):
        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        events = []
        developer_contexts = []
        account_contexts = []
        developer_page.new_tab = lambda url: (
            setattr(developer_page, "opened_account_url", url) or account_page
        )

        def collect_developer(page, *_args, **kwargs):
            developer_contexts.append(_args[3])
            holder = kwargs.get("page_holder")
            if isinstance(holder, dict):
                holder["page"] = page
            self.assertFalse(kwargs["open_in_new_tab"])
            if developer_error is not None:
                raise developer_error
            return developer_result or self._developer_result(), page, None

        def complete_account(page, *_args, **kwargs):
            account_contexts.append(kwargs["authentication_context"])
            self.assertIs(page, account_page)
            return self._account_authentication_result()

        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {
                "APPLE_ID": "person@example.com",
                "APPLE_PASSWORD": "secret",
                "DEVELOPER_MEMBERSHIP_GATE": gate,
                "BROWSER_PRESERVE_ON_FAILURE": preserve_on_failure,
                "BROWSER_PRESERVE_ON_SUCCESS": "0",
            },
            clear=False,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: developer_page, FakeKeys),
        ), patch(
            "apple_account_flow.try_attach_existing_browser_for_flow",
            return_value=(None, "new_tab"),
        ), patch(
            "apple_account_flow.collect_developer_account_membership",
            side_effect=collect_developer,
        ), patch(
            "apple_account_flow.complete_account_authentication",
            side_effect=complete_account,
        ), patch(
            "apple_account_flow.reach_personal_information_page", return_value=None
        ), patch(
            "apple_account_flow.detect_login_state", return_value={"trusted": True, "error": False}
        ), patch(
            "apple_account_flow.settle_trust_state", side_effect=lambda _page, state, **_kwargs: state
        ), patch(
            "apple_account_flow.wait_for_profile_capture_ready", return_value=None
        ), patch(
            "apple_account_flow.take_screenshot", return_value=None
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"name": "Test Given Test Family", "birthday": "2000-01-02"},
        ), patch(
            "apple_account_flow.change_account_password",
            return_value={
                "success": True,
                "attempted": True,
                "passwordStored": True,
                "passwordLength": 16,
                "newPassword": "RotatedA2!fixtrX",
                "failureStage": "unknown",
                "failureClass": "unknown",
                "browserAlive": True,
                "browserPreserved": False,
                "browserPreservationRequested": False,
            },
        ), patch(
            "apple_account_flow.apply_small_business_program",
            return_value=(
                {
                    "success": True,
                    "attempted": True,
                    "submitted": True,
                    "failureStage": "unknown",
                    "failureClass": "unknown",
                    "browserAlive": True,
                    "browserPreserved": False,
                    "browserPreservationRequested": False,
                },
                account_page,
                None,
            ),
        ), patch(
            "apple_account_flow.finalize_post_login_browser",
            return_value={
                "browserFinalizationCompleted": True,
                "browserPreservationRequested": False,
                "browserSessionPreserved": False,
                "finalizationClass": "completed",
            },
        ), patch("apple_account_flow.human_pause", return_value=None), patch(
            "apple_account_flow.emit", side_effect=events.append
        ):
            if expected_error is None:
                self.assertEqual(browser_flow(args), 0)
            else:
                with self.assertRaisesRegex(RuntimeError, expected_error):
                    browser_flow(args)

        return events, developer_contexts, account_contexts

    def test_developer_uses_initial_tab_then_account_uses_one_new_tab_and_shared_context(self):
        developer_page = self._page()
        account_page = self._page()

        events, developer_contexts, account_contexts = self._run_with_pages(
            developer_page,
            account_page,
            gate="1",
        )

        self.assertEqual(developer_page.opened_account_url, "https://appleid.apple.com/sign-in")
        self.assertEqual(len(developer_contexts), 1)
        self.assertEqual(len(account_contexts), 1)
        self.assertIs(developer_contexts[0], account_contexts[0])
        self.assertTrue(
            any(event.get("status") == "account_module_tab_created" for event in events)
        )

    def test_gate_disabled_continues_to_account_for_non_member(self):
        developer_page = self._page()
        account_page = self._page()

        _events, _developer_contexts, account_contexts = self._run_with_pages(
            developer_page,
            account_page,
            developer_result=self._developer_result("not_enrolled"),
            gate="0",
        )

        self.assertEqual(len(account_contexts), 1)
        self.assertEqual(developer_page.opened_account_url, "https://appleid.apple.com/sign-in")

    def test_gate_disabled_continues_to_account_for_authenticated_unknown_membership(self):
        developer_page = self._page()
        account_page = self._page()

        events, _developer_contexts, account_contexts = self._run_with_pages(
            developer_page,
            account_page,
            developer_result=self._developer_result("unknown"),
            gate="0",
        )

        self.assertEqual(len(account_contexts), 1)
        self.assertEqual(
            developer_page.opened_account_url,
            "https://appleid.apple.com/sign-in",
        )
        result = next(event for event in events if event.get("event") == "result")
        self.assertEqual(
            result["accountModule"],
            {
                "attempted": True,
                "skipped": False,
                "skipReason": "unknown",
                "membershipGateEnabled": False,
                "membershipGatePassed": True,
            },
        )

    def test_unauthenticated_developer_failure_never_opens_account_tab_for_any_gate(self):
        for gate in ("0", "1"):
            with self.subTest(gate=gate):
                developer_page = self._page()
                account_page = self._page()
                events, _developer_contexts, account_contexts = self._run_with_pages(
                    developer_page,
                    account_page,
                    developer_error=RuntimeError("developer login session was not confirmed"),
                    gate=gate,
                    expected_error="developer account authentication did not complete before account module",
                    preserve_on_failure="1",
                )

                self.assertEqual(account_contexts, [])
                self.assertFalse(hasattr(developer_page, "opened_account_url"))
                self.assertFalse(
                    any(
                        event.get("status") in {"account_module_started", "account_module_tab_created"}
                        for event in events
                    )
                )
                failure_event = next(
                    event
                    for event in events
                    if event.get("status") == "developer_account_failed"
                )
                self.assertFalse(failure_event["authenticated"])
                self.assertTrue(
                    any(
                        event.get("status") == "browser_preserved"
                        and event.get("preserved") is True
                        for event in events
                    )
                )

    def test_membership_gate_requires_authenticated_developer_account(self):
        cases = (
            ("0", True, True, "active", True),
            ("0", False, True, "unknown", True),
            ("0", False, False, "unknown", False),
            ("1", True, True, "active", True),
            ("1", False, True, "active", False),
            ("1", True, True, "unknown", False),
            ("1", True, False, "active", False),
        )
        for gate, success, authenticated, membership_status, expected in cases:
            with self.subTest(
                gate=gate,
                success=success,
                authenticated=authenticated,
                membership_status=membership_status,
            ):
                self.assertIs(
                    account_flow.developer_membership_allows_account(
                        {
                            "success": success,
                            "authenticated": authenticated,
                            "membershipStatus": membership_status,
                        },
                        gate_enabled=gate == "1",
                    ),
                    expected,
                )

    def test_gate_enabled_blocks_authenticated_non_active_before_new_tab(self):
        cases = (
            (self._developer_result("not_enrolled"), None),
            (self._developer_result("unknown"), None),
        )
        for developer_result, developer_error in cases:
            with self.subTest(
                membership=(developer_result or {}).get("membershipStatus", "failure")
            ):
                developer_page = self._page()
                account_page = self._page()
                events, _developer_contexts, account_contexts = self._run_with_pages(
                    developer_page,
                    account_page,
                    developer_result=developer_result,
                    developer_error=developer_error,
                    gate="1",
                )

                self.assertEqual(account_contexts, [])
                self.assertFalse(hasattr(developer_page, "opened_account_url"))
                result = next(event for event in events if event.get("event") == "result")
                self.assertTrue(result["success"])
                self.assertFalse(result["browserLogin"]["accountHomeConfirmed"])
                self.assertEqual(
                    result["accountModule"],
                    {
                        "attempted": False,
                        "skipped": True,
                        "skipReason": "developer_membership_gate",
                        "membershipGateEnabled": True,
                        "membershipGatePassed": False,
                    },
                )
                gate_event = next(
                    event
                    for event in events
                    if event.get("status") == "developer_membership_gate_blocked"
                )
                self.assertEqual(
                    gate_event["developerResultSucceeded"],
                    developer_result is not None,
                )

    def test_current_tab_developer_collection_navigates_before_authentication(self):
        page = self._page("https://account.apple.com/account/manage")
        contexts = []
        context = {"twofaPrepared": False, "nextGeneration": 1}

        def complete_developer(page_arg, *_args, **kwargs):
            self.assertIs(page_arg, page)
            contexts.append(kwargs["authentication_context"])
            self.assertFalse(kwargs["account_home_confirmed"])
            return {
                "confirmedState": {"developerAccountShell": True},
                "skippedLogin": False,
                "skipped2FA": False,
                "rememberAccount": None,
            }

        with patch(
            "apple_account_flow.complete_account_authentication",
            side_effect=complete_developer,
        ), patch("apple_account_flow.human_pause", return_value=None), patch(
            "apple_account_flow.emit"
        ), patch(
            "apple_account_flow.confirm_active_developer_membership",
            return_value=False,
        ) as confirm_active:
            result, returned_page, _screenshot = account_flow.collect_developer_account_membership(
                page,
                "person@example.com",
                "secret",
                FakeKeys,
                context,
                Path("test-developer.png"),
                open_in_new_tab=False,
            )

        self.assertIs(returned_page, page)
        self.assertTrue(result["success"])
        self.assertEqual(page.get_calls, [account_flow.DEVELOPER_ACCOUNT_URL])
        self.assertEqual(contexts, [context])
        confirm_active.assert_called_once_with(page)

    def test_account_tab_failure_keeps_developer_membership_screenshot(self):
        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        developer_page = self._page()
        developer_page.new_tab = lambda _url: (_ for _ in ()).throw(RuntimeError("new tab failed"))
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            screenshot_path = report_dir / "screenshots" / "03-developer-membership.png"
            screenshot_path.parent.mkdir(parents=True)
            screenshot_path.write_text("developer membership", encoding="utf-8")
            args = parse_args(["--report-dir", str(report_dir)])

            def collect_developer(page, *_args, **kwargs):
                holder = kwargs.get("page_holder")
                if isinstance(holder, dict):
                    holder["page"] = page
                return self._developer_result(), page, str(screenshot_path)

            with patch.dict(
                os.environ,
                {
                    "APPLE_ID": "person@example.com",
                    "APPLE_PASSWORD": "secret",
                    "BROWSER_PRESERVE_ON_FAILURE": "0",
                    "BROWSER_PRESERVE_ON_SUCCESS": "0",
                },
                clear=False,
            ), patch(
                "apple_account_flow.import_ruyipage",
                return_value=(FakeFirefoxOptions, lambda _opts: developer_page, FakeKeys),
            ), patch(
                "apple_account_flow.try_attach_existing_browser_for_flow",
                return_value=(None, "new_tab"),
            ), patch(
                "apple_account_flow.collect_developer_account_membership",
                side_effect=collect_developer,
            ), patch("apple_account_flow.human_pause", return_value=None), patch(
                "apple_account_flow.emit"
            ):
                with self.assertRaisesRegex(RuntimeError, "new account module tab could not be created"):
                    browser_flow(args)

            self.assertTrue(screenshot_path.exists())

    def test_membership_gate_requires_the_exact_value_one(self):
        for value, expected in (("1", True), ("0", False), ("true", False), (" yes ", False), ("", False)):
            with self.subTest(value=value):
                with patch.dict(
                    os.environ, {account_flow.DEVELOPER_MEMBERSHIP_GATE_ENV: value}, clear=False
                ):
                    self.assertIs(account_flow.developer_membership_gate_enabled(), expected)


class SafeFailureBoundaryTests(unittest.TestCase):
    def setUp(self):
        def completed_developer_membership(page, *_args, **kwargs):
            page_holder = kwargs.get("page_holder")
            if isinstance(page_holder, dict):
                page_holder["page"] = page
            return (
                {
                    "success": True,
                    "authenticated": True,
                    "membershipStatus": "active",
                    "failureStage": "unknown",
                    "failureClass": "unknown",
                    "browserAlive": True,
                    "browserPreserved": False,
                    "browserPreservationRequested": False,
                },
                page,
                None,
            )

        self._developer_membership_patch = patch(
            "apple_account_flow.collect_developer_account_membership",
            side_effect=completed_developer_membership,
        )
        self._account_tab_patch = patch(
            "apple_account_flow.open_account_module_tab",
            side_effect=lambda page, _url: page,
        )
        self._developer_membership_mock = self._developer_membership_patch.start()
        self._account_tab_mock = self._account_tab_patch.start()

    def tearDown(self):
        self._account_tab_patch.stop()
        self._developer_membership_patch.stop()

    SECRET_SENTINEL = "?token=SECRET"

    class DiskScreenshotPage:
        def __init__(self, secret, *, quit_fails=False):
            self.secret = secret
            self.quit_fails = quit_fails
            self.current_url = "about:blank"
            self.wait = type(
                "FakeWait",
                (),
                {"doc_loaded": lambda *_args, **_kwargs: None},
            )()

        def get(self, url):
            self.current_url = url

        def run_js(self, script):
            if "location.href" in script:
                return self.current_url
            raise RuntimeError("unexpected JavaScript query")

        def screenshot(self, path, *, full_page):
            self.assert_full_page = full_page
            Path(path).write_text(self.secret, encoding="utf-8")

        def quit(self):
            if self.quit_fails:
                raise RuntimeError("quit failed")

    def run_late_flow(
        self,
        report_dir,
        page,
        final_state,
        personal_info,
        events,
        event_sink=None,
        wait_ready_side_effect=None,
        collect_side_effect=None,
        password_change_result=None,
        small_business_result=None,
        password_change_side_effect=None,
        small_business_side_effect=None,
    ):
        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        password_change_result = password_change_result or {
            "success": True,
            "attempted": True,
            "passwordStored": True,
            "passwordLength": 16,
            "newPassword": "RotatedA2!fixtrX",
            "failureStage": "unknown",
            "failureClass": "unknown",
            "browserAlive": True,
            "browserPreserved": False,
            "browserPreservationRequested": False,
        }
        small_business_result = small_business_result or {
            "success": True,
            "attempted": True,
            "submitted": True,
            "failureStage": "unknown",
            "failureClass": "unknown",
            "browserAlive": True,
            "browserPreserved": False,
            "browserPreservationRequested": False,
        }
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
            "apple_account_flow.wait_for_profile_capture_ready",
            side_effect=wait_ready_side_effect or (lambda _page: None),
        ), patch(
            "apple_account_flow.collect_personal_info",
            side_effect=collect_side_effect or (lambda _page: personal_info),
        ), patch(
            "apple_account_flow.change_account_password",
            side_effect=password_change_side_effect,
            return_value=password_change_result,
        ), patch(
            "apple_account_flow.apply_small_business_program",
            side_effect=small_business_side_effect,
            return_value=(small_business_result, None, None),
        ), patch(
            "apple_account_flow.human_pause",
            return_value=None,
        ), patch(
            "apple_account_flow.emit",
            side_effect=event_sink or events.append,
        ):
            return browser_flow(args)

    def test_late_authentication_failure_is_a_profile_partial_result(self):
        secret = "person@example.com OTP 123456"
        events = []
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            page = self.DiskScreenshotPage(secret)

            self.assertEqual(
                self.run_late_flow(
                    report_dir,
                    page,
                    {
                        "trusted": False,
                        "error": True,
                        "rootError": True,
                        "hardAuthenticationError": True,
                        "rootHardAuthenticationError": True,
                    },
                    {"name": "Test Given Test Family", "birthday": "2000-01-02"},
                    events,
                ),
                0,
            )

            self.assertEqual(
                sorted(path.name for path in report_dir.rglob("*.png")),
                [],
            )
            result = next(event for event in events if event.get("event") == "result")
            self.assertTrue(result["success"])
            self.assertTrue(result["browserLogin"]["accountHomeConfirmed"])
            self.assertEqual(result["personalInfo"], {})
            self.assertEqual(
                result["postLoginProfileCapture"],
                {
                    "success": False,
                    "failureStage": "profile_capture",
                    "failureClass": "profile_authentication_error",
                    "browserAlive": False,
                    "browserPreserved": False,
                    "browserPreservationRequested": True,
                },
            )
            self.assertNotIn(secret, json.dumps(events))

    def test_stable_information_anchor_overrides_stale_text_only_auth_copy(self):
        secret = "person@example.com OTP 123456"
        events = []
        stale_state = {
            "trusted": False,
            "error": True,
            "rootError": True,
            "twofa": True,
            "twofaVisible": True,
            "codeInputCount": 0,
            "password": False,
            "email": False,
            "trustPrompt": False,
            "otpRejected": False,
            "blocked": False,
            "hardAuthenticationError": True,
            "rootHardAuthenticationError": True,
            "childAuthUiPresent": False,
            "activeAuthUiPresent": False,
            "activeOtpRejected": False,
            "activeBlocked": False,
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            page = self.DiskScreenshotPage(secret)

            self.assertEqual(
                self.run_late_flow(
                    report_dir,
                    page,
                    stale_state,
                    {
                        "name": "Test Given Test Family",
                        "birthday": "2000-01-02",
                    },
                    events,
                    wait_ready_side_effect=lambda _page: (
                        account_flow.confirmed_personal_information_state(
                            stale_state
                        )
                    ),
                ),
                0,
            )

            result = next(event for event in events if event.get("event") == "result")
            self.assertTrue(result["postLoginProfileCapture"]["success"])
            self.assertEqual(
                sorted(path.name for path in report_dir.rglob("*.png")),
                ["02-account-information.png"],
            )
            self.assertNotIn(secret, json.dumps(events))

    def test_information_screenshot_is_after_cards_and_before_profile_collection(self):
        order = []

        class OrderedScreenshotPage(self.DiskScreenshotPage):
            def __init__(self, secret):
                super().__init__(secret)
                self.urls = []

            def get(self, url):
                self.urls.append(url)
                super().get(url)

            def screenshot(self, path, *, full_page):
                order.append("screenshot")
                super().screenshot(path, full_page=full_page)

        final_state = {"trusted": True, "error": False}
        personal_info = {
            "name": "Test Given Test Family",
            "birthday": "2000-01-02",
        }
        events = []
        with tempfile.TemporaryDirectory() as temp_dir:
            page = OrderedScreenshotPage("redacted screenshot")

            def cards_ready(_page):
                order.append("cards_ready")
                return account_flow.confirmed_personal_information_state(
                    final_state
                )

            def collect(_page):
                order.extend(("birthday_read", "name_modal_opened"))
                return personal_info

            self.assertEqual(
                self.run_late_flow(
                    Path(temp_dir),
                    page,
                    final_state,
                    personal_info,
                    events,
                    wait_ready_side_effect=cards_ready,
                    collect_side_effect=collect,
                ),
                0,
            )

        self.assertEqual(
            order,
            [
                "cards_ready",
                "screenshot",
                "birthday_read",
                "name_modal_opened",
            ],
        )

    def test_result_stage_is_completed_only_after_the_result_is_emitted(self):
        result = {"event": "result", "success": True}
        emitted = []

        def fail_result(event):
            emitted.append(event)
            if event.get("event") == "result":
                raise BrokenPipeError("test result write failed")

        with patch.object(
            account_flow, "browser_startup_stage", "post_login_finalization"
        ), patch.object(account_flow, "browser_stage_file", None), patch(
            "apple_account_flow.emit", side_effect=fail_result
        ):
            with self.assertRaises(BrokenPipeError):
                account_flow.emit_browser_result(result)
            self.assertEqual(account_flow.browser_startup_stage, "result_emitting")
            self.assertEqual(
                emitted,
                [
                    {
                        "event": "status",
                        "status": "browser_stage",
                        "stage": "result_emitting",
                        "previousStage": "post_login_finalization",
                        "transition": "entered",
                    },
                    result,
                ],
            )

        emitted.clear()
        with patch.object(
            account_flow, "browser_startup_stage", "post_login_finalization"
        ), patch.object(account_flow, "browser_stage_file", None), patch(
            "apple_account_flow.emit", side_effect=emitted.append
        ):
            account_flow.emit_browser_result(result)
            self.assertEqual(account_flow.browser_startup_stage, "result_emitted")
            self.assertEqual(
                [event.get("stage") for event in emitted if event.get("event") == "status"],
                ["result_emitting"],
            )
            self.assertIs(emitted[-1], result)

    def test_personal_info_parse_failure_is_a_profile_partial_result(self):
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
                    {"name": None, "birthday": None},
                    events,
                ),
                0,
            )

            self.assertEqual(
                sorted(path.name for path in report_dir.rglob("*.png")),
                ["02-account-information.png"],
            )
            result = next(event for event in events if event.get("event") == "result")
            self.assertEqual(
                result["postLoginProfileCapture"]["failureClass"],
                "profile_data_incomplete",
            )
            self.assertNotIn(secret, json.dumps(events))

    def test_profile_name_modal_cleanup_failure_blocks_password_and_small_business(self):
        events = []
        password_change = Mock(name="change_account_password")
        small_business = Mock(name="apply_small_business_program")

        with tempfile.TemporaryDirectory() as temp_dir:
            result_code = self.run_late_flow(
                Path(temp_dir),
                self.DiskScreenshotPage("redacted"),
                {"trusted": True, "error": False},
                {"name": "Given Family", "birthday": "2000-01-02"},
                events,
                collect_side_effect=lambda _page: (_ for _ in ()).throw(
                    RuntimeError("personal information name modal cleanup failed")
                ),
                password_change_side_effect=password_change,
                small_business_side_effect=small_business,
            )

        self.assertEqual(result_code, 0)
        password_change.assert_not_called()
        small_business.assert_not_called()
        result = next(event for event in events if event.get("event") == "result")
        self.assertEqual(
            result["postLoginProfileCapture"]["failureClass"],
            "profile_name_modal_cleanup_failed",
        )
        self.assertFalse(result["postLoginProfileCapture"]["success"])
        statuses = [event.get("status") for event in events]
        self.assertNotIn("profile_capture_completed", statuses)

    def test_profile_capture_failure_keeps_personal_information_screenshot_and_browser(self):
        class PreservedProfilePage(self.DiskScreenshotPage):
            def __init__(self, secret):
                super().__init__(secret)
                self.states = type("FakeStates", (), {"is_alive": True})()
                self.quit_calls = 0

            def quit(self):
                self.quit_calls += 1
                super().quit()

        secret = "person@example.com OTP 123456"
        events = []
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            page = PreservedProfilePage(secret)
            with patch.dict(
                os.environ,
                {
                    "BROWSER_PRESERVE_ON_FAILURE": "1",
                    "BROWSER_PRESERVE_ON_SUCCESS": "1",
                },
                clear=False,
            ):
                self.assertEqual(
                    self.run_late_flow(
                        report_dir,
                        page,
                        {"trusted": True, "error": False},
                        {"name": None, "birthday": None},
                        events,
                    ),
                    0,
                )

            self.assertEqual(
                sorted(path.name for path in report_dir.rglob("*.png")),
                ["02-account-information.png"],
            )
            self.assertEqual(page.quit_calls, 0)
            self.assertIn(
                {
                    "event": "status",
                    "status": "browser_session_preserved",
                    "preserved": True,
                    "profileCaptureSuccess": False,
                },
                events,
            )
            result = next(event for event in events if event.get("event") == "result")
            self.assertEqual(result["personalInfo"], {})
            self.assertEqual(
                result["postLoginProfileCapture"],
                {
                    "success": False,
                    "failureStage": "profile_birthday",
                    "failureClass": "profile_data_incomplete",
                    "browserAlive": True,
                    "browserPreserved": True,
                    "browserPreservationRequested": True,
                },
            )
            self.assertTrue(
                result["postLoginDeveloperAccount"]["browserPreserved"]
            )
            self.assertLess(
                events.index(
                    {
                        "event": "status",
                        "status": "browser_session_preserved",
                        "preserved": True,
                        "profileCaptureSuccess": False,
                    }
                ),
                events.index(result),
            )
            self.assertNotIn(secret, json.dumps(events))

    def test_profile_capture_does_not_claim_preservation_after_connection_disappears(self):
        class FlappingProfilePage(self.DiskScreenshotPage):
            def __init__(self, secret):
                super().__init__(secret)
                self.is_alive = True
                self.quit_calls = 0

            @property
            def states(self):
                return type("FakeStates", (), {"is_alive": self.is_alive})()

            def quit(self):
                self.quit_calls += 1
                super().quit()

        secret = "person@example.com OTP 123456"
        events = []
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            page = FlappingProfilePage(secret)

            def record(event):
                events.append(event)
                if event.get("status") == "profile_capture_failed":
                    page.is_alive = False

            with patch.dict(
                os.environ,
                {
                    "BROWSER_PRESERVE_ON_FAILURE": "1",
                    "BROWSER_PRESERVE_ON_SUCCESS": "1",
                },
                clear=False,
            ):
                self.assertEqual(
                    self.run_late_flow(
                        report_dir,
                        page,
                        {"trusted": True, "error": False},
                        {"name": None, "birthday": None},
                        events,
                        event_sink=record,
                    ),
                    0,
                )

            result = next(event for event in events if event.get("event") == "result")
            self.assertTrue(
                result["postLoginProfileCapture"]["browserPreservationRequested"]
            )
            self.assertFalse(result["postLoginProfileCapture"]["browserPreserved"])
            self.assertEqual(page.quit_calls, 0)
            self.assertEqual(
                result["postLoginFinalization"],
                {
                    "browserFinalizationCompleted": False,
                    "browserPreservationRequested": True,
                    "browserSessionPreserved": False,
                    "finalizationClass": "browser_connection_lost",
                },
            )
            self.assertIn(
                {
                    "event": "status",
                    "status": "browser_finalization_partial",
                    "browserFinalizationCompleted": False,
                    "browserPreservationRequested": True,
                    "browserSessionPreserved": False,
                    "finalizationClass": "browser_connection_lost",
                },
                events,
            )
            self.assertNotIn(
                "browser_session_preserved",
                [event.get("status") for event in events],
            )
            self.assertNotIn(secret, json.dumps(events))

    def test_quit_failure_after_account_home_keeps_success_screenshots_and_reports_partial_finalization(self):
        secret = "person@example.com OTP 123456"
        events = []
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            page = self.DiskScreenshotPage(secret, quit_fails=True)
            page.states = FakeStates(alive=True)

            with patch.dict(
                os.environ,
                {
                    "BROWSER_PRESERVE_ON_FAILURE": "0",
                    "BROWSER_PRESERVE_ON_SUCCESS": "0",
                },
                clear=False,
            ):
                self.assertEqual(
                    self.run_late_flow(
                        report_dir,
                        page,
                        {"trusted": True, "error": False},
                        {"name": "Test Given Test Family", "birthday": "2000-01-02"},
                        events,
                    ),
                    0,
                )

            result = next(event for event in events if event.get("event") == "result")
            self.assertTrue(result["success"])
            self.assertTrue(result["browserLogin"]["accountHomeConfirmed"])
            self.assertEqual(
                result["postLoginFinalization"],
                {
                    "browserFinalizationCompleted": False,
                    "browserPreservationRequested": False,
                    "browserSessionPreserved": False,
                    "finalizationClass": "browser_quit_failed",
                },
            )
            self.assertEqual(
                sorted(path.name for path in report_dir.rglob("*.png")),
                ["02-account-information.png"],
            )
            self.assertIn(
                {
                    "event": "status",
                    "status": "browser_finalization_partial",
                    "browserFinalizationCompleted": False,
                    "browserPreservationRequested": False,
                    "browserSessionPreserved": False,
                    "finalizationClass": "browser_quit_failed",
                },
                events,
            )
            self.assertNotIn(secret, json.dumps(events))

    def test_post_login_disconnect_without_preservation_is_a_partial_finalization(self):
        class DisconnectedProfilePage(self.DiskScreenshotPage):
            def __init__(self, secret):
                super().__init__(secret)
                self.states = FakeStates(alive=False)
                self.quit_calls = 0

            def quit(self):
                self.quit_calls += 1
                super().quit()

        secret = "person@example.com OTP 123456"
        events = []
        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            page = DisconnectedProfilePage(secret)
            with patch.dict(
                os.environ,
                {
                    "BROWSER_PRESERVE_ON_FAILURE": "0",
                    "BROWSER_PRESERVE_ON_SUCCESS": "0",
                },
                clear=False,
            ):
                self.assertEqual(
                    self.run_late_flow(
                        report_dir,
                        page,
                        {"trusted": True, "error": False},
                        {"name": "Test Given Test Family", "birthday": "2000-01-02"},
                        events,
                    ),
                    0,
                )

            result = next(event for event in events if event.get("event") == "result")
            self.assertTrue(result["success"])
            self.assertTrue(result["browserLogin"]["accountHomeConfirmed"])
            self.assertEqual(page.quit_calls, 0)
            self.assertEqual(
                result["postLoginFinalization"],
                {
                    "browserFinalizationCompleted": False,
                    "browserPreservationRequested": False,
                    "browserSessionPreserved": False,
                    "finalizationClass": "browser_connection_lost",
                },
            )
            self.assertIn(
                {
                    "event": "status",
                    "status": "browser_finalization_partial",
                    "browserFinalizationCompleted": False,
                    "browserPreservationRequested": False,
                    "browserSessionPreserved": False,
                    "finalizationClass": "browser_connection_lost",
                },
                events,
            )
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
                    {"name": "Test Given Test Family", "birthday": "2000-01-02"},
                    events,
                ),
                0,
            )

            screenshots = sorted(path.name for path in report_dir.rglob("*.png"))
            self.assertEqual(
                screenshots,
                ["02-account-information.png"],
            )
            self.assertIn(
                {
                    "event": "status",
                    "status": "screenshot_capture",
                    "checkpoint": "account_information",
                },
                events,
            )

    def test_early_failure_does_not_delete_fixed_screenshots_from_an_older_run(self):
        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        class FailingPage:
            states = FakeStates(alive=True)

            def get(self, _url):
                raise RuntimeError("navigation failed")

            def quit(self):
                raise RuntimeError("quit failed")

        with tempfile.TemporaryDirectory() as temp_dir:
            report_dir = Path(temp_dir)
            screenshots_dir = report_dir / "screenshots"
            screenshots_dir.mkdir(parents=True)
            older_files = (
                screenshots_dir / "02-account-information.png",
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
            ), patch(
                "apple_account_flow.try_attach_existing_browser_for_flow",
                return_value=(None, "new_tab"),
            ), patch("apple_account_flow.emit"):
                self._account_tab_mock.side_effect = (
                    lambda page, *_args, **_kwargs: (
                        account_flow.set_browser_startup_stage("account_navigation"),
                        page.get("https://appleid.apple.com/sign-in"),
                    )[-1]
                )
                with self.assertRaisesRegex(RuntimeError, "navigation failed"):
                    browser_flow(args)

            self.assertEqual(
                [path.read_text(encoding="utf-8") for path in older_files],
                ["older run"],
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
            result = account_flow.take_screenshot(
                FailingScreenshotPage(),
                FakePath(),
                checkpoint="account_information",
            )

        self.assertIsNone(result)
        self.assertEqual(
            emit_event.call_args.args[0],
            {
                "event": "status",
                "status": "screenshot_failed",
                "checkpoint": "account_information",
            },
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
            {
                "APPLE_ID": "person@example.com",
                "APPLE_PASSWORD": "secret",
                "BROWSER_PRESERVE_ON_FAILURE": "0",
            },
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

    def test_direct_failure_preserves_firefox_for_manual_inspection(self):
        class FakeFirefoxOptions:
            def __init__(self):
                self.close_on_exit_values = []

            def close_on_exit(self, value):
                self.close_on_exit_values.append(value)

            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        class FailingPage:
            def __init__(self):
                self.quit_calls = 0
                self.states = FakeStates(alive=True)

            def get(self, _url):
                raise RuntimeError("navigation failed")

            def quit(self):
                self.quit_calls += 1

        options = FakeFirefoxOptions()
        page = FailingPage()
        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=True,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(lambda: options, lambda _opts: page, FakeKeys),
        ), patch(
            "apple_account_flow.try_attach_existing_browser_for_flow",
            return_value=(None, "new_tab"),
        ), patch("apple_account_flow.emit") as emit_event:
            self._account_tab_mock.side_effect = (
                lambda page, *_args, **_kwargs: (
                    account_flow.set_browser_startup_stage("account_navigation"),
                    page.get("https://appleid.apple.com/sign-in"),
                )[-1]
            )
            with self.assertRaisesRegex(RuntimeError, "navigation failed"):
                browser_flow(args)

        self.assertEqual(options.close_on_exit_values, [False])
        self.assertEqual(page.quit_calls, 0)
        self.assertIn(
                {
                    "event": "status",
                    "status": "browser_preserved",
                    "failureStage": "account_navigation",
                    "preserved": True,
                },
            [call.args[0] for call in emit_event.call_args_list],
        )

    def test_direct_failure_does_not_claim_a_dead_browser_was_preserved(self):
        class FakeFirefoxOptions:
            def close_on_exit(self, _value):
                return None

            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        class FailingPage:
            def __init__(self):
                self.quit_calls = 0
                self.states = FakeStates(alive=False)

            def get(self, _url):
                raise RuntimeError("navigation failed")

            def quit(self):
                self.quit_calls += 1

        page = FailingPage()
        args = parse_args(["--report-dir", "test-report"])
        with patch.dict(
            os.environ,
            {"APPLE_ID": "person@example.com", "APPLE_PASSWORD": "secret"},
            clear=True,
        ), patch(
            "apple_account_flow.import_ruyipage",
            return_value=(FakeFirefoxOptions, lambda _opts: page, FakeKeys),
        ), patch(
            "apple_account_flow.try_attach_existing_browser_for_flow",
            return_value=(None, "new_tab"),
        ), patch("apple_account_flow.emit") as emit_event:
            self._account_tab_mock.side_effect = (
                lambda page, *_args, **_kwargs: (
                    account_flow.set_browser_startup_stage("account_navigation"),
                    page.get("https://appleid.apple.com/sign-in"),
                )[-1]
            )
            with self.assertRaisesRegex(RuntimeError, "navigation failed"):
                browser_flow(args)

        self.assertEqual(page.quit_calls, 1)
        self.assertNotIn(
            "browser_preserved",
            [call.args[0].get("status") for call in emit_event.call_args_list],
        )

    def test_authentication_failure_does_not_persist_a_failure_screenshot(self):
        order = []

        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        class FailingAuthenticationPage:
            states = FakeStates(alive=True)

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
        ), patch(
            "apple_account_flow.try_attach_existing_browser_for_flow",
            return_value=(None, "new_tab"),
        ), patch("apple_account_flow.take_screenshot") as take_screenshot, patch(
            "apple_account_flow.emit",
            side_effect=lambda event: order.append(("event", event)),
        ) as emit_event:
            self._account_tab_mock.side_effect = (
                lambda page, *_args, **_kwargs: (
                    account_flow.set_browser_startup_stage("account_navigation"),
                    page.get("https://appleid.apple.com/sign-in"),
                )[-1]
            )
            with self.assertRaisesRegex(RuntimeError, "authentication navigation failed"):
                browser_flow(args)

        take_screenshot.assert_not_called()
        self.assertIn(
            {
                    "event": "status",
                    "status": "browser_failure",
                    "failureStage": "account_navigation",
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
            ), patch("apple_account_flow.browser_startup_stage", "not_started"), patch(
                "apple_account_flow.emit"
            ) as emit_event, redirect_stderr(stderr):
                return_code = run_cli([])
        finally:
            account_flow.configure_diagnostic_secrets()

        self.assertEqual(return_code, 1)
        events = [call.args[0] for call in emit_event.call_args_list]
        self.assertEqual(
            events[0],
            {
                "event": "status",
                "status": "browser_failure",
                "failureStage": "not_started",
            },
        )
        self.assertEqual(events[1]["event"], "diagnostic")
        self.assertEqual(events[1]["kind"], "python_exception")
        self.assertEqual(events[1]["errorType"], "RuntimeError")
        self.assertEqual(events[1]["errorClass"], "browser_exception")
        self.assertIs(events[1]["hasTraceback"], True)
        self.assertNotIn("message", events[1])
        self.assertNotIn("traceback", events[1])
        self.assertNotIn(self.SECRET_SENTINEL, json.dumps(events[1]))
        self.assertNotIn("123 456", json.dumps(events[1]))
        self.assertNotIn("user:pw@", json.dumps(events[1]))
        self.assertNotIn("?token=secret", json.dumps(events[1]))
        self.assertEqual(
            events[-1],
            {
                "event": "result",
                "success": False,
                "error": "ruyipage_browser_flow_failed",
                "failureStage": "not_started",
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

    def test_manage_security_copy_only_neutralizes_generic_twofa_and_error_text(self):
        class ManageSecurityCopyScope:
            def __init__(self):
                self.script = ""

            def run_js(self, script):
                self.script = script
                return json.dumps(
                    {
                        "href": "https://account.apple.com/account/manage",
                        "hasStrongTwoFactorText": True,
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                        "codeInputCount": 0,
                        "password": False,
                        "email": False,
                        "trustPrompt": False,
                        "otpRejected": False,
                        "blocked": False,
                        "hardAuthenticationError": False,
                        "genericAuthText": True,
                        "securityFeatureCopy": True,
                        "error": True,
                        "accountManage": True,
                        "accountMarker": True,
                    }
                )

        scope = ManageSecurityCopyScope()
        state = account_flow.detect_scope_login_state(scope)

        self.assertTrue(state["securityCopyOnly"])
        self.assertTrue(state["securityFeatureCopy"])
        self.assertFalse(state["twofa"])
        self.assertFalse(state["error"])
        self.assertTrue(state["trusted"])
        self.assertIn("const genericAuthText", scope.script)
        self.assertIn("const hardAuthenticationError", scope.script)
        self.assertIn("const securityFeatureCopy", scope.script)
        self.assertIn("hasStaticAccountSecurityFeatureCard", scope.script)

    def test_manage_security_copy_does_not_neutralize_a_hard_authentication_error(self):
        class ManageHardErrorScope:
            def run_js(self, _script):
                return json.dumps(
                    {
                        "href": "https://account.apple.com/account/manage",
                        "hasStrongTwoFactorText": True,
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                        "codeInputCount": 0,
                        "password": False,
                        "email": False,
                        "trustPrompt": False,
                        "otpRejected": False,
                        "blocked": False,
                        "hardAuthenticationError": True,
                        "genericAuthText": True,
                        "securityFeatureCopy": True,
                        "error": True,
                        "accountManage": True,
                        "accountMarker": True,
                    }
                )

        state = account_flow.detect_scope_login_state(ManageHardErrorScope())

        self.assertFalse(state.get("securityCopyOnly", False))
        self.assertTrue(state["error"])
        self.assertFalse(state["trusted"])

    def test_manage_generic_auth_text_without_security_feature_copy_remains_an_error(self):
        class ManageGenericAuthScope:
            def run_js(self, _script):
                return json.dumps(
                    {
                        "href": "https://account.apple.com/account/manage",
                        "hasStrongTwoFactorText": False,
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                        "codeInputCount": 0,
                        "password": False,
                        "email": False,
                        "trustPrompt": False,
                        "otpRejected": False,
                        "blocked": False,
                        "hardAuthenticationError": False,
                        "genericAuthText": True,
                        "securityFeatureCopy": False,
                        "error": True,
                        "accountManage": True,
                        "accountMarker": True,
                    }
                )

        state = account_flow.detect_scope_login_state(ManageGenericAuthScope())

        self.assertFalse(state["securityFeatureCopy"])
        self.assertFalse(state.get("securityCopyOnly", False))
        self.assertTrue(state["error"])
        self.assertFalse(state["trusted"])


class TwoFactorStateTests(unittest.TestCase):
    def test_submitted_wait_accepts_account_manage_security_copy_without_live_auth_ui(self):
        page = FakePage(
            state={
                "href": "https://account.apple.com/account/manage",
                "hasStrongTwoFactorText": True,
                "semanticTargetCount": 0,
                "digitCellCount": 0,
                "codeInputCount": 0,
                "password": False,
                "email": False,
                "trustPrompt": False,
                "otpRejected": False,
                "blocked": False,
                "genericAuthText": True,
                "securityFeatureCopy": True,
                "error": True,
                "accountManage": True,
                "accountMarker": True,
            }
        )
        page.states = FakeStates(alive=True)
        transition_states = []

        with patch(
            "apple_account_flow.human_pause",
            side_effect=AssertionError("security-copy-only management page should confirm immediately"),
        ):
            state = wait_for_signed_in(
                page,
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
                transition_observer=transition_states.append,
            )

        self.assertTrue(state["trusted"])
        self.assertTrue(state["rootSecurityCopyOnly"])
        self.assertFalse(state["rootError"])
        self.assertEqual(len(transition_states), 1)
        self.assertTrue(transition_states[0]["rootSecurityCopyOnly"])
        self.assertFalse(transition_states[0]["error"])
        self.assertFalse(transition_states[0]["twofa"])

    def test_submitted_wait_accepts_account_manage_security_copy_in_root_shadow(self):
        shadow_root = FakePage(
            state={
                "shadowEvidence": {
                    "hasStrongText": True,
                    "semanticTargetCount": 0,
                    "digitCellCount": 0,
                    "codeInputCount": 0,
                    "password": False,
                    "email": False,
                    "trustPrompt": False,
                    "otpRejected": False,
                    "blocked": False,
                    "genericAuthText": True,
                    "securityFeatureCopy": True,
                    "error": True,
                }
            }
        )
        page = FakePage(
            shadow_roots=[shadow_root],
            state={
                "href": "https://account.apple.com/account/manage",
                "hasStrongTwoFactorText": False,
                "semanticTargetCount": 0,
                "digitCellCount": 0,
                "codeInputCount": 0,
                "password": False,
                "email": False,
                "trustPrompt": False,
                "otpRejected": False,
                "blocked": False,
                "genericAuthText": False,
                "error": False,
                "accountManage": True,
                "accountMarker": True,
            },
        )
        page.states = FakeStates(alive=True)

        state = wait_for_signed_in(
            page,
            timeout_s=0.05,
            submitted=True,
            otp_generation=1,
            submission_method="automatic",
        )

        self.assertTrue(state["trusted"])
        self.assertTrue(state["rootSecurityCopyOnly"])
        self.assertFalse(state["rootError"])

    def test_submitted_wait_rejects_root_strong_auth_text_without_security_feature_copy(self):
        page = FakePage(
            state={
                "href": "https://account.apple.com/account/manage",
                "hasStrongTwoFactorText": True,
                "semanticTargetCount": 0,
                "digitCellCount": 0,
                "codeInputCount": 0,
                "password": False,
                "email": False,
                "trustPrompt": False,
                "otpRejected": False,
                "blocked": False,
                "hardAuthenticationError": False,
                "genericAuthText": True,
                "securityFeatureCopy": False,
                "error": True,
                "accountManage": True,
                "accountMarker": True,
            }
        )
        page.states = FakeStates(alive=True)
        observations = []

        self.assertIsNone(
            account_flow.confirmed_account_manage_state(
                page,
                allow_retiring_child_errors=True,
            )
        )
        with self.assertRaisesRegex(RuntimeError, "2FA/login failed"):
            wait_for_signed_in(
                page,
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
                transition_observer=observations.append,
            )

        self.assertEqual(len(observations), 1)
        self.assertTrue(observations[0]["rootError"])
        self.assertFalse(observations[0]["trusted"])
        self.assertFalse(observations[0]["rootSecurityCopyOnly"])

    def test_submitted_wait_rejects_root_shadow_strong_auth_text_without_security_feature_copy(self):
        shadow_root = FakePage(
            state={
                "shadowEvidence": {
                    "hasStrongText": True,
                    "semanticTargetCount": 0,
                    "digitCellCount": 0,
                    "codeInputCount": 0,
                    "password": False,
                    "email": False,
                    "trustPrompt": False,
                    "otpRejected": False,
                    "blocked": False,
                    "hardAuthenticationError": False,
                    "genericAuthText": True,
                    "securityFeatureCopy": False,
                    "error": True,
                }
            }
        )
        page = FakePage(
            shadow_roots=[shadow_root],
            state={
                "href": "https://account.apple.com/account/manage",
                "hasStrongTwoFactorText": False,
                "semanticTargetCount": 0,
                "digitCellCount": 0,
                "codeInputCount": 0,
                "password": False,
                "email": False,
                "trustPrompt": False,
                "otpRejected": False,
                "blocked": False,
                "hardAuthenticationError": False,
                "genericAuthText": False,
                "error": False,
                "accountManage": True,
                "accountMarker": True,
            },
        )
        page.states = FakeStates(alive=True)
        observations = []

        self.assertIsNone(
            account_flow.confirmed_account_manage_state(
                page,
                allow_retiring_child_errors=True,
            )
        )
        with self.assertRaisesRegex(RuntimeError, "2FA/login failed"):
            wait_for_signed_in(
                page,
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
                transition_observer=observations.append,
            )

        self.assertEqual(len(observations), 1)
        self.assertTrue(observations[0]["rootError"])
        self.assertFalse(observations[0]["trusted"])
        self.assertFalse(observations[0]["rootSecurityCopyOnly"])

    def test_submitted_wait_accepts_account_manage_url_before_dom_hydration(self):
        page = FakePage(state={"href": "https://account.apple.com/account/manage"})
        with patch(
            "apple_account_flow.browser_connection_is_alive",
            return_value=True,
        ), patch(
            "apple_account_flow.detect_login_state",
            side_effect=AssertionError("the settled DOM should not be required after the redirect"),
        ):
            state = wait_for_signed_in(page, timeout_s=0.05, submitted=True)

        self.assertTrue(state["trusted"])
        self.assertTrue(state["rootSessionTrusted"])

    @staticmethod
    def nested_opaque_manage_shell(*, trust_prompt=False, error=False):
        inner = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "trustPrompt": trust_prompt,
                "error": error,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            }
        )
        inner_host = FakeElement(attrs={"src": inner.state["href"]})
        outer = FakePage(
            {"css:iframe": [inner_host]},
            frames=[inner],
            state={"href": "about:blank"},
        )
        outer_host = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": "about:blank"}
        )
        page = FakePage(
            {"css:iframe": [outer_host]},
            frames=[outer],
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
            },
        )
        outer.parent = page
        inner.parent = outer
        return page

    def test_submitted_wait_accepts_manage_shell_despite_retiring_error_frame(self):
        retiring_frame = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "trustPrompt": False,
                "error": True,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            }
        )
        page = FakePage(
            frames=[retiring_frame],
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
            },
        )
        retiring_frame.parent = page
        page.states = FakeStates(alive=True)

        with patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_signed_in(
                page,
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
                submission_method="button",
            )

        self.assertTrue(state["trusted"])

    @staticmethod
    def manage_shell_with_shadow_error(*, code_input_count):
        shadow_root = FakePage(
            state={
                "shadowEvidence": {
                    "hasStrongText": False,
                    "semanticTargetCount": 0,
                    "digitCellCount": 6 if code_input_count == 6 else 0,
                    "codeInputCount": code_input_count,
                    "trustPrompt": False,
                    "otpRejected": False,
                    "blocked": False,
                    "error": True,
                }
            }
        )
        frame = FakePage(
            shadow_roots=[shadow_root],
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            },
        )
        frame_host = FakeElement(attrs={"src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [frame_host]},
            frames=[frame],
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "otpRejected": False,
                "blocked": False,
                "trusted": True,
                "accountMarker": True,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            },
        )
        frame.parent = page
        page.states = FakeStates(alive=True)
        return page, shadow_root

    def test_automatic_post_otp_wait_accepts_manage_shell_with_a_live_error_only_frame(self):
        retiring_frame = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "trustPrompt": False,
                "error": True,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            }
        )
        frame_host = FakeElement(attrs={"src": retiring_frame.state["href"]})
        page = FakePage(
            {"css:iframe": [frame_host]},
            frames=[retiring_frame],
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "otpRejected": False,
                "blocked": False,
                "trusted": True,
                "accountMarker": True,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            },
        )
        retiring_frame.parent = page
        page.states = FakeStates(alive=True)

        with patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_signed_in(
                page,
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
            )

        self.assertTrue(state["trusted"])

    def test_automatic_post_otp_wait_does_not_accept_a_live_twofa_frame(self):
        frame = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "trustPrompt": False,
                "error": False,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 6,
            }
        )
        frame_host = FakeElement(attrs={"src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [frame_host]},
            frames=[frame],
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "otpRejected": False,
                "blocked": False,
                "trusted": True,
                "accountMarker": True,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            },
        )
        frame.parent = page
        page.states = FakeStates(alive=True)

        self.assertIsNone(
            account_flow.confirmed_account_manage_state(
                page,
                allow_retiring_child_errors=True,
            )
        )

    def test_automatic_post_otp_wait_does_not_accept_a_live_shadow_twofa_error(self):
        page, shadow_root = self.manage_shell_with_shadow_error(code_input_count=6)

        self.assertEqual(
            account_flow.detect_shadow_root_state(shadow_root)["codeInputCount"],
            6,
        )
        self.assertIsNone(
            account_flow.confirmed_account_manage_state(
                page,
                allow_retiring_child_errors=True,
            )
        )

    def test_automatic_post_otp_wait_accepts_a_retired_shadow_error(self):
        page, shadow_root = self.manage_shell_with_shadow_error(code_input_count=0)

        self.assertEqual(
            account_flow.detect_shadow_root_state(shadow_root)["codeInputCount"],
            0,
        )
        state = account_flow.confirmed_account_manage_state(
            page,
            allow_retiring_child_errors=True,
        )
        self.assertIsNotNone(state)
        self.assertTrue(state["trusted"])


    def test_automatic_post_otp_wait_rejects_live_shadow_password_or_email(self):
        for field in ("password", "email"):
            with self.subTest(field=field):
                page, shadow_root = self.manage_shell_with_shadow_error(code_input_count=0)
                shadow_root.state["shadowEvidence"][field] = True

                self.assertIsNone(
                    account_flow.confirmed_account_manage_state(
                        page,
                        allow_retiring_child_errors=True,
                    )
                )
                state = account_flow.detect_login_state(page)
                self.assertTrue(state["childAuthUiPresent"])
                self.assertFalse(account_flow.has_confirmed_account_session(state))

    def test_shadow_auth_detection_requires_an_enabled_editable_control(self):
        class CapturingShadowRoot:
            def __init__(self):
                self.script = ""

            def run_js(self, script):
                self.script = script
                return json.dumps(
                    {
                        "hasStrongText": False,
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                        "codeInputCount": 0,
                        "password": False,
                        "email": False,
                        "trustPrompt": False,
                        "otpRejected": False,
                        "blocked": False,
                        "error": False,
                    }
                )

        shadow_root = CapturingShadowRoot()
        state = account_flow.detect_shadow_root_state(shadow_root)

        self.assertFalse(state["password"])
        self.assertFalse(state["email"])
        self.assertIn("!el.disabled", shadow_root.script)
        self.assertIn("el.getAttribute('aria-disabled') !== 'true'", shadow_root.script)
        self.assertIn("const id =", shadow_root.script)
        self.assertIn("/account[_-]?name|username/.test(`${name} ${id}`)", shadow_root.script)

    def test_direct_email_detector_accepts_apple_account_name_id(self):
        class CapturingScope:
            def __init__(self):
                self.script = ""

            def run_js(self, script):
                self.script = script
                return json.dumps(
                    {
                        "href": "https://idmsa.apple.com/appleauth/auth/signin",
                        "hasStrongTwoFactorText": False,
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                        "password": False,
                        "email": True,
                        "trustPrompt": False,
                        "otpRejected": False,
                        "blocked": False,
                        "error": True,
                    }
                )

        scope = CapturingScope()
        state = account_flow.detect_scope_login_state(scope)

        self.assertTrue(state["email"])
        self.assertIn("const autocomplete =", scope.script)
        self.assertIn("const id =", scope.script)
        self.assertIn("autocomplete === 'email'", scope.script)
        self.assertIn("autocomplete === 'username'", scope.script)
        self.assertIn("/account[_-]?name|username/.test(`${name} ${id}`)", scope.script)

    def test_automatic_post_otp_wait_rejects_live_direct_email_error(self):
        frame = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "trustPrompt": False,
                "error": True,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": True,
                "codeInputCount": 0,
            }
        )
        frame_host = FakeElement(attrs={"src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [frame_host]},
            frames=[frame],
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            },
        )
        frame.parent = page
        page.states = FakeStates(alive=True)

        self.assertIsNone(
            account_flow.confirmed_account_manage_state(
                page,
                allow_retiring_child_errors=True,
            )
        )
        state = account_flow.detect_login_state(page)
        self.assertTrue(state["childAuthUiPresent"])
        self.assertFalse(account_flow.has_confirmed_account_session(state))

    def test_automatic_post_otp_wait_accepts_manage_shell_before_account_marker_hydrates(self):
        frame = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "trustPrompt": False,
                "error": True,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            }
        )
        frame_host = FakeElement(attrs={"src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [frame_host]},
            frames=[frame],
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            },
        )
        frame.parent = page
        page.states = FakeStates(alive=True)
        transition_states = []

        with patch(
            "apple_account_flow.human_pause",
            side_effect=AssertionError("stable account/manage redirect should not wait for hydration"),
        ):
            state = wait_for_signed_in(
                page,
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
                transition_observer=transition_states.append,
            )

        self.assertTrue(state["trusted"])
        self.assertEqual(len(transition_states), 1)
        observation = transition_states[0]
        self.assertTrue(observation["rootManageUrl"])
        self.assertFalse(observation["rootAccountMarker"])
        self.assertFalse(observation["rootError"])
        self.assertTrue(observation["retiringChildError"])
        self.assertFalse(observation["childAuthUiPresent"])
        self.assertTrue(observation["inspectionAvailable"])
        self.assertEqual(observation["generation"], 1)

    def test_automatic_post_otp_wait_without_marker_still_rejects_live_shadow_otp(self):
        page, _shadow_root = self.manage_shell_with_shadow_error(code_input_count=6)
        page.state["accountMarker"] = False

        self.assertIsNone(
            account_flow.confirmed_account_manage_state(
                page,
                allow_retiring_child_errors=True,
            )
        )

    def test_automatic_post_otp_wait_without_marker_keeps_root_and_trust_blockers_closed(self):
        root_error_page = FakePage(
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": True,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            }
        )
        root_error_page.states = FakeStates(alive=True)
        trust_page = self.nested_opaque_manage_shell(trust_prompt=True)
        trust_page.state["accountMarker"] = False
        trust_page.states = FakeStates(alive=True)

        for page in (root_error_page, trust_page):
            with self.subTest(page=page is trust_page):
                self.assertIsNone(
                    account_flow.confirmed_account_manage_state(
                        page,
                        allow_retiring_child_errors=True,
                    )
                )
    def test_submitted_wait_does_not_accept_a_manage_shell_with_root_error(self):
        page = FakePage(
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": True,
                "otpRejected": False,
                "blocked": False,
                "trusted": True,
                "accountMarker": True,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            }
        )
        page.states = FakeStates(alive=True)

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "2FA/login failed"):
                wait_for_signed_in(
                    page,
                    timeout_s=0.05,
                    submitted=True,
                    otp_generation=1,
                    submission_method="button",
                )

    def test_submitted_wait_does_not_accept_a_manage_shell_with_live_otp_frame(self):
        frame = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "trustPrompt": False,
                "error": True,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 6,
            }
        )
        iframe = FakeElement(attrs={"src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [iframe]},
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
            },
        )
        frame.parent = page
        page.states = FakeStates(alive=True)

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "2FA/login failed"):
                wait_for_signed_in(
                    page,
                    timeout_s=0.05,
                    submitted=True,
                    otp_generation=1,
                    submission_method="button",
                )

    def test_submitted_wait_does_not_accept_a_manage_shell_with_live_opaque_otp_frame(self):
        frame = FakePage(
            state={
                "href": "about:blank",
                "twofa": True,
                "trustPrompt": False,
                "error": True,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 6,
            }
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": "about:blank"}
        )
        page = FakePage(
            {"css:iframe": [iframe]},
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
            },
        )
        frame.parent = page
        page.states = FakeStates(alive=True)

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "2FA/login failed"):
                wait_for_signed_in(
                    page,
                    timeout_s=0.05,
                    submitted=True,
                    otp_generation=1,
                    submission_method="button",
                )

    def test_automatic_otp_wait_never_clicks_a_trust_prompt(self):
        page = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": False,
                "trustPrompt": True,
                "error": False,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            }
        )

        with patch("apple_account_flow.click_trust_browser") as click_trust, patch(
            "apple_account_flow.human_pause",
            lambda *_: None,
        ):
            with self.assertRaisesRegex(RuntimeError, "account session was not confirmed"):
                wait_for_signed_in(
                    page,
                    timeout_s=0.05,
                    submitted=True,
                    otp_generation=1,
                    submission_method="automatic",
                )

        click_trust.assert_not_called()

    def test_live_opaque_trust_frame_blocks_manage_session_confirmation(self):
        frame = FakePage(
            state={
                "href": "about:blank",
                "twofa": False,
                "trustPrompt": True,
                "error": False,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            }
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": "about:blank"}
        )
        page = FakePage(
            {"css:iframe": [iframe]},
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
            },
        )
        frame.parent = page

        state = detect_login_state(page)

        self.assertFalse(account_flow.has_confirmed_account_session(state))

    def test_live_opaque_error_frame_blocks_manage_session_confirmation(self):
        frame = FakePage(
            state={
                "href": "about:srcdoc",
                "twofa": False,
                "trustPrompt": False,
                "error": True,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
                "accountMarker": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            }
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": "about:srcdoc"}
        )
        page = FakePage(
            {"css:iframe": [iframe]},
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
            },
        )
        frame.parent = page

        state = detect_login_state(page)

        self.assertTrue(state["error"])
        self.assertFalse(account_flow.has_confirmed_account_session(state))

    def test_nested_live_opaque_trust_frame_blocks_manage_session_confirmation(self):
        state = detect_login_state(self.nested_opaque_manage_shell(trust_prompt=True))

        self.assertFalse(account_flow.has_confirmed_account_session(state))

    def test_nested_live_opaque_error_frame_blocks_manage_session_confirmation(self):
        state = detect_login_state(self.nested_opaque_manage_shell(error=True))

        self.assertTrue(state["error"])
        self.assertFalse(account_flow.has_confirmed_account_session(state))

    def test_submitted_wait_retries_a_transient_unreadable_scope_before_confirming_session(self):
        recovered_state = {
            "href": "https://account.apple.com/account/manage",
            "twofa": False,
            "trusted": True,
            "error": False,
        }
        transition_states = []
        with patch(
            "apple_account_flow.detect_login_state",
            side_effect=[
                RuntimeError("unable to inspect login page state through ruyiPage"),
                recovered_state,
            ],
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_signed_in(
                FakePage(),
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
                submission_method="enter",
                transition_observer=transition_states.append,
            )

        self.assertTrue(state["trusted"])
        self.assertFalse(transition_states[0]["inspectionAvailable"])
        self.assertEqual(transition_states[0]["generation"], 1)
        self.assertTrue(transition_states[-1]["inspectionAvailable"])
        self.assertEqual(transition_states[-1]["generation"], 1)

    def test_root_unreadable_child_readable_state_fails_closed_and_marks_observation_unavailable(self):
        page = FakePage(
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trusted": False,
                "error": False,
                "codeInputCount": 0,
            }
        )
        child = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "trusted": False,
                "error": False,
                "codeInputCount": 0,
            },
            parent=page,
        )
        page.frames = [child]
        page.states = FakeStates(alive=True)
        original_detect_scope = account_flow.detect_scope_login_state

        def root_unreadable(scope):
            if scope is page:
                raise RuntimeError("root scope unavailable")
            return original_detect_scope(scope)

        with patch(
            "apple_account_flow.detect_scope_login_state",
            side_effect=root_unreadable,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "unable to inspect login page state through ruyiPage",
            ):
                detect_login_state(page)

        transition_states = []
        monotonic_values = iter((0.0, 0.0, 0.0, 1.0))
        with patch(
            "apple_account_flow.detect_scope_login_state",
            side_effect=root_unreadable,
        ), patch(
            "apple_account_flow.time.monotonic",
            side_effect=lambda: next(monotonic_values),
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "2FA submit state could not be confirmed"):
                wait_for_signed_in(
                    page,
                    timeout_s=0.5,
                    submitted=True,
                    otp_generation=1,
                    submission_method="automatic",
                    transition_observer=transition_states.append,
                )

        self.assertEqual(len(transition_states), 1)
        self.assertFalse(transition_states[0]["inspectionAvailable"])
        self.assertEqual(transition_states[0]["generation"], 1)

    def test_first_generation_requires_an_explicit_otp_rejection_for_retry(self):
        state = {
            "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
            "twofa": True,
            "error": True,
            "otpRejected": False,
            "blocked": False,
        }

        self.assertFalse(account_flow.otp_retry_allowed(state, generation=1))
        state["otpRejected"] = True
        self.assertTrue(account_flow.otp_retry_allowed(state, generation=1))

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


    def test_wait_prefers_apple_six_cell_container_with_aria_description(self):
        fields = [
            FakeElement(
                attrs={
                    "maxlength": "1",
                    "aria-description": "Enter the verification code in each input field.",
                }
            )
            for _ in range(6)
        ]
        page = FakePage(
            {"css:.form-security-code-inputs input": fields},
            state={
                "twofa": True,
                "codeInputCount": 6,
                "trusted": False,
                "error": False,
            },
        )

        discovered = self.wait_for_target(page)

        self.assertEqual(discovered, [(page, field) for field in fields])
        self.assertIn(
            ("css:.form-security-code-inputs input", 0),
            page.eles_calls,
        )

    def test_form_security_code_container_rejects_a_single_generic_input(self):
        field = FakeElement(attrs={"maxlength": "1"})
        page = FakePage(
            {"css:.form-security-code-inputs input": [field]},
            state={"twofa": True, "codeInputCount": 1},
        )

        self.assertEqual(account_flow.security_code_fields(page), [])

    def test_security_code_fields_rejects_competing_single_and_six_cell_targets(self):
        single = FakeElement(attrs={"autocomplete": "one-time-code"})
        digits = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        frame = FakePage(
            {"css:.form-security-code-inputs input": digits},
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "codeInputCount": 6,
            },
        )
        page = FakePage(
            {"css:input[autocomplete='one-time-code']": [single]},
            frames=[frame],
            state={"twofa": True, "codeInputCount": 1},
        )
        frame.parent = page

        self.assertEqual(account_flow.security_code_fields(page), [])

    def test_wait_finds_semantic_role_textbox_in_shadow_root(self):
        field = FakeElement(attrs={"role": "textbox", "aria-label": "Verification code"})
        shadow_root = FakePage({"css:[role='textbox']": [field]})
        page = FakePage(
            shadow_roots=[shadow_root],
            state={"twofa": True, "trusted": False, "error": False},
        )

        fields = self.wait_for_target(page)

        self.assertEqual(fields, [(page, field)])
        self.assertEqual(page.shadow_roots_calls, [("all", False), ("all", False)])

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
        self.assertEqual(frame.shadow_roots_calls, [("all", False), ("all", False)])

    def test_shadow_enumeration_failure_keeps_ordinary_scope_available(self):
        field = FakeElement(attrs={"aria-label": "One-time verification code"})
        page = FakePage(
            {"css:input": [field]},
            state={"twofa": True, "trusted": False, "error": False},
            shadow_error=RuntimeError("shadow serialization unavailable"),
        )

        fields = self.wait_for_target(page)

        self.assertEqual(fields, [(page, field)])
        self.assertEqual(page.shadow_roots_calls, [("all", False), ("all", False)])

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

    def test_wait_rejects_opaque_otp_frame_below_a_non_apple_parent(self):
        field = FakeElement(attrs={"autocomplete": "one-time-code"})
        opaque_frame = FakePage(
            {"css:input[autocomplete='one-time-code']": [field]},
            state={"href": "about:blank", "twofa": True},
        )
        non_apple_frame = FakePage(
            frames=[opaque_frame],
            state={"href": "https://evil.example/verify", "twofa": False},
        )
        page = FakePage(
            frames=[non_apple_frame],
            state={"href": "https://account.apple.com/sign-in", "twofa": False},
        )
        non_apple_frame.parent = page
        opaque_frame.parent = non_apple_frame

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "OTP target"):
                account_flow.wait_for_otp_target(page, timeout_s=0.01)

        self.assertEqual(page.actions.calls, [])
        self.assertEqual(non_apple_frame.actions.calls, [])
        self.assertEqual(opaque_frame.actions.calls, [])

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
        self.assertIn("aria-description", marker_root.script)

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
        self.assertIn("form-security-code-inputs", prompt_button.script)
        self.assertIn("aria-description", prompt_button.script)

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

    def test_aria_description_otp_semantics_are_supported(self):
        field = FakeElement(
            attrs={
                "aria-description": "Enter the verification code in each input field.",
            }
        )

        self.assertTrue(account_flow.element_has_otp_semantics(field))

    def test_wait_rejects_six_generic_role_textboxes_in_an_opaque_2fa_frame(self):
        fields = [
            FakeElement(attrs={"role": "textbox", "maxlength": "1"})
            for _ in range(6)
        ]
        page = FakePage(
            state={
                "href": "https://account.apple.com/sign-in",
                "twofa": False,
                "trusted": False,
                "error": False,
            }
        )
        frame = FakePage(
            {"css:[role='textbox']": fields},
            state={"href": "about:blank", "twofa": True},
            parent=page,
        )
        page.frames = [frame]

        with patch("apple_account_flow.human_pause", lambda *_: None):
            with self.assertRaisesRegex(RuntimeError, "OTP target"):
                account_flow.wait_for_otp_target(page, timeout_s=0.01)
        self.assertEqual(page.actions.calls, [])
        self.assertEqual(frame.actions.calls, [])

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


class OtpEntryConfirmationTests(unittest.TestCase):
    def test_vanished_otp_does_not_count_as_automatic_when_credentials_return(self):
        page = FakePage()
        returned_to_credentials = {
            "twofa": False,
            "email": True,
            "password": False,
            "trustPrompt": False,
            "trusted": False,
            "error": False,
        }

        with patch("apple_account_flow.security_code_fields", return_value=[]), patch(
            "apple_account_flow.detect_login_state",
            return_value=returned_to_credentials,
        ), patch("apple_account_flow.human_pause", lambda *_: None), self.assertRaisesRegex(
            RuntimeError,
            "2FA code input was not confirmed",
        ):
            account_flow.wait_for_otp_entry_confirmation(page, expected_count=6, timeout_s=0.01)

    def test_vanished_otp_counts_as_automatic_after_a_trusted_or_trust_prompt_transition(self):
        page = FakePage()
        for state in (
            {"trusted": True, "twofa": False, "error": False},
            {"trusted": False, "trustPrompt": True, "twofa": False, "error": False},
        ):
            with self.subTest(state=state), patch(
                "apple_account_flow.security_code_fields",
                return_value=[],
            ), patch("apple_account_flow.detect_login_state", return_value=state):
                self.assertIsNone(
                    account_flow.wait_for_otp_entry_confirmation(
                        page,
                        expected_count=6,
                        timeout_s=0.01,
                    )
                )


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

    def test_rejects_mixed_scope_six_targets_before_direct_input(self):
        root_field = FakeElement(attrs={"autocomplete": "one-time-code"})
        frame_fields = [
            FakeElement(attrs={"autocomplete": "one-time-code"})
            for _ in range(5)
        ]
        frame = FakePage(
            {"css:input[autocomplete='one-time-code']": frame_fields},
            state={"twofa": True, "trusted": False, "error": False},
        )
        page = FakePage(
            {"css:input[autocomplete='one-time-code']": [root_field]},
            frames=[frame],
            state={"twofa": True, "trusted": False, "error": False},
        )
        frame.parent = page
        mixed_fields = [(page, root_field), *[(frame, field) for field in frame_fields]]

        self.assertEqual(account_flow.security_code_fields(page), [])
        with self.assertRaisesRegex(RuntimeError, "six targets in one trusted Apple frame"):
            fill_security_code(
                page,
                "123456",
                FakeKeys,
                pause=lambda *_: None,
                fields=mixed_fields,
            )

        self.assertTrue(all(not field.inputs for _scope, field in mixed_fields))
        self.assertEqual(page.actions.calls, [])
        self.assertEqual(frame.actions.calls, [])

    def test_fills_single_contenteditable_target_through_trusted_actions(self):
        field = FakeElement(
            attrs={"contenteditable": "true", "aria-label": "Verification code"}
        )
        shadow_root = FakePage({"css:[contenteditable='true']": [field]})
        page = FakePage(
            shadow_roots=[shadow_root],
            state={"twofa": True, "trusted": False, "error": False},
        )

        with patch(
            "apple_account_flow.read_element_input_value",
            side_effect=AssertionError("OTP entry must not read the code value"),
        ):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual(field.value, "123456")
        self.assertEqual(field.inputs, [])
        self.assertEqual(field.clicks, 0)
        self.assertIn(("human_click", field), page.actions.calls)
        self.assertIn(("type", "123456", page.actions.calls[-2][2]), page.actions.calls)

    def test_fills_six_role_textboxes_as_one_owner_context_sequence(self):
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
            actions=FakeActions(auto_advance_targets=fields),
            state={"twofa": True, "trusted": False, "error": False},
        )

        with patch(
            "apple_account_flow.read_element_input_value",
            side_effect=AssertionError("OTP entry must not read the code value"),
        ):
            fill_security_code(page, "654321", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.value for field in fields], list("654321"))
        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        self.assertEqual(
            [call[1] for call in page.actions.calls if call[0] == "type"],
            ["654321"],
        )
        self.assertEqual(
            [call[0] for call in page.actions.calls].count("combo"),
            1,
        )

    def test_fills_six_visible_digit_fields_as_one_frame_sequence(self):
        fields = [
            FakeElement(
                attrs={"maxlength": "1"},
                location={"x": 20 + index * 45, "y": 30},
            )
            for index in range(6)
        ]
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            actions=FakeActions(auto_advance_targets=fields),
        )
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
        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        self.assertEqual(
            [call[1] for call in frame.actions.calls if call[0] == "type"],
            ["123456"],
        )
        self.assertEqual(page.actions.calls, [])

    def test_six_digit_uses_precise_cell_bidi_fallback_only_when_all_cells_are_empty(self):
        fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        frame_actions = FakeActions(apply_typed_text=False)
        frame = FakePage(
            {"css:.form-security-code-inputs input": fields},
            actions=frame_actions,
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "codeInputCount": 6,
            },
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]}
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        with patch("apple_account_flow.emit") as emit_event:
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.value for field in fields], list("123456"))
        self.assertEqual(
            [field.inputs for field in fields],
            [[(digit, False)] for digit in "123456"],
        )
        self.assertEqual(
            [call[1] for call in frame_actions.calls if call[0] == "type"],
            ["123456"],
        )
        self.assertEqual(page.actions.calls, [])
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("cell_bidi_fallback_started", steps)
        self.assertIn("cell_bidi_fallback_completed", steps)

    def test_six_digit_uses_exact_cell_fallback_when_owner_click_cannot_confirm_focus(self):
        fields = [FakeElement(attrs={"maxlength": "1"}, focused=False) for _ in range(6)]
        frame_actions = FakeActions(apply_typed_text=False)
        frame = FakePage(
            {"css:.form-security-code-inputs input": fields},
            actions=frame_actions,
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "codeInputCount": 6,
            },
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]}
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        with patch("apple_account_flow.emit") as emit_event:
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.value for field in fields], list("123456"))
        self.assertEqual(
            [field.inputs for field in fields],
            [[(digit, False)] for digit in "123456"],
        )
        self.assertNotIn(
            ("combo", (FakeKeys.COMMAND, "a")),
            frame_actions.calls,
        )
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("sequence_focus_unconfirmed", steps)
        self.assertIn("cell_bidi_fallback_started", steps)
        self.assertIn("cell_bidi_fallback_completed", steps)

    def test_six_digit_focus_fallback_confirms_last_cell_auto_transition(self):
        fields = [FakeElement(attrs={"maxlength": "1"}, focused=False) for _ in range(6)]

        class AutoTransitionFrame(FakePage):
            def __init__(self):
                super().__init__(
                    actions=FakeActions(apply_typed_text=False),
                    state={
                        "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                        "twofa": True,
                        "codeInputCount": 6,
                    },
                )
                self.live_fields = fields
                for field in fields:
                    field.scope = self

            def eles(self, selector, timeout=None):
                self.eles_calls.append((selector, timeout))
                if selector == "css:.form-security-code-inputs input":
                    return list(self.live_fields)
                return []

        frame = AutoTransitionFrame()
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]}
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        original_input = fields[-1].input

        def input_last_digit_and_transition(value, clear=True):
            result = original_input(value, clear)
            frame.live_fields = []
            frame.state.update(
                {"twofa": False, "trustPrompt": True, "codeInputCount": 0}
            )
            return result

        fields[-1].input = input_last_digit_and_transition

        with patch.object(
            account_flow,
            "TWO_FACTOR_EMPTY_CELL_FALLBACK_PROBE_TIMEOUT_S",
            0.01,
        ), patch("apple_account_flow.human_pause", lambda *_: None), patch(
            "apple_account_flow.emit"
        ) as emit_event:
            completed = fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertIsNone(completed)
        self.assertEqual([field.value for field in fields], list("123456"))
        self.assertEqual(
            [field.inputs for field in fields],
            [[(digit, False)] for digit in "123456"],
        )
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("sequence_focus_unconfirmed", steps)
        self.assertIn("cell_bidi_fallback_started", steps)
        self.assertIn("sequence_auto_submitted", steps)
        self.assertNotIn("input_unconfirmed", steps)

    def test_six_digit_stops_before_clear_when_widget_becomes_partially_filled(self):
        fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        fields[0].on_click = lambda: setattr(fields[1], "value", "1")
        frame_actions = FakeActions(apply_typed_text=False)
        frame = FakePage(
            {"css:.form-security-code-inputs input": fields},
            actions=frame_actions,
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "codeInputCount": 6,
            },
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]}
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        with patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "2FA code input was not confirmed",
        ):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("sequence_focus_started", steps)
        self.assertIn("input_unconfirmed", steps)
        self.assertNotIn("sequence_cleared", steps)
        self.assertNotIn("cell_bidi_fallback_started", steps)
        self.assertNotIn(("combo", (FakeKeys.COMMAND, "a")), frame_actions.calls)

    def test_six_digit_refuses_initial_partial_widget_before_clear(self):
        fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        fields[0].value = "1"
        frame_actions = FakeActions(apply_typed_text=False)
        frame = FakePage(
            {"css:.form-security-code-inputs input": fields},
            actions=frame_actions,
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "codeInputCount": 6,
            },
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]}
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        with patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "2FA code input was not confirmed",
        ):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual(frame_actions.calls, [])
        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("input_unconfirmed", steps)
        self.assertNotIn("sequence_focus_started", steps)
        self.assertNotIn("cell_bidi_fallback_started", steps)

    def test_six_digit_focus_fallback_rejects_a_replaced_pristine_widget(self):
        initial_fields = [FakeElement(attrs={"maxlength": "1"}, focused=False) for _ in range(6)]
        replacement_fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        frame_actions = FakeActions(apply_typed_text=False)
        frame = FakePage(
            {"css:.form-security-code-inputs input": initial_fields},
            actions=frame_actions,
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "codeInputCount": 6,
            },
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]}
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        def replace_widget():
            for field in replacement_fields:
                field.scope = frame
            frame.elements_by_selector["css:.form-security-code-inputs input"] = replacement_fields

        initial_fields[0].on_click = replace_widget

        with patch(
            "apple_account_flow.wait_for_otp_entry_confirmation",
            side_effect=RuntimeError("synthetic unconfirmed entry"),
        ), patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "2FA code input was not confirmed",
        ):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.inputs for field in initial_fields], [[], [], [], [], [], []])
        self.assertEqual([field.inputs for field in replacement_fields], [[], [], [], [], [], []])
        self.assertNotIn(("combo", (FakeKeys.COMMAND, "a")), frame_actions.calls)
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("sequence_focus_unconfirmed", steps)
        self.assertNotIn("cell_bidi_fallback_started", steps)

    def test_six_digit_cell_fallback_requires_the_observed_apple_iframe_id(self):
        fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        frame_actions = FakeActions(apply_typed_text=False)
        frame = FakePage(
            {"css:.form-security-code-inputs input": fields},
            actions=frame_actions,
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "codeInputCount": 6,
            },
        )
        iframe = FakeElement(attrs={"id": "different-apple-frame", "src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [iframe]},
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        with patch(
            "apple_account_flow.wait_for_otp_entry_confirmation",
            side_effect=RuntimeError("synthetic unconfirmed entry"),
        ), patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "2FA code input was not confirmed",
        ):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertNotIn("cell_bidi_fallback_started", steps)

    def test_six_digit_cell_fallback_accepts_rewrapped_iframe_elements_with_the_same_shared_id(self):
        frame = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "codeInputCount": 6,
            },
        )
        hosting_iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]},
            shared_id="apple-widget-frame",
        )
        rewrapped_iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]},
            shared_id="apple-widget-frame",
        )
        page = FakePage(
            {
                "css:iframe": [hosting_iframe],
                "css:iframe#aid-auth-widget-iFrame": [rewrapped_iframe],
            },
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        self.assertTrue(account_flow.is_apple_six_cell_widget_scope(page, frame))

    def test_six_digit_cell_fallback_rejects_generic_cells_outside_the_known_container(self):
        fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            actions=FakeActions(apply_typed_text=False),
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "codeInputCount": 6,
            },
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]}
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        with patch(
            "apple_account_flow.wait_for_otp_entry_confirmation",
            side_effect=RuntimeError("synthetic unconfirmed entry"),
        ), patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "2FA code input was not confirmed",
        ):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertNotIn("cell_bidi_fallback_started", steps)

    def test_six_digit_cell_fallback_stops_before_second_digit_when_frame_changes(self):
        fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        frame_actions = FakeActions(apply_typed_text=False)
        frame = FakePage(
            {"css:.form-security-code-inputs input": fields},
            actions=frame_actions,
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "codeInputCount": 6,
            },
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]}
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        def input_first_digit(value, clear=True):
            fields[0].inputs.append((value, clear))
            fields[0].value = value
            frame.state["href"] = "https://example.invalid/changed"
            return fields[0]

        fields[0].input = input_first_digit

        with patch(
            "apple_account_flow.wait_for_otp_entry_confirmation",
            side_effect=RuntimeError("synthetic unconfirmed entry"),
        ), patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "2FA code input was not confirmed",
        ):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual(fields[0].inputs, [("1", False)])
        self.assertEqual([field.inputs for field in fields[1:]], [[], [], [], [], []])
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("cell_bidi_fallback_unconfirmed", steps)

    def test_six_digit_cell_fallback_stops_when_live_cells_are_replaced(self):
        initial_fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        replacement_fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]

        class RehydratingFrame(FakePage):
            def __init__(self):
                super().__init__(
                    actions=FakeActions(apply_typed_text=False),
                    state={
                        "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                        "twofa": True,
                        "codeInputCount": 6,
                    },
                )
                self.live_fields = initial_fields
                for field in initial_fields + replacement_fields:
                    field.scope = self

            def eles(self, selector, timeout=None):
                self.eles_calls.append((selector, timeout))
                if selector == "css:.form-security-code-inputs input":
                    return list(self.live_fields)
                return []

        frame = RehydratingFrame()
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]}
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        original_input = initial_fields[0].input

        def input_first_digit_and_rehydrate(value, clear=True):
            result = original_input(value, clear)
            frame.live_fields = replacement_fields
            return result

        initial_fields[0].input = input_first_digit_and_rehydrate

        with patch(
            "apple_account_flow.wait_for_otp_entry_confirmation",
            side_effect=RuntimeError("synthetic unconfirmed entry"),
        ), patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "2FA code input was not confirmed",
        ):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual(initial_fields[0].inputs, [("1", False)])
        self.assertEqual([field.inputs for field in initial_fields[1:]], [[], [], [], [], []])
        self.assertEqual([field.inputs for field in replacement_fields], [[], [], [], [], [], []])
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("cell_bidi_fallback_unconfirmed", steps)
        self.assertNotIn("cell_bidi_fallback_completed", steps)

    def test_six_digit_does_not_replay_cells_after_a_partial_owner_sequence(self):
        fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        frame_actions = FakeActions(auto_advance_targets=fields[:1])
        frame = FakePage(
            {"css:.form-security-code-inputs input": fields},
            actions=frame_actions,
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
                "twofa": True,
                "codeInputCount": 6,
            },
        )
        page = FakePage(
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in"},
        )
        frame.parent = page

        with patch(
            "apple_account_flow.wait_for_otp_entry_confirmation",
            side_effect=RuntimeError("synthetic partial entry"),
        ), patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "2FA code input was not confirmed",
        ):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.value for field in fields], ["1", "", "", "", "", ""])
        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertNotIn("cell_bidi_fallback_started", steps)

    def test_six_digit_entry_uses_length_confirmation_not_sensitive_readback(self):
        fields = [
            FakeElement(
                attrs={"maxlength": "1"},
                location={"x": 20 + index * 45, "y": 30},
            )
            for index in range(6)
        ]
        frame_actions = FakeActions(auto_advance_targets=fields)
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            actions=frame_actions,
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]}
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            actions=FakeActions(coordinate_target=fields),
        )
        frame.parent = page

        with patch(
            "apple_account_flow.read_element_input_value",
            side_effect=[(True, "")] * 6,
        ), patch("apple_account_flow.emit") as emit_event:
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        self.assertEqual([field.value for field in fields], list("123456"))
        self.assertEqual(
            len([call for call in frame_actions.calls if call[0] == "human_click"]),
            1,
        )
        self.assertEqual(
            [call[1] for call in frame_actions.calls if call[0] == "type"],
            ["123456"],
        )
        self.assertIn(("combo", (FakeKeys.COMMAND, "a")), frame_actions.calls)
        self.assertIn(("press", FakeKeys.DELETE), frame_actions.calls)
        self.assertEqual(page.actions.calls, [])
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("sequence_focus_started", steps)
        self.assertIn("sequence_cleared", steps)
        self.assertIn("sequence_typed", steps)
        self.assertIn("aggregate_confirmed", steps)

    def test_six_digit_length_confirmation_never_replays_the_full_code(self):
        fields = [
            FakeElement(
                attrs={"maxlength": "1"},
                location={"x": 20 + index * 45, "y": 30},
            )
            for index in range(6)
        ]
        frame_actions = FakeActions(auto_advance_targets=fields)
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            actions=frame_actions,
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]}
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            actions=FakeActions(coordinate_target=fields),
        )
        frame.parent = page

        with patch(
            "apple_account_flow.read_element_input_value",
            side_effect=[(True, "")] * 6,
        ), patch("apple_account_flow.emit") as emit_event:
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        self.assertEqual(
            [call[1] for call in frame_actions.calls if call[0] == "type"],
            ["123456"],
        )
        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("aggregate_confirmed", steps)

    def test_six_digit_sequence_does_not_depend_on_per_cell_readback(self):
        fields = [
            FakeElement(
                attrs={"maxlength": "1"},
                location={"x": 20 + index * 45, "y": 30},
            )
            for index in range(6)
        ]
        frame_actions = FakeActions(auto_advance_targets=fields)
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            actions=frame_actions,
        )
        iframe = FakeElement(attrs={"src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [iframe]},
            frames=[frame],
            actions=FakeActions(coordinate_target=fields),
        )
        frame.parent = page

        with patch(
            "apple_account_flow.read_element_input_value",
            side_effect=[(True, "9"), *[(True, digit) for digit in "123456"]],
        ):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        self.assertEqual([field.value for field in fields], list("123456"))
        self.assertEqual(
            len([call for call in frame_actions.calls if call[0] == "human_click"]),
            1,
        )
        self.assertEqual(
            [call[1] for call in frame_actions.calls if call[0] == "type"],
            ["123456"],
        )
        self.assertEqual(page.actions.calls, [])

    def test_six_digit_sequence_avoids_per_cell_element_input(self):
        fields = [
            FakeElement(
                attrs={"maxlength": "1"},
                location={"x": 20 + index * 45, "y": 30},
            )
            for index in range(6)
        ]

        def input_raises(*_args, **_kwargs):
            raise RuntimeError("synthetic element input failure")

        fields[0].input = input_raises

        frame_actions = FakeActions(auto_advance_targets=fields)
        frame = FakePage({"css:input[maxlength='1']": fields}, actions=frame_actions)
        iframe = FakeElement(attrs={"src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [iframe]},
            frames=[frame],
            actions=FakeActions(apply_typed_text=False, coordinate_target=fields),
        )
        frame.parent = page

        fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.value for field in fields], list("123456"))
        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        self.assertEqual(
            len([call for call in frame_actions.calls if call[0] == "human_click"]),
            1,
        )
        self.assertEqual(
            [call[1] for call in frame_actions.calls if call[0] == "type"],
            ["123456"],
        )

    def test_six_digit_sequence_isolated_from_a_later_cell_element_failure(self):
        fields = [
            FakeElement(
                attrs={"maxlength": "1"},
                location={"x": 20 + index * 45, "y": 30},
            )
            for index in range(6)
        ]

        def input_raises(*_args, **_kwargs):
            raise RuntimeError("synthetic second-cell input failure")

        fields[1].input = input_raises
        frame_actions = FakeActions(auto_advance_targets=fields)
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            actions=frame_actions,
        )
        iframe = FakeElement(attrs={"src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [iframe]},
            frames=[frame],
            actions=FakeActions(coordinate_target=fields),
        )
        frame.parent = page

        fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        self.assertEqual([field.value for field in fields], list("123456"))
        self.assertEqual([field.inputs for field in fields], [[], [], [], [], [], []])
        self.assertEqual(
            [call[1] for call in frame_actions.calls if call[0] == "type"],
            ["123456"],
        )
        self.assertEqual(page.actions.calls, [])

    def test_six_digit_sequence_stops_without_submit_when_length_confirmation_fails(self):
        fields = [
            FakeElement(
                attrs={"maxlength": "1"},
                location={"x": 20 + index * 45, "y": 30},
            )
            for index in range(6)
        ]

        def input_without_effect(value, clear=True):
            fields[0].inputs.append((value, clear))
            return fields[0]

        fields[0].input = input_without_effect
        frame_actions = FakeActions(apply_typed_text=False)
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            actions=frame_actions,
        )
        iframe = FakeElement(attrs={"src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [iframe]},
            frames=[frame],
            actions=FakeActions(coordinate_target=fields),
        )
        frame.parent = page

        with patch(
            "apple_account_flow.wait_for_otp_entry_confirmation",
            side_effect=RuntimeError("synthetic length confirmation failure"),
        ), patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "2FA code input was not confirmed",
        ):
            fill_security_code(page, "123456", FakeKeys, pause=lambda *_: None)

        steps = [event["step"] for event in (call.args[0] for call in emit_event.call_args_list)]
        self.assertIn("input_unconfirmed", steps)
        self.assertEqual(
            [field.inputs for field in fields],
            [[], [], [], [], [], []],
        )
        self.assertEqual(
            len([call for call in frame_actions.calls if call[0] == "human_click"]),
            1,
        )
        self.assertEqual(
            [call[1] for call in frame_actions.calls if call[0] == "type"],
            ["123456"],
        )

    def test_six_digit_sequence_failure_does_not_emit_code_or_failure_details(self):
        code = "123456"
        secret = "synthetic-secret-token"
        raw_dom = f"<input value='{code}' data-secret='{secret}'>"
        url_query = (
            "https://idmsa.apple.com/appleauth/auth/verify?"
            f"otp={code}&token={secret}"
        )
        fields = [
            FakeElement(
                attrs={"maxlength": "1"},
                location={"x": 20 + index * 45, "y": 30},
            )
            for index in range(6)
        ]

        def input_without_effect(field):
            def apply(value, clear=True):
                field.inputs.append((value, clear))
                return field

            return apply

        for field in fields:
            field.input = input_without_effect(field)

        frame_actions = FakeActions(apply_typed_text=False)
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            actions=frame_actions,
        )
        iframe = FakeElement(
            attrs={"id": "aid-auth-widget-iFrame", "src": frame.state["href"]},
            location={"x": 100, "y": 200},
        )
        page = FakePage(
            {
                "css:iframe": [iframe],
                "css:iframe#aid-auth-widget-iFrame": [iframe],
            },
            frames=[frame],
            actions=FakeActions(coordinate_target=fields),
        )
        frame.parent = page

        with patch(
            "apple_account_flow.wait_for_otp_entry_confirmation",
            side_effect=RuntimeError(f"synthetic confirmation failure {raw_dom} {url_query}"),
        ), patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "2FA code input was not confirmed",
        ) as failure:
            fill_security_code(page, code, FakeKeys, pause=lambda *_: None)

        rendered_events = json.dumps(
            [call.args[0] for call in emit_event.call_args_list]
        )
        for forbidden in (code, secret, raw_dom, url_query, "?otp="):
            self.assertNotIn(forbidden, rendered_events)
            self.assertNotIn(forbidden, str(failure.exception))
        self.assertEqual(
            [field.inputs for field in fields],
            [[], [], [], [], [], []],
        )
        self.assertEqual(
            len([call for call in frame_actions.calls if call[0] == "human_click"]),
            1,
        )
        self.assertEqual(
            [call[1] for call in frame_actions.calls if call[0] == "type"],
            [code],
        )

    def test_six_digit_sequence_rechecks_owner_scope_before_keyboard_actions(self):
        fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            actions=FakeActions(auto_advance_targets=fields),
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "twofa": True,
            }
        )
        page = FakePage(
            frames=[frame],
            state={"href": "https://account.apple.com/sign-in", "twofa": False},
        )
        frame.parent = page
        calls = []

        def pause_once(*_args):
            calls.append("pause")
            if len(calls) == 1:
                frame.state["href"] = "https://evil.example/sign-in"

        with self.assertRaisesRegex(RuntimeError, "2FA code input was not confirmed"):
            fill_security_code(page, "123456", FakeKeys, pause=pause_once)

        self.assertNotIn(("combo", (FakeKeys.COMMAND, "a")), frame.actions.calls)
        self.assertEqual([call for call in frame.actions.calls if call[0] == "type"], [])

    def test_ignores_outer_single_character_noise_before_six_digit_frame(self):
        outer_noise = FakeElement()
        fields = [
            FakeElement(
                attrs={"maxlength": "1"},
                location={"x": 20 + index * 45, "y": 30},
            )
            for index in range(6)
        ]
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            actions=FakeActions(auto_advance_targets=fields),
        )
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
        field = FakeElement(attrs={"autocomplete": "one-time-code"})
        page = FakePage({"css:input[autocomplete='one-time-code']": [field]})

        with patch(
            "apple_account_flow.read_element_input_value",
            side_effect=AssertionError("OTP entry must not read the code value"),
        ):
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

    def test_trust_never_substitutes_a_continue_button_for_the_explicit_trust_action(self):
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

        self.assertFalse(click_trust_browser(page, pause=lambda *_: None))

        self.assertNotIn(("human_click", unrelated_continue), page.actions.calls)
        self.assertNotIn(("human_click", prompt_continue), page.actions.calls)

    def test_trust_clicks_shadow_button_through_its_owner_scope(self):
        trust = FakeElement(
            "Trust this browser",
            prompt_semantics={"trust": True},
        )
        shadow_root = FakePage(buttons=[trust])
        page = FakePage(
            shadow_roots=[shadow_root],
            state={"trustPrompt": True},
        )

        self.assertTrue(click_trust_browser(page, pause=lambda *_: None))

        self.assertEqual(page.shadow_roots_calls, [("all", False)])
        self.assertIn(("human_click", trust), page.actions.calls)
        self.assertEqual(shadow_root.actions.calls, [])

    def test_trust_uses_an_accessible_label_when_button_text_is_empty(self):
        trust = FakeElement(
            attrs={"aria-label": "Trust"},
            prompt_semantics={"trust": True},
        )
        page = FakePage(buttons=[trust], state={"trustPrompt": True})

        self.assertTrue(click_trust_browser(page, pause=lambda *_: None))

        self.assertIn(("human_click", trust), page.actions.calls)

    def test_trust_requires_a_unique_explicit_trust_candidate(self):
        first = FakeElement("Trust", prompt_semantics={"trust": True})
        second = FakeElement("Trust", prompt_semantics={"trust": True})
        page = FakePage(buttons=[first, second], state={"trustPrompt": True})

        self.assertFalse(click_trust_browser(page, pause=lambda *_: None))

        self.assertEqual(page.actions.calls, [])

    def test_trust_semantics_walks_visible_ancestors_without_using_document_body(self):
        trust = FakeElement("Trust", prompt_semantics={"trust": True})

        self.assertTrue(account_flow.button_has_prompt_semantics(trust, "trust"))

        # The fake only exposes the semantic return; capture the generated JS
        # through a tiny wrapper so the regression locks the fieldset-parent
        # traversal that fixed Apple's current markup.
        captured = {}

        def capture(script_text):
            captured["script"] = script_text
            return True

        trust.run_js = capture
        self.assertTrue(account_flow.button_has_prompt_semantics(trust, "trust"))
        self.assertIn("current = current.parentElement", captured["script"])
        self.assertIn("tag === 'body' || tag === 'html'", captured["script"])

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

    def test_two_factor_submit_clicks_input_submit_without_waiting(self):
        verify = FakeElement(
            attrs={"value": "Verify"},
            prompt_semantics={"twofa": True},
        )
        page = FakePage(
            {"css:input[type='submit']": [verify]},
            state={"twofa": True, "codeInputCount": 6},
        )

        self.assertTrue(click_two_factor_submit(page, pause=lambda *_: None))

        self.assertIn(("css:button", 0), page.eles_calls)
        self.assertIn(("css:input[type='submit']", 0), page.eles_calls)
        self.assertIn(("human_click", verify), page.actions.calls)

    def test_two_factor_submit_uses_enter_after_confirming_last_otp_focus(self):
        fields = [
            FakeElement(
                attrs={
                    "maxlength": "1",
                    "aria-description": "Enter the verification code in each input field.",
                }
            )
            for _ in range(6)
        ]
        page = FakePage(
            {"css:.form-security-code-inputs input": fields},
            state={"twofa": True, "codeInputCount": 6},
        )
        scoped_fields = [(page, field) for field in fields]

        self.assertTrue(
            click_two_factor_submit(
                page,
                pause=lambda *_: None,
                keys=FakeKeys,
                fields=scoped_fields,
                auto_submit_wait_s=0,
            )
        )

        self.assertIn(("human_click", fields[-1]), page.actions.calls)
        self.assertIn(("press", FakeKeys.ENTER), page.actions.calls)

    def test_two_factor_submit_never_enters_without_confirmed_otp_focus(self):
        fields = [
            FakeElement(
                attrs={"maxlength": "1", "aria-description": "Verification code"},
                focused=False,
            )
            for _ in range(6)
        ]
        page = FakePage(
            {"css:.form-security-code-inputs input": fields},
            state={"twofa": True, "codeInputCount": 6},
        )

        self.assertFalse(
            click_two_factor_submit(
                page,
                pause=lambda *_: None,
                keys=FakeKeys,
                fields=[(page, field) for field in fields],
                auto_submit_wait_s=0,
            )
        )

        self.assertNotIn(("press", FakeKeys.ENTER), page.actions.calls)

    def test_two_factor_submit_observes_apple_auto_transition_before_enter(self):
        fields = [
            FakeElement(
                attrs={"maxlength": "1", "aria-description": "Verification code"}
            )
            for _ in range(6)
        ]
        page = FakePage(
            {"css:.form-security-code-inputs input": fields},
            state={"twofa": True, "codeInputCount": 6},
        )
        outcome = {}

        def auto_transition(*_args):
            page.state["twofa"] = False

        self.assertTrue(
            click_two_factor_submit(
                page,
                pause=auto_transition,
                keys=FakeKeys,
                fields=[(page, field) for field in fields],
                submit_outcome=outcome,
                auto_submit_wait_s=0.05,
            )
        )

        self.assertEqual(outcome, {"method": "automatic"})
        self.assertNotIn(("press", FakeKeys.ENTER), page.actions.calls)

    def test_two_factor_submit_enters_after_the_otp_frame_is_rewrapped(self):
        original_fields = [
            FakeElement(
                attrs={"maxlength": "1", "aria-description": "Verification code"}
            )
            for _ in range(6)
        ]
        refreshed_fields = [
            FakeElement(
                attrs={"maxlength": "1", "aria-description": "Verification code"}
            )
            for _ in range(6)
        ]
        original_frame = FakePage(
            {"css:.form-security-code-inputs input": original_fields},
            state={"twofa": True, "codeInputCount": 6},
        )
        refreshed_frame = FakePage(
            {"css:.form-security-code-inputs input": refreshed_fields},
            state={"twofa": True, "codeInputCount": 6},
        )
        iframe = FakeElement(attrs={"src": refreshed_frame.state["href"]})
        page = FakePage(
            {"css:iframe": [iframe]},
            frames=[refreshed_frame],
            actions=FakeActions(coordinate_target=refreshed_fields[-1]),
            state={"twofa": False, "codeInputCount": 0},
        )
        original_frame.parent = page
        refreshed_frame.parent = page
        outcome = {}

        self.assertTrue(
            click_two_factor_submit(
                page,
                pause=lambda *_: None,
                keys=FakeKeys,
                fields=[(original_frame, field) for field in original_fields],
                submit_outcome=outcome,
                auto_submit_wait_s=0,
            )
        )

        self.assertEqual(outcome, {"method": "enter"})
        self.assertIs(page.actions.target, refreshed_fields[-1])
        self.assertEqual(original_frame.actions.calls, [])
        self.assertIn(("press", FakeKeys.ENTER), page.actions.calls)

    def test_two_factor_submit_state_probe_error_does_not_suppress_enter(self):
        fields = [
            FakeElement(
                attrs={"maxlength": "1", "aria-description": "Verification code"}
            )
            for _ in range(6)
        ]
        page = FakePage(
            {"css:.form-security-code-inputs input": fields},
            state={"twofa": True, "codeInputCount": 6},
        )
        outcome = {}

        with patch(
            "apple_account_flow.detect_login_state",
            side_effect=RuntimeError("temporary state probe failure"),
        ):
            self.assertTrue(
                click_two_factor_submit(
                    page,
                    pause=lambda *_: None,
                    keys=FakeKeys,
                    fields=[(page, field) for field in fields],
                    submit_outcome=outcome,
                    auto_submit_wait_s=0,
                )
            )

        self.assertEqual(outcome, {"method": "enter"})
        self.assertIn(("press", FakeKeys.ENTER), page.actions.calls)

    def test_two_factor_submit_rechecks_focus_after_its_final_pause(self):
        fields = [
            FakeElement(
                attrs={"maxlength": "1", "aria-description": "Verification code"}
            )
            for _ in range(6)
        ]
        page = FakePage(
            {"css:.form-security-code-inputs input": fields},
            state={"twofa": True, "codeInputCount": 6},
        )
        pauses = 0
        outcome = {}

        def lose_focus_after_final_pause(*_args):
            nonlocal pauses
            pauses += 1
            if pauses == 3:
                fields[-1].focused = False

        self.assertFalse(
            click_two_factor_submit(
                page,
                pause=lose_focus_after_final_pause,
                keys=FakeKeys,
                fields=[(page, field) for field in fields],
                submit_outcome=outcome,
                auto_submit_wait_s=0,
            )
        )

        self.assertEqual(outcome, {"method": "none", "failure": "focus_unconfirmed"})
        self.assertNotIn(("press", FakeKeys.ENTER), page.actions.calls)

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
        iframe = FakeElement(attrs={"src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [iframe]},
            buttons=[unrelated_continue],
            frames=[frame],
            state={"trustPrompt": False},
        )
        frame.parent = page

        clicked = click_trust_browser(page, pause=lambda *_: None)

        self.assertTrue(clicked)
        self.assertEqual(unrelated_continue.clicks, 0)
        self.assertEqual(trust.clicks, 0)
        self.assertNotIn(("human_click", unrelated_continue), page.actions.calls)
        self.assertIn(("human_click", trust), frame.actions.calls)

    def test_trust_clicks_an_opaque_child_only_when_anchored_to_an_apple_root(self):
        for opaque_url in ("about:blank", "about:srcdoc"):
            with self.subTest(opaque_url=opaque_url):
                root_trust = FakeElement("Trust", prompt_semantics={"trust": True})
                child_trust = FakeElement("Trust", prompt_semantics={"trust": True})
                opaque_child = FakePage(
                    buttons=[child_trust],
                    state={"href": opaque_url, "trustPrompt": True},
                )
                iframe = FakeElement(attrs={"src": opaque_url})
                apple_root = FakePage(
                    {"css:iframe": [iframe]},
                    buttons=[root_trust],
                    frames=[opaque_child],
                    state={
                        "href": "https://idmsa.apple.com/IDMSWebAuth/signin",
                        "trustPrompt": False,
                    },
                )
                opaque_child.parent = apple_root

                self.assertTrue(click_trust_browser(apple_root, pause=lambda *_: None))

                self.assertNotIn(("human_click", root_trust), apple_root.actions.calls)
                self.assertIn(("human_click", child_trust), opaque_child.actions.calls)

    def test_trust_rejects_an_opaque_child_under_a_non_apple_parent(self):
        trust = FakeElement("Trust", prompt_semantics={"trust": True})
        opaque_child = FakePage(
            buttons=[trust],
            state={"href": "about:blank", "trustPrompt": True},
        )
        iframe = FakeElement(attrs={"src": "about:blank"})
        non_apple_parent = FakePage(
            {"css:iframe": [iframe]},
            frames=[opaque_child],
            state={"href": "https://evil.example/trust", "trustPrompt": False},
        )
        opaque_child.parent = non_apple_parent

        self.assertFalse(click_trust_browser(non_apple_parent, pause=lambda *_: None))

        self.assertEqual(non_apple_parent.actions.calls, [])
        self.assertEqual(opaque_child.actions.calls, [])

    def test_trust_rejects_an_opaque_top_level_document(self):
        trust = FakeElement("Trust", prompt_semantics={"trust": True})
        opaque_top_level = FakePage(
            buttons=[trust],
            state={"href": "about:blank", "trustPrompt": True},
        )

        self.assertFalse(click_trust_browser(opaque_top_level, pause=lambda *_: None))

        self.assertEqual(opaque_top_level.actions.calls, [])

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

    def test_two_factor_submit_rejects_an_opaque_top_level_frame_chain(self):
        verify = FakeElement("Verify", prompt_semantics={"twofa": True})
        top = FakePage(state={"href": "about:blank", "twofa": False})
        apple_frame = FakePage(
            state={"href": "https://idmsa.apple.com/appleauth/auth/verify", "twofa": False},
            parent=top,
        )
        opaque_frame = FakePage(
            buttons=[verify],
            state={"href": "about:blank", "twofa": True, "codeInputCount": 6},
            parent=apple_frame,
        )
        top.frames = [apple_frame]
        apple_frame.frames = [opaque_frame]

        clicked = click_two_factor_submit(top, pause=lambda *_: None)

        self.assertFalse(clicked)
        self.assertEqual(opaque_frame.actions.calls, [])

    def test_signed_in_wait_handles_a_shadow_only_trust_prompt(self):
        trust = FakeElement(
            "Trust this browser",
            prompt_semantics={"trust": True},
        )
        shadow_root = FakePage(buttons=[trust])
        page = FakePage(
            shadow_roots=[shadow_root],
            state={
                "trustPrompt": True,
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
                    "trustPrompt": False,
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
                "trustPrompt": True,
                "twofa": False,
                "error": False,
                "password": False,
                "email": False,
            },
        )
        trust.on_click = lambda: (
            page.state.__setitem__("trustPrompt", False),
            setattr(page, "_shadow_roots", []),
        )

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
                "trustPrompt": True,
                "twofa": False,
                "error": False,
                "password": False,
                "email": False,
            },
        )
        trust.on_click = lambda: (
            page.state.__setitem__("trustPrompt", False),
            setattr(page, "_shadow_roots", []),
        )

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
                wait_for_signed_in(page, timeout_s=0.05)

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

    def test_developer_automatic_otp_clicks_trust_once_then_confirms_the_shell(self):
        page = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "trustPrompt": True,
                "twofa": False,
                "trusted": False,
                "error": False,
                "password": False,
                "email": False,
            }
        )
        clicks = []
        events = []

        def click_trust(_page, **_kwargs):
            clicks.append("trust")
            page.state.update(
                {
                    "href": "https://developer.apple.com/account",
                    "trustPrompt": False,
                    "twofa": False,
                    "error": False,
                }
            )
            return True

        def developer_shell_probe(_page):
            if not clicks:
                return None
            return {
                "href": "https://developer.apple.com/account",
                "developerAccountShell": True,
                "trusted": True,
                "error": False,
            }

        with patch(
            "apple_account_flow.click_trust_browser", side_effect=click_trust
        ), patch("apple_account_flow.human_pause", lambda *_: None), patch(
            "apple_account_flow.emit", side_effect=events.append
        ):
            state = wait_for_signed_in(
                page,
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
                session_probe=developer_shell_probe,
            )

        self.assertTrue(state["developerAccountShell"])
        self.assertEqual(clicks, ["trust"])
        phases = [
            event.get("phase")
            for event in events
            if event.get("status") == "twofa_progress"
        ]
        self.assertEqual(phases, ["trust_prompt_detected", "trust_click_sent"])

    def test_developer_session_probe_waits_past_transient_account_manage_state(self):
        page = FakePage(
            state={
                "href": "https://account.apple.com/account/manage",
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "password": False,
                "email": False,
            }
        )
        page.states = FakeStates(alive=True)
        probe_states = iter(
            (
                None,
                {
                    "href": "https://developer.apple.com/account",
                    "developerAccountShell": True,
                    "trusted": True,
                    "error": False,
                },
            )
        )
        generic_account_state = {
            "href": "https://account.apple.com/account/manage",
            "trusted": True,
            "rootSessionTrusted": True,
            "rootError": False,
        }

        with patch(
            "apple_account_flow.confirmed_account_manage_state",
            return_value=generic_account_state,
        ) as generic_probe, patch(
            "apple_account_flow.human_pause", lambda *_: None
        ):
            state = wait_for_signed_in(
                page,
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
                session_probe=lambda _page: next(probe_states),
            )

        self.assertTrue(state["developerAccountShell"])
        generic_probe.assert_not_called()

    def test_developer_session_probe_waits_past_generic_trusted_state(self):
        page = FakePage(
            state={"href": "https://account.apple.com/account/manage"}
        )
        page.states = FakeStates(alive=True)
        probe_states = iter(
            (
                None,
                {
                    "href": "https://developer.apple.com/account",
                    "developerAccountShell": True,
                    "trusted": True,
                    "error": False,
                },
            )
        )
        transient_account_state = {
            "href": "https://account.apple.com/account/manage",
            "trusted": True,
            "rootSessionTrusted": True,
            "rootError": False,
            "twofa": False,
            "trustPrompt": False,
            "error": False,
        }

        with patch(
            "apple_account_flow.confirmed_account_manage_state", return_value=None
        ), patch(
            "apple_account_flow.detect_login_state",
            return_value=transient_account_state,
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_signed_in(
                page,
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
                session_probe=lambda _page: next(probe_states),
            )

        self.assertTrue(state["developerAccountShell"])

    def test_developer_pre_otp_probe_waits_past_generic_account_session(self):
        page = FakePage(
            state={"href": "https://account.apple.com/account/manage"}
        )
        page.states = FakeStates(alive=True)
        probe_states = iter(
            (
                None,
                {
                    "href": "https://developer.apple.com/account",
                    "developerAccountShell": True,
                    "trusted": True,
                    "error": False,
                },
            )
        )
        transient_account_state = {
            "href": "https://account.apple.com/account/manage",
            "trusted": True,
            "rootSessionTrusted": True,
            "rootError": False,
            "twofa": False,
            "trustPrompt": False,
            "error": False,
        }

        with patch(
            "apple_account_flow.detect_login_state",
            return_value=transient_account_state,
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            state = account_flow.wait_for_2fa_or_session(
                page,
                timeout_s=0.05,
                session_probe=lambda _page: next(probe_states),
            )

        self.assertTrue(state["developerAccountShell"])

    def test_shadow_trust_cannot_be_clicked_again_after_deadline_when_state_omits_prompt(self):
        initial_state = {
            "href": "https://idmsa.apple.com/appleauth/auth/verify",
            "trustPrompt": True,
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
            with self.assertRaisesRegex(RuntimeError, "trust-browser prompt"):
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

        current_state = page.state

        def next_state(script):
            nonlocal current_state
            if "location.href" in script and "JSON.stringify" not in script:
                return current_state["href"]
            if len(states) > 1:
                current_state = states.pop(0)
            else:
                current_state = states[0]
            return serialize_scope_state(current_state)

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

        current_state = page.state

        def next_state(script):
            nonlocal current_state
            if "location.href" in script and "JSON.stringify" not in script:
                return current_state["href"]
            if len(states) > 1:
                current_state = states.pop(0)
            else:
                current_state = states[0]
            return serialize_scope_state(current_state)

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
        page = FakePage(
            state={
                "href": "https://account.apple.com/sign-in",
                "twofa": False,
                "codeInputCount": 0,
            }
        )
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            state={"href": "about:blank", "twofa": True},
            parent=page,
        )
        page.frames = [frame]

        with patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_2fa_or_session(page, timeout_s=0.05)

        self.assertEqual(state["codeInputCount"], 6)
        self.assertTrue(state.get("twofaVisible"))
        self.assertTrue(state.get("inputReady"))

    def test_login_state_accepts_two_factor_in_an_opaque_apple_child_frame(self):
        page = FakePage(
            state={"href": "https://account.apple.com/sign-in", "twofa": False}
        )
        frame = FakePage(
            state={"href": "about:blank", "twofa": True, "codeInputCount": 6},
            parent=page,
        )
        page.frames = [frame]

        state = detect_login_state(page)

        self.assertTrue(state["twofa"])
        self.assertTrue(state["twofaVisible"])
        self.assertEqual(state["codeInputCount"], 6)

    def test_login_state_rejects_two_factor_in_an_opaque_non_apple_child_chain(self):
        page = FakePage(
            state={"href": "https://account.apple.com/sign-in", "twofa": False}
        )
        non_apple_frame = FakePage(
            state={"href": "https://evil.example/verify", "twofa": False},
            parent=page,
        )
        opaque_frame = FakePage(
            state={"href": "about:blank", "twofa": True, "codeInputCount": 6},
            parent=non_apple_frame,
        )
        page.frames = [non_apple_frame]
        non_apple_frame.frames = [opaque_frame]

        state = detect_login_state(page)

        self.assertFalse(state["twofa"])
        self.assertEqual(state["codeInputCount"], 0)

    def test_two_factor_scope_rechecks_a_leaf_url_that_changed_after_state_read(self):
        page = FakePage(
            state={"href": "https://account.apple.com/sign-in", "twofa": False}
        )
        frame = FakePage(
            state={"href": "https://evil.example/after-state-read", "twofa": True},
            parent=page,
        )

        self.assertFalse(
            account_flow.is_trusted_two_factor_scope(
                frame,
                "https://idmsa.apple.com/appleauth/auth/verify",
            )
        )

    def test_two_factor_scope_accepts_an_apple_rooted_srcdoc_child(self):
        page = FakePage(
            state={"href": "https://account.apple.com/sign-in", "twofa": False}
        )
        frame = FakePage(
            state={"href": "about:srcdoc", "twofa": True, "codeInputCount": 6},
            parent=page,
        )

        self.assertTrue(account_flow.is_trusted_two_factor_scope(frame))

    def test_2fa_wait_retries_a_transient_unreadable_scope_before_rechecking(self):
        recovered_state = {
            "href": "https://idmsa.apple.com/appleauth/auth/verify/phone",
            "twofa": True,
            "trusted": False,
            "error": False,
            "codeInputCount": 0,
        }
        with patch(
            "apple_account_flow.detect_login_state",
            side_effect=[
                RuntimeError("unable to inspect login page state through ruyiPage"),
                recovered_state,
            ],
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_2fa_or_session(FakePage(), timeout_s=0.05)

        self.assertTrue(state["twofa"])
        self.assertTrue(state["twofaVisible"])

    def test_2fa_wait_rediscovers_an_opaque_frame_after_enumeration_failure(self):
        fields = [FakeElement(attrs={"maxlength": "1"}) for _ in range(6)]
        page = FakePage(
            state={"href": "https://account.apple.com/sign-in", "twofa": False}
        )
        frame = FakePage(
            {"css:input[maxlength='1']": fields},
            state={"href": "about:blank", "twofa": True},
            parent=page,
        )
        page.frame_results = [RuntimeError("stale browsing context"), [frame]]

        with patch("apple_account_flow.human_pause", lambda *_: None):
            state = wait_for_2fa_or_session(page, timeout_s=0.05)

        self.assertTrue(state["twofaVisible"])
        self.assertTrue(state["inputReady"])
        self.assertEqual(state["codeInputCount"], 6)
        self.assertGreaterEqual(page.get_frames_calls, 2)
        self.assertEqual(page.actions.calls, [])
        self.assertEqual(frame.actions.calls, [])

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
        iframe = FakeElement(attrs={"src": frame.state["href"]})
        page = FakePage(
            {"css:iframe": [iframe]},
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
        frame.parent = page

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


class DeveloperAccountTests(unittest.TestCase):
    def authenticated_page(self, *, join_program=False, membership_navigation=False):
        page = DeveloperFakePage(
            state={
                "href": account_flow.DEVELOPER_ACCOUNT_URL,
                "twofa": False,
                "trustPrompt": False,
                "error": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            },
            account_snapshot={
                "authenticated": True,
                "accountShell": True,
                "joinProgram": join_program,
                "membershipNavigation": membership_navigation,
            },
        )
        page.states = FakeStates(alive=True)
        return page

    def evaluate_membership_details_query(
        self,
        text="",
        hash_value="#MembershipDetailsCard",
        *,
        main_text=None,
        body_text=None,
        shadow_texts=(),
        membership_card_text=None,
    ):
        page = DeveloperFakePage(state={"href": account_flow.DEVELOPER_ACCOUNT_URL})
        account_flow.developer_membership_details_snapshot(page)
        query = page.developer_scripts[-1]
        runner = r"""
const payload = JSON.parse(process.argv[1]);
const makeElement = (text, { id = '', className = '', shadowRoot = null } = {}) => ({
  innerText: text,
  textContent: text,
  children: [],
  shadowRoot,
  tagName: 'SPAN',
  id,
  className,
  getAttribute() { return null; },
  getBoundingClientRect() { return { width: 100, height: 20 }; }
});
const elementsFor = (text) => String(text || '')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((value) => makeElement(value));
const shadowRoots = (payload.shadowTexts || []).map((text) => {
  const elements = elementsFor(text);
  return {
    querySelectorAll(selector) {
      if (selector.includes('[id], [class], [data-testid]')) return [];
      if (selector.includes('h1, h2, h3, h4')) return [];
      return elements;
    }
  };
});
const membershipCards = payload.membershipCardText
  ? [makeElement(payload.membershipCardText, { id: 'MembershipDetailsCard' })]
  : [];
const elements = [
  ...elementsFor(payload.text),
  ...shadowRoots.map((root) => makeElement('', { shadowRoot: root })),
  ...membershipCards,
];
const main = { innerText: String(payload.mainText || '') };
const body = { innerText: String(payload.bodyText || '') };
globalThis.document = {
  body,
  querySelector(selector) { return selector === 'main' ? main : null; },
  querySelectorAll(selector) {
    if (selector.includes('[id], [class], [data-testid]')) return membershipCards;
    if (selector.includes('h1, h2, h3, h4')) return [];
    return elements;
  }
};
globalThis.location = { hash: payload.hash, pathname: '/account' };
globalThis.window = {
  getComputedStyle() { return { display: 'block', visibility: 'visible' }; }
};
const prefix = 'return JSON.stringify(';
const query = String(payload.query || '').trim();
if (!query.startsWith(prefix)) throw new Error('unexpected query prefix');
const expression = query.slice(prefix.length).replace(/\)\s*$/, '');
process.stdout.write(JSON.stringify(eval(expression)));
"""
        completed = subprocess.run(
            [
                "node",
                "-e",
                runner,
                json.dumps(
                    {
                        "query": query,
                        "text": text,
                        "mainText": text if main_text is None else main_text,
                        "bodyText": text if body_text is None else body_text,
                        "shadowTexts": list(shadow_texts),
                        "membershipCardText": membership_card_text,
                        "hash": hash_value,
                    },
                    ensure_ascii=False,
                ),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        return json.loads(completed.stdout)

    def test_developer_account_url_is_exact_https_origin(self):
        for url in (
            "https://developer.apple.com/account",
            "https://developer.apple.com/account/",
            "https://developer.apple.com/account/membership",
        ):
            with self.subTest(url=url):
                self.assertTrue(account_flow.is_developer_account_url(url))
        for url in (
            "http://developer.apple.com/account",
            "https://developer.apple.com.evil.example/account",
            "https://developer.apple.com:444/account",
            "https://developer.apple.com/sign-in?returnUrl=/account",
        ):
            with self.subTest(url=url):
                self.assertFalse(account_flow.is_developer_account_url(url))

    def test_join_program_banner_is_authenticated_not_enrolled_evidence(self):
        page = self.authenticated_page(join_program=True)

        state = account_flow.confirmed_developer_account_state(page)

        self.assertIsNotNone(state)
        self.assertTrue(state["joinProgram"])
        self.assertFalse(state["membershipNavigation"])

    def test_join_program_query_accepts_private_use_icon_prefix(self):
        page = self.authenticated_page(join_program=True)
        private_icon_banner = (
            "\U000f0000 \u52a0\u5165 Apple Developer Program "
            "\u5f53\u4f60\u51c6\u5907\u597d\u6784\u5efa\u66f4\u591a\u9ad8\u7ea7\u529f\u80fd"
        )

        account_flow.developer_account_snapshot(page)

        query = page.developer_scripts[-1]
        self.assertIn(
            "\u52a0\u5165 apple developer program",
            private_icon_banner.casefold(),
        )
        self.assertIn(
            r"label.includes('\u52a0\u5165 apple developer program')",
            query,
        )
        self.assertIn("authenticated: accountShell", query)
        self.assertNotIn(
            r"label.startsWith('\u52a0\u5165 apple developer program')",
            query,
        )

    def test_developer_snapshot_includes_localized_tab_navigation_shell_evidence(self):
        page = self.authenticated_page()

        account_flow.developer_account_snapshot(page)

        query = page.developer_scripts[-1]
        self.assertIn("[class*=\"DeveloperTabNav\"] li", query)
        self.assertIn(r"\u8ba1\u5212\u8d44\u6e90", query)
        self.assertIn("tabNavigation.length > 0", query)
        self.assertIn("navigationFeatureCount: featureCount", query)

    def test_membership_markers_without_account_shell_never_confirm_authentication(self):
        for marker in ("joinProgram", "membershipNavigation"):
            snapshot = {
                "authenticated": True,
                "accountShell": False,
                "joinProgram": False,
                "membershipNavigation": False,
            }
            snapshot[marker] = True
            page = DeveloperFakePage(
                state={"href": account_flow.DEVELOPER_ACCOUNT_URL},
                account_snapshot=snapshot,
            )
            page.states = FakeStates(alive=True)

            with self.subTest(marker=marker):
                self.assertIsNone(
                    account_flow.confirmed_developer_account_state(page)
                )

    def test_root_broad_text_error_does_not_block_a_verified_developer_shell(self):
        page = self.authenticated_page(join_program=True)
        page.state["error"] = True
        page.state["hardAuthenticationError"] = True
        page.state["assertiveAuthenticationError"] = False

        state = account_flow.confirmed_developer_account_state(page)

        self.assertIsNotNone(state)
        self.assertTrue(state["developerAccountShell"])
        self.assertTrue(state["joinProgram"])

    def test_root_assertive_authentication_error_blocks_a_verified_developer_shell(self):
        page = self.authenticated_page(join_program=True)
        page.state["error"] = True
        page.state["hardAuthenticationError"] = True
        page.state["assertiveAuthenticationError"] = True

        self.assertIsNone(account_flow.confirmed_developer_account_state(page))

    def test_root_shadow_broad_text_error_does_not_block_a_verified_shell(self):
        shadow_root = FakePage(
            state={
                "shadowEvidence": {
                    "hasStrongText": False,
                    "semanticTargetCount": 0,
                    "digitCellCount": 0,
                    "codeInputCount": 0,
                    "password": False,
                    "email": False,
                    "trustPrompt": False,
                    "otpRejected": False,
                    "blocked": False,
                    "error": True,
                    "hardAuthenticationError": True,
                    "assertiveAuthenticationError": False,
                }
            }
        )
        page = self.authenticated_page(join_program=True)
        page._shadow_roots = [shadow_root]

        state = account_flow.confirmed_developer_account_state(page)

        self.assertIsNotNone(state)
        self.assertIn(("all", False), page.shadow_roots_calls)

    def test_unreadable_root_shadow_state_blocks_a_verified_shell(self):
        page = self.authenticated_page(join_program=True)
        page.shadow_error = RuntimeError("shadow state unavailable")

        self.assertIsNone(account_flow.confirmed_developer_account_state(page))

    def test_live_root_auth_controls_block_account_shell_and_membership_marker(self):
        for control in (
            "email",
            "password",
            "twofa",
            "trustPrompt",
            "blocked",
            "otpRejected",
        ):
            with self.subTest(control=control):
                page = self.authenticated_page(join_program=True)
                page.state[control] = True

                self.assertIsNone(
                    account_flow.confirmed_developer_account_state(page)
                )

    def test_live_apple_child_error_blocks_a_verified_developer_shell(self):
        child = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "error": True,
                "email": False,
                "password": False,
                "twofa": False,
                "trustPrompt": False,
                "otpRejected": False,
                "blocked": False,
            }
        )
        iframe = FakeElement(attrs={"src": child.state["href"]})
        page = self.authenticated_page(join_program=True)
        page.elements_by_selector["css:iframe"] = [iframe]
        page.frames = [child]
        child.parent = page

        self.assertIsNone(account_flow.confirmed_developer_account_state(page))

    def test_live_opaque_two_factor_child_blocks_a_verified_developer_shell(self):
        for opaque_url in ("about:blank", "about:srcdoc"):
            with self.subTest(opaque_url=opaque_url):
                child = FakePage(
                    state={
                        "href": opaque_url,
                        "error": False,
                        "email": False,
                        "password": False,
                        "twofa": True,
                        "trustPrompt": False,
                        "otpRejected": False,
                        "blocked": False,
                        "codeInputCount": 6,
                    }
                )
                iframe = FakeElement(
                    attrs={
                        "id": account_flow.APPLE_SIX_CELL_WIDGET_IFRAME_ID,
                        "src": opaque_url,
                    }
                )
                page = self.authenticated_page(join_program=True)
                page.elements_by_selector["css:iframe"] = [iframe]
                page.frames = [child]
                child.parent = page

                self.assertIsNone(
                    account_flow.confirmed_developer_account_state(page)
                )

    def test_live_apple_child_shadow_error_blocks_a_verified_developer_shell(self):
        child_shadow = FakePage(
            state={
                "shadowEvidence": {
                    "hasStrongText": False,
                    "semanticTargetCount": 0,
                    "digitCellCount": 0,
                    "codeInputCount": 0,
                    "password": False,
                    "email": False,
                    "trustPrompt": False,
                    "otpRejected": False,
                    "blocked": False,
                    "error": True,
                    "hardAuthenticationError": True,
                    "assertiveAuthenticationError": True,
                }
            }
        )
        child = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "error": False,
                "email": False,
                "password": False,
                "twofa": False,
                "trustPrompt": False,
                "otpRejected": False,
                "blocked": False,
            },
            shadow_roots=[child_shadow],
        )
        iframe = FakeElement(attrs={"src": child.state["href"]})
        page = self.authenticated_page(join_program=True)
        page.elements_by_selector["css:iframe"] = [iframe]
        page.frames = [child]
        child.parent = page

        self.assertIsNone(account_flow.confirmed_developer_account_state(page))
        self.assertIn(("all", False), child.shadow_roots_calls)

    def test_retiring_child_text_error_does_not_block_a_verified_developer_shell(self):
        child_shadow = FakePage(
            state={
                "shadowEvidence": {
                    "hasStrongText": False,
                    "semanticTargetCount": 0,
                    "digitCellCount": 0,
                    "codeInputCount": 0,
                    "password": False,
                    "email": False,
                    "trustPrompt": False,
                    "otpRejected": False,
                    "blocked": False,
                    "error": True,
                    "hardAuthenticationError": True,
                    "assertiveAuthenticationError": False,
                }
            }
        )
        child = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "error": False,
                "email": False,
                "password": False,
                "twofa": False,
                "trustPrompt": False,
                "otpRejected": False,
                "blocked": False,
                "codeInputCount": 0,
            },
            shadow_roots=[child_shadow],
        )
        iframe = FakeElement(attrs={"src": child.state["href"]})
        page = self.authenticated_page(join_program=True)
        page.elements_by_selector["css:iframe"] = [iframe]
        page.frames = [child]
        child.parent = page

        state = account_flow.confirmed_developer_account_state(page)

        self.assertIsNotNone(state)
        self.assertTrue(state["developerAccountShell"])
        self.assertIn(("all", False), child.shadow_roots_calls)

    def test_missing_membership_evidence_fails_closed_without_claiming_active(self):
        page = self.authenticated_page()

        state = account_flow.confirmed_developer_account_state(page)

        self.assertIsNotNone(state)
        self.assertFalse(state["joinProgram"])
        self.assertFalse(state["membershipNavigation"])

    def test_active_requires_membership_navigation_and_program_details(self):
        membership_link = FakeElement(
            text="会员资格详细信息",
            attrs={
                "developerMembershipNavigation": {
                    "visible": True,
                    "label": "会员资格详细信息",
                }
            },
        )
        page = DeveloperFakePage(
            {"css:a": [membership_link]},
            state={"href": "https://developer.apple.com/account"},
            account_snapshot={
                "authenticated": True,
                "accountShell": True,
                "joinProgram": False,
                "membershipNavigation": True,
            },
            membership_details=[
                {
                    "detailsPage": False,
                    "appleDeveloperProgram": False,
                    "renewalDate": False,
                    "registrationIdentity": False,
                    "membershipFieldCount": 0,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "membershipFieldCount": 2,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "membershipFieldCount": 2,
                },
            ],
        )
        page.states = FakeStates(alive=True)

        with patch("apple_account_flow.time.monotonic", side_effect=[0.0, 0.1, 0.2, 0.3]), patch(
            "apple_account_flow.human_pause", lambda *_: None
        ):
            active = account_flow.confirm_active_developer_membership(
                page,
                pause=lambda *_: None,
            )

        self.assertTrue(active)
        self.assertIn(("human_click", membership_link), page.actions.calls)
        self.assertEqual(membership_link.scroll.calls, [("to_see",)])
        details_queries = [
            script
            for script in page.developer_scripts
            if "ruyipage-developer-membership-details" in script
        ]
        self.assertEqual(len(details_queries), 3)

    def test_plain_list_item_can_open_membership_details(self):
        membership_item = FakeElement(
            text="Membership details",
            attrs={
                "developerMembershipNavigation": {
                    "visible": True,
                    "label": "membership details",
                }
            },
        )
        page = DeveloperFakePage(
            {"css:main li": [membership_item]},
            state={"href": account_flow.DEVELOPER_ACCOUNT_URL},
            membership_details=[
                {
                    "detailsPage": False,
                    "appleDeveloperProgram": False,
                    "renewalDate": False,
                    "registrationIdentity": False,
                    "membershipFieldCount": 0,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "membershipFieldCount": 2,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "membershipFieldCount": 2,
                },
            ],
        )
        page.states = FakeStates(alive=True)

        with patch(
            "apple_account_flow.time.monotonic",
            side_effect=[0.0, 0.1, 0.2, 0.3],
        ):
            active = account_flow.confirm_active_developer_membership(
                page,
                pause=lambda *_: None,
            )

        self.assertTrue(active)
        self.assertIn(("human_click", membership_item), page.actions.calls)

    def test_hash_routed_membership_details_bypass_navigation_and_wait_for_hydration(self):
        page = DeveloperFakePage(
            state={
                "href": "https://developer.apple.com/account#MembershipDetailsCard"
            },
            membership_details=[
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": False,
                    "renewalDate": False,
                    "registrationIdentity": False,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "membershipFieldCount": 2,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "membershipFieldCount": 2,
                },
            ],
        )
        page.states = FakeStates(alive=True)

        with patch(
            "apple_account_flow.time.monotonic",
            side_effect=[0.0, 0.1, 0.2, 0.3, 0.4],
        ):
            active = account_flow.confirm_active_developer_membership(
                page,
                pause=lambda *_: None,
            )

        self.assertTrue(active)
        self.assertEqual(page.actions.calls, [])
        self.assertEqual(
            len(
                [
                    script
                    for script in page.developer_scripts
                    if "ruyipage-developer-membership-details" in script
                ]
            ),
            3,
        )

    def test_canonical_account_url_confirms_visible_membership_details_without_navigation(self):
        page = DeveloperFakePage(
            state={"href": "https://developer.apple.com/account"},
            membership_details=[
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "teamId": True,
                    "membershipFieldCount": 3,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "teamId": True,
                    "membershipFieldCount": 3,
                },
            ],
        )
        page.states = FakeStates(alive=True)

        with patch(
            "apple_account_flow.time.monotonic",
            side_effect=[0.0, 0.1, 0.2, 0.3],
        ), patch("apple_account_flow.emit"):
            active = account_flow.confirm_active_developer_membership(
                page,
                pause=lambda *_: None,
            )

        self.assertTrue(active)
        self.assertEqual(page.actions.calls, [])

    def test_membership_details_require_renewal_evidence(self):
        page = DeveloperFakePage(
            state={
                "href": "https://developer.apple.com/account#MembershipDetailsCard"
            },
            membership_details={
                "detailsPage": True,
                "appleDeveloperProgram": True,
                "renewalDate": False,
                "registrationIdentity": False,
                "membershipFieldCount": 0,
            },
        )
        page.states = FakeStates(alive=True)

        with patch(
            "apple_account_flow.time.monotonic",
            side_effect=[0.0, 0.1, 0.2, 1.1],
        ):
            active = account_flow.confirm_active_developer_membership(
                page,
                timeout_s=1.0,
                pause=lambda *_: None,
            )

        self.assertFalse(active)

    def test_membership_details_with_renewal_evidence_do_not_require_registration_identity(self):
        page = DeveloperFakePage(
            state={
                "href": "https://developer.apple.com/account#MembershipDetailsCard"
            },
            membership_details=[
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": False,
                    "teamId": True,
                    "membershipFieldCount": 2,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": False,
                    "teamId": True,
                    "membershipFieldCount": 2,
                },
            ],
        )
        page.states = FakeStates(alive=True)

        with patch(
            "apple_account_flow.time.monotonic",
            side_effect=[0.0, 0.1, 0.2, 0.3],
        ):
            active = account_flow.confirm_active_developer_membership(
                page,
                pause=lambda *_: None,
            )

        self.assertTrue(active)

    def test_hash_routed_membership_scrolls_card_before_lazy_field_hydration(self):
        order = []

        class OrderedDeveloperPage(DeveloperFakePage):
            def run_js(self, script):
                if "ruyipage-developer-membership-details" in script:
                    order.append("probe")
                return super().run_js(script)

        initial_details = {
            "detailsPage": True,
            "appleDeveloperProgram": True,
            "renewalDate": False,
            "registrationIdentity": False,
            "membershipFieldCount": 0,
        }
        hydrated_details = {
            "detailsPage": True,
            "appleDeveloperProgram": True,
            "renewalDate": True,
            "registrationIdentity": True,
            "membershipFieldCount": 2,
        }
        page = OrderedDeveloperPage(
            state={
                "href": "https://developer.apple.com/account#MembershipDetailsCard"
            },
            membership_details=initial_details,
        )
        membership_card = FakeElement(
            attrs={"id": "MembershipDetailsCard"},
            on_scroll=lambda: (
                order.append("scroll"),
                setattr(page, "membership_details", hydrated_details),
            ),
        )
        page.elements_by_selector[
            "css:[id*='MembershipDetailsCard']"
        ] = [membership_card]
        membership_card.scope = page
        page.states = FakeStates(alive=True)

        with patch(
            "apple_account_flow.time.monotonic",
            side_effect=[0.0, 0.1, 0.2, 0.3],
        ):
            active = account_flow.confirm_active_developer_membership(
                page,
                pause=lambda *_: None,
            )

        self.assertTrue(active)
        self.assertEqual(membership_card.scroll.calls, [("to_see",)])
        self.assertEqual(order, ["scroll", "probe", "probe"])

    def test_membership_details_with_live_auth_controls_fails_closed(self):
        page = DeveloperFakePage(
            state={
                "href": "https://developer.apple.com/account#MembershipDetailsCard",
                "email": True,
                "password": True,
                "error": True,
                "assertiveAuthenticationError": True,
            },
            membership_details={
                "detailsPage": True,
                "appleDeveloperProgram": True,
                "renewalDate": True,
                "registrationIdentity": True,
                "membershipFieldCount": 2,
            },
        )
        page.states = FakeStates(alive=True)

        with patch(
            "apple_account_flow.time.monotonic",
            side_effect=[0.0, 0.1, 0.2],
        ):
            active = account_flow.confirm_active_developer_membership(
                page,
                pause=lambda *_: None,
            )

        self.assertFalse(active)

    def test_membership_details_with_root_text_only_error_waits_for_hydration(self):
        page = DeveloperFakePage(
            state={
                "href": "https://developer.apple.com/account#MembershipDetailsCard",
                "error": True,
            },
            membership_details=[
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": False,
                    "renewalDate": False,
                    "registrationIdentity": False,
                    "membershipFieldCount": 0,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "membershipFieldCount": 2,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "membershipFieldCount": 2,
                },
            ],
        )
        page.states = FakeStates(alive=True)

        with patch(
            "apple_account_flow.time.monotonic",
            side_effect=[0.0, 0.1, 0.2, 0.3, 0.4],
        ):
            active = account_flow.confirm_active_developer_membership(
                page,
                pause=lambda *_: None,
            )

        self.assertTrue(active)

    def test_membership_details_query_reads_hash_and_generic_card_fields(self):
        page = DeveloperFakePage(
            state={"href": account_flow.DEVELOPER_ACCOUNT_URL},
        )

        account_flow.developer_membership_details_snapshot(page)

        query = page.developer_scripts[-1]
        self.assertIn("location.hash", query)
        self.assertIn("openShadowRoots", query)
        self.assertIn("queryRoots", query)
        self.assertIn("renewalDate", query)
        self.assertIn("registrationIdentity", query)

    def test_membership_details_query_classifies_chinese_and_english_dom_text(self):
        fixtures = (
            (
                "会员资格详细信息\n团队 ID\nTEAM-TEST-001\n计划\nApple Developer Program\n"
                "注册身份\n个人\n续订日期\n2030年1月2日",
                "#MembershipDetailsCard",
            ),
            (
                "Membership details\nTeam ID\nTEAM-TEST-001\nPlan\nApple Developer Program\n"
                "Registration identity\nIndividual\nRenewal date\nJanuary 2, 2030",
                "#MembershipDetailsCard",
            ),
            (
                "Membership details Team ID TEAM-TEST-001 Plan Apple Developer Program "
                "Registration identity Individual Phone 5550100 Street address Example Street "
                "Renewal date January 2, 2030 Annual fee TEST-AMOUNT Device reset date January 2, 2030",
                "#MembershipDetailsCard",
            ),
            (
                "会员资格详细信息 团队 ID TEAM-TEST-001 计划 Apple Developer Program "
                "注册身份 个人 电话 5550100 街道地址 示例街道 续订日期 2030年1月2日 "
                "年费 TEST-AMOUNT 设备重置日期 2030年1月2日",
                "#MembershipDetailsCard",
            ),
        )
        for text, hash_value in fixtures:
            with self.subTest(text=text):
                snapshot = self.evaluate_membership_details_query(text, hash_value)
                self.assertTrue(snapshot["detailsPage"])
                self.assertTrue(snapshot["appleDeveloperProgram"])
                self.assertTrue(snapshot["renewalDate"])
                self.assertTrue(snapshot["registrationIdentity"])
                self.assertEqual(
                    snapshot["registrationIdentityValue"],
                    "个人" if "注册身份" in text else "individual",
                )
                self.assertTrue(
                    account_flow.developer_membership_snapshot_is_active(snapshot)
                )

    def test_membership_details_query_merges_shell_body_and_open_shadow_card_text(self):
        snapshot = self.evaluate_membership_details_query(
            "",
            "#MembershipDetailsCard",
            main_text="Account",
            body_text="Account",
            shadow_texts=(
                "会员资格详细信息 团队 ID TESTTEAM01 计划 Apple Developer Program "
                "注册身份 个人 电话 5550100 街道地址 Example Street 续订日期 2030年1月2日 "
                "年费 TEST-AMOUNT 设备重置日期 2030年1月2日",
            ),
        )

        self.assertTrue(snapshot["detailsPage"])
        self.assertTrue(snapshot["appleDeveloperProgram"])
        self.assertTrue(snapshot["renewalDate"])
        self.assertTrue(snapshot["registrationIdentity"])
        self.assertTrue(
            account_flow.developer_membership_snapshot_is_active(snapshot)
        )

    def test_membership_details_query_rejects_hash_and_title_without_field_values(self):
        snapshot = self.evaluate_membership_details_query(
            "会员资格详细信息\nApple Developer Program"
        )
        self.assertTrue(snapshot["detailsPage"])
        self.assertTrue(snapshot["appleDeveloperProgram"])
        self.assertFalse(snapshot["renewalDate"])
        self.assertFalse(snapshot["registrationIdentity"])
        self.assertIsNone(snapshot["registrationIdentityValue"])

    def test_membership_navigation_label_is_not_a_membership_details_page(self):
        snapshot = self.evaluate_membership_details_query(
            "Membership details",
            "",
        )

        self.assertFalse(snapshot["detailsPage"])
        self.assertFalse(snapshot["appleDeveloperProgram"])
        self.assertFalse(snapshot["renewalDate"])
        self.assertFalse(snapshot["registrationIdentity"])
        self.assertIsNone(snapshot["registrationIdentityValue"])

    def test_membership_details_query_does_not_cross_text_source_boundaries(self):
        membership_labels_without_values = (
            "Membership details\nPlan\nApple Developer Program\n"
            "Registration identity\nRenewal date"
        )
        snapshot = self.evaluate_membership_details_query(
            "",
            "#MembershipDetailsCard",
            main_text=membership_labels_without_values,
            body_text="Account\n" + membership_labels_without_values,
        )

        self.assertTrue(snapshot["detailsPage"])
        self.assertTrue(snapshot["appleDeveloperProgram"])
        self.assertFalse(snapshot["renewalDate"])
        self.assertFalse(snapshot["registrationIdentity"])
        self.assertIsNone(snapshot["registrationIdentityValue"])
        self.assertFalse(
            account_flow.developer_membership_snapshot_is_active(snapshot)
        )

    def test_membership_details_query_does_not_skip_over_the_next_field_label(self):
        snapshot = self.evaluate_membership_details_query(
            "Membership details\nPlan\nApple Developer Program\n"
            "Renewal date\nRegistration identity\nIndividual"
        )

        self.assertTrue(snapshot["detailsPage"])
        self.assertTrue(snapshot["appleDeveloperProgram"])
        self.assertFalse(snapshot["renewalDate"])
        self.assertTrue(snapshot["registrationIdentity"])
        self.assertFalse(
            account_flow.developer_membership_snapshot_is_active(snapshot)
        )

    def test_membership_details_card_is_primary_evidence_scope(self):
        snapshot = self.evaluate_membership_details_query(
            "",
            "",
            main_text="Account",
            body_text="Account",
            membership_card_text=(
                "Membership details Team ID TEAM-TEST-001 Plan Apple Developer Program "
                "Registration identity Individual Renewal date January 2, 2030"
            ),
        )

        self.assertTrue(snapshot["detailsPage"])
        self.assertTrue(snapshot["appleDeveloperProgram"])
        self.assertTrue(snapshot["renewalDate"])
        self.assertTrue(snapshot["registrationIdentity"])
        self.assertTrue(
            account_flow.developer_membership_snapshot_is_active(snapshot)
        )

    def test_membership_details_card_does_not_borrow_surrounding_page_values(self):
        snapshot = self.evaluate_membership_details_query(
            "",
            "",
            main_text="Account",
            body_text=(
                "Membership details Plan Apple Developer Program Registration identity "
                "Individual Renewal date January 2, 2030"
            ),
            membership_card_text=(
                "Membership details Plan Apple Developer Program Registration identity "
                "Renewal date"
            ),
        )

        self.assertTrue(snapshot["detailsPage"])
        self.assertTrue(snapshot["appleDeveloperProgram"])
        self.assertFalse(snapshot["renewalDate"])
        self.assertFalse(snapshot["registrationIdentity"])
        self.assertFalse(
            account_flow.developer_membership_snapshot_is_active(snapshot)
        )

    def test_membership_details_query_rejects_empty_renewal_placeholders(self):
        for placeholder in ("-", "—", "N/A", "未提供"):
            with self.subTest(placeholder=placeholder):
                snapshot = self.evaluate_membership_details_query(
                    "Membership details\nPlan\nApple Developer Program\n"
                    f"Renewal date\n{placeholder}\nRegistration identity\nIndividual"
                )

                self.assertTrue(snapshot["detailsPage"])
                self.assertTrue(snapshot["appleDeveloperProgram"])
                self.assertFalse(snapshot["renewalDate"])
                self.assertTrue(snapshot["registrationIdentity"])
                self.assertFalse(
                    account_flow.developer_membership_snapshot_is_active(snapshot)
                )

    def test_membership_details_query_accepts_expiration_date_without_registration_identity(self):
        snapshot = self.evaluate_membership_details_query(
            "Membership details\nPlan\nApple Developer Program\n"
            "Expiration date\nJanuary 2, 2030"
        )

        self.assertTrue(snapshot["detailsPage"])
        self.assertTrue(snapshot["appleDeveloperProgram"])
        self.assertTrue(snapshot["renewalDate"])
        self.assertFalse(snapshot["registrationIdentity"])
        self.assertTrue(
            account_flow.developer_membership_snapshot_is_active(snapshot)
        )

    def test_selector_priority_avoids_counting_nested_wrappers_twice(self):
        membership_item = FakeElement(
            text="Membership details",
            attrs={
                "developerMembershipNavigation": {
                    "visible": True,
                    "label": "membership details",
                }
            },
        )
        nested_link_wrapper = FakeElement(
            text="Membership details",
            attrs={
                "developerMembershipNavigation": {
                    "visible": True,
                    "label": "membership details",
                }
            },
        )
        page = DeveloperFakePage(
            {
                "css:main li": [membership_item],
                "css:a": [nested_link_wrapper],
            },
            state={"href": account_flow.DEVELOPER_ACCOUNT_URL},
        )

        resolved = account_flow.resolve_developer_membership_navigation(page)

        self.assertEqual(resolved, (page, membership_item))

    def test_duplicate_membership_items_in_one_selector_fail_closed(self):
        first = FakeElement(
            text="Membership details",
            attrs={
                "developerMembershipNavigation": {
                    "visible": True,
                    "label": "membership details",
                }
            },
        )
        second = FakeElement(
            text="Membership details",
            attrs={
                "developerMembershipNavigation": {
                    "visible": True,
                    "label": "membership details",
                }
            },
        )
        page = DeveloperFakePage(
            {"css:main li": [first, second]},
            state={"href": account_flow.DEVELOPER_ACCOUNT_URL},
        )

        self.assertIsNone(
            account_flow.resolve_developer_membership_navigation(page)
        )

    def test_program_details_without_membership_navigation_never_claims_active(self):
        page = DeveloperFakePage(
            state={"href": "https://developer.apple.com/account"},
            account_snapshot={
                "authenticated": True,
                "joinProgram": False,
                "membershipNavigation": False,
            },
            membership_details={
                "detailsPage": True,
                "appleDeveloperProgram": True,
            },
        )

        self.assertFalse(
            account_flow.confirm_active_developer_membership(
                page,
                timeout_s=0,
                pause=lambda *_: None,
            )
        )

    def test_collects_not_enrolled_in_a_new_tab_without_requesting_another_code(self):
        developer_page = self.authenticated_page(join_program=True)
        developer_page.wait = type(
            "FakeWait",
            (),
            {"doc_loaded": lambda *_args, **_kwargs: None},
        )()

        class RootPage:
            def __init__(self):
                self.opened = []

            def new_tab(self, url):
                self.opened.append(url)
                return developer_page

        context = {"twofaPrepared": True, "nextGeneration": 2}
        page_holder = {}
        with patch(
            "apple_account_flow.complete_account_authentication",
            return_value={
                "confirmedState": {
                    "trusted": True,
                    "developerAccountShell": True,
                    "joinProgram": True,
                    "membershipNavigation": False,
                },
                "skippedLogin": True,
                "skipped2FA": True,
                "rememberAccount": None,
            },
        ) as authenticate, patch("apple_account_flow.human_pause", lambda *_: None), patch(
            "apple_account_flow.emit"
        ):
            result, returned_page, screenshot = (
                account_flow.collect_developer_account_membership(
                    RootPage(),
                    "person@example.com",
                    "secret",
                    FakeKeys,
                    context,
                    Path("unused.png"),
                    page_holder=page_holder,
                )
            )

        self.assertEqual(result["membershipStatus"], "not_enrolled")
        self.assertIs(returned_page, developer_page)
        self.assertIs(page_holder["page"], developer_page)
        self.assertIsNone(screenshot)
        authenticate.assert_called_once_with(
            developer_page,
            "person@example.com",
            "secret",
            FakeKeys,
            account_home_confirmed=False,
            authentication_context=context,
            session_probe=account_flow.confirmed_developer_account_state,
        )

    def test_collects_active_membership_and_returns_fixed_screenshot(self):
        developer_page = self.authenticated_page(membership_navigation=True)
        capture_order = []
        membership_card = FakeElement(
            attrs={"id": "MembershipDetailsCard"},
            on_scroll=lambda: capture_order.append("card_scrolled"),
        )
        developer_page.elements_by_selector[
            "css:[id*='MembershipDetailsCard']"
        ] = [membership_card]
        developer_page.membership_details = {
            "detailsPage": True,
            "appleDeveloperProgram": True,
            "renewalDate": True,
            "registrationIdentity": True,
            "registrationIdentityValue": "个人",
            "membershipFieldCount": 2,
        }
        developer_page.wait = type(
            "FakeWait",
            (),
            {"doc_loaded": lambda *_args, **_kwargs: None},
        )()

        class RootPage:
            def new_tab(self, _url):
                return developer_page

        screenshot_path = Path("03-developer-membership.png")
        events = []
        with patch(
            "apple_account_flow.complete_account_authentication",
            return_value={
                "confirmedState": {
                    "trusted": True,
                    "developerAccountShell": True,
                    "joinProgram": False,
                    "membershipNavigation": True,
                },
                "skippedLogin": True,
                "skipped2FA": True,
                "rememberAccount": None,
            },
        ), patch(
            "apple_account_flow.confirm_active_developer_membership",
            return_value=True,
        ), patch(
            "apple_account_flow.take_screenshot",
            side_effect=lambda *_args, **_kwargs: (
                capture_order.append("screenshot"),
                str(screenshot_path),
            )[1],
        ) as screenshot, patch(
            "apple_account_flow.human_pause",
            lambda *_: None,
        ), patch("apple_account_flow.emit", side_effect=events.append):
            result, returned_page, captured = (
                account_flow.collect_developer_account_membership(
                    RootPage(),
                    "person@example.com",
                    "secret",
                    FakeKeys,
                    {"twofaPrepared": True, "nextGeneration": 2},
                    screenshot_path,
                )
            )

        self.assertTrue(result["success"])
        self.assertTrue(result["authenticated"])
        self.assertEqual(result["membershipStatus"], "active")
        self.assertEqual(result["registrationIdentityValue"], "个人")
        self.assertIn(
            {
                "event": "status",
                "status": "developer_membership_checked",
                "membershipStatus": "active",
                "registrationIdentityValue": "个人",
            },
            events,
        )
        self.assertIs(returned_page, developer_page)
        self.assertEqual(captured, str(screenshot_path))
        self.assertEqual(membership_card.scroll.calls, [("to_see",)])
        self.assertEqual(capture_order, ["card_scrolled", "screenshot"])
        screenshot.assert_called_once_with(
            developer_page,
            screenshot_path,
            checkpoint="developer_membership",
            full_page=False,
        )

    def test_collects_active_membership_after_late_hash_hydration_without_nav_snapshot(self):
        developer_page = DeveloperFakePage(
            state={
                "href": "https://developer.apple.com/account#MembershipDetailsCard"
            },
            membership_details=[
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": False,
                    "renewalDate": False,
                    "registrationIdentity": False,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "registrationIdentityValue": "个人",
                    "membershipFieldCount": 2,
                },
                {
                    "detailsPage": True,
                    "appleDeveloperProgram": True,
                    "renewalDate": True,
                    "registrationIdentity": True,
                    "registrationIdentityValue": "个人",
                    "membershipFieldCount": 2,
                },
            ],
        )
        membership_card = FakeElement(attrs={"id": "MembershipDetailsCard"})
        developer_page.elements_by_selector[
            "css:[id*='MembershipDetailsCard']"
        ] = [membership_card]
        membership_card.scope = developer_page
        developer_page.states = FakeStates(alive=True)
        developer_page.wait = type(
            "FakeWait",
            (),
            {"doc_loaded": lambda *_args, **_kwargs: None},
        )()

        class RootPage:
            def new_tab(self, _url):
                return developer_page

        screenshot_path = Path("03-developer-membership.png")
        with patch(
            "apple_account_flow.complete_account_authentication",
            return_value={
                "confirmedState": {
                    "trusted": True,
                    "developerAccountShell": True,
                    "joinProgram": False,
                    "membershipNavigation": False,
                },
                "skippedLogin": True,
                "skipped2FA": True,
                "rememberAccount": None,
            },
        ), patch(
            "apple_account_flow.time.monotonic",
            side_effect=[0.0, 0.1, 0.2, 0.3, 0.4],
        ), patch(
            "apple_account_flow.take_screenshot",
            return_value=str(screenshot_path),
        ) as screenshot, patch(
            "apple_account_flow.human_pause",
            lambda *_: None,
        ), patch("apple_account_flow.emit"):
            result, returned_page, captured = (
                account_flow.collect_developer_account_membership(
                    RootPage(),
                    "person@example.com",
                    "secret",
                    FakeKeys,
                    {"twofaPrepared": True, "nextGeneration": 2},
                    screenshot_path,
                )
            )

        self.assertEqual(result["membershipStatus"], "active")
        self.assertEqual(result["registrationIdentityValue"], "个人")
        self.assertIs(returned_page, developer_page)
        self.assertEqual(captured, str(screenshot_path))
        screenshot.assert_called_once_with(
            developer_page,
            screenshot_path,
            checkpoint="developer_membership",
            full_page=False,
        )
        self.assertEqual(membership_card.scroll.calls, [("to_see",), ("to_see",)])

    def test_active_membership_without_a_resolved_details_card_skips_misleading_screenshot(self):
        developer_page = self.authenticated_page(membership_navigation=True)
        developer_page.wait = type(
            "FakeWait",
            (),
            {"doc_loaded": lambda *_args, **_kwargs: None},
        )()

        class RootPage:
            def new_tab(self, _url):
                return developer_page

        events = []
        with patch(
            "apple_account_flow.complete_account_authentication",
            return_value={
                "confirmedState": {
                    "trusted": True,
                    "developerAccountShell": True,
                    "joinProgram": False,
                    "membershipNavigation": True,
                },
                "skippedLogin": True,
                "skipped2FA": True,
                "rememberAccount": None,
            },
        ), patch(
            "apple_account_flow.confirm_active_developer_membership",
            return_value=True,
        ), patch("apple_account_flow.human_pause", lambda *_: None), patch(
            "apple_account_flow.take_screenshot"
        ) as screenshot, patch("apple_account_flow.emit", side_effect=events.append):
            result, _returned_page, captured = (
                account_flow.collect_developer_account_membership(
                    RootPage(),
                    "person@example.com",
                    "secret",
                    FakeKeys,
                    {"twofaPrepared": True, "nextGeneration": 2},
                    Path("03-developer-membership.png"),
                )
            )

        self.assertEqual(result["membershipStatus"], "active")
        self.assertIsNone(captured)
        screenshot.assert_not_called()
        self.assertIn(
            {
                "event": "status",
                "status": "developer_membership_card_unavailable",
            },
            events,
        )

    def test_membership_markers_cannot_be_classified_without_confirmed_account_shell(self):
        developer_page = self.authenticated_page()
        developer_page.wait = type(
            "FakeWait",
            (),
            {"doc_loaded": lambda *_args, **_kwargs: None},
        )()

        class RootPage:
            def new_tab(self, _url):
                return developer_page

        for marker in ("joinProgram", "membershipNavigation"):
            confirmed_state = {
                "trusted": True,
                "developerAccountShell": False,
                "joinProgram": False,
                "membershipNavigation": False,
            }
            confirmed_state[marker] = True
            with self.subTest(marker=marker), patch(
                "apple_account_flow.complete_account_authentication",
                return_value={
                    "confirmedState": confirmed_state,
                    "skippedLogin": False,
                    "skipped2FA": False,
                    "rememberAccount": None,
                },
            ), patch(
                "apple_account_flow.confirm_active_developer_membership"
            ) as confirm_active, patch(
                "apple_account_flow.human_pause",
                lambda *_: None,
            ), patch("apple_account_flow.emit"), self.assertRaisesRegex(
                RuntimeError,
                "account shell was not confirmed",
            ):
                account_flow.collect_developer_account_membership(
                    RootPage(),
                    "person@example.com",
                    "secret",
                    FakeKeys,
                    {"twofaPrepared": True, "nextGeneration": 2},
                    Path("unused.png"),
                )
            confirm_active.assert_not_called()

    def test_preservation_is_partial_when_only_developer_tab_disconnects(self):
        account_page = FakePage()
        account_page.states = FakeStates(alive=True)
        developer_page = FakePage()
        developer_page.states = FakeStates(alive=False)
        events = []

        with patch("apple_account_flow.emit", side_effect=events.append):
            result = account_flow.finalize_post_login_browser(
                account_page,
                preserve_requested=True,
                profile_capture_success=True,
                required_pages=(developer_page,),
            )

        self.assertEqual(
            result,
            {
                "browserFinalizationCompleted": False,
                "browserPreservationRequested": True,
                "browserSessionPreserved": False,
                "finalizationClass": "browser_connection_lost",
            },
        )
        self.assertIn(
            {
                "event": "status",
                "status": "browser_finalization_partial",
                **result,
            },
            events,
        )
        self.assertNotIn(
            "browser_session_preserved",
            [event.get("status") for event in events],
        )

    def test_developer_redirect_waits_for_exact_target_dom_hydration(self):
        page = FakePage(
            state={
                "href": account_flow.DEVELOPER_ACCOUNT_URL,
                "twofa": False,
                "error": True,
                "hardAuthenticationError": True,
                "assertiveAuthenticationError": False,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
            }
        )
        confirmed = {
            "href": account_flow.DEVELOPER_ACCOUNT_URL,
            "trusted": True,
            "rootSessionTrusted": True,
            "developerAccount": True,
            "developerAccountShell": True,
            "joinProgram": True,
            "membershipNavigation": False,
        }
        session_probe = Mock(side_effect=[None, confirmed])
        with patch(
            "apple_account_flow.confirmed_account_manage_state",
            return_value=None,
        ), patch(
            "apple_account_flow.detect_login_state",
            return_value=page.state,
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            result = account_flow.wait_for_signed_in(
                page,
                timeout_s=1,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
                session_probe=session_probe,
            )

        self.assertIs(result, confirmed)
        self.assertEqual(session_probe.call_count, 2)

    def test_complete_developer_authentication_waits_past_initial_generic_session(self):
        page = FakePage(
            state={"href": "https://account.apple.com/account/manage"}
        )
        page.states = FakeStates(alive=True)
        generic_account_state = {
            "href": "https://account.apple.com/account/manage",
            "trusted": True,
            "rootSessionTrusted": True,
            "rootError": False,
            "twofa": False,
            "trustPrompt": False,
            "error": False,
        }
        confirmed = {
            "href": account_flow.DEVELOPER_ACCOUNT_URL,
            "trusted": True,
            "rootSessionTrusted": True,
            "developerAccount": True,
            "developerAccountShell": True,
            "joinProgram": False,
            "membershipNavigation": False,
        }
        session_probe = Mock(side_effect=[None, confirmed])

        with patch(
            "apple_account_flow.detect_login_state",
            return_value=generic_account_state,
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch("apple_account_flow.human_pause", lambda *_: None), patch(
            "apple_account_flow.emit_browser_observation"
        ):
            result = account_flow.complete_account_authentication(
                page,
                "person@example.com",
                "secret",
                FakeKeys,
                account_home_confirmed=False,
                authentication_context={"twofaPrepared": True, "nextGeneration": 2},
                session_probe=session_probe,
            )

        self.assertIs(result["confirmedState"], confirmed)
        self.assertTrue(result["skippedLogin"])
        self.assertTrue(result["skipped2FA"])
        self.assertEqual(session_probe.call_count, 2)

    def test_developer_top_level_target_waits_past_retiring_child_error(self):
        child = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "twofa": False,
                "trustPrompt": False,
                "error": True,
                "otpRejected": False,
                "blocked": False,
                "assertiveAuthenticationError": False,
                "password": False,
                "email": False,
                "codeInputCount": 0,
            }
        )
        page = self.authenticated_page(join_program=True)
        page.elements_by_selector["css:iframe"] = [
            FakeElement(attrs={"src": child.state["href"]})
        ]
        page.frames = [child]
        child.parent = page
        stale_child_state = {
            "href": child.state["href"],
            "twofa": False,
            "trustPrompt": False,
            "error": True,
            "otpRejected": False,
            "blocked": False,
            "trusted": False,
        }
        confirmed = {
            "href": account_flow.DEVELOPER_ACCOUNT_URL,
            "trusted": True,
            "rootSessionTrusted": True,
            "developerAccount": True,
            "developerAccountShell": True,
            "joinProgram": True,
            "membershipNavigation": False,
        }
        session_probe = Mock(side_effect=[None, confirmed])

        with patch(
            "apple_account_flow.confirmed_account_manage_state",
            return_value=None,
        ), patch(
            "apple_account_flow.detect_login_state",
            return_value=stale_child_state,
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch("apple_account_flow.human_pause", lambda *_: None):
            result = account_flow.wait_for_signed_in(
                page,
                timeout_s=1,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
                session_probe=session_probe,
            )

        self.assertIs(result, confirmed)
        self.assertEqual(session_probe.call_count, 2)

    def test_developer_redirect_rejects_assertive_apple_child_error_while_hydrating(self):
        child_shadow = FakePage(
            state={
                "shadowEvidence": {
                    "hasStrongText": False,
                    "semanticTargetCount": 0,
                    "digitCellCount": 0,
                    "codeInputCount": 0,
                    "password": False,
                    "email": False,
                    "trustPrompt": False,
                    "otpRejected": False,
                    "blocked": False,
                    "error": True,
                    "hardAuthenticationError": True,
                    "assertiveAuthenticationError": True,
                }
            }
        )
        child = FakePage(
            state={
                "href": "https://idmsa.apple.com/appleauth/auth/verify",
                "error": False,
                "hardAuthenticationError": False,
                "assertiveAuthenticationError": False,
                "email": False,
                "password": False,
                "twofa": False,
                "trustPrompt": False,
                "otpRejected": False,
                "blocked": False,
            },
            shadow_roots=[child_shadow],
        )
        iframe = FakeElement(attrs={"src": child.state["href"]})
        page = FakePage(
            state={
                "href": account_flow.DEVELOPER_ACCOUNT_URL,
                "twofa": False,
                "error": True,
                "hardAuthenticationError": True,
                "assertiveAuthenticationError": False,
                "otpRejected": False,
                "blocked": False,
                "trusted": False,
            },
            elements_by_selector={"css:iframe": [iframe]},
            frames=[child],
        )
        child.parent = page
        session_probe = Mock(return_value=None)

        with patch(
            "apple_account_flow.confirmed_account_manage_state",
            return_value=None,
        ), patch(
            "apple_account_flow.detect_login_state",
            return_value=page.state,
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch("apple_account_flow.human_pause", lambda *_: None), self.assertRaisesRegex(
            RuntimeError,
            "2FA state left the verified Apple HTTPS origin",
        ):
            account_flow.wait_for_signed_in(
                page,
                timeout_s=1,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
                session_probe=session_probe,
            )

        self.assertEqual(session_probe.call_count, 1)
        self.assertIn(("all", False), child.shadow_roots_calls)

    def test_developer_two_factor_exhaustion_has_a_fixed_partial_class(self):
        for error in (
            RuntimeError("2FA generation limit exhausted"),
            RuntimeError("2FA shared acquisition deadline exhausted"),
            RuntimeError("2FA collector unavailable for generation 2"),
        ):
            with self.subTest(error=str(error)):
                self.assertEqual(
                    account_flow.classify_developer_account_failure(error),
                    "developer_twofa_unavailable",
                )

    def test_expired_shared_two_factor_deadline_stops_before_generation_two(self):
        context = {
            "twofaPrepared": True,
            "nextGeneration": 2,
            "twofaAcquisitionStartedAt": 10.0,
        }

        with patch("apple_account_flow.time.monotonic", return_value=250.0):
            with self.assertRaisesRegex(
                RuntimeError,
                "shared acquisition deadline exhausted",
            ):
                account_flow.ensure_two_factor_generation_available(context, 2)

    def test_second_developer_authentication_uses_generation_two_without_reprepare(self):
        initial_state = {
            "href": "https://idmsa.apple.com/appleauth/auth/signin",
            "twofa": True,
            "error": False,
        }
        context = {"twofaPrepared": True, "nextGeneration": 2}
        with patch(
            "apple_account_flow.confirmed_developer_account_state",
            side_effect=[None, None],
        ), patch(
            "apple_account_flow.detect_login_state", return_value=initial_state
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value=initial_state,
        ), patch(
            "apple_account_flow.read_command",
            return_value={"type": "2fa_code", "generation": 2, "code": "123456"},
        ), patch(
            "apple_account_flow.wait_for_otp_target",
            return_value=[FakeElement()],
        ), patch("apple_account_flow.fill_security_code"), patch(
            "apple_account_flow.wait_for_signed_in",
            return_value={
                "trusted": True,
                "joinProgram": True,
                "membershipNavigation": False,
            },
        ), patch(
            "apple_account_flow.request_two_factor_preparation"
        ) as prepare, patch(
            "apple_account_flow.emit_browser_observation"
        ), patch(
            "apple_account_flow.set_browser_startup_stage"
        ), patch(
            "apple_account_flow.human_pause"
        ), patch(
            "apple_account_flow.emit"
        ) as emitted:
            result = account_flow.complete_account_authentication(
                FakePage(state=initial_state),
                "person@example.com",
                "secret",
                FakeKeys,
                account_home_confirmed=True,
                authentication_context=context,
                session_probe=account_flow.confirmed_developer_account_state,
            )

        prepare.assert_not_called()
        self.assertEqual(context["nextGeneration"], 3)
        self.assertTrue(result["confirmedState"]["joinProgram"])
        need_twofa = [
            call.args[0]
            for call in emitted.call_args_list
            if call.args[0].get("event") == "need_2fa"
        ]
        self.assertEqual([event["generation"] for event in need_twofa], [2])


class PersonalInformationTests(unittest.TestCase):
    @staticmethod
    def stable_profile_cards():
        name_card = FakeElement(
            attrs={
                "id": "name-card",
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                },
            }
        )
        birthday_card = FakeElement(
            attrs={
                "id": "birthday-card",
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000-01-02",
                },
            }
        )
        return name_card, birthday_card

    def test_account_sign_in_url_requires_an_exact_trusted_https_login_route(self):
        for url in (
            "https://account.apple.com/sign-in?returnUrl=%2Faccount%2Fmanage",
            "https://appleid.apple.com/sign-in",
        ):
            with self.subTest(url=url):
                self.assertTrue(account_flow.is_account_sign_in_url(url))
        for url in (
            "http://account.apple.com/sign-in",
            "http://appleid.apple.com/sign-in",
            "https://account.apple.com/account/sign-in",
            "https://account.apple.com/sign-in/extra",
            "https://appleid.apple.com/sign-in/extra",
            "https://account.apple.com.evil.example/sign-in",
            "https://appleid.apple.com.evil.example/sign-in",
            "https://account.apple.com/account/manage?returnUrl=/sign-in",
        ):
            with self.subTest(url=url):
                self.assertFalse(account_flow.is_account_sign_in_url(url))

    def test_split_recovery_copy_uses_local_dom_context_before_hard_error(self):
        class InspectingScope:
            script = ""

            def run_js(self, script):
                self.script = script
                return json.dumps(
                    {
                        "href": "https://account.apple.com/account/manage",
                        "hasStrongTwoFactorText": True,
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                        "codeInputCount": 0,
                        "password": False,
                        "email": False,
                        "trustPrompt": False,
                        "otpRejected": False,
                        "blocked": False,
                        "hardAuthenticationError": False,
                        "genericAuthText": True,
                        "securityFeatureCopy": True,
                        "error": True,
                        "accountManage": True,
                        "accountMarker": True,
                    }
                )

        scope = InspectingScope()
        state = account_flow.detect_scope_login_state(scope)

        self.assertTrue(state["trusted"])
        self.assertFalse(state["error"])
        self.assertIn("const recoveryContextFor = (el)", scope.script)
        self.assertIn("el.previousElementSibling", scope.script)
        self.assertIn("el.nextElementSibling", scope.script)
        self.assertIn("current.parentElement", scope.script)
        self.assertIn("const unableToSignInLeaves", scope.script)
        self.assertIn("el.contains(candidate)", scope.script)

        class InspectingShadowRoot:
            script = ""

            def run_js(self, script):
                self.script = script
                return json.dumps(
                    {
                        "hasStrongText": True,
                        "semanticTargetCount": 0,
                        "digitCellCount": 0,
                        "codeInputCount": 0,
                        "password": False,
                        "email": False,
                        "trustPrompt": False,
                        "otpRejected": False,
                        "blocked": False,
                        "hardAuthenticationError": False,
                        "genericAuthText": True,
                        "securityFeatureCopy": True,
                        "error": True,
                    }
                )

        root = InspectingShadowRoot()
        shadow_state = account_flow.detect_shadow_root_state(root)

        self.assertFalse(shadow_state["hardAuthenticationError"])
        self.assertIn("const recoveryContextFor = (el)", root.script)
        self.assertIn("el.previousElementSibling", root.script)
        self.assertIn("const unableToSignInLeaves", root.script)

    def test_login_state_uses_the_url_path_not_return_url_for_account_manage(self):
        class InspectingScope:
            script = ""

            def run_js(self, script):
                self.script = script
                return serialize_scope_state(
                    {
                        "href": (
                            "https://account.apple.com/sign-in"
                            "?returnUrl=%2Faccount%2Fmanage%2Fsection%2Finformation"
                        ),
                        "accountManage": False,
                        "accountMarker": False,
                        "error": False,
                    }
                )

        scope = InspectingScope()
        state = account_flow.detect_scope_login_state(scope)

        self.assertFalse(state["accountManage"])
        self.assertIn("currentUrl.pathname === '/account/manage'", scope.script)
        self.assertNotIn(
            "accountManage: /account\\.apple\\.com\\/account\\/manage/i.test(href)",
            scope.script,
        )

    def test_profile_navigation_prefers_the_authenticated_sidebar_link(self):
        link = FakeElement(
            attrs={
                "id": "personal-information-link",
                "href": account_flow.ACCOUNT_INFORMATION_URL,
                "profileNavigationLink": {
                    "visible": True,
                    "href": account_flow.ACCOUNT_INFORMATION_URL,
                },
            }
        )

        class NavigationPage(FakePage):
            def __init__(self):
                super().__init__(
                    {
                        "css:a[href]": [link],
                        "css:[role='link'][href]": [link],
                    },
                    state={
                        "href": "https://account.apple.com/account/manage",
                    },
                )
                self.get_calls = []
                link.on_click = lambda: self.state.__setitem__(
                    "href",
                    account_flow.ACCOUNT_INFORMATION_URL,
                )

            def get(self, url):
                self.get_calls.append(url)
                raise AssertionError("direct navigation must not run when the sidebar link exists")

        page = NavigationPage()
        with patch(
            "apple_account_flow.human_click",
            side_effect=lambda scope, element: scope.actions.human_click(element).perform(),
        ), patch("apple_account_flow.wait_for_document_settle"), patch(
            "apple_account_flow.emit"
        ) as emit_event:
            result = account_flow.navigate_to_personal_information(
                page,
                navigation_attempt=1,
            )

        self.assertEqual(result, "account_information")
        self.assertEqual(page.get_calls, [])
        self.assertIn(("human_click", link), page.actions.calls)
        statuses = [call.args[0]["status"] for call in emit_event.call_args_list]
        self.assertIn("profile_navigation_sidebar_link_resolved", statuses)
        self.assertIn("profile_navigation_sidebar_click_sent", statuses)
        self.assertIn("profile_navigation_arrived", statuses)
        self.assertNotIn("profile_navigation_direct_fallback", statuses)

    def test_profile_navigation_uses_direct_url_only_as_a_fallback(self):
        class NavigationPage(FakePage):
            def __init__(self):
                super().__init__(
                    state={"href": "https://account.apple.com/account/manage"}
                )
                self.get_calls = []

            def get(self, url):
                self.get_calls.append(url)
                self.state["href"] = url

        page = NavigationPage()
        with patch("apple_account_flow.wait_for_document_settle"), patch(
            "apple_account_flow.emit"
        ) as emit_event:
            result = account_flow.navigate_to_personal_information(
                page,
                navigation_attempt=1,
            )

        self.assertEqual(result, "account_information")
        self.assertEqual(page.get_calls, [account_flow.ACCOUNT_INFORMATION_URL])
        statuses = [call.args[0]["status"] for call in emit_event.call_args_list]
        self.assertIn("profile_navigation_direct_fallback", statuses)
        self.assertIn("profile_navigation_arrived", statuses)

    def test_profile_navigation_accepts_one_fixed_localized_semantic_button(self):
        for label in ("Personal Information", "个人信息", "個人資料"):
            with self.subTest(label=label):
                button = FakeElement(
                    text=label,
                    attrs={
                        "id": "personal-information-button",
                        "profileNavigationLink": {
                            "visible": True,
                            "href": "",
                            "label": label.casefold(),
                        },
                    },
                )

                class NavigationPage(FakePage):
                    def __init__(self):
                        super().__init__(
                            buttons=[button],
                            state={
                                "href": "https://account.apple.com/account/manage",
                            },
                        )
                        self.get_calls = []
                        button.on_click = lambda: self.state.__setitem__(
                            "href",
                            account_flow.ACCOUNT_INFORMATION_URL,
                        )

                    def get(self, url):
                        self.get_calls.append(url)

                page = NavigationPage()
                with patch(
                    "apple_account_flow.human_click",
                    side_effect=lambda scope, element: scope.actions.human_click(
                        element
                    ).perform(),
                ), patch("apple_account_flow.wait_for_document_settle"), patch(
                    "apple_account_flow.emit"
                ):
                    result = account_flow.navigate_to_personal_information(
                        page,
                        navigation_attempt=1,
                    )

                self.assertEqual(result, "account_information")
                self.assertEqual(page.get_calls, [])
                self.assertIn(("human_click", button), page.actions.calls)

    def test_sidebar_click_without_a_transition_uses_the_direct_url_fallback(self):
        link = FakeElement(
            attrs={
                "id": "personal-information-link",
                "profileNavigationLink": {
                    "visible": True,
                    "href": account_flow.ACCOUNT_INFORMATION_URL,
                    "label": "personal information",
                },
            }
        )

        class NavigationPage(FakePage):
            def __init__(self):
                super().__init__(
                    {"css:a[href]": [link]},
                    state={"href": "https://account.apple.com/account/manage"},
                )
                self.get_calls = []

            def get(self, url):
                self.get_calls.append(url)
                self.state["href"] = url

        page = NavigationPage()
        with patch(
            "apple_account_flow.human_click",
            side_effect=lambda scope, element: scope.actions.human_click(
                element
            ).perform(),
        ), patch("apple_account_flow.wait_for_document_settle"), patch(
            "apple_account_flow.wait_for_profile_navigation_result",
            side_effect=["unconfirmed", "account_information"],
        ), patch("apple_account_flow.emit") as emit_event:
            result = account_flow.navigate_to_personal_information(
                page,
                navigation_attempt=1,
            )

        self.assertEqual(result, "account_information")
        self.assertEqual(page.get_calls, [account_flow.ACCOUNT_INFORMATION_URL])
        self.assertIn(("human_click", link), page.actions.calls)
        fallback_event = next(
            call.args[0]
            for call in emit_event.call_args_list
            if call.args[0].get("status") == "profile_navigation_direct_fallback"
        )
        self.assertEqual(fallback_event["after"], "sidebar_unconfirmed")

    def test_ambiguous_semantic_profile_buttons_fall_back_to_the_exact_url(self):
        buttons = [
            FakeElement(
                text="Personal Information",
                attrs={
                    "id": f"personal-information-{index}",
                    "profileNavigationLink": {
                        "visible": True,
                        "href": "",
                        "label": "personal information",
                    },
                },
            )
            for index in range(2)
        ]

        class NavigationPage(FakePage):
            def __init__(self):
                super().__init__(
                    buttons=buttons,
                    state={"href": "https://account.apple.com/account/manage"},
                )
                self.get_calls = []

            def get(self, url):
                self.get_calls.append(url)
                self.state["href"] = url

        page = NavigationPage()
        with patch("apple_account_flow.wait_for_document_settle"), patch(
            "apple_account_flow.emit"
        ):
            result = account_flow.navigate_to_personal_information(
                page,
                navigation_attempt=1,
            )

        self.assertEqual(result, "account_information")
        self.assertEqual(page.get_calls, [account_flow.ACCOUNT_INFORMATION_URL])
        self.assertEqual(page.actions.calls, [])

    def test_ambiguous_exact_profile_links_fall_back_to_the_exact_url(self):
        links = [
            FakeElement(
                text="Personal Information",
                attrs={
                    "profileNavigationLink": {
                        "visible": True,
                        "href": account_flow.ACCOUNT_INFORMATION_URL,
                        "domIdentity": f"html:0/body:1/nav:0/a:{index}",
                        "label": "personal information",
                    },
                },
            )
            for index in range(2)
        ]

        class NavigationPage(FakePage):
            def __init__(self):
                super().__init__(
                    {"css:a[href]": links},
                    state={"href": "https://account.apple.com/account/manage"},
                )
                self.get_calls = []

            def get(self, url):
                self.get_calls.append(url)
                self.state["href"] = url

        page = NavigationPage()
        with patch("apple_account_flow.wait_for_document_settle"), patch(
            "apple_account_flow.emit"
        ):
            result = account_flow.navigate_to_personal_information(
                page,
                navigation_attempt=1,
            )

        self.assertEqual(result, "account_information")
        self.assertEqual(page.get_calls, [account_flow.ACCOUNT_INFORMATION_URL])
        self.assertEqual(page.actions.calls, [])

    def test_profile_navigation_reports_the_exact_sign_in_redirect(self):
        class RedirectingPage(FakePage):
            def __init__(self):
                super().__init__(
                    state={"href": "https://account.apple.com/account/manage"}
                )

            def get(self, _url):
                self.state["href"] = (
                    "https://account.apple.com/sign-in"
                    "?returnUrl=%2Faccount%2Fmanage%2Fsection%2Finformation"
                )

        page = RedirectingPage()
        with patch("apple_account_flow.wait_for_document_settle"), patch(
            "apple_account_flow.emit"
        ) as emit_event:
            result = account_flow.navigate_to_personal_information(
                page,
                navigation_attempt=1,
            )

        self.assertEqual(result, "sign_in")
        self.assertIn(
            "profile_navigation_sign_in_redirect",
            [call.args[0]["status"] for call in emit_event.call_args_list],
        )

    def test_profile_navigation_reports_the_appleid_sign_in_redirect(self):
        page = FakePage(
            state={
                "href": (
                    "https://appleid.apple.com/sign-in"
                    "?returnUrl=https%3A%2F%2Faccount.apple.com%2Faccount%2Fmanage"
                    "%2Fsection%2Finformation"
                )
            }
        )

        self.assertEqual(
            account_flow.wait_for_profile_navigation_result(
                page,
                timeout_s=0.05,
                pause=lambda *_: None,
            ),
            "sign_in",
        )

    def test_profile_failure_observation_refreshes_current_sign_in_state(self):
        page = FakePage(state={"href": "https://appleid.apple.com/sign-in"})
        page.states = FakeStates(alive=True)
        current_state = {
            "href": "https://appleid.apple.com/sign-in",
            "trusted": False,
            "email": True,
            "password": False,
            "error": False,
        }
        events = []

        with patch(
            "apple_account_flow.detect_login_state",
            return_value=current_state,
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch("apple_account_flow.emit", side_effect=events.append):
            observed = account_flow.inspect_profile_failure_state(page)
            account_flow.emit_browser_observation(
                "profile_capture_failed",
                page,
                observed,
                account_home_confirmed=True,
            )

        self.assertTrue(observed["inspectionAvailable"])
        observation = events[-1]
        self.assertEqual(observation["pageKind"], "sign_in")
        self.assertFalse(observation["sessionConfirmed"])
        self.assertTrue(observation["inspectionAvailable"])

    def test_profile_failure_observation_marks_an_unreadable_page(self):
        page = FakePage(state={"href": "https://appleid.apple.com/sign-in"})
        page.states = FakeStates(alive=True)
        with patch(
            "apple_account_flow.detect_login_state",
            side_effect=RuntimeError("stale browsing context"),
        ):
            observed = account_flow.inspect_profile_failure_state(page)

        self.assertEqual(observed, {"inspectionAvailable": False})

    def test_profile_reauthentication_runs_once_then_retries_sidebar_navigation(self):
        reauthentication = {
            "confirmedState": {"trusted": True},
            "skippedLogin": False,
            "skipped2FA": True,
            "rememberAccount": True,
        }
        authentication_context = {"twofaPrepared": True, "nextGeneration": 2}
        with patch(
            "apple_account_flow.navigate_to_personal_information",
            side_effect=["sign_in", "account_information"],
        ) as navigate, patch(
            "apple_account_flow.complete_account_authentication",
            return_value=reauthentication,
        ) as authenticate, patch(
            "apple_account_flow.emit_browser_observation"
        ) as observation, patch("apple_account_flow.emit") as emit_event:
            result = account_flow.reach_personal_information_page(
                object(),
                "person@example.com",
                "password",
                FakeKeys,
                authentication_context,
            )

        self.assertIs(result, reauthentication)
        self.assertEqual(navigate.call_count, 2)
        authenticate.assert_called_once_with(
            unittest.mock.ANY,
            "person@example.com",
            "password",
            FakeKeys,
            account_home_confirmed=True,
            authentication_context=authentication_context,
        )
        observation.assert_called_once()
        statuses = [call.args[0]["status"] for call in emit_event.call_args_list]
        self.assertEqual(
            statuses,
            [
                "profile_reauthentication_started",
                "profile_reauthentication_completed",
            ],
        )

    def test_profile_reauthentication_stops_after_the_second_sign_in_redirect(self):
        reauthentication = {
            "confirmedState": {"trusted": True},
            "skippedLogin": False,
            "skipped2FA": True,
            "rememberAccount": None,
        }
        with patch(
            "apple_account_flow.navigate_to_personal_information",
            side_effect=["sign_in", "sign_in"],
        ) as navigate, patch(
            "apple_account_flow.complete_account_authentication",
            return_value=reauthentication,
        ) as authenticate, patch(
            "apple_account_flow.emit_browser_observation"
        ), patch("apple_account_flow.emit") as emit_event, self.assertRaisesRegex(
            RuntimeError,
            "repeated reauthentication",
        ):
            account_flow.reach_personal_information_page(
                object(),
                "person@example.com",
                "password",
                FakeKeys,
                {"twofaPrepared": True, "nextGeneration": 2},
            )

        self.assertEqual(navigate.call_count, 2)
        self.assertEqual(authenticate.call_count, 1)
        self.assertIn(
            "profile_reauthentication_exhausted",
            [call.args[0]["status"] for call in emit_event.call_args_list],
        )
        self.assertEqual(
            account_flow.classify_profile_capture_failure(
                RuntimeError(
                    "personal information navigation required repeated reauthentication"
                )
            ),
            "profile_reauthentication_exhausted",
        )
        self.assertEqual(
            account_flow.classify_profile_capture_failure(
                RuntimeError(
                    "personal information reauthentication exhausted the 2FA generation limit"
                )
            ),
            "profile_reauthentication_exhausted",
        )
        self.assertIn(
            "profile_reauthentication_exhausted",
            account_flow.PROFILE_CAPTURE_FAILURE_CLASSES,
        )

    def test_reauthentication_continues_with_generation_two_without_repreparing(self):
        initial_state = {
            "href": "https://account.apple.com/sign-in",
            "twofa": True,
            "twofaVisible": True,
            "error": False,
        }
        authentication_context = {"twofaPrepared": True, "nextGeneration": 2}
        with patch(
            "apple_account_flow.detect_login_state",
            return_value=initial_state,
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch(
            "apple_account_flow.has_confirmed_account_session",
            return_value=False,
        ), patch(
            "apple_account_flow.request_two_factor_preparation"
        ) as prepare, patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value=initial_state,
        ), patch(
            "apple_account_flow.read_command",
            return_value={"type": "2fa_code", "generation": 2, "code": "123456"},
        ), patch(
            "apple_account_flow.wait_for_otp_target",
            return_value=[FakeElement()],
        ), patch(
            "apple_account_flow.fill_security_code"
        ), patch(
            "apple_account_flow.wait_for_signed_in",
            return_value={"trusted": True},
        ), patch(
            "apple_account_flow.emit_browser_observation"
        ), patch(
            "apple_account_flow.set_browser_startup_stage"
        ), patch(
            "apple_account_flow.human_pause"
        ), patch(
            "apple_account_flow.emit"
        ) as emit_event:
            result = account_flow.complete_account_authentication(
                FakePage(state=initial_state),
                "person@example.com",
                "password",
                FakeKeys,
                account_home_confirmed=True,
                authentication_context=authentication_context,
            )

        prepare.assert_not_called()
        self.assertEqual(authentication_context["nextGeneration"], 3)
        self.assertTrue(result["confirmedState"]["trusted"])
        need_2fa = [
            call.args[0]
            for call in emit_event.call_args_list
            if call.args[0].get("event") == "need_2fa"
        ]
        self.assertEqual([event["generation"] for event in need_2fa], [2])

    def test_reauthentication_never_requests_a_third_two_factor_code(self):
        initial_state = {
            "href": "https://account.apple.com/sign-in",
            "twofa": True,
            "error": False,
        }
        with patch(
            "apple_account_flow.detect_login_state",
            return_value=initial_state,
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch(
            "apple_account_flow.has_confirmed_account_session",
            return_value=False,
        ), patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value=initial_state,
        ), patch(
            "apple_account_flow.request_two_factor_preparation"
        ) as prepare, patch(
            "apple_account_flow.read_command"
        ) as read_command, patch(
            "apple_account_flow.emit_browser_observation"
        ), patch(
            "apple_account_flow.set_browser_startup_stage"
        ), self.assertRaisesRegex(
            RuntimeError,
            "generation limit exhausted",
        ):
            account_flow.complete_account_authentication(
                FakePage(state=initial_state),
                "person@example.com",
                "password",
                FakeKeys,
                account_home_confirmed=True,
                authentication_context={"twofaPrepared": True, "nextGeneration": 3},
            )

        prepare.assert_not_called()
        read_command.assert_not_called()

    def test_exact_sign_in_with_stale_error_and_live_fields_resumes_credentials(self):
        page = FakePage(
            state={
                "href": "https://account.apple.com/sign-in"
                "?returnUrl=%2Faccount%2Fmanage%2Fsection%2Finformation",
            }
        )
        email = FakeElement()
        password = FakeElement(attrs={"type": "password"})
        refreshed_password = FakeElement(attrs={"type": "password"})
        initial_state = {
            "href": page.state["href"],
            "email": True,
            "password": False,
            "twofa": True,
            "twofaVisible": True,
            "error": True,
            "rootError": True,
            "hardAuthenticationError": True,
            "blocked": False,
            "otpRejected": False,
        }
        authentication_context = {"twofaPrepared": False, "nextGeneration": 1}

        def input_value(scope, _field, _value, label, _keys, **kwargs):
            if label == "password":
                kwargs["target_holder"].update(
                    {"scope": scope, "field": refreshed_password}
                )
            return scope

        with patch(
            "apple_account_flow.detect_login_state",
            return_value=initial_state,
        ), patch(
            "apple_account_flow.settle_trust_state",
            side_effect=lambda _page, state, **_kwargs: state,
        ), patch(
            "apple_account_flow.has_confirmed_account_session",
            return_value=False,
        ), patch(
            "apple_account_flow.wait_for_element",
            return_value=(page, email),
        ), patch(
            "apple_account_flow.wait_for_password_target",
            return_value=(page, password),
        ), patch(
            "apple_account_flow.input_and_verify",
            side_effect=input_value,
        ) as input_verify, patch(
            "apple_account_flow.submit_element_with_enter"
        ) as submit_password, patch(
            "apple_account_flow.ensure_remember_checked",
            return_value=True,
        ), patch(
            "apple_account_flow.request_two_factor_preparation"
        ) as prepare, patch(
            "apple_account_flow.wait_for_document_settle"
        ), patch(
            "apple_account_flow.wait_for_2fa_or_session",
            return_value={"trusted": True},
        ), patch(
            "apple_account_flow.emit_browser_observation"
        ), patch(
            "apple_account_flow.set_browser_startup_stage"
        ):
            result = account_flow.complete_account_authentication(
                page,
                "person@example.com",
                "password",
                FakeKeys,
                account_home_confirmed=True,
                authentication_context=authentication_context,
            )

        self.assertEqual(
            [call.args[3] for call in input_verify.call_args_list],
            ["email", "password"],
        )
        self.assertIs(submit_password.call_args.args[2], refreshed_password)
        prepare.assert_called_once_with()
        self.assertTrue(authentication_context["twofaPrepared"])
        self.assertTrue(result["confirmedState"]["trusted"])

    def test_stale_sign_in_error_is_not_recoverable_when_blocked_or_rejected(self):
        page = FakePage(
            state={"href": "https://account.apple.com/sign-in"}
        )
        for blocker in ("blocked", "otpRejected", "activeBlocked", "activeOtpRejected"):
            state = {
                "email": True,
                "password": False,
                "blocked": False,
                "otpRejected": False,
                "activeBlocked": False,
                "activeOtpRejected": False,
            }
            state[blocker] = True
            with self.subTest(blocker=blocker):
                self.assertFalse(
                    account_flow.is_recoverable_account_sign_in_state(page, state)
                )

    def test_stable_information_cards_override_stale_account_security_text(self):
        name_card, birthday_card = self.stable_profile_cards()
        page = FakePage(
            {
                "css:button.button.button-bare": [name_card],
                "css:button[class*='button-bare']": [name_card],
                "css:.card": [birthday_card],
            },
            state={
                "href": account_flow.ACCOUNT_INFORMATION_URL,
                "hasStrongTwoFactorText": True,
                "semanticTargetCount": 0,
                "digitCellCount": 0,
                "codeInputCount": 0,
                "password": False,
                "email": False,
                "trustPrompt": False,
                "otpRejected": False,
                "blocked": False,
                "hardAuthenticationError": True,
                "genericAuthText": True,
                "securityFeatureCopy": False,
                "error": True,
                "accountManage": True,
                "accountMarker": True,
            },
        )

        state = account_flow.wait_for_profile_capture_ready(
            page,
            pause=lambda *_: None,
        )

        self.assertTrue(state["trusted"])
        self.assertTrue(state["rootSessionTrusted"])
        self.assertFalse(state["error"])
        self.assertFalse(state["rootError"])
        self.assertFalse(state["twofa"])
        self.assertFalse(state["activeAuthUiPresent"])
        self.assertTrue(state["hardAuthenticationError"])
        self.assertTrue(state["rootHardAuthenticationError"])

    def test_shadow_root_profile_cards_have_distinct_dom_identities(self):
        name_card = FakeElement(
            attrs={
                "profileDomIdentity": "html:1/body:1/shadow/button:1",
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                },
            }
        )
        birthday_card = FakeElement(
            attrs={
                "profileDomIdentity": "html:1/body:1/shadow/button:2",
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000-01-02",
                },
            }
        )
        shadow_root = FakePage(buttons=[name_card, birthday_card])
        page = FakePage(
            shadow_roots=[shadow_root],
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )
        events = []
        safe_state = {
            "trusted": True,
            "password": False,
            "email": False,
            "trustPrompt": False,
            "codeInputCount": 0,
            "otpRejected": False,
            "blocked": False,
            "hardAuthenticationError": False,
            "rootHardAuthenticationError": False,
            "childAuthUiPresent": False,
        }

        self.assertEqual(
            account_flow.element_stability_signature(page, name_card),
            account_flow.element_stability_signature(page, birthday_card),
        )
        with patch(
            "apple_account_flow.detect_login_state",
            return_value=safe_state,
        ), patch("apple_account_flow.emit", side_effect=events.append):
            state = account_flow.wait_for_profile_capture_ready(
                page,
                pause=lambda *_: None,
            )

        self.assertTrue(state["trusted"])
        self.assertIn(("all", False), page.shadow_roots_calls)
        readiness = [
            event
            for event in events
            if event.get("status") == "profile_capture_readiness"
        ]
        self.assertEqual(readiness[-1]["snapshotOutcome"], "ready")
        self.assertEqual(readiness[-1]["nameCardCount"], 1)
        self.assertEqual(readiness[-1]["birthdayCardCount"], 1)
        self.assertFalse(readiness[-1]["sameCardIdentity"])

    def test_profile_card_candidates_collapse_a_matching_parent_card(self):
        parent_card = FakeElement(
            attrs={
                "profileDomIdentity": "html:1/body:1/main:1/div:1",
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                },
            }
        )
        name_button = FakeElement(
            attrs={
                "tagName": "BUTTON",
                "profileDomIdentity": "html:1/body:1/main:1/div:1/button:1",
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                },
            }
        )
        page = FakePage(
            elements_by_selector={
                "css:.card": [parent_card],
                "css:button.button.button-bare": [name_button],
            },
            buttons=[name_button],
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        candidates = account_flow.profile_card_candidates(page, "name")

        self.assertEqual(len(candidates), 1)
        self.assertIs(candidates[0][1], name_button)
        self.assertIs(account_flow.resolve_profile_card(page, "name")[1], name_button)

    def test_profile_card_candidates_prefer_an_outer_semantic_button(self):
        name_button = FakeElement(
            attrs={
                "tagName": "BUTTON",
                "profileDomIdentity": "html:1/body:1/main:1/button:1",
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                },
            }
        )
        inner_card = FakeElement(
            attrs={
                "profileDomIdentity": "html:1/body:1/main:1/button:1/div:1",
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                },
            }
        )
        page = FakePage(
            elements_by_selector={
                "css:.card": [inner_card],
                "css:button.button.button-bare": [name_button],
            },
            buttons=[name_button],
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        candidates = account_flow.profile_card_candidates(page, "name")

        self.assertEqual(len(candidates), 1)
        self.assertIs(candidates[0][1], name_button)
        self.assertIs(account_flow.resolve_profile_card(page, "name")[1], name_button)

    def test_birthday_card_keeps_the_container_with_the_ready_value(self):
        birthday_card = FakeElement(
            attrs={
                "profileDomIdentity": "html:1/body:1/main:1/div:1",
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000-01-02",
                },
            }
        )
        edit_button = FakeElement(
            attrs={
                "tagName": "BUTTON",
                "profileDomIdentity": "html:1/body:1/main:1/div:1/button:1",
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": None,
                },
            }
        )
        page = FakePage(
            elements_by_selector={
                "css:.card": [birthday_card],
                "css:button.button.button-bare": [edit_button],
            },
            buttons=[edit_button],
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        candidates = account_flow.profile_card_candidates(page, "birthday")

        self.assertEqual(len(candidates), 1)
        self.assertIs(candidates[0][1], birthday_card)
        self.assertEqual(
            account_flow.resolve_profile_card(page, "birthday")[2][
                "birthdayValue"
            ],
            "2000-01-02",
        )

    def test_profile_capture_ignores_child_frame_cards_and_modals(self):
        frame_name_card = FakeElement(
            attrs={
                "profileDomIdentity": "html:1/body:1/button:1",
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                },
            }
        )
        frame_birthday_card = FakeElement(
            attrs={
                "profileDomIdentity": "html:1/body:1/button:2",
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000-01-02",
                },
            }
        )
        frame_modal = FakeElement(
            attrs={
                "id": "modal-content-name",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                },
            }
        )
        child_frame = FakePage(
            elements_by_selector={"css:[id^='modal-content-']": [frame_modal]},
            buttons=[frame_name_card, frame_birthday_card],
            state={"href": "https://account.apple.com/auth/child"},
        )
        page = FakePage(
            frames=[child_frame],
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        self.assertEqual(account_flow.profile_card_candidates(page, "name"), [])
        self.assertEqual(account_flow.profile_card_candidates(page, "birthday"), [])
        self.assertIsNone(account_flow.resolve_profile_name_modal(page))

    def test_all_profile_card_ambiguity_errors_keep_the_specific_failure_class(self):
        for message in (
            "personal information name card is ambiguous",
            "personal information birthday card is ambiguous",
            "personal information profile card is ambiguous",
        ):
            with self.subTest(message=message):
                self.assertEqual(
                    account_flow.classify_profile_capture_failure(
                        RuntimeError(message)
                    ),
                    "profile_card_ambiguous",
                )

    def test_shadow_root_profile_name_modal_is_collected_after_birthday(self):
        calls: list[str] = []
        birthday_card = FakeElement(
            attrs={
                "profileDomIdentity": "html:1/body:1/shadow/button:1",
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000-01-02",
                },
            }
        )
        modal = FakeElement(
            displayed=False,
            attrs={
                "id": "modal-content-name",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                },
            },
        )
        name_card = FakeElement(
            on_click=lambda: (
                calls.append("name_click"),
                setattr(modal.states, "is_displayed", True),
            ),
            attrs={
                "profileDomIdentity": "html:1/body:1/shadow/button:2",
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                },
            },
        )
        shadow_root = FakePage(
            elements_by_selector={"css:[id^='modal-content-']": [modal]},
            buttons=[birthday_card, name_card],
        )
        page = FakePage(
            shadow_roots=[shadow_root],
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        with patch("apple_account_flow.human_pause", lambda *_: None):
            result = account_flow.collect_personal_info(page)

        self.assertEqual(result, {"name": "Given Family", "birthday": "2000-01-02"})
        self.assertEqual(calls, ["name_click"])
        self.assertIn(("human_click", name_card), page.actions.calls)

    def test_collect_personal_info_closes_name_modal_from_owner_overlay(self):
        class ModalWithoutDefaultClose(FakeElement):
            def eles(self, selector, timeout=None):
                elements = self.attrs.get("elementsBySelector", {}).get(selector, [])
                for element in elements:
                    element.scope = self.scope
                return elements

        birthday_card = FakeElement(
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000-01-02",
                }
            }
        )
        inner_modal = ModalWithoutDefaultClose(
            displayed=False,
            attrs={
                "id": "modal-content-name",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                },
            },
        )
        outer_dialog = ModalWithoutDefaultClose(
            displayed=False,
            attrs={
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                }
            },
        )

        def dismiss_modal():
            inner_modal.states.is_displayed = False
            outer_dialog.states.is_displayed = False

        external_close = FakeElement(
            on_click=dismiss_modal,
            attrs={"aria-label": "Close"},
        )
        outer_dialog.attrs["elementsBySelector"] = {
            "css:button[aria-label='Close']": [external_close]
        }
        name_card = FakeElement(
            on_click=lambda: (
                setattr(inner_modal.states, "is_displayed", True),
                setattr(outer_dialog.states, "is_displayed", True),
            ),
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                }
            },
        )
        page = FakePage(
            {
                "css:button.button.button-bare": [name_card],
                "css:button[class*='button-bare']": [name_card],
                "css:.card": [birthday_card],
                "css:[id^='modal-content-']": [inner_modal],
                "css:[role='dialog']": [outer_dialog],
                "css:aside": [],
            },
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )
        events = []

        with patch("apple_account_flow.human_pause", lambda *_: None), patch(
            "apple_account_flow.emit", side_effect=events.append
        ):
            result = account_flow.collect_personal_info(page)

        self.assertEqual(result, {"name": "Given Family", "birthday": "2000-01-02"})
        self.assertIn(("human_click", external_close), page.actions.calls)
        statuses = [event["status"] for event in events if event.get("event") == "status"]
        self.assertLess(
            statuses.index("profile_name_collected"),
            statuses.index("profile_name_modal_closed"),
        )
        self.assertNotIn("profile_name_modal_cleanup_failed", statuses)

    def test_collect_personal_info_uses_portal_close_only_when_aria_controls_matches(self):
        class ModalWithoutDefaultClose(FakeElement):
            def eles(self, _selector, timeout=None):
                return []

        birthday_card = FakeElement(
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000-01-02",
                }
            }
        )
        modal = ModalWithoutDefaultClose(
            displayed=False,
            attrs={
                "id": "modal-content-name",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                },
            },
        )

        def dismiss_modal():
            modal.states.is_displayed = False

        portal_close = FakeElement(
            on_click=dismiss_modal,
            attrs={
                "aria-controls": "modal-content-name",
                # Apple can expose a localised close label without the
                # modal-close CSS token when the button lives in a portal.
                "profileModalClose": {
                    "visible": True,
                    "label": "关闭",
                    "className": "",
                },
            },
        )
        unrelated_close = FakeElement(
            attrs={"aria-label": "Close", "className": "modal-close"}
        )
        name_card = FakeElement(
            on_click=lambda: setattr(modal.states, "is_displayed", True),
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                }
            },
        )
        page = FakePage(
            {
                "css:button.button.button-bare": [name_card],
                "css:button[class*='button-bare']": [name_card],
                "css:.card": [birthday_card],
                "css:[id^='modal-content-']": [modal],
                "css:[role='dialog']": [],
                "css:aside": [],
                "css:button[aria-controls='modal-content-name']": [portal_close],
            },
            buttons=[unrelated_close],
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )
        events = []

        with patch("apple_account_flow.human_pause", lambda *_: None), patch(
            "apple_account_flow.emit", side_effect=events.append
        ):
            result = account_flow.collect_personal_info(page)

        self.assertEqual(result, {"name": "Given Family", "birthday": "2000-01-02"})
        self.assertIn(("human_click", portal_close), page.actions.calls)
        self.assertNotIn(("human_click", unrelated_close), page.actions.calls)
        self.assertIn(
            {"event": "status", "status": "profile_name_modal_closed"},
            events,
        )

    def test_collect_personal_info_emits_redacted_diagnostic_when_modal_cleanup_fails(self):
        class InnerModalWithoutClose(FakeElement):
            def eles(self, _selector, timeout=None):
                return []

        birthday_card = FakeElement(
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000-01-02",
                }
            }
        )
        modal = InnerModalWithoutClose(
            displayed=False,
            attrs={
                "id": "modal-content-name",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                },
            },
        )
        name_card = FakeElement(
            on_click=lambda: setattr(modal.states, "is_displayed", True),
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                }
            },
        )
        unrelated_close = FakeElement(
            attrs={"aria-label": "Close", "className": "modal-close"}
        )
        page = FakePage(
            {
                "css:button.button.button-bare": [name_card],
                "css:button[class*='button-bare']": [name_card],
                "css:.card": [birthday_card],
                "css:[id^='modal-content-']": [modal],
                "css:[role='dialog']": [],
                "css:aside": [],
            },
            buttons=[unrelated_close],
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )
        events = []

        with patch("apple_account_flow.human_pause", lambda *_: None), patch(
            "apple_account_flow.emit", side_effect=events.append
        ), self.assertRaisesRegex(
            RuntimeError,
            "personal information name modal cleanup failed",
        ):
            account_flow.collect_personal_info(page)

        cleanup = next(
            event
            for event in events
            if event.get("status") == "profile_name_modal_cleanup_failed"
        )
        self.assertEqual(
            cleanup,
            {
                "event": "status",
                "status": "profile_name_modal_cleanup_failed",
                "failureClass": "profile_name_modal_close_control_unavailable",
                "closeSearchScope": "none",
            },
        )
        self.assertIn(
            cleanup["failureClass"],
            account_flow.PROFILE_NAME_MODAL_CLEANUP_FAILURE_CLASSES,
        )
        statuses = [event["status"] for event in events if event.get("event") == "status"]
        self.assertLess(
            statuses.index("profile_name_collected"),
            statuses.index("profile_name_modal_cleanup_failed"),
        )
        serialized_events = json.dumps(events)
        self.assertNotIn("Given", serialized_events)
        self.assertNotIn("Family", serialized_events)
        self.assertNotIn("2000-01-02", serialized_events)
        self.assertNotIn(("human_click", unrelated_close), page.actions.calls)

    def test_profile_name_modal_cleanup_failure_maps_to_dedicated_class(self):
        self.assertEqual(
            account_flow.classify_profile_capture_failure(
                RuntimeError("personal information name modal cleanup failed")
            ),
            "profile_name_modal_cleanup_failed",
        )
        self.assertIn(
            "profile_name_modal_cleanup_failed",
            account_flow.PROFILE_CAPTURE_FAILURE_CLASSES,
        )

    def test_close_profile_name_modal_accepts_dismissed_stale_click(self):
        class ModalWithoutDefaultClose(FakeElement):
            def eles(self, selector, timeout=None):
                elements = self.attrs.get("elementsBySelector", {}).get(selector, [])
                for element in elements:
                    element.scope = self.scope
                return elements

        modal = ModalWithoutDefaultClose(
            attrs={
                "id": "modal-content-name",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                },
            }
        )
        page = FakePage(
            {
                "css:[id^='modal-content-']": [modal],
                "css:[role='dialog']": [],
                "css:aside": [],
            },
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        def dismiss_then_raise():
            modal.states.is_displayed = False
            raise RuntimeError("stale close target")

        stale_close = FakeElement(
            on_click=dismiss_then_raise,
            attrs={"aria-label": "Close"},
        )
        modal.attrs["elementsBySelector"] = {
            "css:button[aria-label='Close']": [stale_close]
        }
        events = []

        with patch("apple_account_flow.emit", side_effect=events.append):
            result = account_flow.close_profile_name_modal(
                page,
                page,
                modal,
                timeout_s=0.5,
                pause=lambda *_: None,
            )

        self.assertTrue(result["closed"])
        self.assertEqual(result["closeSearchScope"], "modal_content")
        clicked = [call for call in page.actions.calls if call[0] == "human_click"]
        self.assertEqual(clicked, [("human_click", stale_close)])
        self.assertIn(
            {"event": "status", "status": "profile_name_modal_closed"},
            events,
        )

    def test_close_profile_name_modal_refreshes_modal_and_portal_close_after_stale_click(self):
        class ModalWithoutDefaultClose(FakeElement):
            def eles(self, selector, timeout=None):
                elements = self.attrs.get("elementsBySelector", {}).get(selector, [])
                for element in elements:
                    element.scope = self.scope
                return elements

        modal_attrs = {
            "id": "modal-content-name",
            "profileModal": {
                "visible": True,
                "fieldCount": 2,
                "given": "Given",
                "family": "Family",
            },
        }
        stale_modal = ModalWithoutDefaultClose(attrs=dict(modal_attrs))
        fresh_modal = ModalWithoutDefaultClose(displayed=False, attrs=dict(modal_attrs))
        page = FakePage(
            {
                "css:[id^='modal-content-']": [stale_modal],
                "css:[role='dialog']": [],
                "css:aside": [],
                "css:button[aria-controls='modal-content-name']": [],
            },
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        def dismiss_fresh_modal():
            fresh_modal.states.is_displayed = False

        fresh_portal_close = FakeElement(
            on_click=dismiss_fresh_modal,
            attrs={
                "aria-controls": "modal-content-name",
                "profileModalClose": {
                    "visible": True,
                    "label": "Close",
                    "className": "modal-close",
                },
            },
        )

        def replace_modal_then_raise():
            stale_modal.states.is_displayed = False
            fresh_modal.states.is_displayed = True
            fresh_modal.scope = page
            fresh_portal_close.scope = page
            page.elements_by_selector["css:[id^='modal-content-']"] = [fresh_modal]
            page.elements_by_selector[
                "css:button[aria-controls='modal-content-name']"
            ] = [fresh_portal_close]
            raise RuntimeError("stale close target")

        stale_close = FakeElement(
            on_click=replace_modal_then_raise,
            attrs={"aria-label": "Close"},
        )
        stale_modal.attrs["elementsBySelector"] = {
            "css:button[aria-label='Close']": [stale_close]
        }

        result = account_flow.close_profile_name_modal(
            page,
            page,
            stale_modal,
            timeout_s=0.5,
            pause=lambda *_: None,
        )

        self.assertTrue(result["closed"])
        self.assertEqual(result["closeSearchScope"], "portal_owner")
        self.assertIn(("human_click", stale_close), page.actions.calls)
        self.assertIn(("human_click", fresh_portal_close), page.actions.calls)

    def test_close_profile_name_modal_fails_closed_when_click_leaves_personal_information(self):
        class ModalWithoutDefaultClose(FakeElement):
            def eles(self, selector, timeout=None):
                elements = self.attrs.get("elementsBySelector", {}).get(selector, [])
                for element in elements:
                    element.scope = self.scope
                return elements

        modal = ModalWithoutDefaultClose(
            attrs={
                "id": "modal-content-name",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                },
            }
        )
        page = FakePage(
            {
                "css:[id^='modal-content-']": [modal],
                "css:[role='dialog']": [],
                "css:aside": [],
            },
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )
        close = FakeElement(
            on_click=lambda: page.state.update({"href": account_flow.ACCOUNT_SECURITY_URL}),
            attrs={"aria-label": "Close"},
        )
        modal.attrs["elementsBySelector"] = {
            "css:button[aria-label='Close']": [close]
        }
        events = []

        with patch("apple_account_flow.emit", side_effect=events.append):
            result = account_flow.close_profile_name_modal(
                page,
                page,
                modal,
                timeout_s=0.5,
                pause=lambda *_: None,
            )

        self.assertFalse(result["closed"])
        self.assertEqual(
            result["failureClass"],
            "profile_name_modal_close_context_lost",
        )
        self.assertNotIn(
            {"event": "status", "status": "profile_name_modal_closed"},
            events,
        )

    def test_close_profile_name_modal_classifies_close_query_failure(self):
        class ModalWithoutDefaultClose(FakeElement):
            def eles(self, selector, timeout=None):
                elements = self.attrs.get("elementsBySelector", {}).get(selector, [])
                for element in elements:
                    element.scope = self.scope
                return elements

        class CloseSummaryFailure(FakeElement):
            def run_js(self, script):
                if "ruyipage-profile-modal-close" in script:
                    raise RuntimeError("temporary ruyipage query failure")
                return super().run_js(script)

        modal = ModalWithoutDefaultClose(
            attrs={
                "id": "modal-content-name",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                },
            }
        )
        failing_close = CloseSummaryFailure()
        modal.attrs["elementsBySelector"] = {"css:button": [failing_close]}
        page = FakePage(
            {
                "css:[id^='modal-content-']": [modal],
                "css:[role='dialog']": [],
                "css:aside": [],
            },
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        result = account_flow.close_profile_name_modal(
            page,
            page,
            modal,
            timeout_s=0.5,
            pause=lambda *_: None,
        )

        self.assertFalse(result["closed"])
        self.assertEqual(
            result["failureClass"],
            "profile_name_modal_close_query_failed",
        )
        self.assertEqual(result["closeSearchScope"], "modal_content")

    def test_close_profile_name_modal_maps_post_click_query_failure(self):
        class QueryFailureAfterCloseModal(FakeElement):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.fail_cleanup_query = False

            def run_js(self, script):
                if (
                    self.fail_cleanup_query
                    and "ruyipage-profile-name-modal" in script
                ):
                    raise RuntimeError("temporary cleanup query failure")
                return super().run_js(script)

            def eles(self, selector, timeout=None):
                elements = self.attrs.get("elementsBySelector", {}).get(selector, [])
                for element in elements:
                    element.scope = self.scope
                return elements

        modal = QueryFailureAfterCloseModal(
            attrs={
                "id": "modal-content-name",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                },
            }
        )
        close = FakeElement(
            on_click=lambda: setattr(modal, "fail_cleanup_query", True),
            attrs={"aria-label": "Close"},
        )
        modal.attrs["elementsBySelector"] = {
            "css:button[aria-label='Close']": [close]
        }
        page = FakePage(
            {
                "css:[id^='modal-content-']": [modal],
                "css:[role='dialog']": [],
                "css:aside": [],
            },
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        result = account_flow.close_profile_name_modal(
            page,
            page,
            modal,
            timeout_s=0.5,
            pause=lambda *_: None,
        )

        self.assertFalse(result["closed"])
        self.assertEqual(
            result["failureClass"],
            "profile_name_modal_close_query_failed",
        )


    def test_profile_name_modal_cleanup_state_keeps_visible_unhydrated_modal_open(self):
        modal = FakeElement(
            attrs={
                "id": "modal-content-name",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": None,
                    "family": None,
                },
            }
        )
        page = FakePage(
            {
                "css:[id^='modal-content-']": [modal],
                "css:[role='dialog']": [],
                "css:aside": [],
            },
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        self.assertEqual(account_flow.profile_name_modal_cleanup_state(page), "open")

    def test_profile_name_modal_cleanup_state_keeps_idless_hydration_skeleton_open(self):
        for field_count in (0, 1):
            with self.subTest(field_count=field_count):
                modal = FakeElement(
                    attrs={
                        "profileModal": {
                            "visible": True,
                            "fieldCount": field_count,
                            "given": None,
                            "family": None,
                        }
                    }
                )
                page = FakePage(
                    {
                        "css:[id^='modal-content-']": [],
                        "css:[role='dialog']": [modal],
                        "css:aside": [],
                    },
                    state={"href": account_flow.ACCOUNT_INFORMATION_URL},
                )

                self.assertEqual(
                    account_flow.profile_name_modal_cleanup_state(
                        page,
                        modal_selector="css:[role='dialog']",
                        modal_scope=page,
                    ),
                    "open",
                )

    def test_close_profile_name_modal_does_not_clear_an_idless_hydration_skeleton(self):
        class ModalWithoutDefaultClose(FakeElement):
            def eles(self, selector, timeout=None):
                elements = self.attrs.get("elementsBySelector", {}).get(selector, [])
                for element in elements:
                    element.scope = self.scope
                return elements

        modal = ModalWithoutDefaultClose(
            attrs={
                "role": "dialog",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                },
            }
        )
        close = FakeElement(
            on_click=lambda: modal.attrs["profileModal"].update(
                {"fieldCount": 0, "given": None, "family": None}
            ),
            attrs={"aria-label": "Close"},
        )
        modal.attrs["elementsBySelector"] = {
            "css:button[aria-label='Close']": [close]
        }
        page = FakePage(
            {
                "css:[id^='modal-content-']": [],
                "css:[role='dialog']": [modal],
                "css:aside": [],
            },
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        result = account_flow.close_profile_name_modal(
            page,
            page,
            modal,
            timeout_s=0.02,
            pause=lambda *_: None,
        )

        self.assertFalse(result["closed"])
        self.assertEqual(
            result["failureClass"],
            "profile_name_modal_close_unconfirmed",
        )

    def test_profile_confirmation_fails_closed_for_live_authentication_state(self):
        blockers = (
            {"password": True},
            {"email": True},
            {"trustPrompt": True},
            {"codeInputCount": 6},
            {"otpRejected": True},
            {"blocked": True},
            {"hardAuthenticationError": True},
            {"rootHardAuthenticationError": True},
            {"childAuthUiPresent": True},
        )
        for blocker in blockers:
            with self.subTest(blocker=blocker), self.assertRaisesRegex(
                RuntimeError,
                "authentication error",
            ):
                account_flow.confirmed_personal_information_state(
                    {
                        "codeInputCount": 0,
                        "password": False,
                        "email": False,
                        "trustPrompt": False,
                        "otpRejected": False,
                        "blocked": False,
                        "hardAuthenticationError": False,
                        "rootHardAuthenticationError": False,
                        "childAuthUiPresent": False,
                        **blocker,
                    }
                )

    def test_retired_auth_control_counts_do_not_override_live_profile_cards(self):
        state = account_flow.confirmed_personal_information_state(
            {
                "codeInputCount": 6,
                "password": True,
                "otpRejected": True,
                "activeAuthUiPresent": False,
                "activeOtpRejected": False,
                "activeBlocked": False,
                "hardAuthenticationError": True,
                "rootHardAuthenticationError": True,
            }
        )

        self.assertTrue(state["trusted"])
        self.assertFalse(state["twofa"])
        self.assertTrue(state["hardAuthenticationError"])
        self.assertTrue(state["rootHardAuthenticationError"])

    def test_explicit_active_authentication_signals_still_fail_closed(self):
        for active_key in (
            "activeAuthUiPresent",
            "activeOtpRejected",
            "activeBlocked",
        ):
            state = {
                "activeAuthUiPresent": False,
                "activeOtpRejected": False,
                "activeBlocked": False,
                "hardAuthenticationError": True,
                "rootHardAuthenticationError": True,
            }
            state[active_key] = True
            with self.subTest(active_key=active_key), self.assertRaisesRegex(
                RuntimeError,
                "authentication error",
            ):
                account_flow.confirmed_personal_information_state(state)

    def test_root_password_control_is_reported_as_active_profile_auth_ui(self):
        page = FakePage(
            state={
                "href": account_flow.ACCOUNT_INFORMATION_URL,
                "password": True,
                "email": False,
                "trustPrompt": False,
                "codeInputCount": 0,
                "otpRejected": False,
                "blocked": False,
                "hardAuthenticationError": False,
                "error": False,
                "accountManage": True,
                "accountMarker": True,
            }
        )

        state = detect_login_state(page)

        self.assertTrue(state["activeAuthUiPresent"])
        with self.assertRaisesRegex(RuntimeError, "authentication error"):
            account_flow.confirmed_personal_information_state(state)

    def test_profile_card_snapshot_requires_exact_information_route(self):
        name_card, birthday_card = self.stable_profile_cards()
        elements = {
            "css:button.button.button-bare": [name_card],
            "css:button[class*='button-bare']": [name_card],
            "css:.card": [birthday_card],
        }
        for url in (
            "https://account.apple.com/account/manage",
            "https://account.apple.com/account/manage/section/security",
            "http://account.apple.com/account/manage/section/information",
            "https://evil.example/account/manage/section/information",
        ):
            with self.subTest(url=url):
                page = FakePage(elements, state={"href": url})
                self.assertIsNone(
                    account_flow.profile_capture_card_snapshot(page)
                )

    def test_waits_for_hydrated_birthday_value_before_accepting_the_card(self):
        birthday_card = FakeElement()
        summaries = [
            {
                "visible": True,
                "name": False,
                "birthday": True,
                "birthdayValue": "",
                "domIdentity": "test:hydrated-birthday-card",
            },
            {
                "visible": True,
                "name": False,
                "birthday": True,
                "birthdayValue": "2000-01-02",
                "domIdentity": "test:hydrated-birthday-card",
            },
            {
                "visible": True,
                "name": False,
                "birthday": True,
                "birthdayValue": "2000-01-02",
                "domIdentity": "test:hydrated-birthday-card",
            },
        ]

        def read_summary(script):
            self.assertIn("ruyipage-profile-card-summary", script)
            return json.dumps(summaries.pop(0))

        birthday_card.run_js = read_summary
        page = FakePage(
            {"css:.card": [birthday_card]},
            state={
                "href": "https://account.apple.com/account/manage/section/information"
            },
        )

        _scope, card, summary = account_flow.wait_for_profile_card(
            page,
            "birthday",
            pause=lambda *_: None,
        )

        self.assertIs(card, birthday_card)
        self.assertEqual(summary["birthdayValue"], "2000-01-02")
        self.assertEqual(summaries, [])

    def test_prefers_nested_name_content_and_waits_for_hydrated_values(self):
        outer_modal = FakeElement(
            attrs={
                "profileModal": {
                    "visible": True,
                    "fieldCount": 3,
                    "given": "Outer",
                    "family": "Container",
                }
            }
        )
        inner_modal = FakeElement()
        summaries = [
            {"visible": True, "fieldCount": 3, "given": "", "family": ""},
            {
                "visible": True,
                "fieldCount": 3,
                "given": "Given",
                "family": "Family",
            },
            {
                "visible": True,
                "fieldCount": 3,
                "given": "Given",
                "family": "Family",
            },
        ]

        def read_summary(script):
            self.assertIn("ruyipage-profile-name-modal", script)
            return json.dumps(summaries.pop(0))

        inner_modal.run_js = read_summary
        page = FakePage(
            {
                "css:[id^='modal-content-']": [inner_modal],
                "css:[role='dialog']": [outer_modal],
                "css:aside": [outer_modal],
            },
            state={
                "href": "https://account.apple.com/account/manage/section/information"
            },
        )

        _scope, modal, summary = account_flow.wait_for_profile_name_modal(
            page,
            pause=lambda *_: None,
        )

        self.assertIs(modal, inner_modal)
        self.assertEqual(summary["given"], "Given")
        self.assertEqual(summary["family"], "Family")
        self.assertEqual(summaries, [])

    def test_profile_card_wait_accepts_a_rewrapped_ruyipage_element(self):
        class RewrappingProfilePage(FakePage):
            def __init__(self):
                super().__init__(
                    state={
                        "href": "https://account.apple.com/account/manage/section/information"
                    }
                )
                self.wrappers: list[FakeElement] = []

            def eles(self, selector, timeout=None):
                self.eles_calls.append((selector, timeout))
                if selector != "css:.card":
                    return []
                card = FakeElement(
                    attrs={
                        "id": "birthday-card",
                        "profileCard": {
                            "visible": True,
                            "name": False,
                            "birthday": True,
                            "birthdayValue": "2000-01-02",
                        },
                    }
                )
                card.scope = self
                self.wrappers.append(card)
                return [card]

        page = RewrappingProfilePage()
        _scope, card, summary = account_flow.wait_for_profile_card(
            page,
            "birthday",
            pause=lambda *_: None,
        )

        self.assertIs(card, page.wrappers[-1])
        self.assertEqual(summary["birthdayValue"], "2000-01-02")
        self.assertEqual(len(page.wrappers), 2)
        self.assertIsNot(page.wrappers[0], page.wrappers[1])

    def test_profile_name_modal_wait_accepts_a_rewrapped_ruyipage_element(self):
        class RewrappingProfilePage(FakePage):
            def __init__(self):
                super().__init__(
                    state={
                        "href": "https://account.apple.com/account/manage/section/information"
                    }
                )
                self.wrappers: list[FakeElement] = []

            def eles(self, selector, timeout=None):
                self.eles_calls.append((selector, timeout))
                if selector != "css:[id^='modal-content-']":
                    return []
                modal = FakeElement(
                    attrs={
                        "id": "modal-content-stable",
                        "profileModal": {
                            "visible": True,
                            "fieldCount": 3,
                            "given": "Given",
                            "family": "Family",
                        },
                    }
                )
                modal.scope = self
                self.wrappers.append(modal)
                return [modal]

        page = RewrappingProfilePage()
        _scope, modal, summary = account_flow.wait_for_profile_name_modal(
            page,
            pause=lambda *_: None,
        )

        self.assertIs(modal, page.wrappers[-1])
        self.assertEqual(summary["given"], "Given")
        self.assertEqual(summary["family"], "Family")
        self.assertEqual(len(page.wrappers), 2)
        self.assertIsNot(page.wrappers[0], page.wrappers[1])

    def test_name_modal_rejects_order_guessing_and_excludes_chinese_middle_name(self):
        modal = FakeElement(
            attrs={
                "profileModal": {
                    "visible": True,
                    "fieldCount": 3,
                    "given": "Given",
                    "family": "Family",
                }
            }
        )
        original_run_js = modal.run_js

        def inspect_query(script):
            self.assertIn(r"\u4e2d\u95f4\u540d", script)
            self.assertIn(r"\u4e2d\u9593\u540d", script)
            self.assertNotIn("fallback[2]", script)
            return original_run_js(script)

        modal.run_js = inspect_query
        summary = account_flow.profile_name_modal_summary(modal)

        self.assertEqual(summary["given"], "Given")
        self.assertEqual(summary["family"], "Family")

    def test_name_modal_script_executes_for_english_and_chinese_fields(self):
        harness = r"""
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
global.window = {
  getComputedStyle() {
    return { display: 'block', visibility: 'visible' };
  }
};
const makeField = (item) => ({
  labels: (item.labels || []).map((text) => ({ innerText: text, textContent: text })),
  disabled: false,
  readOnly: false,
  type: item.type || 'text',
  value: item.value || '',
  getBoundingClientRect() {
    return { width: 160, height: 32 };
  },
  getAttribute(name) {
    return Object.hasOwn(item.attributes || {}, name) ? item.attributes[name] : null;
  },
  closest(selector) {
    return selector === 'label' && item.closestLabel
      ? { innerText: item.closestLabel }
      : null;
  }
});
const fields = payload.fields.map(makeField);
const modal = {
  querySelectorAll(selector) {
    return selector === 'input' ? fields : [];
  },
  getBoundingClientRect() {
    return { width: 480, height: 320 };
  },
  getAttribute() {
    return null;
  }
};
const query = eval(`(${payload.script})`);
process.stdout.write(query.call(modal));
"""
        fixtures = (
            (
                [
                    {
                        "value": "Ada",
                        "attributes": {"placeholder": "First Name"},
                    },
                    {
                        "value": "Ignored",
                        "attributes": {"autocomplete": "additional-name"},
                    },
                    {
                        "value": "Lovelace",
                        "attributes": {"aria-label": "Last Name"},
                    },
                ],
                {
                    "given": "Ada",
                    "family": "Lovelace",
                    "orderedParts": ["Ada", "Lovelace"],
                },
            ),
            (
                [
                    {
                        "value": "王",
                        "labels": ["姓氏"],
                    },
                    {
                        "value": "忽略",
                        "attributes": {"aria-label": "中间名"},
                    },
                    {
                        "value": "小明",
                        "closestLabel": "名",
                    },
                ],
                {
                    "given": "小明",
                    "family": "王",
                    "orderedParts": ["王", "小明"],
                },
            ),
        )

        for fields, expected in fixtures:
            with self.subTest(expected=expected):
                completed = subprocess.run(
                    ["node", "-e", harness],
                    input=json.dumps(
                        {
                            "script": account_flow.PROFILE_NAME_MODAL_SUMMARY_SCRIPT,
                            "fields": fields,
                        },
                        ensure_ascii=False,
                    ),
                    text=True,
                    encoding="utf-8",
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                summary = json.loads(completed.stdout)
                self.assertEqual(summary["fieldCount"], 3)
                self.assertEqual(
                    {
                        "given": summary["given"],
                        "family": summary["family"],
                        "orderedParts": summary["orderedParts"],
                    },
                    expected,
                )

    def test_name_modal_query_failure_is_reported_once_without_error_text(self):
        modal = FakeElement()

        def fail_query(_script):
            raise RuntimeError("secret DOM text must not leave the backend")

        modal.run_js = fail_query
        page = FakePage(
            {"css:[id^='modal-content-']": [modal]},
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )
        events = []

        with patch.object(
            account_flow, "profile_name_modal_query_failure_emitted", False
        ), patch("apple_account_flow.emit", side_effect=events.append):
            self.assertIsNone(account_flow.resolve_profile_name_modal(page))
            self.assertIsNone(account_flow.resolve_profile_name_modal(page))

        self.assertEqual(
            events,
            [
                {
                    "event": "status",
                    "status": "profile_name_modal_query_failed",
                }
            ],
        )
        self.assertNotIn("secret DOM text", json.dumps(events))

    def test_name_modal_query_failure_has_a_fixed_profile_failure_class(self):
        modal = FakeElement()

        def fail_query(_script):
            raise RuntimeError("secret DOM text must not leave the backend")

        modal.run_js = fail_query
        page = FakePage(
            {"css:[id^='modal-content-']": [modal]},
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )
        events = []
        monotonic_values = iter((0.0, 0.0, 0.5))

        with patch.object(
            account_flow, "profile_name_modal_query_failure_emitted", False
        ), patch("apple_account_flow.emit", side_effect=events.append), patch(
            "apple_account_flow.time.monotonic",
            side_effect=lambda: next(monotonic_values),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "personal information name modal query failed"
            ) as raised:
                account_flow.wait_for_profile_name_modal(
                    page,
                    timeout_s=0.25,
                    pause=lambda *_: None,
                )

        self.assertEqual(
            account_flow.classify_profile_capture_failure(raised.exception),
            "profile_name_modal_query_failed",
        )
        self.assertEqual(
            events,
            [
                {
                    "event": "status",
                    "status": "profile_name_modal_query_failed",
                }
            ],
        )
        self.assertNotIn("secret DOM text", json.dumps(events))

    def test_name_modal_unavailable_has_fixed_class_and_bounded_diagnostics(self):
        page = FakePage(
            {"css:[id^='modal-content-']": [], "css:[role='dialog']": []},
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )
        events = []

        with patch(
            "apple_account_flow.wait_for_profile_card",
            side_effect=RuntimeError("personal information name card was not found"),
        ), patch("apple_account_flow.emit", side_effect=events.append):
            with self.assertRaisesRegex(
                RuntimeError, "personal information name modal is unavailable"
            ) as raised:
                account_flow.open_profile_name_modal(
                    page,
                    timeout_s=1,
                    pause=lambda *_: None,
                )

        self.assertEqual(
            account_flow.classify_profile_capture_failure(raised.exception),
            "profile_name_modal_unavailable",
        )
        self.assertIn(
            "profile_name_modal_unavailable",
            account_flow.PROFILE_CAPTURE_FAILURE_CLASSES,
        )
        self.assertEqual(
            events,
            [
                {
                    "event": "status",
                    "status": "profile_name_modal_unavailable",
                    "attemptCount": account_flow.PROFILE_NAME_MODAL_OPEN_CLICK_ATTEMPTS,
                    "outcome": "card_missing",
                }
            ],
        )

    def test_clicked_name_card_without_modal_has_fixed_class_and_bounded_diagnostics(
        self,
    ):
        page = FakePage(
            {"css:[id^='modal-content-']": [], "css:[role='dialog']": []},
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )
        name_card = FakeElement()
        events = []

        with patch(
            "apple_account_flow.wait_for_profile_card",
            return_value=(page, name_card, {}),
        ), patch("apple_account_flow.human_click"), patch(
            "apple_account_flow.wait_for_profile_name_modal",
            side_effect=RuntimeError("personal information name modal was not found"),
        ), patch("apple_account_flow.emit", side_effect=events.append):
            with self.assertRaisesRegex(
                RuntimeError, "personal information name modal is unavailable"
            ) as raised:
                account_flow.open_profile_name_modal(
                    page,
                    timeout_s=1,
                    pause=lambda *_: None,
                )

        self.assertEqual(
            account_flow.classify_profile_capture_failure(raised.exception),
            "profile_name_modal_unavailable",
        )
        self.assertEqual(
            events,
            [
                {
                    "event": "status",
                    "status": "profile_name_modal_unavailable",
                    "attemptCount": account_flow.PROFILE_NAME_MODAL_OPEN_CLICK_ATTEMPTS,
                    "outcome": "modal_missing",
                }
            ],
        )

    def test_name_modal_unavailable_after_deadline_preserves_fixed_class(self):
        page = FakePage(
            {"css:[id^='modal-content-']": [], "css:[role='dialog']": []},
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )
        events = []
        monotonic_values = iter((0.0, 0.0, 1.1))

        with patch(
            "apple_account_flow.wait_for_profile_card",
            side_effect=RuntimeError("personal information name card was not found"),
        ), patch("apple_account_flow.emit", side_effect=events.append), patch(
            "apple_account_flow.time.monotonic",
            side_effect=lambda: next(monotonic_values),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "personal information name modal is unavailable"
            ) as raised:
                account_flow.open_profile_name_modal(
                    page,
                    timeout_s=1,
                    pause=lambda *_: None,
                )

        self.assertEqual(
            account_flow.classify_profile_capture_failure(raised.exception),
            "profile_name_modal_unavailable",
        )
        self.assertEqual(
            events,
            [
                {
                    "event": "status",
                    "status": "profile_name_modal_unavailable",
                    "attemptCount": account_flow.PROFILE_NAME_MODAL_OPEN_CLICK_ATTEMPTS,
                    "outcome": "card_missing",
                }
            ],
        )

    def test_ambiguous_name_modal_has_fixed_class_without_clicking_a_card(self):
        page = FakePage(
            {"css:[id^='modal-content-']": [], "css:[role='dialog']": []},
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )

        with patch(
            "apple_account_flow.resolve_profile_name_modal",
            side_effect=RuntimeError("personal information name modal is ambiguous"),
        ), patch("apple_account_flow.wait_for_profile_card") as wait_for_card:
            with self.assertRaisesRegex(
                RuntimeError, "personal information name modal is ambiguous"
            ) as raised:
                account_flow.open_profile_name_modal(
                    page,
                    timeout_s=1,
                    pause=lambda *_: None,
                )

        wait_for_card.assert_not_called()
        self.assertEqual(
            account_flow.classify_profile_capture_failure(raised.exception),
            "profile_name_modal_ambiguous",
        )
        self.assertIn(
            "profile_name_modal_ambiguous",
            account_flow.PROFILE_CAPTURE_FAILURE_CLASSES,
        )

    def test_collects_birthday_before_opening_the_name_modal(self):
        calls: list[str] = []
        birthday_card = FakeElement(
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000年1月2日",
                }
            }
        )
        original_birthday_run_js = birthday_card.run_js

        def record_birthday_query(script):
            if "ruyipage-profile-card-summary" in script:
                calls.append("birthday")
            return original_birthday_run_js(script)

        birthday_card.run_js = record_birthday_query
        modal = FakeElement(
            displayed=False,
            attrs={
                "profileModal": {
                    "visible": True,
                    "fieldCount": 3,
                    "given": "Quang Vinh",
                    "family": "Le",
                    "orderedParts": ["Le", "Quang Vinh"],
                }
            },
        )
        name_card = FakeElement(
            on_click=lambda: (
                calls.append("name_click"),
                setattr(modal.states, "is_displayed", True),
            ),
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                }
            },
        )
        page = FakePage(
            {
                "css:button.button.button-bare": [name_card],
                "css:button[class*='button-bare']": [name_card],
                "css:.card": [birthday_card],
                "css:[role='dialog']": [modal],
                "css:aside": [],
                "css:[id^='modal-content-']": [],
            },
            state={
                "href": "https://account.apple.com/account/manage/section/information"
            },
        )

        with patch("apple_account_flow.human_pause", lambda *_: None):
            result = collect_personal_info(page)

        self.assertEqual(
            result,
            {"name": "Quang Vinh Le", "birthday": "2000年1月2日"},
        )
        self.assertLess(calls.index("birthday"), calls.index("name_click"))
        self.assertEqual(name_card.clicks, 0)
        self.assertIn(("human_click", name_card), page.actions.calls)

    def test_re_resolves_name_card_after_hydration_before_click(self):
        birthday_card = FakeElement(
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000-01-02",
                }
            }
        )
        modal = FakeElement(
            displayed=False,
            attrs={
                "id": "modal-content-name",
                "profileModal": {
                    "visible": True,
                    "fieldCount": 2,
                    "given": "Given",
                    "family": "Family",
                },
            },
        )
        old_card = FakeElement(
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                }
            }
        )
        fresh_card = FakeElement(
            on_click=lambda: setattr(modal.states, "is_displayed", True),
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": True,
                    "birthday": False,
                    "birthdayValue": None,
                }
            },
        )
        close = FakeElement(
            on_click=lambda: setattr(modal.states, "is_displayed", False),
            attrs={"aria-label": "Close"},
        )
        modal.attrs["elementsBySelector"] = {
            "css:button[aria-label='Close']": [close]
        }
        page = FakePage(
            {
                "css:button.button.button-bare": [fresh_card],
                "css:button[class*='button-bare']": [fresh_card],
                "css:.card": [birthday_card],
                "css:[id^='modal-content-']": [modal],
                "css:[role='dialog']": [],
                "css:aside": [],
            },
            state={"href": account_flow.ACCOUNT_INFORMATION_URL},
        )
        wait_results = iter(
            [
                (page, birthday_card, birthday_card.attrs["profileCard"]),
                (page, old_card, old_card.attrs["profileCard"]),
                (page, fresh_card, fresh_card.attrs["profileCard"]),
            ]
        )
        events = []
        with patch(
            "apple_account_flow.wait_for_profile_card",
            side_effect=lambda *_args, **_kwargs: next(wait_results),
        ), patch("apple_account_flow.human_pause", lambda *_: None), patch(
            "apple_account_flow.emit", side_effect=events.append
        ):
            result = account_flow.collect_personal_info(page)

        self.assertEqual(result, {"name": "Given Family", "birthday": "2000-01-02"})
        self.assertIn(("human_click", fresh_card), page.actions.calls)
        self.assertNotIn(("human_click", old_card), page.actions.calls)
        self.assertIn(
            {"event": "status", "status": "profile_name_modal_closed"},
            events,
        )

    def test_rejects_ambiguous_name_cards_without_clicking_either(self):
        cards = [
            FakeElement(
                attrs={
                    "profileCard": {
                        "visible": True,
                        "name": True,
                        "birthday": False,
                        "birthdayValue": None,
                    }
                }
            )
            for _ in range(2)
        ]
        birthday_card = FakeElement(
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000-01-02",
                }
            }
        )
        page = FakePage(
            {
                "css:button.button.button-bare": cards,
                "css:button[class*='button-bare']": cards,
                "css:.card": [birthday_card],
            },
            state={
                "href": "https://account.apple.com/account/manage/section/information"
            },
        )

        with patch("apple_account_flow.human_pause", lambda *_: None), self.assertRaisesRegex(
            RuntimeError,
            "name card is ambiguous",
        ):
            collect_personal_info(page)

        self.assertEqual(page.actions.calls, [])

    def test_rejects_profile_cards_outside_the_authenticated_manage_page(self):
        card = FakeElement(
            attrs={
                "profileCard": {
                    "visible": True,
                    "name": False,
                    "birthday": True,
                    "birthdayValue": "2000-01-02",
                }
            }
        )
        page = FakePage(
            {"css:.card": [card]},
            state={"href": "https://evil.example/account/manage/section/information"},
        )

        with patch("apple_account_flow.human_pause", lambda *_: None), self.assertRaisesRegex(
            RuntimeError,
            "birthday card was not found",
        ):
            collect_personal_info(page)

    def test_requires_authenticated_state_and_at_least_one_parsed_field(self):
        with self.assertRaisesRegex(RuntimeError, "authenticated"):
            validate_personal_info_result(
                {"trusted": False},
                {"name": "Person", "birthday": None},
            )
        with self.assertRaisesRegex(RuntimeError, "name and birthday"):
            validate_personal_info_result(
                {"trusted": True},
                {"name": None, "birthday": None},
            )

        validate_personal_info_result(
            {"trusted": True},
            {"name": "Test Given Test Family", "birthday": "2000-01-02"},
        )

    def test_account_security_url_requires_exact_trusted_security_route(self):
        self.assertTrue(
            account_flow.is_account_security_url(account_flow.ACCOUNT_SECURITY_URL)
        )
        for url in (
            "http://account.apple.com/account/manage/section/security",
            "https://account.apple.com/account/manage/section/security/extra",
            "https://account.apple.com.evil.example/account/manage/section/security",
            "https://account.apple.com/account/manage/section/information",
        ):
            with self.subTest(url=url):
                self.assertFalse(account_flow.is_account_security_url(url))

    def test_generated_account_password_matches_the_fixed_policy(self):
        confusing = set("0O1Il")
        for _ in range(50):
            password = account_flow.generate_account_password()
            self.assertEqual(len(password), 16)
            self.assertTrue(any(ch in account_flow.ACCOUNT_PASSWORD_UPPERCASE for ch in password))
            self.assertTrue(any(ch in account_flow.ACCOUNT_PASSWORD_LOWERCASE for ch in password))
            self.assertTrue(any(ch in account_flow.ACCOUNT_PASSWORD_DIGITS for ch in password))
            self.assertTrue(
                any(ch in account_flow.ACCOUNT_PASSWORD_SPECIAL_CHARACTERS for ch in password)
            )
            self.assertTrue(confusing.isdisjoint(password))

    def test_password_change_fields_use_semantics_then_dom_order_fallback(self):
        current = FakeElement(
            attrs={
                "type": "password",
                "passwordChangeField": {
                    "visible": True,
                    "editable": True,
                    "inputType": "password",
                    "signals": ["current-password"],
                },
            }
        )
        new = FakeElement(
            attrs={
                "type": "password",
                "passwordChangeField": {
                    "visible": True,
                    "editable": True,
                    "inputType": "password",
                    "signals": ["新密码"],
                },
            }
        )
        confirm = FakeElement(
            attrs={
                "type": "password",
                "passwordChangeField": {
                    "visible": True,
                    "editable": True,
                    "inputType": "password",
                    "signals": ["确认新密码"],
                },
            }
        )
        page = FakePage(
            {"css:input[type='password']": [new, confirm, current]},
            state={
                "href": account_flow.ACCOUNT_SECURITY_URL,
                "securityPage": True,
            },
        )

        fields = account_flow.resolve_account_password_change_fields(page)

        self.assertIs(fields["current"][1], current)
        self.assertIs(fields["new"][1], new)
        self.assertIs(fields["confirm"][1], confirm)

        ordered = [
            FakeElement(attrs={"type": "password"}),
            FakeElement(attrs={"type": "password"}),
            FakeElement(attrs={"type": "password"}),
        ]
        fallback_page = FakePage(
            {"css:input[type='password']": ordered},
            state={
                "href": account_flow.ACCOUNT_SECURITY_URL,
                "securityPage": True,
            },
        )

        fallback = account_flow.resolve_account_password_change_fields(fallback_page)

        self.assertIs(fallback["current"][1], ordered[0])
        self.assertIs(fallback["new"][1], ordered[1])
        self.assertIs(fallback["confirm"][1], ordered[2])

    def test_password_change_submit_requires_one_interactable_change_button(self):
        submit = FakeElement(
            text="更改密码",
            attrs={
                "id": "change-password-submit",
                "accountPasswordSubmit": {
                    "visible": True,
                    "enabled": True,
                    "label": "更改密码",
                }
            },
        )
        disabled_duplicate = FakeElement(
            text="更改密码",
            enabled=False,
            attrs={
                "id": "change-password-disabled",
                "accountPasswordSubmit": {
                    "visible": True,
                    "enabled": False,
                    "label": "更改密码",
                }
            },
        )
        page = FakePage(
            buttons=[submit, disabled_duplicate],
            state={"href": account_flow.ACCOUNT_SECURITY_URL},
        )

        self.assertEqual(
            account_flow.resolve_account_password_change_submit(page),
            (page, submit),
        )

        duplicate = FakeElement(
            text="更改密码",
            attrs={
                "id": "change-password-duplicate",
                "accountPasswordSubmit": {
                    "visible": True,
                    "enabled": True,
                    "label": "更改密码",
                }
            },
        )
        ambiguous_page = FakePage(
            buttons=[submit, duplicate],
            state={"href": account_flow.ACCOUNT_SECURITY_URL},
        )

        self.assertIsNone(
            account_flow.resolve_account_password_change_submit(ambiguous_page)
        )

    def test_change_account_password_runs_security_card_form_submit_and_success(self):
        events = []
        typed: list[tuple[str, str]] = []
        new_password = "Aa2!Bb3@Cc4#Dd5$"
        link = FakeElement(
            text="登录与安全性",
            attrs={
                "href": account_flow.ACCOUNT_SECURITY_URL,
                "profileNavigationLink": {
                    "visible": True,
                    "href": account_flow.ACCOUNT_SECURITY_URL,
                    "label": "登录与安全性",
                },
            },
        )
        card = FakeElement(
            text="密码 上次更新：2026年7月30日",
            attrs={
                "id": "password-card",
                "accountPasswordCard": {
                    "visible": True,
                    "passwordCard": True,
                    "lastUpdated": True,
                },
            },
        )
        current = FakeElement(
            attrs={
                "id": "current-password",
                "type": "password",
                "passwordChangeField": {
                    "visible": True,
                    "editable": True,
                    "inputType": "password",
                    "signals": ["当前密码"],
                },
            }
        )
        new = FakeElement(
            attrs={
                "id": "new-password",
                "type": "password",
                "passwordChangeField": {
                    "visible": True,
                    "editable": True,
                    "inputType": "password",
                    "signals": ["新密码"],
                },
            }
        )
        confirm = FakeElement(
            attrs={
                "id": "confirm-password",
                "type": "password",
                "passwordChangeField": {
                    "visible": True,
                    "editable": True,
                    "inputType": "password",
                    "signals": ["确认新密码"],
                },
            }
        )
        submit = FakeElement(
            text="更改密码",
            attrs={
                "accountPasswordSubmit": {
                    "visible": True,
                    "enabled": True,
                    "label": "更改密码",
                }
            },
        )

        class SecurityPage(FakePage):
            def __init__(self):
                super().__init__(
                    {
                        "css:a[href]": [link],
                        "css:button.button.button-bare": [card],
                        "css:input[type='password']": [current, new, confirm],
                    },
                    buttons=[submit],
                    state={
                        "href": account_flow.ACCOUNT_INFORMATION_URL,
                        "securityPage": False,
                        "passwordCard": False,
                        "passwordForm": False,
                        "passwordFieldCount": 3,
                        "passwordChanged": False,
                    },
                )
                link.on_click = self.open_security
                card.on_click = self.open_password_form
                submit.on_click = self.complete_password_change

            def open_security(self):
                self.state["href"] = account_flow.ACCOUNT_SECURITY_URL
                self.state["securityPage"] = True
                self.state["passwordCard"] = True

            def open_password_form(self):
                self.state["passwordForm"] = True

            def complete_password_change(self):
                self.state["passwordChanged"] = True

        page = SecurityPage()

        def fake_input(scope, field, value, label, keys, **kwargs):
            self.assertIs(scope, page)
            self.assertEqual(label, "password")
            typed.append((field.attrs["id"], value))

        with patch("apple_account_flow.emit", side_effect=events.append), patch(
            "apple_account_flow.human_click",
            side_effect=lambda scope, element, pause=None: scope.actions.human_click(element).perform(),
        ), patch("apple_account_flow.wait_for_document_settle"), patch(
            "apple_account_flow.generate_account_password",
            return_value=new_password,
        ), patch("apple_account_flow.input_and_verify", side_effect=fake_input), patch(
            "apple_account_flow.human_pause", lambda *_: None
        ):
            result = account_flow.change_account_password(
                page,
                "OldPass123!",
                FakeKeys,
                pause=lambda *_: None,
            )

        self.assertEqual(
            typed,
            [
                ("current-password", "OldPass123!"),
                ("new-password", new_password),
                ("confirm-password", new_password),
            ],
        )
        self.assertTrue(page.state["passwordChanged"])
        self.assertEqual(result["success"], True)
        self.assertEqual(result["attempted"], True)
        self.assertEqual(result["newPassword"], new_password)
        self.assertEqual(result["passwordLength"], 16)
        statuses = [event["status"] for event in events if event.get("event") == "status"]
        self.assertLess(
            statuses.index("account_security_navigation_started"),
            statuses.index("account_security_navigation_sidebar_click_sent"),
        )
        self.assertLess(
            statuses.index("password_change_form_ready"),
            statuses.index("password_change_submitted"),
        )
        self.assertIn("password_change_completed", statuses)
        non_terminal_statuses = [
            event
            for event in events
            if event.get("event") == "status"
            and event.get("status") != "password_change_completed"
        ]
        self.assertNotIn(new_password, json.dumps(non_terminal_statuses))


class SmallBusinessApplicationTests(unittest.TestCase):
    def small_business_control(
        self,
        label,
        *,
        input_type="radio",
        group_text="",
        element_id="",
        dom_order=0,
        on_click=None,
    ):
        return FakeElement(
            text=label,
            on_click=on_click,
            attrs={
                "id": element_id,
                "smallBusinessControl": {
                    "visible": True,
                    "enabled": True,
                    "tagName": "label",
                    "inputType": input_type,
                    "checked": False,
                    "label": label,
                    "text": label,
                    "groupText": group_text,
                    "sectionId": "",
                    "className": "",
                    "id": element_id,
                    "name": element_id,
                    "value": label,
                    "domIdentity": f"dom:{element_id}",
                    "controlIdentity": f"control:{element_id}",
                    "domOrder": dom_order,
                },
            },
        )

    def small_business_page(self, *, chinese=False):
        if chinese:
            paid = self.small_business_control(
                "是，我已接受",
                group_text="付费应用程序协议",
                element_id="paid-yes",
                dom_order=1,
            )
            no_label = "否"
            checkbox = self.small_business_control(
                "据你所知，你和关联开发者账户收入不超过 1,000,000 美元",
                input_type="checkbox",
                group_text="据你所知 关联开发者账户 收入 美元",
                element_id="revenue-certification",
                dom_order=10,
            )
            submit_label = "提交"
        else:
            paid = self.small_business_control(
                "Yes, I have accepted.",
                group_text="Paid Applications Agreement",
                element_id="paid-yes",
                dom_order=1,
            )
            no_label = "No"
            checkbox = self.small_business_control(
                "To the best of your knowledge, you and your Associated Developer Accounts earned no more than 1,000,000 USD.",
                input_type="checkbox",
                group_text="Associated Developer Accounts earned no more than 1,000,000 USD",
                element_id="revenue-certification",
                dom_order=10,
            )
            submit_label = "Submit"
        nos = [
            self.small_business_control(
                no_label,
                group_text="Associated Developer Accounts",
                element_id=f"associated-no-{index}",
                dom_order=2 + index,
            )
            for index in range(4)
        ]
        submit = self.small_business_control(
            submit_label,
            input_type="submit",
            group_text="",
            element_id="submit",
            dom_order=11,
        )
        page = FakePage(
            {
                "css:fieldset label": [paid, *nos, checkbox],
                "css:input#submit": [submit],
            },
            state={
                "href": account_flow.SMALL_BUSINESS_PROGRAM_ENROLL_URL,
                "smallBusinessEnrollPage": True,
                "smallBusinessFormReady": True,
                "smallBusinessPaidAgreementYes": True,
                "smallBusinessNoCount": 4,
                "smallBusinessRevenueCertification": True,
                "smallBusinessSubmitAvailable": True,
            },
        )
        return page, paid, nos, checkbox, submit

    def test_small_business_url_requires_exact_developer_enroll_route(self):
        self.assertTrue(
            account_flow.is_small_business_program_enroll_url(
                account_flow.SMALL_BUSINESS_PROGRAM_ENROLL_URL
            )
        )
        for url in (
            "http://developer.apple.com/app-store/small-business-program/enroll/",
            "https://developer.apple.com.evil.example/app-store/small-business-program/enroll/",
            "https://developer.apple.com/app-store/small-business-program/enroll/extra",
            "https://developer.apple.com/account",
        ):
            with self.subTest(url=url):
                self.assertFalse(
                    account_flow.is_small_business_program_enroll_url(url)
                )

    def test_small_business_form_controls_resolve_in_english_and_chinese(self):
        for chinese in (False, True):
            with self.subTest(chinese=chinese):
                page, paid, nos, checkbox, submit = self.small_business_page(
                    chinese=chinese
                )

                self.assertEqual(
                    account_flow.resolve_small_business_paid_agreement_yes(page),
                    (page, paid, account_flow.small_business_control_summary(paid)),
                )
                resolved_nos = account_flow.resolve_small_business_associated_no_options(page)
                self.assertEqual([item[1] for item in resolved_nos], nos)
                self.assertEqual(
                    account_flow.resolve_small_business_revenue_certification(page)[1],
                    checkbox,
                )
                self.assertEqual(
                    account_flow.resolve_small_business_submit(page)[1],
                    submit,
                )

    def test_apply_small_business_program_clicks_choices_submits_and_confirms(self):
        page, paid, nos, checkbox, submit = self.small_business_page()
        clicked = []

        def mark_clicked(element):
            def inner():
                clicked.append(element.attrs["id"])
                element.states.is_checked = True
                control = element.attrs["smallBusinessControl"]
                control["checked"] = True
                if element is submit:
                    page.state["smallBusinessThankYou"] = True

            return inner

        for element in [paid, *nos, checkbox, submit]:
            element.on_click = mark_clicked(element)

        account_page = FakePage()
        account_page.states = FakeStates(alive=True)
        page.states = FakeStates(alive=True)
        opened = {}

        def new_tab(url):
            opened["url"] = url
            return page

        account_page.new_tab = new_tab
        page.wait = type("Wait", (), {"doc_loaded": lambda *_args, **_kwargs: None})()
        events = []

        with patch("apple_account_flow.emit", side_effect=events.append), patch(
            "apple_account_flow.complete_account_authentication",
            return_value={
                "confirmedState": {
                    "trusted": True,
                    "smallBusinessApplication": True,
                },
                "skippedLogin": True,
                "skipped2FA": True,
                "rememberAccount": None,
            },
        ), patch("apple_account_flow.human_pause", lambda *_: None), patch(
            "apple_account_flow.take_screenshot",
            return_value="04-small-business-application.png",
        ):
            result, returned_page, screenshot = account_flow.apply_small_business_program(
                account_page,
                "person@example.com",
                "RotatedPass2!",
                FakeKeys,
                {"twofaPrepared": False, "nextGeneration": 1},
                Path("04-small-business-application.png"),
                pause=lambda *_: None,
            )

        self.assertEqual(opened["url"], account_flow.SMALL_BUSINESS_PROGRAM_ENROLL_URL)
        self.assertEqual(
            clicked,
            [
                "paid-yes",
                "associated-no-0",
                "associated-no-1",
                "associated-no-2",
                "associated-no-3",
                "revenue-certification",
                "submit",
            ],
        )
        self.assertIs(returned_page, page)
        self.assertEqual(screenshot, "04-small-business-application.png")
        self.assertTrue(result["success"])
        self.assertTrue(result["submitted"])
        statuses = [event["status"] for event in events if event.get("event") == "status"]
        self.assertLess(
            statuses.index("small_business_paid_agreement_accepted"),
            statuses.index("small_business_associated_accounts_answered"),
        )
        self.assertLess(
            statuses.index("small_business_revenue_certification_checked"),
            statuses.index("small_business_application_submitted"),
        )
        self.assertIn("small_business_application_completed", statuses)


if __name__ == "__main__":
    unittest.main()
