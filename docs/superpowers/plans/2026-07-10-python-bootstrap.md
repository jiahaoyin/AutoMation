# Automatic Python Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `./install.sh` request administrator authorization immediately, install signed Python 3.12.10 automatically when Python 3.10+ is unavailable, and continue into the isolated ruyiPage installation.

**Architecture:** `scripts/bootstrap-macos.sh` owns macOS runtime detection and the privileged Python.org PKG installation. Root and generated `install.sh` call a new privileged install entry point, while root and generated `run.sh` keep the existing non-privileged runtime entry point. A focused Node regression test inspects both shell entry points and the release renderer on Windows.

**Tech Stack:** Bash 3.2-compatible shell, macOS `sudo`, `curl`, `pkgutil`, `installer`, Node.js ESM tests, Python.org universal2 PKG.

## Global Constraints

- Request administrator authorization with `sudo -v` immediately after the install banner.
- Never read, store, pipe, or log the administrator password.
- Reuse an existing Python only when it reports Python 3.10 or newer.
- Pin the fallback installer to Python 3.12.10.
- Download only from `https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg` by default.
- Require a successful `pkgutil --check-signature` result containing `Python Software Foundation`.
- Install the PKG with `sudo installer -pkg <package> -target /`.
- Keep ruyiPage installed in `.runtime/ruyipage-venv`; do not set `RUYIPAGE_PYTHON` to the system interpreter.
- Do not make `run.sh` request administrator authorization.
- Keep root scripts and generated release scripts behaviorally identical.

---

### Task 1: Lock The Bootstrap Contract With A Failing Test

**Files:**
- Create: `scripts/test-python-bootstrap.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `renderInstallSh(version: string): string` and `renderRunSh(): string` from `scripts/build-release.mjs`.
- Produces: npm script `test:python-bootstrap` and a regression test that defines the required shell contract.

- [ ] **Step 1: Write the failing regression test**

Create `scripts/test-python-bootstrap.mjs`:

```js
import { strict as assert } from "node:assert";
import fs from "node:fs";

import { renderInstallSh, renderRunSh } from "./build-release.mjs";

const bootstrap = fs.readFileSync(
  new URL("./bootstrap-macos.sh", import.meta.url),
  "utf-8"
);
const rootInstall = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf-8");
const rootRun = fs.readFileSync(new URL("../run.sh", import.meta.url), "utf-8");
const generatedInstall = renderInstallSh("test-version");
const generatedRun = renderRunSh();

assert.match(rootInstall, /bootstrap_macos_install_runtime/);
assert.match(generatedInstall, /bootstrap_macos_install_runtime/);
assert.doesNotMatch(rootRun, /bootstrap_macos_install_runtime/);
assert.doesNotMatch(generatedRun, /bootstrap_macos_install_runtime/);
assert.match(rootRun, /bootstrap_macos_runtime/);
assert.match(generatedRun, /bootstrap_macos_runtime/);

const installFunction = bootstrap.match(
  /bootstrap_macos_install_runtime\(\)\s*\{([\s\S]*?)\n\}/
)?.[1];
assert.ok(installFunction, "privileged install bootstrap function is required");
const sudoIndex = installFunction.indexOf("acquire_admin_authorization");
const pythonIndex = installFunction.indexOf("ensure_python");
const nodeIndex = installFunction.indexOf("ensure_node");
assert.ok(sudoIndex >= 0 && sudoIndex < pythonIndex);
assert.ok(pythonIndex >= 0 && pythonIndex < nodeIndex);

