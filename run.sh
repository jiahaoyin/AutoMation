#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source "$(dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_runtime

if [[ "${SKIP_ENV_SETUP:-}" != "1" ]]; then
  node scripts/setup-environment.mjs --quiet
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

exec node scripts/apple-id-full-flow.mjs --skip-setup "$@"
