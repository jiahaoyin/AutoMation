#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source "$(dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_runtime

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

if [[ "${SKIP_ENV_SETUP:-}" != "1" ]]; then
  setup_args=(--quiet)
  if [[ "${skip_browser}" == "1" ]]; then
    setup_args+=(--skip-firefox --skip-ruyipage)
  fi
  if [[ "${skip_mac}" == "1" ]]; then
    setup_args+=(--skip-automation)
  fi
  node scripts/setup-environment.mjs "${setup_args[@]}"
fi

if [[ "${skip_browser}" != "1" ]]; then
  node scripts/preflight-2fa-permissions.mjs --quiet
fi

# credentials.js loads .env as data and preserves already-exported runtime overrides.

exec node scripts/apple-id-full-flow.mjs --skip-setup "$@"
