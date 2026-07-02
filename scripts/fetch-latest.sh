#!/bin/bash
# 从 GitHub Releases 下载最新 macOS 分发包并解压（无需 clone 仓库）
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/jiahaoyin/Apple-AutoMation/main/scripts/fetch-latest.sh | bash
#   ./scripts/fetch-latest.sh [目标目录]
#
# 环境变量:
#   GITHUB_REPO  默认 jiahaoyin/Apple-AutoMation
set -euo pipefail

DEFAULT_REPO="jiahaoyin/Apple-AutoMation"
REPO="${GITHUB_REPO:-$DEFAULT_REPO}"
DEST="${1:-./apple-id-automation-latest}"

mkdir -p "$DEST"
cd "$DEST"

download_with_gh() {
  rm -f ./*-macos.zip 2>/dev/null || true
  gh release download -R "$REPO" --pattern '*-macos.zip'
}

download_with_curl() {
  local api asset url
  api="https://api.github.com/repos/${REPO}/releases/latest"
  asset="$(curl -fsSL "$api" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data.get('assets', []):
    if a.get('name', '').endswith('-macos.zip'):
        print(a['name'] + '|' + a['browser_download_url'])
        break
")"
  if [[ -z "$asset" ]]; then
    echo "错误: 最新 Release 中未找到 *-macos.zip 附件" >&2
    exit 1
  fi
  local name="${asset%%|*}"
  url="${asset#*|}"
  echo "==> 下载 ${name} …"
  curl -fL "$url" -o "$name"
}

echo "==> 从 ${REPO} 拉取最新 Release …"

if command -v gh >/dev/null 2>&1; then
  download_with_gh
else
  echo "提示: 未安装 gh，使用 curl 下载（公开仓库无需登录）"
  download_with_curl
fi

ZIP="$(ls -1t *-macos.zip 2>/dev/null | head -1)"
if [[ -z "$ZIP" ]]; then
  echo "错误: 未找到 *-macos.zip 附件" >&2
  exit 1
fi

echo "==> 解压 ${ZIP} …"
unzip -qo "$ZIP"
rm -f "$ZIP"

DIR="$(ls -1dt apple-id-automation-* 2>/dev/null | head -1)"
ABS_DEST="$(cd "$DEST" && pwd)"

echo ""
echo "完成: ${ABS_DEST}/${DIR}"
echo "下一步:"
echo "  cd \"${ABS_DEST}/${DIR}\""
echo "  ./install.sh && ./run.sh"
