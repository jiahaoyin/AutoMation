#!/usr/bin/env python3
"""Camoufox session helpers: Firefox default profile, proxy/geoip, fingerprint."""

from __future__ import annotations

import configparser
import os
import platform
from pathlib import Path
from typing import Any


DEFAULT_CLASH_PROXY = {
    "server": "http://127.0.0.1:7890",
}


def firefox_profiles_root() -> Path:
    system = platform.system()
    home = Path.home()
    if system == "Darwin":
        return home / "Library" / "Application Support" / "Firefox"
    if system == "Windows":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / "Mozilla" / "Firefox"
        return home / "AppData" / "Roaming" / "Mozilla" / "Firefox"
    return home / ".mozilla" / "firefox"


def resolve_default_firefox_profile(override: str | None = None) -> Path | None:
    """Locate the profile Firefox uses when launched from the app icon."""
    configured = (override or os.environ.get("FIREFOX_PROFILE_DIR") or "").strip()
    if configured:
        path = Path(configured).expanduser()
        return path if path.exists() else path

    root = firefox_profiles_root()
    ini_path = root / "profiles.ini"
    if not ini_path.is_file():
        return None

    parser = configparser.ConfigParser()
    try:
        parser.read(ini_path, encoding="utf-8")
    except (OSError, configparser.Error):
        return None

    install_default: str | None = None
    profile_default: str | None = None
    for section in parser.sections():
        if section.startswith("Install") and parser.has_option(section, "Default"):
            install_default = parser.get(section, "Default").strip()
        if section.startswith("Profile") and parser.get(section, "Default", fallback="") == "1":
            is_relative = parser.get(section, "IsRelative", fallback="1") == "1"
            path_value = parser.get(section, "Path", fallback="").strip()
            if not path_value:
                continue
            profile_default = (
                str(root / path_value) if is_relative else path_value
            )

    if install_default:
        candidate = Path(install_default)
        if not candidate.is_absolute():
            candidate = root / install_default
        if candidate.is_dir():
            return candidate

    if profile_default:
        candidate = Path(profile_default)
        if candidate.is_dir():
            return candidate

    # Last resort: newest Profiles/* directory.
    profiles_dir = root / "Profiles"
    if profiles_dir.is_dir():
        children = sorted(
            (p for p in profiles_dir.iterdir() if p.is_dir()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if children:
            return children[0]
    return None


def resolve_clash_proxy(env: dict[str, str] | None = None) -> dict[str, str] | None:
    source = env if env is not None else os.environ
    disabled = str(source.get("CAMOUFOX_PROXY_ENABLED", "1")).strip().lower()
    if disabled in {"0", "false", "no", "off"}:
        return None

    server = str(source.get("CAMOUFOX_PROXY_SERVER") or "").strip()
    if not server:
        server = DEFAULT_CLASH_PROXY["server"]

    proxy: dict[str, str] = {"server": server}
    username = str(source.get("CAMOUFOX_PROXY_USERNAME") or "").strip()
    password = str(source.get("CAMOUFOX_PROXY_PASSWORD") or "").strip()
    if username:
        proxy["username"] = username
    if password:
        proxy["password"] = password
    return proxy


def build_camoufox_launch_kwargs(
    *,
    profile_dir: str | Path | None = None,
    window: tuple[int, int] = (1280, 960),
    headless: bool = False,
    close_on_exit: bool = True,
    firefox_executable: str | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build Camoufox kwargs: macOS fingerprint, humanize, clash geoip, default profile."""
    source = env if env is not None else os.environ
    profile = resolve_default_firefox_profile(
        str(profile_dir) if profile_dir else None
    )
    if profile is None:
        raise RuntimeError(
            "Firefox default profile not found. Open Firefox once from the app icon, "
            "then close it, or set FIREFOX_PROFILE_DIR."
        )

    proxy = resolve_clash_proxy(source)
    kwargs: dict[str, Any] = {
        # One randomly selected real macOS fingerprint preset for this process.
        # All tabs share the same persistent context, so the fingerprint stays fixed.
        "fingerprint_preset": True,
        "os": "macos",
        "humanize": True,
        "headless": headless,
        "window": window,
        "persistent_context": True,
        "user_data_dir": str(profile),
        # Cross-version profile warning bypass (system Firefox vs Camoufox).
        "args": ["--allow-downgrade"],
        "i_know_what_im_doing": True,
    }
    if proxy:
        kwargs["proxy"] = proxy
        kwargs["geoip"] = True

    # Prefer Camoufox bundled browser; optionally force a path only when requested.
    executable = (
        firefox_executable
        or str(source.get("CAMOUFOX_EXECUTABLE") or "").strip()
        or None
    )
    if executable:
        kwargs["executable_path"] = executable

    # Preserve browser when the flow asks not to close on exit.
    if not close_on_exit:
        # Camoufox/Playwright always closes the context manager; the flow layer
        # keeps the Python process alive instead when preserve flags are set.
        kwargs["_preserve_process"] = True

    return kwargs


def ensure_camoufox_dev_channel(env: dict[str, str] | None = None) -> str:
    """Sync and activate the official FF152 dev/prerelease channel, then fetch."""
    import subprocess
    import sys

    source = env if env is not None else os.environ
    channel = str(source.get("CAMOUFOX_CHANNEL") or "").strip() or "official/prerelease"
    commands = [
        [sys.executable, "-m", "camoufox", "sync"],
        [sys.executable, "-m", "camoufox", "set", channel],
        [sys.executable, "-m", "camoufox", "fetch"],
    ]
    for command in commands:
        try:
            subprocess.run(command, check=False, capture_output=True, text=True, timeout=600)
        except (OSError, subprocess.SubprocessError):
            continue
    return channel


# Backward-compatible alias used by older call sites / docs snippets.
ensure_camoufox_prerelease_channel = ensure_camoufox_dev_channel