assert.match(bootstrap, /sudo -v/);
assert.match(bootstrap, /PYTHON_BOOTSTRAP_VERSION:-3\.12\.10/);
assert.match(
  bootstrap,
  /https:\/\/www\.python\.org\/ftp\/python\/3\.12\.10\/python-3\.12\.10-macos11\.pkg/
);
assert.match(bootstrap, /pkgutil --check-signature/);
assert.match(bootstrap, /Python Software Foundation/);
assert.match(bootstrap, /sudo installer -pkg "\$pkg" -target \//);
assert.match(bootstrap, /major > 3 \|\| \(major == 3 && minor >= 10\)/);

console.log("python bootstrap contract: ok");
```

Add to `package.json`:

```json
"test:python-bootstrap": "node scripts/test-python-bootstrap.mjs"
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm.cmd run test:python-bootstrap
```

Expected: FAIL because `bootstrap_macos_install_runtime`, Python installer constants, signature verification, and privileged installer command do not exist.

---

### Task 2: Implement The Privileged Python Bootstrap

**Files:**
- Modify: `scripts/bootstrap-macos.sh`
- Modify: `install.sh`
- Modify: `scripts/build-release.mjs`
- Test: `scripts/test-python-bootstrap.mjs`

**Interfaces:**
- Consumes: existing `ensure_node()` and `bootstrap_macos_runtime()` behavior.
- Produces:
  - `python_version_supported(command: string): boolean`
  - `resolve_supported_python(): string`
  - `acquire_admin_authorization(): void`
  - `install_python_official_pkg(): void`
  - `ensure_python(): void`
  - `bootstrap_macos_install_runtime(): void`

- [ ] **Step 1: Add Python bootstrap constants**

Add after the Node constants in `scripts/bootstrap-macos.sh`:

```bash
LOCAL_PYTHON_VERSION="${PYTHON_BOOTSTRAP_VERSION:-3.12.10}"
PYTHON_DOWNLOAD_DIR="$PACKAGE_ROOT/.runtime/downloads"
PYTHON_BOOTSTRAP_PKG_URL="${PYTHON_BOOTSTRAP_PKG_URL:-https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg}"
PYTHON_FRAMEWORK_BIN="/Library/Frameworks/Python.framework/Versions/3.12/bin"
```

- [ ] **Step 2: Implement supported-version detection**

Add:

```bash
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
```

- [ ] **Step 3: Implement immediate administrator authorization**

Add:

```bash
acquire_admin_authorization() {
  echo "==> 需要管理员权限安装受信任的 Python 运行环境"
  echo "    密码仅由 sudo 读取，项目不会保存或记录密码"
  if ! sudo -v; then
    echo "错误: 未获得管理员授权，安装已停止"
    exit 1
  fi
}
```

- [ ] **Step 4: Implement signed official PKG installation**

Add:

```bash
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
```

The single-file `rm -f "$partial"` is permitted because it targets only the known incomplete download file.

- [ ] **Step 5: Implement Python selection and post-install verification**

Add:

```bash
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
```

Do not export `RUYIPAGE_PYTHON`; `scripts/lib/ruyipage-runtime.js` must still create `.runtime/ruyipage-venv`.

- [ ] **Step 6: Add the install-only bootstrap entry point**

Keep the existing `bootstrap_macos_runtime()` implementation for `run.sh`, and add:

```bash
bootstrap_macos_install_runtime() {
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "错误: 仅支持 macOS"
    exit 1
  fi
  acquire_admin_authorization
  ensure_python
  ensure_node
}
```

- [ ] **Step 7: Wire root and generated install scripts**

In root `install.sh`, replace:

```bash
bootstrap_macos_runtime
```

with:

```bash
bootstrap_macos_install_runtime
```

Make the same replacement inside `renderInstallSh()` in `scripts/build-release.mjs`. Do not change root or generated `run.sh`.

- [ ] **Step 8: Run the focused tests**

Run:

```powershell
npm.cmd run test:python-bootstrap
node scripts/test-release-copy-paths.mjs
```

Expected:

```text
python bootstrap contract: ok
release copy paths: ok
```

- [ ] **Step 9: Run shell syntax checks**

Run:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' -n scripts/bootstrap-macos.sh
& 'C:\Program Files\Git\bin\bash.exe' -n install.sh
node --input-type=module -e "import { renderInstallSh } from './scripts/build-release.mjs'; process.stdout.write(renderInstallSh('syntax-test'))" | & 'C:\Program Files\Git\bin\bash.exe' -n -s
```

Expected: all commands exit 0.

- [ ] **Step 10: Commit the bootstrap implementation**

```bash
git add scripts/bootstrap-macos.sh install.sh scripts/build-release.mjs scripts/test-python-bootstrap.mjs package.json
git commit -m "feat: bootstrap Python during install"
```

---

### Task 3: Document The New Install Flow And Run Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/PROJECT.md`
- Modify: `scripts/build-release.mjs`
- Modify: `scripts/test-release-copy-paths.mjs`

**Interfaces:**
- Consumes: `bootstrap_macos_install_runtime()` from Task 2.
- Produces: matching root and generated documentation plus regression coverage for release packaging.

- [ ] **Step 1: Extend release regression assertions**

In `scripts/test-release-copy-paths.mjs`, add:

```js
const bootstrapMacOS = fs.readFileSync(
  new URL("./bootstrap-macos.sh", import.meta.url),
  "utf-8"
);
assert.ok(COPY_PATHS.includes("scripts/bootstrap-macos.sh"));
assert.match(generatedInstallSh, /bootstrap_macos_install_runtime/);
assert.match(rootRunSh, /bootstrap_macos_runtime/);
assert.doesNotMatch(rootRunSh, /bootstrap_macos_install_runtime/);
assert.match(bootstrapMacOS, /sudo -v/);
assert.match(bootstrapMacOS, /Python Software Foundation/);
```

- [ ] **Step 2: Run the release test to verify the new assertions pass**

Run:

```powershell
node scripts/test-release-copy-paths.mjs
```

Expected: `release copy paths: ok`.

- [ ] **Step 3: Update root documentation**

Update `README.md` and `docs/PROJECT.md` to state:

```text
./install.sh 启动后会立即请求一次管理员密码授权。若没有 Python 3.10+，
安装器会下载并验证 Python.org 官方 Python 3.12.10 universal2 PKG，
完成系统安装后继续创建 .runtime/ruyipage-venv，无需重新运行脚本。
```

Also state that `run.sh` does not request administrator authorization.

- [ ] **Step 4: Update generated release README text**

In `buildReadme()` inside `scripts/build-release.mjs`, replace the manual Python prerequisite with:

```markdown
- **Python**：`./install.sh` 会自动检测 Python 3.10+；缺失时请求管理员授权，
  安装经签名验证的 Python.org Python 3.12.10 universal2 PKG，再把
  ruyiPage 安装到项目内 `.runtime/ruyipage-venv`
```

- [ ] **Step 5: Run the complete verification matrix**

Run:

```powershell
node scripts/test-browser-backend.mjs
node scripts/test-ruyipage-runtime.mjs
$env:RUYIPAGE_PYTHON='C:\Users\hasee\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
node scripts/test-ruyipage-protocol.mjs
node scripts/test-firefox-profile-mode.mjs
node scripts/test-release-copy-paths.mjs
npm.cmd run test:python-bootstrap
npm.cmd run test:ruyipage-flow
npm.cmd run check
git diff --check
```

Also run `node --check` for every changed `.js`/`.mjs`, and `bash -n` for root and generated shell scripts.

Expected:

- All unit and protocol tests exit 0.
- Python flow reports 38 passing tests.
- Windows `npm run check` exits 0 with expected non-macOS/runtime warnings.
- No production Node browser automation references reappear.

- [ ] **Step 6: Commit documentation and verification coverage**

```bash
git add README.md docs/PROJECT.md scripts/build-release.mjs scripts/test-release-copy-paths.mjs
git commit -m "docs: explain automatic Python installation"
```

- [ ] **Step 7: Push the test branch**

```bash
git push origin codex/ruyipage-risk-reduction
```

- [ ] **Step 8: Run the macOS acceptance flow**

On the macOS test machine:

```bash
git fetch origin
git switch codex/ruyipage-risk-reduction
git pull --ff-only
./install.sh
npm run check
npm run test:python-bootstrap
npm run test:ruyipage-flow
./run.sh
```

Expected acceptance checkpoints:

1. The administrator password prompt appears immediately after the install banner.
2. A compatible existing Python is reused, or signed Python 3.12.10 is installed.
3. `.runtime/ruyipage-venv/bin/python` exists and reports ruyiPage 1.2.45.
4. Installation continues into Swift helper compilation and environment checks without asking the user to rerun the script.
