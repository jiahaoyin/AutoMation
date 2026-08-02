import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
assert.equal(generatedInstall, rootInstall, "release install.sh must match the repository source");
for (const source of [rootInstall, generatedInstall]) {
  assert.match(source, /swiftc_usable\(\)/);
  assert.match(source, /ensure_swiftc\(\)/);
  assert.match(source, /\/usr\/bin\/xcrun --find swiftc/);
  assert.match(source, /"\$swiftc_path" --version/);
  assert.doesNotMatch(source, /command -v swiftc/);
  assert.match(source, /"mac-2fa-click-allow"/);
  assert.match(source, /"mac-2fa-popup-ocr"[\s\S]*?-framework ScreenCaptureKit/);
  assert.match(source, /node scripts\/preflight-2fa-permissions\.mjs --all/);
  assert.match(source, /readonly OPTIONAL_SWIFT_HELPERS=/);
  assert.match(source, /\/usr\/bin\/xcode-select --install/);
  assert.match(source, /readonly SWIFTC_INSTALL_MAX_ATTEMPTS=[1-9][0-9]*/);
  assert.match(source, /readonly SWIFTC_INSTALL_POLL_SECONDS=[1-9][0-9]*/);
  assert.match(source, /readonly SWIFT_SOFTWAREUPDATE_LIST_TIMEOUT_SECONDS=[1-9][0-9]*/);
  assert.match(source, /readonly SWIFT_SOFTWAREUPDATE_INSTALL_TIMEOUT_SECONDS=[1-9][0-9]*/);
  assert.match(source, /readonly SWIFT_MODULE_CACHE_DIR=/);
  assert.match(source, /run_command_with_timeout\(\)/);
  assert.match(source, /run_swiftc\(\)/);
  assert.match(source, /\/usr\/bin\/xcrun swiftc -module-cache-path/);
  assert.match(source, /\/usr\/sbin\/softwareupdate --install/);
  assert.match(source, /\/usr\/bin\/sudo -v/);
  assert.match(
    source,
    /错误: 未找到 swiftc。请完成 Apple 官方 Xcode Command Line Tools 安装后重新运行 \.\/install\.sh。/
  );
  assert.doesNotMatch(source, /xcodebuild[^\n]*license/i);
}
assert.doesNotMatch(
  rootInstall.slice(0, rootInstall.indexOf("bootstrap_macos_install_runtime")),
  /\bnode\b/
);
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

