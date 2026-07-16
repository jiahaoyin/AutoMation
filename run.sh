#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

launcher_report_root="${APPLE_AUTOMATION_REPORT_ROOT:-data/reports}"
case "$launcher_report_root" in
  ""|*$'\n'*|*$'\r'*) exit 1 ;;
esac

umask 077
if ! /bin/mkdir -p "$launcher_report_root" >/dev/null 2>&1; then
  exit 1
fi
if ! launcher_report_root="$(cd "$launcher_report_root" >/dev/null 2>&1 && /bin/pwd -P)"; then
  exit 1
fi
export APPLE_AUTOMATION_REPORT_ROOT="$launcher_report_root"

if ! launcher_audit_dir="$(/usr/bin/mktemp -d "$launcher_report_root/.launcher-audit.XXXXXX" 2>/dev/null)"; then
  exit 1
fi
launcher_audit_path="$launcher_audit_dir/launcher-audit.jsonl"
if ! { : > "$launcher_audit_path" && /bin/chmod 600 "$launcher_audit_path"; } 2>/dev/null; then
  exit 1
fi
export APPLE_AUTOMATION_LAUNCHER_AUDIT_PATH="$launcher_audit_path"
printf '%s\n' "$launcher_audit_path"

launcher_audit_record() {
  local stage="$1"
  local exit_code="$2"
  local timestamp

  case "$stage" in
    launcher_entered|launcher_bootstrap_started|launcher_bootstrap_ready|launcher_env_setup_started|launcher_env_setup_skipped|launcher_env_setup_ready|launcher_preflight_started|launcher_preflight_skipped|launcher_preflight_ready|flow_main_started|credentials_ready|apple_flow_exec|settings_smoke_exec|settings_smoke_completed|failure) ;;
    *) return 1 ;;
  esac
  [[ "$exit_code" =~ ^[0-9]+$ ]] || return 1
  timestamp="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || return 1
  [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  printf '{"timestamp":"%s","stage":"%s","exitCode":%d}\n' "$timestamp" "$stage" "$exit_code" >> "$launcher_audit_path" 2>/dev/null
}

launcher_stage() {
  launcher_audit_record "$1" 0
  printf '[apple-automation] stage:%s\n' "$1"
}

launcher_exit() {
  local exit_code=$?
  trap - EXIT
  if (( exit_code != 0 )); then
    launcher_audit_record failure "$exit_code" || true
    printf '[apple-automation] stage:failure\n' || true
  fi
  exit "$exit_code"
}

trap launcher_exit EXIT

launcher_stage launcher_entered
launcher_stage launcher_bootstrap_started

# shellcheck disable=SC1091
source "$(dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_runtime
launcher_stage launcher_bootstrap_ready

skip_browser=0
skip_mac=0
for arg in "$@"; do
  if [[ "${arg}" == "--skip-browser" ]]; then
    skip_browser=1
  fi
  if [[ "${arg}" == "--skip-mac" ]]; then
    skip_mac=1
  fi
done

if [[ "${APPLE_AUTOMATION_SETTINGS_SMOKE:-}" == "1" ]]; then
  if [[ "${skip_mac}" != "1" || "${skip_browser}" == "1" ]]; then
    exit 1
  fi
  launcher_stage settings_smoke_exec
  node scripts/supervised-settings-2fa-smoke.mjs
  launcher_stage settings_smoke_completed
  exit 0
fi

if [[ "${SKIP_ENV_SETUP:-}" != "1" ]]; then
  launcher_stage launcher_env_setup_started
  setup_args=(--quiet)
  if [[ "${skip_browser}" == "1" ]]; then
    setup_args+=(--skip-firefox --skip-ruyipage)
  fi
  if [[ "${skip_mac}" == "1" ]]; then
    setup_args+=(--skip-automation)
  fi
  node scripts/setup-environment.mjs "${setup_args[@]}"
  launcher_stage launcher_env_setup_ready
else
  launcher_stage launcher_env_setup_skipped
fi

if [[ "${skip_browser}" != "1" ]]; then
  launcher_stage launcher_preflight_started
  node scripts/preflight-2fa-permissions.mjs --quiet --all
  launcher_stage launcher_preflight_ready
else
  launcher_stage launcher_preflight_skipped
fi

# credentials.js loads .env as data and preserves already-exported runtime overrides.

launcher_stage apple_flow_exec
node scripts/apple-id-full-flow.mjs --skip-setup "$@"
