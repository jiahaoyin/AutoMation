#!/bin/bash
# 引导 Node 运行时（仅用 nodejs.org 官方二进制，不用 Homebrew）
set -euo pipefail

BOOTSTRAP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$BOOTSTRAP_DIR/.." && pwd)"
LOCAL_NODE_DIR="$PACKAGE_ROOT/.runtime/node"
LOCAL_NODE_VERSION="${LOCAL_NODE_VERSION:-22.14.0}"

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
