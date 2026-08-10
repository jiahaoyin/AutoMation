#!/usr/bin/env python3
"""Unit tests for Camoufox session helpers (no browser binary required)."""

from __future__ import annotations

import configparser
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from camoufox_session import (
    build_camoufox_launch_kwargs,
    resolve_clash_proxy,
    resolve_default_firefox_profile,
)


class CamoufoxSessionTests(unittest.TestCase):
    def test_resolve_clash_proxy_default(self) -> None:
        proxy = resolve_clash_proxy({"CAMOUFOX_PROXY_ENABLED": "1"})
        assert proxy is not None
        self.assertEqual(proxy["server"], "http://127.0.0.1:7890")

    def test_resolve_clash_proxy_disabled(self) -> None:
        self.assertIsNone(resolve_clash_proxy({"CAMOUFOX_PROXY_ENABLED": "0"}))

    def test_resolve_default_profile_from_ini(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            profile = root / "Profiles" / "abcd.default-release"
            profile.mkdir(parents=True)
            ini = root / "profiles.ini"
            ini.write_text(
                "[InstallDEADBEEF]\n"
                "Default=Profiles/abcd.default-release\n"
                "Locked=1\n"
                "\n"
                "[Profile0]\n"
                "Name=default-release\n"
                "IsRelative=1\n"
                "Path=Profiles/abcd.default-release\n"
                "Default=1\n",
                encoding="utf-8",
            )
            with mock.patch(
                "camoufox_session.firefox_profiles_root", return_value=root
            ):
                resolved = resolve_default_firefox_profile(None)
            self.assertEqual(resolved, profile)

    def test_launch_kwargs_include_allow_downgrade_and_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "profile"
            profile.mkdir()
            kwargs = build_camoufox_launch_kwargs(
                profile_dir=profile,
                env={"CAMOUFOX_PROXY_ENABLED": "1"},
            )
            self.assertTrue(kwargs["fingerprint_preset"])
            self.assertEqual(kwargs["os"], "macos")
            self.assertTrue(kwargs["humanize"])
            self.assertTrue(kwargs["geoip"])
            self.assertEqual(kwargs["proxy"]["server"], "http://127.0.0.1:7890")
            self.assertIn("--allow-downgrade", kwargs["args"])
            self.assertTrue(kwargs["persistent_context"])
            self.assertEqual(kwargs["user_data_dir"], str(profile))


if __name__ == "__main__":
    unittest.main()
