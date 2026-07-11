#!/bin/bash
set -euo pipefail
cd "$(/usr/bin/dirname "$0")"

echo "==> Apple ID 自动化 环境安装"

# shellcheck disable=SC1091
source "$(/usr/bin/dirname "$0")/scripts/bootstrap-macos.sh"
bootstrap_macos_install_runtime

readonly SWIFTC_INSTALL_MAX_ATTEMPTS=120
readonly SWIFTC_INSTALL_POLL_SECONDS=5
SWIFTC_BIN=""
readonly REQUIRED_SWIFT_HELPERS=(
  "mac-settings-2fa-code"
  "mac-2fa-popup-read"
  "mac-2fa-popup-ocr"
  "mac-2fa-click-allow"
)
readonly COMPILED_SWIFT_HELPERS=(
  "mac-settings-ax-fill"
  "${REQUIRED_SWIFT_HELPERS[@]}"
)

swiftc_usable() {
  local swiftc_path
  swiftc_path="$(/usr/bin/xcrun --find swiftc 2>/dev/null)" || return 1
  [[ -n "$swiftc_path" && -x "$swiftc_path" ]] || return 1
  "$swiftc_path" --version >/dev/null 2>&1 || return 1
  SWIFTC_BIN="$swiftc_path"
}

ensure_swiftc() {
  if swiftc_usable; then
    return 0
  fi

  echo "==> 未找到 swiftc，正在请求安装 Apple Xcode Command Line Tools"
  if [[ -x /usr/bin/xcode-select ]]; then
    /usr/bin/xcode-select --install >/dev/null 2>&1 || true
  fi

  local attempt
  for (( attempt = 1; attempt <= SWIFTC_INSTALL_MAX_ATTEMPTS; attempt++ )); do
    /bin/sleep "$SWIFTC_INSTALL_POLL_SECONDS"
    if swiftc_usable; then
      return 0
    fi
  done

  echo "错误: 未找到 swiftc。请完成 Apple 官方 Xcode Command Line Tools 安装后重新运行 ./install.sh。" >&2
  return 1
}

validate_required_swift_sources() {
  local helper
  for helper in "${REQUIRED_SWIFT_HELPERS[@]}"; do
    if [[ -f "scripts/swift/${helper}.swift" ]]; then
      continue
    fi
    echo "错误: 缺少必需 Swift helper 源文件: scripts/swift/${helper}.swift" >&2
    return 1
  done
}

swift_product_is_executable() {
  [[ -f "$1" && -x "$1" ]]
}

cleanup_swift_helper_temp_dir() {
  local temp_dir="$1"
  local helper
  for helper in "${COMPILED_SWIFT_HELPERS[@]}"; do
    /bin/rm -f -- "$temp_dir/${helper}"
  done
  /bin/rmdir "$temp_dir" 2>/dev/null || true
}

compile_swift_helper() {
  local temp_dir="$1"
  local helper="$2"
  shift 2
  local output_path="$temp_dir/${helper}"

  if ! "$SWIFTC_BIN" -O -o "$output_path" "scripts/swift/${helper}.swift" "$@" 2>/dev/null; then
    echo "错误: Swift helper 编译失败: ${helper}。请确认 Apple Xcode Command Line Tools 已完成安装，然后重新运行 ./install.sh。" >&2
    return 1
  fi
  if ! swift_product_is_executable "$output_path"; then
    echo "错误: Swift helper 编译产物无效: ${helper}" >&2
    return 1
  fi
}

compile_swift_helpers() {
  echo "==> 编译 Swift 原生 helper"
  mkdir -p scripts/bin
  local temp_dir
  temp_dir="$(/usr/bin/mktemp -d "scripts/bin/.swift-helpers.XXXXXX")" || {
    echo "错误: 无法创建 Swift helper 临时目录" >&2
    return 1
  }

  if ! compile_swift_helper "$temp_dir" "mac-settings-ax-fill" \
    -framework ApplicationServices -framework AppKit ||
    ! compile_swift_helper "$temp_dir" "mac-settings-2fa-code" \
      -framework ApplicationServices -framework AppKit ||
    ! compile_swift_helper "$temp_dir" "mac-2fa-popup-read" \
      -framework ApplicationServices -framework AppKit ||
    ! compile_swift_helper "$temp_dir" "mac-2fa-popup-ocr" \
      -framework ApplicationServices -framework AppKit -framework Vision -framework CoreGraphics ||
    ! compile_swift_helper "$temp_dir" "mac-2fa-click-allow" \
      -framework ApplicationServices -framework AppKit; then
    cleanup_swift_helper_temp_dir "$temp_dir"
    return 1
  fi

  local helper
  for helper in "${COMPILED_SWIFT_HELPERS[@]}"; do
    if ! /bin/mv -f -- "$temp_dir/${helper}" "scripts/bin/${helper}"; then
      echo "错误: 无法替换 Swift helper: ${helper}" >&2
      cleanup_swift_helper_temp_dir "$temp_dir"
      return 1
    fi
    echo "✓ ${helper} 已编译"
  done

  if ! /bin/rmdir "$temp_dir"; then
    echo "错误: 无法清理 Swift helper 临时目录" >&2
    return 1
  fi
}

validate_required_swift_artifacts() {
  local helper
  for helper in "${REQUIRED_SWIFT_HELPERS[@]}"; do
    if [[ -f "scripts/bin/${helper}" && -x "scripts/bin/${helper}" ]]; then
      continue
    fi
    echo "错误: 必需 Swift helper 编译产物无效: scripts/bin/${helper}" >&2
    return 1
  done
}

ensure_swiftc
validate_required_swift_sources
compile_swift_helpers
validate_required_swift_artifacts

exec node scripts/setup-environment.mjs --install-ruyipage "$@"
