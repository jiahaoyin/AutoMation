import json
import io
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import ANY, patch

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
                "pageKind": "account_information",
                "connectionAlive": True,
                "sessionConfirmed": True,
                "accountHomeConfirmed": True,
                "twofaVisible": False,
                "inputReady": False,
                "codeInputCount": 6,
                "authenticationError": False,
            },
        )
        self.assertNotIn("person@example.com", json.dumps(emit_event.call_args.args[0]))
        self.assertNotIn("123456", json.dumps(emit_event.call_args.args[0]))


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
        if "ruyipage-profile-card-summary" in script:
            return json.dumps(
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
        if "ruyipage-profile-name-modal" in script:
            return json.dumps(
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

        with patch(
            "apple_account_flow.wait_for_element", return_value=(frame, fresh)
        ) as rediscover, patch(
            "apple_account_flow.input_and_verify", return_value=frame
        ) as retype, patch("apple_account_flow.emit") as emit_event:
            submit_element_with_enter(
                root,
                frame,
                stale,
                FakeKeys,
                pause=lambda *_: None,
                password_value="secret",
            )

        rediscover.assert_called_once_with(
            root, account_flow.PASSWORD_SELECTORS, timeout_s=15
        )
        retype.assert_called_once_with(
            frame,
            fresh,
            "secret",
            "password",
            FakeKeys,
            pause=unittest.mock.ANY,
            root_page=root,
        )
        enter_index = root.actions.calls.index(("press", "ENTER"))
        self.assertEqual(root.actions.calls[enter_index + 1], ("perform",))
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

    def test_password_retries_keyboard_after_unreadable_trusted_input(self):
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
        self.assertIn(("type", "secret", ANY), page.actions.calls)
        self.assertIn(
            "owner_bidi_keyboard_retry",
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
    def test_direct_mode_emits_complete_early_browser_stage_sequence(self):
        class FakeFirefoxOptions:
            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: None

        root = FakePage(state={"href": "https://account.apple.com/sign-in"})
        root.get = lambda *_: None
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
                "url_validated",
                "runtime_importing",
                "runtime_imported",
                "browser_constructing",
            ],
        )
        self.assertIn("browser_ready", stages)
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
        root.get = lambda *_: None
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
            side_effect=[(root, email), (root, password)],
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
            return target

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
        ) as click_submit, patch(
            "apple_account_flow.wait_for_signed_in",
            return_value={"trusted": True},
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
        wait_signed_in.assert_called_once_with(
            root,
            submitted=True,
            otp_generation=1,
            submission_method="automatic",
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
        ), patch(
            "apple_account_flow.detect_login_state", return_value={"trusted": False}
        ), patch(
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

        wait_for_element.assert_called_once_with(
            root,
            account_flow.PASSWORD_SELECTORS,
            timeout_s=45,
            stable_observations=2,
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
            "apple_account_flow.wait_for_profile_capture_ready", return_value=None
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value={"name": "Test Given Test Family", "birthday": "2000-01-02"},
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

    def run_late_flow(
        self,
        report_dir,
        page,
        final_state,
        personal_info,
        events,
        event_sink=None,
    ):
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
            "apple_account_flow.wait_for_profile_capture_ready",
            return_value=None,
        ), patch(
            "apple_account_flow.collect_personal_info",
            return_value=personal_info,
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
                    {"trusted": False, "error": True},
                    {"name": "Test Given Test Family", "birthday": "2000-01-02"},
                    events,
                ),
                0,
            )

            self.assertEqual(
                sorted(path.name for path in report_dir.rglob("*.png")),
                ["02-ruyipage-after-login.png"],
            )
            result = next(event for event in events if event.get("event") == "result")
            self.assertTrue(result["success"])
            self.assertTrue(result["browserLogin"]["accountHomeConfirmed"])
            self.assertEqual(result["personalInfo"], {})
            self.assertEqual(
                result["postLoginProfileCapture"],
                {
                    "success": False,
                    "failureStage": "account_information",
                    "failureClass": "profile_authentication_error",
                    "browserAlive": False,
                    "browserPreserved": False,
                    "browserPreservationRequested": True,
                },
            )
            self.assertNotIn(secret, json.dumps(events))

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
                ["02-ruyipage-after-login.png", "03-account-information.png"],
            )
            result = next(event for event in events if event.get("event") == "result")
            self.assertEqual(
                result["postLoginProfileCapture"]["failureClass"],
                "profile_data_incomplete",
            )
            self.assertNotIn(secret, json.dumps(events))

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
                ["02-ruyipage-after-login.png", "03-account-information.png"],
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
                ["02-ruyipage-after-login.png", "03-account-information.png"],
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
                ["02-ruyipage-after-login.png", "03-account-information.png"],
            )
            self.assertIn(
                {
                    "event": "status",
                    "status": "screenshot_capture",
                    "checkpoint": "account_home",
                },
                events,
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
                screenshots_dir / "03-account-information.png",
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
            result = account_flow.take_screenshot(
                FailingScreenshotPage(),
                FakePath(),
                checkpoint="account_home",
            )

        self.assertIsNone(result)
        self.assertEqual(
            emit_event.call_args.args[0],
            {
                "event": "status",
                "status": "screenshot_failed",
                "checkpoint": "account_home",
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
        ), patch("apple_account_flow.emit") as emit_event:
            with self.assertRaisesRegex(RuntimeError, "navigation failed"):
                browser_flow(args)

        self.assertEqual(options.close_on_exit_values, [False])
        self.assertEqual(page.quit_calls, 0)
        self.assertIn(
                {
                    "event": "status",
                    "status": "browser_preserved",
                    "failureStage": "login_navigation",
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
        ), patch("apple_account_flow.emit") as emit_event:
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


class TwoFactorStateTests(unittest.TestCase):
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

    def test_automatic_post_otp_wait_allows_manage_shell_to_hydrate_before_child_error_fails(self):
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
        pauses = 0

        def hydrate_after_one_pause(*_args):
            nonlocal pauses
            pauses += 1
            page.state["accountMarker"] = True

        with patch("apple_account_flow.human_pause", hydrate_after_one_pause):
            state = wait_for_signed_in(
                page,
                timeout_s=0.05,
                submitted=True,
                otp_generation=1,
                submission_method="automatic",
            )

        self.assertGreaterEqual(pauses, 1)
        self.assertTrue(state["trusted"])

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
            )

        self.assertTrue(state["trusted"])

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


class PersonalInformationTests(unittest.TestCase):
    def test_waits_for_hydrated_birthday_value_before_accepting_the_card(self):
        birthday_card = FakeElement()
        summaries = [
            {
                "visible": True,
                "name": False,
                "birthday": True,
                "birthdayValue": "",
            },
            {
                "visible": True,
                "name": False,
                "birthday": True,
                "birthdayValue": "2000-01-02",
            },
            {
                "visible": True,
                "name": False,
                "birthday": True,
                "birthdayValue": "2000-01-02",
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
                    "given": "Given",
                    "family": "Family",
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
            {"name": "Given Family", "birthday": "2000年1月2日"},
        )
        self.assertLess(calls.index("birthday"), calls.index("name_click"))
        self.assertEqual(name_card.clicks, 0)
        self.assertIn(("human_click", name_card), page.actions.calls)

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


if __name__ == "__main__":
    unittest.main()
