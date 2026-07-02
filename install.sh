#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

PKG_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('./package.json','utf8')).version" 2>/dev/null || echo dev)"
echo "==> Apple ID 自动化 环境安装 (v${PKG_VERSION})"

# shellcheck disable=SC1091
source "$(dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_runtime

exec node scripts/setup-environment.mjs "$@"
