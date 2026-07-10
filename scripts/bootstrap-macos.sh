#!/bin/bash
# 引导 Node 运行时（仅用 nodejs.org 官方二进制，不用 Homebrew）
set -euo pipefail

BOOTSTRAP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$BOOTSTRAP_DIR/.." && pwd)"
LOCAL_NODE_DIR="$PACKAGE_ROOT/.runtime/node"
LOCAL_NODE_VERSION="${LOCAL_NODE_VERSION:-22.14.0}"
LOCAL_PYTHON_VERSION="${PYTHON_BOOTSTRAP_VERSION:-3.12.10}"
PYTHON_DOWNLOAD_DIR="$PACKAGE_ROOT/.runtime/downloads"
PYTHON_BOOTSTRAP_PKG_URL="${PYTHON_BOOTSTRAP_PKG_URL:-https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg}"
PYTHON_FRAMEWORK_BIN="/Library/Frameworks/Python.framework/Versions/3.12/bin"

python_version_supported() {
  local command_path="$1"
  local version major minor
  version="$("$command_path" --version 2>&1)" || return 1
  if [[ "$version" =~ Python[[:space:]]+([0-9]+)\.([0-9]+) ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    (( major > 3 || (major == 3 && minor >= 10) ))
    return
  fi
  return 1
}

resolve_supported_python() {
  local candidate command_path
  local candidates=()
  if [[ -n "${PYTHON_BOOTSTRAP_EXECUTABLE:-}" ]]; then
    candidates+=("$PYTHON_BOOTSTRAP_EXECUTABLE")
  fi
  candidates+=(
    "python3"
    "python"
    "/usr/local/bin/python3"
    "$PYTHON_FRAMEWORK_BIN/python3"
  )

  for candidate in "${candidates[@]}"; do
    command_path="$candidate"
    if [[ "$candidate" != */* ]]; then
      command_path="$(command -v "$candidate" 2>/dev/null || true)"
    fi
    if [[ -n "$command_path" && -x "$command_path" ]] &&
      python_version_supported "$command_path"; then
      printf '%s\n' "$command_path"
      return 0
    fi
  done
  return 1
}

acquire_admin_authorization() {
  echo "==> 需要管理员权限安装受信任的 Python 运行环境"
  echo "    密码仅由 sudo 读取，项目不会保存或记录密码"
  if ! sudo -v; then
    echo "错误: 未获得管理员授权，安装已停止"
    exit 1
  fi
}

install_python_official_pkg() {
  local pkg partial signature
  mkdir -p "$PYTHON_DOWNLOAD_DIR"
  pkg="$PYTHON_DOWNLOAD_DIR/python-${LOCAL_PYTHON_VERSION}-macos11.pkg"
  partial="${pkg}.part"

  if [[ ! -f "$pkg" ]]; then
    echo ">>> 从 python.org 下载官方 Python ${LOCAL_PYTHON_VERSION} universal2 安装包"
    if ! curl --fail --location --retry 3 --output "$partial" "$PYTHON_BOOTSTRAP_PKG_URL"; then
      rm -f "$partial"
      echo "错误: Python 安装包下载失败: $PYTHON_BOOTSTRAP_PKG_URL"
      return 1
    fi
    mv "$partial" "$pkg"
  fi

  signature="$(pkgutil --check-signature "$pkg" 2>&1)" || {
    echo "$signature"
    echo "错误: Python 安装包签名验证失败: $pkg"
    return 1
  }
  if [[ "$signature" != *"Python Software Foundation"* ]]; then
    echo "$signature"
    echo "错误: Python 安装包签名不是 Python Software Foundation"
    return 1
  fi

  echo ">>> 安装已验证签名的 Python ${LOCAL_PYTHON_VERSION}"
  sudo installer -pkg "$pkg" -target /
}

ensure_python() {
  local python_path
  if python_path="$(resolve_supported_python)"; then
    export PATH="$(dirname "$python_path"):$PATH"
    echo "✓ Python $("$python_path" --version 2>&1) ($python_path)"
    return 0
  fi

  echo ">>> 未检测到 Python 3.10+，开始自动安装"
  install_python_official_pkg

  if ! python_path="$(resolve_supported_python)"; then
    echo "错误: Python 安装完成后仍未检测到 Python 3.10+"
    echo "已检查 python3、python、/usr/local/bin/python3 与 $PYTHON_FRAMEWORK_BIN/python3"
    return 1
  fi

  export PATH="$(dirname "$python_path"):$PATH"
  echo "✓ Python $("$python_path" --version 2>&1) ($python_path)"
}

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node -p "parseInt(process.versions.node.split('.')[0], 10)"
}

ensure_local_node_path() {
  if [[ -x "$LOCAL_NODE_DIR/bin/node" ]]; then
    export PATH="$LOCAL_NODE_DIR/bin:$PATH"
  fi
}

install_node_official_binary() {
  local arch dest tarball url
  arch="$(uname -m)"
  case "$arch" in
    arm64) arch="arm64" ;;
    x86_64) arch="x86_64" ;;
    *) echo "错误: 不支持的 CPU 架构: $arch"; return 1 ;;
  esac

  dest="$LOCAL_NODE_DIR"
  tarball="node-v${LOCAL_NODE_VERSION}-darwin-${arch}.tar.gz"
  url="https://nodejs.org/dist/v${LOCAL_NODE_VERSION}/${tarball}"

  echo ">>> 从 nodejs.org 下载官方 Node 二进制"
  echo "    版本: v${LOCAL_NODE_VERSION}"
  echo "    安装到: $dest"

  mkdir -p "$dest"
  curl -fsSL "$url" | tar -xz -C "$dest" --strip-components=1
  export PATH="$dest/bin:$PATH"

  local major
  major="$(node_major_version)"
  if [[ "$major" -lt 18 ]]; then
    echo "错误: 官方 Node 安装后版本仍不满足 18+"
    return 1
  fi
  echo "✓ Node $(node -v)（官方二进制）"
}

ensure_node() {
  ensure_local_node_path

  local major
  major="$(node_major_version)"
  if [[ "$major" -ge 18 ]]; then
    echo "✓ Node $(node -v)"
    return 0
  fi

  if [[ "$major" -gt 0 ]]; then
    echo ">>> Node 版本过低 ($(node -v))，需要 18+"
    echo "    请从 https://nodejs.org 安装新版本，或运行 ./install.sh 自动下载官方包"
    exit 1
  fi

  echo ">>> 未检测到 Node.js，开始从 nodejs.org 安装…"
  install_node_official_binary

  major="$(node_major_version)"
  if [[ "$major" -lt 18 ]]; then
    echo "错误: 需要 Node 18+，当前: $(node -v 2>/dev/null || echo none)"
    exit 1
  fi
}

bootstrap_macos_runtime() {
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "错误: 仅支持 macOS"
    exit 1
  fi
  ensure_node
}

bootstrap_macos_install_runtime() {
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "错误: 仅支持 macOS"
    exit 1
  fi
  acquire_admin_authorization
  ensure_python
  ensure_node
}