assert.match(bootstrap, /\/usr\/bin\/sudo -v/);
assert.match(bootstrap, /readonly LOCAL_PYTHON_VERSION="3\.12\.10"/);
assert.match(
  bootstrap,
  /readonly PYTHON_BOOTSTRAP_PKG_URL="https:\/\/www\.python\.org\/ftp\/python\/\$\{LOCAL_PYTHON_VERSION\}\/python-\$\{LOCAL_PYTHON_VERSION\}-macos11\.pkg"/
);
assert.match(
  bootstrap,
  /8373e58da4ea146b3eb1c1f9834f19a319440b6b679b06050b1f9ee3237aa8e4/
);
assert.match(bootstrap, /resolve_trusted_python_signer/);
const signerFunction = bootstrap.match(
  /resolve_trusted_python_signer\(\)\s*\{([\s\S]*?)\n\}/
)?.[1];
assert.ok(signerFunction, "trusted Python signer resolver is required");
const forbiddenSignerTempConstruct =
  /<<<|<<-?|[<>]\s*\(|\bmktemp\b|\/(?:var\/)?tmp(?:\/|\b)|\$\{?TMPDIR\}?/;
for (const unsafeConstruct of [
  '<<< "${signature}"',
  "<<EOF",
  "<<-EOF",
  "< <(printf '%s' value)",
  "> >(cat)",
  "mktemp signer.XXXXXX",
  "/tmp/signer",
  "/var/tmp/signer",
  "$TMPDIR/signer",
  "${TMPDIR}/signer",
]) {
  assert.match(unsafeConstruct, forbiddenSignerTempConstruct);
}
assert.doesNotMatch(
  signerFunction,
  forbiddenSignerTempConstruct,
  "signer parsing must not use shell constructs or paths that create temporary files"
);
assert.doesNotMatch(bootstrap, /BMM5U3QVKW|DJ3H93M7VJ/);
assert.match(bootstrap, /\/usr\/bin\/sudo -n \/usr\/sbin\/pkgutil --check-signature/);
assert.match(bootstrap, /\/usr\/bin\/sudo -n \/usr\/sbin\/installer -pkg/);
assert.match(bootstrap, /\/usr\/bin\/sudo -n \/usr\/bin\/mktemp -d/);
assert.match(bootstrap, /\/usr\/bin\/sudo -n \/usr\/bin\/install/);
assert.match(bootstrap, /\/usr\/bin\/curl/);
assert.match(bootstrap, /\/usr\/bin\/shasum/);
assert.match(bootstrap, /\/usr\/bin\/sudo -n \/usr\/bin\/true/);
assert.match(bootstrap, /SUDO_KEEPALIVE_PID/);
assert.match(bootstrap, /\/usr\/bin\/sudo -k/);
assert.match(bootstrap, /x86_64\) arch="x64" ;;/);
assert.doesNotMatch(bootstrap, /x86_64\) arch="x86_64" ;;/);
assert.match(bootstrap, /major > 3 \|\| \(major == 3 && minor >= 10\)/);
assert.match(bootstrap, /export PYTHON_BOOTSTRAP_EXECUTABLE="\$python_path"/);
assert.match(bootstrap, /python_path_is_admin_trusted/);
assert.match(bootstrap, /\/usr\/bin\/realpath/);
assert.match(bootstrap, /\/usr\/bin\/stat -f/);
const resolveFunction = bootstrap.match(
  /resolve_supported_python\(\)\s*\{([\s\S]*?)\n\}/
)?.[1];
assert.ok(resolveFunction, "supported Python resolver is required");
const trustIndex = resolveFunction.indexOf("python_path_is_admin_trusted");
const versionIndex = resolveFunction.indexOf("python_version_supported", trustIndex);
assert.ok(
  trustIndex >= 0 && trustIndex < versionIndex,
  "non-framework candidate ownership must be checked before executing Python"
);
assert.match(
  resolveFunction,
  /candidate" == "\$PYTHON_FRAMEWORK_BIN\/python3"[\s\S]*python_version_supported/
);
for (const line of bootstrap.split(/\r?\n/).filter((line) => line.includes("/usr/bin/sudo"))) {
  assert.match(
    line,
    /\/usr\/bin\/sudo (?:-v\b|-k\b|-n\b)/,
    `sudo call may prompt unexpectedly: ${line}`
  );
}

const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "/bin/bash";
assert.equal(fs.existsSync(bash), true, `bash is required: ${bash}`);

function toBashPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (process.platform !== "win32") return normalized;
  return normalized.replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`);
}

function bashQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function shellFunction(source, name) {
  return source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0] ?? null;
}

function readonlyArray(source, name) {
  const match = source.match(new RegExp(`readonly ${name}=\\(\\r?\\n([\\s\\S]*?)\\r?\\n\\)`));
  assert.ok(match, `${name} array is required`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function removeTreeOneFileAtATime(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) removeTreeOneFileAtATime(entryPath);
    else fs.unlinkSync(entryPath);
  }
  fs.rmdirSync(directory);
}

const timeoutFunction = shellFunction(rootInstall, "run_command_with_timeout") ?? "";
const cltInstallFunction = shellFunction(rootInstall, "install_command_line_tools_from_softwareupdate") ?? "";
const cltRequestFunction = shellFunction(rootInstall, "request_command_line_tools_install") ?? "";
assert.doesNotMatch(
  cltRequestFunction.replace(/^request_command_line_tools_install\(\)\s*\{/, ""),
  /\brequest_command_line_tools_install\b/,
  "CLT request helper must not call itself"
);
const ensureSwiftcFunction = shellFunction(rootInstall, "ensure_swiftc");
assert.ok(ensureSwiftcFunction, "ensure_swiftc shell function is required");
const swiftcUsableFunction = shellFunction(rootInstall, "swiftc_usable") ?? "";
const swiftCompileEnvironmentDetector =
  shellFunction(rootInstall, "swift_compile_error_is_environmental") ?? "";
assert.match(
  swiftCompileEnvironmentDetector,
  /no such module '\(AppKit\|ApplicationServices\|Vision\|CoreGraphics\|ScreenCaptureKit\)'/,
  "the install repair path must recognize all required OCR framework modules"
);
const harnessEnsureSwiftc = `${swiftcUsableFunction}\n${timeoutFunction}\n${cltInstallFunction}\n${cltRequestFunction}\n${ensureSwiftcFunction}`
  .replace(
    "if [[ -x /usr/bin/xcode-select ]]; then",
    "if fake_xcode_select_available; then"
  )
  .replace(
    "[[ ! -x /usr/bin/xcode-select ]] || /usr/bin/xcode-select --install",
    "! fake_xcode_select_available || fake_xcode_select --install"
  )
  .replaceAll("/usr/bin/xcrun", "fake_xcrun")
  .replaceAll("/usr/bin/xcode-select", "fake_xcode_select")
  .replaceAll("/usr/bin/sudo -n /usr/bin/true", "fake_sudo_true")
  .replaceAll("/usr/bin/sudo -v", "fake_sudo_refresh")
  .replaceAll("/usr/bin/sudo -n /usr/sbin/softwareupdate", "fake_sudo_softwareupdate")
  .replaceAll("/usr/sbin/softwareupdate", "fake_softwareupdate")
  .replaceAll("/bin/sleep", "fake_sleep");

const triggeredInstall = spawnSync(
  bash,
  [
    "-lc",
    `SWIFTC_INSTALL_MAX_ATTEMPTS=3; SWIFTC_INSTALL_POLL_SECONDS=1; ` +
      `SWIFTC_BIN=''; swift_available=0; xcode_select_calls=0; sleep_calls=0; ` +
      `command() { if [[ "$1" == "-v" && "$2" == "swiftc" ]]; then ` +
      `return 0; fi; builtin command "$@"; }; ` +
      `fake_xcrun() { if (( swift_available == 1 )); then printf '/usr/bin/true\n'; return 0; ` +
      `else printf '/usr/bin/false\n'; return 1; fi; }; ` +
      `fake_xcode_select_available() { return 0; }; ` +
      `fake_xcode_select() { (( xcode_select_calls += 1 )); swift_available=1; }; ` +
      `fake_softwareupdate() { return 1; }; fake_sudo_softwareupdate() { return 1; }; ` +
      `fake_sleep() { (( sleep_calls += 1 )); }; ` +
      `${harnessEnsureSwiftc}; ensure_swiftc; status=$?; ` +
      `printf '%s %s %s %s' "$status" "$xcode_select_calls" "$sleep_calls" "$SWIFTC_BIN"`,
  ],
  { encoding: "utf8" }
);
assert.equal(triggeredInstall.status, 0, triggeredInstall.stderr);
assert.equal(
  triggeredInstall.stdout.trim().split(/\r?\n/).at(-1),
  "0 1 1 /usr/bin/true"
);

const unavailableInstall = spawnSync(
  bash,
  [
    "-lc",
    `SWIFTC_INSTALL_MAX_ATTEMPTS=3; SWIFTC_INSTALL_POLL_SECONDS=1; ` +
      `SWIFTC_BIN=''; xcode_select_calls=0; sleep_calls=0; ` +
      `command() { if [[ "$1" == "-v" && "$2" == "swiftc" ]]; then ` +
      `return 0; fi; builtin command "$@"; }; ` +
      `fake_xcrun() { printf '/usr/bin/false\n'; }; ` +
      `fake_xcode_select_available() { return 0; }; ` +
      `fake_xcode_select() { (( xcode_select_calls += 1 )); return 1; }; ` +
      `fake_softwareupdate() { return 1; }; fake_sudo_softwareupdate() { return 1; }; ` +
      `fake_sleep() { (( sleep_calls += 1 )); }; ` +
      `${harnessEnsureSwiftc}; ensure_swiftc; status=$?; ` +
      `printf '%s %s %s' "$status" "$xcode_select_calls" "$sleep_calls"`,
  ],
  { encoding: "utf8" }
);
assert.equal(unavailableInstall.status, 0, unavailableInstall.stderr);
assert.equal(unavailableInstall.stdout.trim().split(/\r?\n/).at(-1), "1 1 3");
assert.match(
  unavailableInstall.stderr,
  /错误: 未找到 swiftc。请完成 Apple 官方 Xcode Command Line Tools 安装后重新运行 \.\/install\.sh。/
);

const softwareupdateInstall = spawnSync(
  bash,
  [
    "-lc",
    `SWIFTC_INSTALL_MAX_ATTEMPTS=3; SWIFTC_INSTALL_POLL_SECONDS=1; ` +
      `SWIFT_SOFTWAREUPDATE_LIST_TIMEOUT_SECONDS=3; SWIFT_SOFTWAREUPDATE_INSTALL_TIMEOUT_SECONDS=3; ` +
      `SWIFTC_BIN=''; marker="$(mktemp)"; list_marker="$(mktemp)"; install_marker="$(mktemp)"; rm -f "$marker" "$list_marker" "$install_marker"; xcode_select_calls=0; sudo_refresh_calls=0; ` +
      `command() { if [[ "$1" == "-v" && "$2" == "swiftc" ]]; then return 0; fi; builtin command "$@"; }; ` +
      `fake_xcrun() { if [[ -f "$marker" ]]; then printf '/usr/bin/true\n'; return 0; else printf '/usr/bin/false\n'; return 1; fi; }; ` +
      `fake_xcode_select_available() { return 0; }; ` +
      `fake_xcode_select() { (( xcode_select_calls += 1 )); return 1; }; ` +
      `fake_softwareupdate() { if [[ "$1" == "--list" ]]; then printf ok > "$list_marker"; printf '* Label: Command Line Tools for Xcode-Test\n'; return 0; fi; return 1; }; ` +
      `fake_sudo_true() { return 1; }; fake_sudo_refresh() { (( sudo_refresh_calls += 1 )); return 0; }; ` +
      `fake_sudo_softwareupdate() { if [[ "$1" == "--install" ]]; then printf ok > "$install_marker"; printf ok > "$marker"; return 0; fi; return 1; }; ` +
      `fake_sleep() { :; }; ` +
      `${harnessEnsureSwiftc}; ensure_swiftc; status=$?; list_seen=0; install_seen=0; [[ -f "$list_marker" ]] && list_seen=1; [[ -f "$install_marker" ]] && install_seen=1; rm -f "$marker" "$list_marker" "$install_marker"; ` +
      `printf '%s %s %s %s %s %s' "$status" "$xcode_select_calls" "$list_seen" "$install_seen" "$sudo_refresh_calls" "$SWIFTC_BIN"`,
  ],
  { encoding: "utf8" }
);
assert.equal(softwareupdateInstall.status, 0, softwareupdateInstall.stderr);
assert.equal(
  softwareupdateInstall.stdout.trim().split(/\r?\n/).at(-1),
  "0 1 1 1 1 /usr/bin/true"
);

const swiftHelpers = [
  "mac-settings-ax-fill",
  "mac-settings-sms-verification",
  "mac-settings-post-sms-finalization",
  "mac-settings-2fa-code",
  "mac-2fa-popup-read",
  "mac-2fa-popup-ocr",
  "mac-2fa-click-allow",
];
const requiredSwiftHelpers = [
  "mac-2fa-popup-read",
  "mac-2fa-click-allow",
  "mac-settings-2fa-code",
  "mac-2fa-popup-ocr",
];
const optionalSwiftHelpers = swiftHelpers.filter(
  (helper) => !requiredSwiftHelpers.includes(helper)
);
const staleOptionalHelpers = new Set(["mac-settings-post-sms-finalization"]);
assert.deepEqual(readonlyArray(rootInstall, "REQUIRED_SWIFT_HELPERS"), requiredSwiftHelpers);
assert.deepEqual(readonlyArray(rootInstall, "OPTIONAL_SWIFT_HELPERS"), [
  "mac-settings-ax-fill",
  "mac-settings-sms-verification",
  "mac-settings-post-sms-finalization",
]);
const installCompileFunctions = [
  "swift_product_is_executable",
  "cleanup_swift_helper_temp_dir",
  "run_swiftc",
  "print_swift_compile_log",
  "swift_compile_error_is_environmental",
  "repair_swift_toolchain_after_compile_failure",
  "compile_swift_helper",
  "compile_swift_helpers",
  "disable_optional_swift_helper",
]
  .map((name) => shellFunction(rootInstall, name))
  .filter(Boolean)
  .join("\n")
  .replaceAll("/usr/bin/xcrun", "fake_xcrun_compile")
  .replaceAll("/bin/mv", "fake_mv");
assert.match(installCompileFunctions, /compile_swift_helpers\(\)/);
assert.match(installCompileFunctions, /fake_xcrun_compile swiftc -module-cache-path/);

function runSwiftInstallCompileHarness(failureMode = "none", failingHelper = "") {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "swift-install-test-"));
  const scriptsDir = path.join(fixtureDir, "scripts");
  const sourceDir = path.join(scriptsDir, "swift");
  const binaryDir = path.join(scriptsDir, "bin");
  const precreatedMarker = path.join(fixtureDir, "precreated-output.txt");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(binaryDir, { recursive: true });
  for (const helper of swiftHelpers) {
    fs.writeFileSync(path.join(sourceDir, `${helper}.swift`), "// fixture\n");
    fs.writeFileSync(path.join(binaryDir, helper), `old-${helper}\n`, { mode: 0o755 });
  }
  if (failureMode === "missing-source" && failingHelper) {
    fs.unlinkSync(path.join(sourceDir, `${failingHelper}.swift`));
  }

  const script = [
    `cd ${bashQuote(toBashPath(fixtureDir))}`,
    `REQUIRED_SWIFT_HELPERS=(${requiredSwiftHelpers.map(bashQuote).join(" ")})`,
    `OPTIONAL_SWIFT_HELPERS=(${optionalSwiftHelpers.map(bashQuote).join(" ")})`,
    `COMPILED_SWIFT_HELPERS=(${swiftHelpers.map(bashQuote).join(" ")})`,
    `SWIFT_MODULE_CACHE_DIR=${bashQuote(toBashPath(path.join(fixtureDir, "module-cache")))}`,
    `FAILURE_MODE=${bashQuote(failureMode)}`,
    `FAILING_HELPER=${bashQuote(failingHelper)}`,
    `PRECREATED_MARKER=${bashQuote(toBashPath(precreatedMarker))}`,
    "SWIFTC_BIN=fake_swiftc",
    "fake_xcrun_compile() {",
    '  if [[ "$1" != "swiftc" ]]; then return 1; fi',
    "  shift",
    '  fake_swiftc "$@"',
    "}",
    "fake_swiftc() {",
    "  local output=''",
    "  while (( $# )); do",
    '    case "$1" in',
    '      -o) output="$2"; shift 2 ;;',
    "      *) shift ;;",
    "    esac",
    "  done",
    '  local helper="$(basename "$output")"',
    '  if [[ -e "$output" ]]; then printf \'%s\\n\' "$output" >> "$PRECREATED_MARKER"; fi',
    '  if [[ "$helper" == "$FAILING_HELPER" && "$FAILURE_MODE" == "compile" ]]; then',
    '    printf \'partial-%s\\n\' "$helper" > "$output"',
    '    /bin/chmod 0755 "$output"',
    "    return 1",
    "  fi",
    '  if [[ "$helper" == "$FAILING_HELPER" && "$FAILURE_MODE" == "incomplete" ]]; then return 0; fi',
    '  printf \'new-%s\\n\' "$helper" > "$output"',
    '  if [[ "$helper" == "$FAILING_HELPER" && "$FAILURE_MODE" == "0644" ]]; then',
    '    /bin/chmod 0644 "$output"',
    "  else",
    '    /bin/chmod 0755 "$output"',
    "  fi",
    "  return 0",
    "}",
    "fake_mv() {",
    "  local positional=()",
    "  while (( $# )); do",
    '    case "$1" in',
    "      --) shift ;;",
    "      -*) shift ;;",
    '      *) positional+=("$1"); shift ;;',
    "    esac",
    "  done",
    '  local src="${positional[0]-}"',
    '  local dst="${positional[1]-}"',
    '  local helper="$(basename "$dst")"',
    '  if [[ "$helper" == "$FAILING_HELPER" && "$FAILURE_MODE" == "move" ]]; then return 1; fi',
    '  command mv -f -- "$src" "$dst"',
    "}",
    installCompileFunctions,
    "swift_product_is_executable() {",
    '  [[ -f "$1" ]] || return 1',
    '  if [[ "$FAILURE_MODE" == "0644" && "$(basename "$1")" == "$FAILING_HELPER" ]]; then return 1; fi',
    "  return 0",
    "}",
    "compile_swift_helpers >/dev/null",
  ].join("\n");

  try {
    const result = spawnSync(bash, ["-s"], { input: script, encoding: "utf8" });
    return {
      result,
      precreatedOutput: fs.existsSync(precreatedMarker),
      binaries: Object.fromEntries(
        swiftHelpers.map((helper) => [
          helper,
          fs.existsSync(path.join(binaryDir, helper))
            ? fs.readFileSync(path.join(binaryDir, helper), "utf8")
            : null,
        ])
      ),
      binaryEntries: fs.readdirSync(binaryDir).sort(),
    };
  } finally {
    removeTreeOneFileAtATime(fixtureDir);
  }
}

for (const failingHelper of requiredSwiftHelpers) {
  const outcome = runSwiftInstallCompileHarness("0644", failingHelper);
  assert.notEqual(outcome.result.status, 0, `${failingHelper} 0644 output was accepted`);
  assert.equal(outcome.precreatedOutput, false, `${failingHelper} output was pre-created`);
  assert.deepEqual(outcome.binaryEntries, [...swiftHelpers].sort());
  for (const helper of swiftHelpers) {
    assert.equal(outcome.binaries[helper], `old-${helper}\n`, `${helper} old binary changed`);
  }
}

for (const optionalHelper of optionalSwiftHelpers) {
  for (const failureMode of ["compile", "incomplete", "0644", "move", "missing-source"]) {
    const outcome = runSwiftInstallCompileHarness(failureMode, optionalHelper);
    assert.equal(
      outcome.result.status,
      0,
      `optional ${optionalHelper} ${failureMode} failure blocked install`
    );
    assert.equal(outcome.precreatedOutput, false, "optional helper output must not be pre-created");
    const expectedEntries = staleOptionalHelpers.has(optionalHelper)
      ? swiftHelpers.filter((helper) => helper !== optionalHelper).sort()
      : [...swiftHelpers].sort();
    assert.deepEqual(outcome.binaryEntries, expectedEntries);
    assert.equal(
      outcome.binaries[optionalHelper],
      staleOptionalHelpers.has(optionalHelper) ? null : `old-${optionalHelper}\n`
    );
    for (const helper of requiredSwiftHelpers) {
      assert.equal(outcome.binaries[helper], `new-${helper}\n`);
    }
  }
}

for (const failingHelper of requiredSwiftHelpers) {
  for (const failureMode of ["compile", "incomplete"]) {
    const outcome = runSwiftInstallCompileHarness(failureMode, failingHelper);
    assert.notEqual(outcome.result.status, 0, `${failingHelper} ${failureMode} compiler product was accepted`);
    assert.equal(outcome.precreatedOutput, false, `${failureMode} output was pre-created`);
    assert.deepEqual(outcome.binaryEntries, [...swiftHelpers].sort());
    for (const helper of swiftHelpers) {
      assert.equal(outcome.binaries[helper], `old-${helper}\n`, `${helper} old binary changed`);
    }
  }
  const moveOutcome = runSwiftInstallCompileHarness("move", failingHelper);
  assert.notEqual(moveOutcome.result.status, 0, `${failingHelper} move failure did not block install`);
  assert.equal(moveOutcome.precreatedOutput, false, `${failingHelper} move output was pre-created`);
  assert.deepEqual(moveOutcome.binaryEntries, [...swiftHelpers].sort());
  assert.equal(moveOutcome.binaries[failingHelper], `old-${failingHelper}\n`);
  for (const helper of optionalSwiftHelpers) {
    assert.equal(moveOutcome.binaries[helper], `old-${helper}\n`);
  }
}

const successfulSwiftCompile = runSwiftInstallCompileHarness();
assert.equal(successfulSwiftCompile.result.status, 0, successfulSwiftCompile.result.stderr);
assert.equal(successfulSwiftCompile.precreatedOutput, false, "compiler output must not be pre-created");
assert.deepEqual(successfulSwiftCompile.binaryEntries, [...swiftHelpers].sort());
for (const helper of swiftHelpers) {
  assert.equal(successfulSwiftCompile.binaries[helper], `new-${helper}\n`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "python-bootstrap-test-"));
const oldPython = path.join(tempDir, "python-old");
const supportedPython = path.join(tempDir, "python-supported");
const untrustedPython = path.join(tempDir, "python-untrusted");
const untrustedMarker = path.join(tempDir, "python-untrusted-executed");
const frameworkBin = path.join(tempDir, "framework-bin");
const frameworkPython = path.join(frameworkBin, "python3");
try {
  fs.mkdirSync(frameworkBin);
  fs.writeFileSync(oldPython, "#!/bin/bash\necho 'Python 3.9.18'\n", { mode: 0o755 });
  fs.writeFileSync(supportedPython, "#!/bin/bash\necho 'Python 3.12.10'\n", { mode: 0o755 });
  fs.writeFileSync(
    untrustedPython,
    `#!/bin/bash\nprintf 'executed\\n' > ${bashQuote(toBashPath(untrustedMarker))}\n` +
      "echo 'Python 3.12.10'\n",
    { mode: 0o755 }
  );
  fs.writeFileSync(frameworkPython, "#!/bin/bash\necho 'Python 3.12.10'\n", { mode: 0o755 });
  const bootstrapPath = fileURLToPath(new URL("./bootstrap-macos.sh", import.meta.url));
  const source = `source ${bashQuote(toBashPath(bootstrapPath))}`;
  const signatureFor = (identity) => `Package "python.pkg":
   Status: signed by a developer certificate issued by Apple for distribution
   Notarization: trusted by the Apple notary service
   Certificate Chain:
    1. ${identity}
    2. Developer ID Certification Authority`;
  const runSigner = (signature) =>
    spawnSync(
      bash,
      [
        "-lc",
        `${source}; resolve_trusted_python_signer ${bashQuote(signature)}`,
      ],
      { encoding: "utf-8" }
    );
  for (const teamId of ["BMM5U3QVKW", "DJ3H93M7VJ"]) {
    const signatureResult = runSigner(
      signatureFor(`Developer ID Installer: Python Software Foundation (${teamId})`)
    );
    assert.equal(signatureResult.status, 0, signatureResult.stderr);
    assert.match(signatureResult.stdout, new RegExp(`\\(${teamId}\\)`));
  }
  const trustedIdentity =
    "Developer ID Installer: Python Software Foundation (BMM5U3QVKW)";
  for (const [name, signature] of [
    ["single line", `1. ${trustedIdentity}`],
    ["LF multiline without trailing newline", signatureFor(trustedIdentity)],
    ["LF multiline with trailing newline", `${signatureFor(trustedIdentity)}\n`],
    [
      "consecutive empty lines",
      `\n\n${signatureFor(trustedIdentity).replaceAll("\n", "\n\n")}\n\n`,
    ],
    [
      "CRLF multiline",
      `${signatureFor(trustedIdentity).replaceAll("\n", "\r\n")}\r\n`,
    ],
  ]) {
    const signatureResult = runSigner(signature);
    assert.equal(signatureResult.status, 0, `${name}: ${signatureResult.stderr}`);
    assert.equal(signatureResult.stdout.trim(), trustedIdentity, name);
  }
  for (const [name, signature] of [
    ["empty input", ""],
    [
      "other publisher",
      signatureFor("Developer ID Installer: Other Publisher (BMM5U3QVKW)"),
    ],
    [
      "short team ID",
      signatureFor(
        "Developer ID Installer: Python Software Foundation (SHORT1234)"
      ),
    ],
    [
      "lowercase team ID",
      signatureFor(
        "Developer ID Installer: Python Software Foundation (bmm5u3qvkw)"
      ),
    ],
    ["same-line prefix", `prefix 1. ${trustedIdentity}`],
    ["same-line suffix", `1. ${trustedIdentity} suffix`],
    ["wrong chain position", `2. ${trustedIdentity}`],
  ]) {
    const signatureResult = runSigner(signature);
    assert.notEqual(signatureResult.status, 0, `unexpectedly trusted ${name}`);
  }
  const oldResult = spawnSync(
    bash,
    ["-lc", `${source}; python_version_supported ${bashQuote(toBashPath(oldPython))}`],
    { encoding: "utf-8" }
  );
  assert.notEqual(oldResult.status, 0);

  const supportedResult = spawnSync(
    bash,
    ["-lc", `${source}; python_version_supported ${bashQuote(toBashPath(supportedPython))}`],
    { encoding: "utf-8" }
  );
  assert.equal(supportedResult.status, 0, supportedResult.stderr);

  const frameworkResult = spawnSync(
    bash,
    [
      "-lc",
      `${source}; python_path_is_admin_trusted() { return 1; }; ` +
        `PYTHON_BOOTSTRAP_EXECUTABLE=''; ` +
        `PYTHON_FRAMEWORK_BIN=${bashQuote(toBashPath(frameworkBin))}; ` +
        "resolve_supported_python",
    ],
    { encoding: "utf-8" }
  );
  assert.equal(frameworkResult.status, 0, frameworkResult.stderr);
  assert.equal(frameworkResult.stdout.trim(), toBashPath(frameworkPython));

  const untrustedResult = spawnSync(
    bash,
    [
      "-lc",
      `${source}; python_path_is_admin_trusted() { return 1; }; ` +
        `PYTHON_BOOTSTRAP_EXECUTABLE=${bashQuote(toBashPath(untrustedPython))}; ` +
        `PYTHON_FRAMEWORK_BIN=${bashQuote(toBashPath(frameworkBin))}; ` +
        "resolve_supported_python",
    ],
    { encoding: "utf-8" }
  );
  assert.equal(untrustedResult.status, 0, untrustedResult.stderr);
  assert.equal(untrustedResult.stdout.trim(), toBashPath(frameworkPython));
  assert.equal(
    fs.existsSync(untrustedMarker),
    false,
    "an untrusted interpreter must not execute while sudo authorization is active"
  );

  const trustedResult = spawnSync(
    bash,
    [
      "-lc",
      `${source}; python_path_is_admin_trusted() { printf '%s\\n' "$1"; }; ` +
        `PYTHON_BOOTSTRAP_EXECUTABLE=${bashQuote(toBashPath(supportedPython))}; ` +
        "resolve_supported_python",
    ],
    { encoding: "utf-8" }
  );
  assert.equal(trustedResult.status, 0, trustedResult.stderr);
  assert.equal(trustedResult.stdout.trim(), toBashPath(supportedPython));

  const ensureResult = spawnSync(
    bash,
    [
      "-lc",
      `${source}; resolve_supported_python() { printf '%s\\n' ` +
        `${bashQuote(toBashPath(supportedPython))}; }; ` +
        `ensure_python >/dev/null; printf '%s' "$PYTHON_BOOTSTRAP_EXECUTABLE"`,
    ],
    { encoding: "utf-8" }
  );
  assert.equal(ensureResult.status, 0, ensureResult.stderr);
  assert.equal(ensureResult.stdout, toBashPath(supportedPython));
} finally {
  if (fs.existsSync(oldPython)) fs.unlinkSync(oldPython);
  if (fs.existsSync(supportedPython)) fs.unlinkSync(supportedPython);
  if (fs.existsSync(untrustedPython)) fs.unlinkSync(untrustedPython);
  if (fs.existsSync(untrustedMarker)) fs.unlinkSync(untrustedMarker);
  if (fs.existsSync(frameworkPython)) fs.unlinkSync(frameworkPython);
  if (fs.existsSync(frameworkBin)) fs.rmdirSync(frameworkBin);
  fs.rmdirSync(tempDir);
}

console.log("python bootstrap contract: ok");
