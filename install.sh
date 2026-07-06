#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

PKG_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('./package.json','utf8')).version" 2>/dev/null || echo dev)"
echo "==> Apple ID 自动化 环境安装 (v${PKG_VERSION})"

# shellcheck disable=SC1091
source "$(dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_runtime

echo "==> 编译 Swift AX 填表 helper"
if command -v swiftc >/dev/null 2>&1; then
  mkdir -p scripts/bin
  if swiftc -O -o scripts/bin/mac-settings-ax-fill \
    scripts/swift/mac-settings-ax-fill.swift \
    -framework ApplicationServices -framework AppKit 2>/dev/null; then
    chmod +x scripts/bin/mac-settings-ax-fill
    echo "✓ mac-settings-ax-fill 已编译"
  else
    echo "⚠ Swift 编译失败，将使用 AppleScript 回退"
  fi
  if swiftc -O -o scripts/bin/mac-settings-2fa-code \
    scripts/swift/mac-settings-2fa-code.swift \
    -framework ApplicationServices -framework AppKit 2>/dev/null; then
    chmod +x scripts/bin/mac-settings-2fa-code
    echo "✓ mac-settings-2fa-code 已编译"
  else
    echo "⚠ mac-settings-2fa-code 编译失败，2FA 将仅依赖系统弹窗"
  fi
  if swiftc -O -o scripts/bin/mac-2fa-popup-read \
    scripts/swift/mac-2fa-popup-read.swift \
    -framework ApplicationServices -framework AppKit 2>/dev/null; then
    chmod +x scripts/bin/mac-2fa-popup-read
    echo "✓ mac-2fa-popup-read 已编译"
  else
    echo "⚠ mac-2fa-popup-read 编译失败，2FA 弹窗将回退 AppleScript"
  fi
else
  echo "⚠ 未找到 swiftc，将使用 AppleScript 回退"
fi

exec node scripts/setup-environment.mjs "$@"
