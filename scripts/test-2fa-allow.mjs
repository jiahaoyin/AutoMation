#!/usr/bin/env node

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  probe2FAState,
  tryAllowOnce,
  waitForManualAllow,
} from "./lib/mac-2fa-allow.js";
import * as allowModule from "./lib/mac-2fa-allow.js";
import * as ocrModule from "./lib/mac-2fa-ocr.js";
import * as popupModule from "./lib/mac-2fa-popup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testSource = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
const allowSource = fs.readFileSync(
  path.join(__dirname, "lib", "mac-2fa-allow.js"),
  "utf8"
);
const swiftSource = fs.readFileSync(
  path.join(__dirname, "swift", "mac-2fa-click-allow.swift"),
  "utf8"
);
const popupSource = fs.readFileSync(
  path.join(__dirname, "lib", "mac-2fa-popup.js"),
  "utf8"
);
const ocrSource = fs.readFileSync(
  path.join(__dirname, "lib", "mac-2fa-ocr.js"),
  "utf8"
);
const popupReadSwiftSource = fs.readFileSync(
  path.join(__dirname, "swift", "mac-2fa-popup-read.swift"),
  "utf8"
);
const popupOcrSwiftSource = fs.readFileSync(
  path.join(__dirname, "swift", "mac-2fa-popup-ocr.swift"),
  "utf8"
);
const sidecarSource = fs.readFileSync(
  path.join(__dirname, "lib", "two-fa-sidecar.js"),
  "utf8"
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
);
const installSource = fs.readFileSync(
  path.join(__dirname, "..", "install.sh"),
  "utf8"
);

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function swiftFunctionBody(name) {
  const start = swiftSource.indexOf(`func ${name}`);
  assert.notEqual(start, -1, `missing Swift function ${name}`);
  const next = swiftSource.indexOf("\nfunc ", start + 5);
  return swiftSource.slice(start, next === -1 ? swiftSource.length : next);
}

function sourceFunctionBody(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `missing source function ${declaration}`);
  const next = source.indexOf("\nfunc ", start + declaration.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function assertAtomicHelperCompilation(module, availabilityExport, label) {
  const isAvailable = module[availabilityExport];
  assert.equal(typeof isAvailable, "function", `${label} availability API is required`);

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-helper-"));
  const sourcePath = path.join(fixtureDir, `${label}.swift`);
  const binaryPath = path.join(fixtureDir, label);
  const oldTime = new Date(Date.now() - 10_000);
  const newTime = new Date();
  fs.writeFileSync(sourcePath, "// source\n");
  fs.writeFileSync(binaryPath, "old-binary\n", { mode: 0o755 });
  fs.utimesSync(binaryPath, oldTime, oldTime);
  fs.utimesSync(sourcePath, newTime, newTime);

  const compilerCalls = [];
  try {
    const availableAfterFailure = isAvailable({
      platform: "darwin",
      sourcePath,
      binaryPath,
      quiet: true,
      spawnSync(command, args) {
        const outputPath = args[args.indexOf("-o") + 1];
        compilerCalls.push({ command, args: [...args], outputPath });
        fs.writeFileSync(outputPath, "partial-output\n", { mode: 0o755 });
        return { status: 1, stdout: "", stderr: "compile failed" };
      },
    });
    assert.equal(availableAfterFailure, false, `${label} must reject the stale binary`);
    assert.equal(fs.readFileSync(binaryPath, "utf8"), "old-binary\n");
    assert.equal(compilerCalls.length, 1, `${label} must attempt recompilation`);
    assert.equal(compilerCalls[0].command, "/usr/bin/xcrun", `${label} must bypass PATH`);
    assert.equal(compilerCalls[0].args[0], "swiftc", `${label} must ask xcrun for swiftc`);
    assert.notEqual(compilerCalls[0].outputPath, binaryPath, `${label} must compile to a temporary path`);
    assert.equal(fs.existsSync(compilerCalls[0].outputPath), false, `${label} must clean failed output`);

    const availableAfterSuccess = isAvailable({
      platform: "darwin",
      sourcePath,
      binaryPath,
      quiet: true,
      spawnSync(command, args) {
        const outputPath = args[args.indexOf("-o") + 1];
        compilerCalls.push({ command, args: [...args], outputPath });
        fs.writeFileSync(outputPath, "new-binary\n", { mode: 0o755 });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(availableAfterSuccess, true, `${label} should accept the new binary`);
    assert.equal(fs.readFileSync(binaryPath, "utf8"), "new-binary\n");
    assert.equal(compilerCalls[1].command, "/usr/bin/xcrun", `${label} must bypass PATH`);
    assert.equal(compilerCalls[1].args[0], "swiftc", `${label} must ask xcrun for swiftc`);
    assert.notEqual(compilerCalls[1].outputPath, binaryPath, `${label} must replace atomically`);
  } finally {
    for (const entry of fs.readdirSync(fixtureDir)) {
      fs.unlinkSync(path.join(fixtureDir, entry));
    }
    fs.rmdirSync(fixtureDir);
  }
}

function assertMissingSourceRejectsOldBinary(module, availabilityExport, label) {
  const isAvailable = module[availabilityExport];
  assert.equal(typeof isAvailable, "function", `${label} availability API is required`);

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "missing-native-source-"));
  const sourcePath = path.join(fixtureDir, `${label}.swift`);
  const binaryPath = path.join(fixtureDir, label);
  let compilerCalls = 0;
  fs.writeFileSync(binaryPath, "old-binary\n", { mode: 0o755 });
  try {
    const available = isAvailable({
      platform: "darwin",
      sourcePath,
      binaryPath,
      quiet: true,
      spawnSync() {
        compilerCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(available, false, `${label} must fail closed without its Swift source`);
    assert.equal(compilerCalls, 0, `${label} must not invoke a compiler without source`);
    assert.equal(fs.readFileSync(binaryPath, "utf8"), "old-binary\n");
  } finally {
    for (const entry of fs.readdirSync(fixtureDir)) {
      fs.unlinkSync(path.join(fixtureDir, entry));
    }
    fs.rmdirSync(fixtureDir);
  }
}

function assertRejectsNonExecutableCompilerOutput(module, availabilityExport, label) {
  const isAvailable = module[availabilityExport];
  assert.equal(typeof isAvailable, "function", `${label} availability API is required`);

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "non-executable-native-helper-"));
  const sourcePath = path.join(fixtureDir, `${label}.swift`);
  const binaryPath = path.join(fixtureDir, label);
  const oldTime = new Date(Date.now() - 10_000);
  let compilerOutput = null;
  fs.writeFileSync(sourcePath, "// source\n");
  fs.writeFileSync(binaryPath, "old-binary\n", { mode: 0o755 });
  fs.utimesSync(binaryPath, oldTime, oldTime);
  try {
    const available = isAvailable({
      platform: "darwin",
      sourcePath,
      binaryPath,
      quiet: true,
      spawnSync(_command, args) {
        compilerOutput = args[args.indexOf("-o") + 1];
        fs.writeFileSync(compilerOutput, "non-executable-output\n", { mode: 0o644 });
        return { status: 0, stdout: "", stderr: "" };
      },
      accessSync(target, mode) {
        if (target === compilerOutput && mode === fs.constants.X_OK) {
          const error = new Error("compiler product is not executable");
          error.code = "EACCES";
          throw error;
        }
        return fs.accessSync(target, mode);
      },
    });

    assert.equal(available, false, `${label} must reject a 0644 compiler product`);
    assert.equal(fs.readFileSync(binaryPath, "utf8"), "old-binary\n");
    assert.ok(compilerOutput, `${label} compiler output path was not captured`);
    assert.equal(
      fs.existsSync(compilerOutput),
      false,
      `${label} must remove the rejected compiler product`
    );
  } finally {
    for (const entry of fs.readdirSync(fixtureDir)) {
      fs.unlinkSync(path.join(fixtureDir, entry));
    }
    fs.rmdirSync(fixtureDir);
  }
}

function assertOcrRejectsNonExecutableCompilerOutput() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-non-executable-"));
  const sourcePath = path.join(fixtureDir, "mac-2fa-popup-ocr.swift");
  const binaryPath = path.join(fixtureDir, "mac-2fa-popup-ocr");
  const oldTime = new Date(Date.now() - 10_000);
  let compilerOutput = null;
  fs.writeFileSync(sourcePath, "// source\n");
  fs.writeFileSync(binaryPath, "old-binary\n", { mode: 0o755 });
  fs.utimesSync(binaryPath, oldTime, oldTime);
  try {
    const available = ocrModule.is2FAOcrHelperAvailable({
      platform: "darwin",
      sourcePath,
      binaryPath,
      quiet: true,
      spawnSync(_command, args) {
        compilerOutput = args[args.indexOf("-o") + 1];
        fs.writeFileSync(compilerOutput, "non-executable-output\n", { mode: 0o755 });
        return { status: 0, stdout: "", stderr: "" };
      },
      accessSync(target, mode) {
        if (target === compilerOutput) {
          const error = new Error("not executable");
          error.code = "EACCES";
          throw error;
        }
        return fs.accessSync(target, mode);
      },
    });
    assert.equal(available, false, "OCR must reject a non-executable compiler product");
    assert.equal(fs.readFileSync(binaryPath, "utf8"), "old-binary\n");
    assert.equal(fs.existsSync(compilerOutput), false, "rejected OCR output must be removed");
  } finally {
    for (const entry of fs.readdirSync(fixtureDir)) {
      fs.unlinkSync(path.join(fixtureDir, entry));
    }
    fs.rmdirSync(fixtureDir);
  }
}

test("tryAllowOnce runs exactly one raw strategy without probing", async () => {
  const calls = [];
  let releases = 0;
  let probes = 0;
  const runtime = {
    strategies: [
      async () => {
        calls.push("first");
        return { action: "none", strategy: "first" };
      },
      async () => {
        calls.push("second");
        return {
          action: "attempted_allow",
          source: "FollowUpUI",
          strategy: "second",
        };
      },
    ],
    async probe2FAState() {
      probes += 1;
      return { action: "has_code_dialog" };
    },
    async releaseMouseButtons() {
      releases += 1;
    },
    async sleep() {},
  };

  const result = await tryAllowOnce(1, { strategyOffset: 1, runtime });

  assert.deepEqual(calls, ["second"]);
  assert.equal(probes, 0, "the collector owns confirmation probes");
  assert.equal(releases, 1);
  assert.deepEqual(result, {
    attempted: true,
    source: "FollowUpUI",
    strategy: "second",
  });
});

test("tryAllowOnce releases mouse buttons when the raw strategy throws", async () => {
  const helperCalls = [];
  const runtime = {
    strategies: [
      async () => {
        throw new Error("raw strategy failed");
      },
    ],
    ensureBin() {
      return true;
    },
    async execFileAsync(command, args, options) {
      helperCalls.push({ command, args, options });
      return { stdout: '{"ok":true,"action":"released_left_button"}\n' };
    },
  };

  await assert.rejects(
    tryAllowOnce(1, { runtime }),
    /raw strategy failed/
  );
  assert.equal(helperCalls.length, 1);
  assert.deepEqual(helperCalls[0].args, ["--release-left-button"]);
  assert.ok(helperCalls[0].options.timeout <= 3_000, "release helper must be bounded");
});

test("tryAllowOnce does not rotate after a non-attempt", async () => {
  const calls = [];
  let releases = 0;
  const runtime = {
    strategies: [
      async () => {
        calls.push("first");
        return { action: "none", strategy: "first" };
      },
      async () => {
        calls.push("second");
        return { action: "attempted_allow", strategy: "second" };
      },
    ],
    async releaseMouseButtons() {
      releases += 1;
    },
  };

  const result = await tryAllowOnce(1, { runtime });

  assert.deepEqual(calls, ["first"]);
  assert.equal(releases, 1);
  assert.deepEqual(result, {
    attempted: false,
    source: undefined,
    strategy: "first",
  });
});

test("the default automatic path contains only constrained atomic Swift", () => {
  const runtimeBody = allowSource.slice(
    allowSource.indexOf("function resolveAllowRuntime"),
    allowSource.indexOf("async function probeWithinDeadline")
  );
  const defaultStrategies = runtimeBody.match(
    /strategies:\s*overrides\.strategies\s*\?\?\s*\[([\s\S]*?)\]/
  )?.[1] ?? "";

  assert.match(defaultStrategies, /tryCgClickAllow/);
  assert.doesNotMatch(
    defaultStrategies,
    /tryReturnKeyAllow|tryAppleScriptAllow|tryCliclickAllow/
  );
  assert.match(
    runtimeBody,
    /releaseMouseButtons:\s*overrides\.releaseMouseButtons\s*\?\?[\s\S]*releaseLeftMouseButton/
  );
  assert.doesNotMatch(runtimeBody, /noOpReleaseMouseButtons/);

  const release = swiftFunctionBody("releaseLeftMouseButton");
  const argumentDispatch = swiftSource.slice(
    swiftSource.indexOf("var timeoutSec"),
    swiftSource.indexOf("let deadline")
  );
  assert.match(release, /\.leftMouseUp/);
  assert.match(release, /\.post\(/);
  assert.doesNotMatch(release, /\.leftMouseDown|NSWorkspace|AXUIElement/);
  assert.match(argumentDispatch, /--release-left-button/);
  assert.match(
    argumentDispatch,
    /if releaseLeftButtonOnly[\s\S]*releaseLeftMouseButton\(\)[\s\S]*emit\(/
  );
});

test("Allow helper rejects a stale binary when recompilation fails", () => {
  assertAtomicHelperCompilation(
    allowModule,
    "is2FAAllowHelperAvailable",
    "mac-2fa-click-allow"
  );
});

test("Allow helper rejects an old binary when its Swift source is missing", () => {
  assertMissingSourceRejectsOldBinary(
    allowModule,
    "is2FAAllowHelperAvailable",
    "mac-2fa-click-allow"
  );
});

test("Allow helper rejects and removes a 0644 compiler product", () => {
  assertRejectsNonExecutableCompilerOutput(
    allowModule,
    "is2FAAllowHelperAvailable",
    "mac-2fa-click-allow"
  );
});

test("popup helper rejects a stale binary when recompilation fails", () => {
  assertAtomicHelperCompilation(
    popupModule,
    "is2FAPopupHelperAvailable",
    "mac-2fa-popup-read"
  );
});

test("popup helper rejects an old binary when its Swift source is missing", () => {
  assertMissingSourceRejectsOldBinary(
    popupModule,
    "is2FAPopupHelperAvailable",
    "mac-2fa-popup-read"
  );
});

test("popup helper rejects and removes a 0644 compiler product", () => {
  assertRejectsNonExecutableCompilerOutput(
    popupModule,
    "is2FAPopupHelperAvailable",
    "mac-2fa-popup-read"
  );
});

test("Allow and popup validate untouched compiler products before replacement", () => {
  for (const [source, label] of [
    [allowSource, "Allow"],
    [popupSource, "popup"],
  ]) {
    const executableCheck = source.slice(
      source.indexOf("function binaryIsExecutable"),
      source.indexOf("\nfunction compileSwift")
    );
    const compileBody = source.slice(
      source.indexOf("function compileSwift"),
      source.indexOf("\nfunction ensureBin")
    );
    const validate = compileBody.indexOf("binaryIsExecutable(temporaryBin, options)");
    const replace = compileBody.indexOf("renameSync(temporaryBin");

    assert.match(executableCheck, /\.isFile\(\)/, `${label} must require a regular file`);
    assert.match(executableCheck, /fs\.constants\.X_OK/, `${label} must require X_OK`);
    assert.doesNotMatch(compileBody, /chmodSync/, `${label} must not repair compiler modes`);
    assert.ok(
      validate >= 0 && replace > validate,
      `${label} must validate the untouched compiler product before replacement`
    );
  }
});

test("OCR helper rejects a stale binary and cleans failed compiler output", () => {
  assertAtomicHelperCompilation(
    ocrModule,
    "is2FAOcrHelperAvailable",
    "mac-2fa-popup-ocr"
  );
});

test("OCR helper rejects an old binary when its Swift source is missing", () => {
  assertMissingSourceRejectsOldBinary(
    ocrModule,
    "is2FAOcrHelperAvailable",
    "mac-2fa-popup-ocr"
  );
});

test("OCR helper rejects and removes a non-executable compiler product", () => {
  assertOcrRejectsNonExecutableCompilerOutput();
});

test("manual wait carries confirmed Allow history without accepting a stale code", async () => {
  const makeRuntime = () => {
    let now = 0;
    return {
      now: () => now,
      async probe2FAState() {
        return { action: "has_code_dialog", source: "FollowUpUI" };
      },
      async sleep(ms) {
        now += ms;
      },
      setTimer() {
        return 1;
      },
      clearTimer() {},
    };
  };

  const stale = await waitForManualAllow({
    timeoutMs: 10,
    runtime: makeRuntime(),
  });
  assert.deepEqual(stale, { clicked: false });

  const raced = await waitForManualAllow({
    timeoutMs: 10,
    initialSawAllowDialog: true,
    runtime: makeRuntime(),
  });
  assert.deepEqual(raced, {
    clicked: true,
    source: "FollowUpUI",
    strategy: "manual",
  });
});

test("the normal JavaScript wrapper exposes no confirmClick bypass", () => {
  assert.doesNotMatch(allowSource, /confirmClick/);
});

test("native probe failures stay distinct from a confirmed idle state", () => {
  assert.match(allowSource, /return \{ action: "probe_error" \}/);
});

test("Allow diagnostics never interpolate verification codes or OCR raw text", () => {
  const consoleLines = allowSource
    .split(/\r?\n/)
    .filter((line) => /console\.(?:log|warn)/.test(line));

  for (const line of consoleLines) {
    assert.doesNotMatch(line, /\$\{[^}]*(?:code|raw|old)[^}]*\}/i);
  }
});

test("the Swift helper reports only a raw attempted action", () => {
  assert.match(swiftSource, /"attempted_allow"/);
  assert.doesNotMatch(swiftSource, /"clicked_allow"/);
});

test("Swift coordinate probing is absolutely read-only", () => {
  const probe = swiftFunctionBody("probeAllowCoordinates");
  const mainLoop = swiftSource.slice(swiftSource.indexOf("let deadline"));

  assert.match(probe, /findAllowTarget/);
  assert.match(probe, /frameOf/);
  assert.doesNotMatch(
    probe,
    /AXUIElementPerformAction|CGEvent|clickScreenPoint|pressButton|activate\(|raiseWindow|postReturnKey/
  );
  assert.match(
    mainLoop,
    /if probeCoordsOnly[\s\S]*probeAllowCoordinates[\s\S]*continue[\s\S]*tryClickAllowInApp/
  );
});

test("the Swift target is an actual positive Allow AXButton", () => {
  const predicate = swiftFunctionBody("isPositiveAllowButton");
  const finder = swiftFunctionBody("findAllowButton");

  assert.match(predicate, /kAXButtonRole/);
  assert.match(predicate, /"允许"/);
  assert.match(predicate, /"Allow"|lowercased/);
  assert.match(predicate, /"不允许"/);
  assert.match(predicate, /don't/);
  assert.match(finder, /isPositiveAllowButton/);
  assert.doesNotMatch(finder, /return buttons\.last/);
});

test("the Swift helper finds its target before activating the app", () => {
  const body = swiftFunctionBody("tryClickAllowInApp");
  const findTarget = body.indexOf("findAllowTarget");
  const activate = body.indexOf(".activate(");
  const refreshedTarget = body.indexOf("findAllowTarget", findTarget + 1);

  assert.notEqual(findTarget, -1);
  assert.notEqual(activate, -1);
  assert.ok(findTarget < activate, "target discovery must precede activation");
  assert.ok(
    refreshedTarget > activate,
    "the target must be rediscovered after activation before it is used"
  );
  assert.doesNotMatch(body, /guard looksLikeAllowDialog/);
});

test("the Swift helper never scans arbitrary regular applications", () => {
  const candidate = swiftFunctionBody("candidateKind");
  const systemPath = swiftFunctionBody("isAppleSystemExecutable");
  const mainLoop = swiftSource.slice(swiftSource.indexOf("let deadline"));

  assert.match(swiftSource, /CoreAuthentication/);
  assert.doesNotMatch(candidate, /localizedName/);
  assert.match(candidate, /executableURL/);
  assert.match(candidate, /lastPathComponent/);
  assert.match(candidate, /bundleIdentifier/);
  assert.match(candidate, /isAppleSystemExecutable/);
  assert.match(systemPath, /\/System\//);
  assert.match(systemPath, /\/usr\/libexec\//);
  assert.match(mainLoop, /guard candidateKind\(for: app\) != nil else/);
  assert.doesNotMatch(mainLoop, /activationPolicy != \.regular/);
});

test("the Swift popup probe uses the same executable identity boundary", () => {
  const candidate = sourceFunctionBody(
    popupReadSwiftSource,
    "func candidateKind"
  );

  assert.match(candidate, /executableURL/);
  assert.match(candidate, /lastPathComponent/);
  assert.match(candidate, /bundleIdentifier/);
  assert.doesNotMatch(candidate, /localizedName/);
  assert.match(popupReadSwiftSource, /CoreAuthentication/);
});

test("shared Swift hosts require Apple login evidence", () => {
  const finder = swiftFunctionBody("findAllowTarget");

  assert.match(finder, /candidateKind\(for: app\)/);
  assert.match(finder, /case \.sharedHost/);
  assert.match(finder, /looksLikeAppleLoginDialog\(blob\)/);
});

test("shared-host Chinese Apple login evidence allows intervening text", () => {
  const predicate = swiftFunctionBody("looksLikeAppleLoginDialog");

  assert.match(predicate, /contains\("正用于"\).*contains\("登录"\)/s);
  assert.match(predicate, /contains\("正被用于"\).*contains\("登录"\)/s);
  assert.match(predicate, /contains\("正用於"\).*contains\("登入"\)/s);
  assert.match(predicate, /contains\("正被用於"\).*contains\("登入"\)/s);
});

test("SecurityAgent and akd are shared hosts, not dedicated auth apps", () => {
  const dedicatedBlock = swiftSource.slice(
    swiftSource.indexOf("let dedicatedAuthExecutables"),
    swiftSource.indexOf("let sharedHostExecutables")
  );
  const sharedBlock = swiftSource.slice(
    swiftSource.indexOf("let sharedHostExecutables"),
    swiftSource.indexOf("enum CandidateKind")
  );

  assert.doesNotMatch(dedicatedBlock, /SecurityAgent|akd/);
  assert.match(sharedBlock, /SecurityAgent/);
  assert.match(sharedBlock, /akd/);
});

test("shared hosts require explicit Apple account evidence for every code operation", () => {
  const sources = [popupReadSwiftSource, popupOcrSwiftSource];
  const predicates = sources.map((source) => ({
    evidence: sourceFunctionBody(
      source,
      "func hasExplicitAppleAccountEvidence"
    ),
    eligible: sourceFunctionBody(source, "func isEligibleCodeWindow"),
  }));

  for (const { evidence, eligible } of predicates) {
    for (const marker of [
      "apple id",
      "apple account",
      "apple账户",
      "apple 账户",
      "apple帐户",
      "apple 帐户",
      "apple帳戶",
      "apple 帳戶",
    ]) {
      assert.ok(
        evidence.toLowerCase().includes(marker),
        `missing explicit Apple account marker ${marker}`
      );
    }
    assert.doesNotMatch(
      evidence,
      /verification code|验证码|驗證碼/i,
      "a generic code prompt is not Apple account evidence"
    );
    assert.match(
      eligible,
      /case \.dedicated:[\s\S]*return hasCodePrompt \|\| hasCodeDisplay/
    );
    assert.match(
      eligible,
      /case \.sharedHost:[\s\S]*return hasCodePrompt && hasExplicitAppleAccountEvidence\(blob\)/
    );
  }

  assert.equal(
    predicates[0].eligible.replace(/\s+/g, " ").trim(),
    predicates[1].eligible.replace(/\s+/g, " ").trim(),
    "AX and OCR helpers must use the same shared-host eligibility predicate"
  );

  for (const name of [
    "func tryReadCode",
    "func tryDismissStale",
    "func tryDismissDone",
    "func probeState",
  ]) {
    const body = sourceFunctionBody(popupReadSwiftSource, name);
    assert.match(body, /isEligibleCodeWindow\(/, `${name} bypasses eligibility`);
    assert.match(body, /kind: item\.candidateKind/);
    assert.match(body, /blob: item\.scan\.blob/);
  }

  const finder = sourceFunctionBody(
    popupOcrSwiftSource,
    "func findCodeDialogs"
  );
  const identity = finder.indexOf("guard let kind = candidateKind(for: app)");
  const eligibility = finder.indexOf("isEligibleCodeWindow(");
  const windowID = finder.indexOf("windowIDFor(win)");
  assert.ok(identity >= 0, "OCR must retain the candidate kind");
  assert.ok(eligibility > identity, "OCR eligibility must follow process identity");
  assert.ok(windowID > eligibility, "OCR must reject the window before reading its ID");
  assert.match(finder, /kind: kind/);
  assert.match(finder, /blob: blob/);
  assert.match(finder, /hasCodePrompt: hasCodePrompt/);
});

test("the Swift title predicate covers English and both Chinese scripts", () => {
  const predicate = swiftFunctionBody("isPositiveAllowButton");

  for (const title of [
    '"Allow"',
    '"Don\'t Allow"',
    '"Do Not Allow"',
    '"允许"',
    '"不允许"',
    '"允許"',
    '"不允許"',
  ]) {
    assert.ok(predicate.includes(title), `missing title contract ${title}`);
  }
});

test("the Swift probe recognizes tri-lingual positive and negative Allow titles", () => {
  const popupPredicate = sourceFunctionBody(
    popupReadSwiftSource,
    "func isPositiveAllowTitle"
  );
  const expectedTitles = [
    "Allow",
    "Don't Allow",
    "Do Not Allow",
    "允许",
    "不允许",
    "允許",
    "不允許",
  ];

  for (const title of expectedTitles) {
    assert.ok(popupPredicate.includes(title), `Swift probe missing ${title}`);
  }
  assert.match(popupReadSwiftSource, /isPositiveAllowTitle\(title\)/);
});

test("zh-Hant verification prompts reach popup state and OCR targeting", () => {
  const popupPrompt = sourceFunctionBody(
    popupReadSwiftSource,
    "func hasCodeDisplayPrompt"
  );
  const scanWindow = sourceFunctionBody(popupReadSwiftSource, "func scanWindow");
  const readCode = sourceFunctionBody(popupReadSwiftSource, "func tryReadCode");
  const probeState = sourceFunctionBody(popupReadSwiftSource, "func probeState");
  const ocrPrompt = sourceFunctionBody(
    popupOcrSwiftSource,
    "func looksLikeCodeDialog"
  );
  const findOcrTargets = sourceFunctionBody(
    popupOcrSwiftSource,
    "func findCodeDialogs"
  );

  for (const prompt of [
    "在網頁上輸入此驗證碼",
    "在網頁上輸入",
    "驗證碼",
    "輸入此驗證碼",
    "驗證碼以登入",
  ]) {
    assert.ok(popupPrompt.includes(prompt), `popup read missing zh-Hant prompt ${prompt}`);
  }
  assert.match(
    scanWindow,
    /scan\.hasCodePrompt\s*=\s*hasCodeDisplayPrompt\(scan\.blob\)/
  );
  assert.match(
    readCode,
    /isEligibleCodeWindow\([\s\S]*hasCodePrompt: item\.scan\.hasCodePrompt/
  );
  assert.match(
    probeState,
    /isEligibleCodeWindow\([\s\S]*hasCodePrompt: item\.scan\.hasCodePrompt[\s\S]*"has_code_dialog"/
  );

  for (const prompt of [
    "在網頁上輸入此驗證碼",
    "在網頁上輸入",
    "驗證碼",
    "驗證碼以登入",
  ]) {
    assert.ok(ocrPrompt.includes(prompt), `popup OCR missing zh-Hant prompt ${prompt}`);
  }
  assert.match(
    findOcrTargets,
    /let hasCodePrompt = looksLikeCodeDialog\(blob\)[\s\S]*isEligibleCodeWindow\([\s\S]*hasCodePrompt: hasCodePrompt[\s\S]*windowIDFor\(win\)/
  );
});

test("zh-Hant code reading and completion cleanup share one state chain", () => {
  const doneTitle = sourceFunctionBody(popupReadSwiftSource, "func isDoneTitle");
  const collector = sourceFunctionBody(popupReadSwiftSource, "func walkCollect");
  const clickDone = sourceFunctionBody(popupReadSwiftSource, "func clickDone");
  const scanWindow = sourceFunctionBody(popupReadSwiftSource, "func scanWindow");
  const readCode = sourceFunctionBody(popupReadSwiftSource, "func tryReadCode");
  const probeState = sourceFunctionBody(popupReadSwiftSource, "func probeState");
  const dismissStale = sourceFunctionBody(popupReadSwiftSource, "func tryDismissStale");
  const dismissDone = sourceFunctionBody(popupReadSwiftSource, "func tryDismissDone");

  for (const title of ["完成", "Done", "OK", "好"]) {
    assert.ok(doneTitle.includes(title), `popup completion predicate missing title ${title}`);
  }
  assert.match(collector, /isDoneTitle\(title\)/);
  assert.match(clickDone, /isDoneTitle\(\$0\)/);
  assert.match(
    scanWindow,
    /scan\.hasCodePrompt\s*=\s*hasCodeDisplayPrompt\(scan\.blob\)/
  );
  assert.match(
    readCode,
    /isEligibleCodeWindow\([\s\S]*hasCodePrompt: item\.scan\.hasCodePrompt,[\s\S]*hasCodeDisplay: item\.scan\.code != nil[\s\S]*looksLikeCodeDisplay\(raw\)/
  );
  assert.match(
    probeState,
    /isEligibleCodeWindow\([\s\S]*hasCodePrompt: item\.scan\.hasCodePrompt,[\s\S]*hasCodeDisplay: item\.scan\.code != nil[\s\S]*"has_code_dialog"/
  );
  for (const [body, label] of [
    [dismissStale, "dismiss stale"],
    [dismissDone, "dismiss done"],
  ]) {
    assert.match(body, /isEligibleCodeWindow\(/);
    assert.match(body, /hasCodePrompt: item\.scan\.hasCodePrompt/);
    assert.match(body, /hasCodeDisplay: item\.scan\.code != nil/);
    assert.match(body, /clickDone\(item\.window\)/, `${label} must use clickDone`);
  }

  const readPhase = popupReadSwiftSource.slice(
    popupReadSwiftSource.indexOf("if phase == .readCode"),
    popupReadSwiftSource.indexOf("if phase == .probe")
  );
  const donePhase = popupReadSwiftSource.slice(
    popupReadSwiftSource.indexOf("if phase == .dismissDone"),
    popupReadSwiftSource.indexOf("if phase == .dismissStale")
  );
  assert.match(readPhase, /tryReadCode\(windows\)[\s\S]*action: "read_code"/);
  assert.match(donePhase, /tryDismissDone\(windows\)[\s\S]*action: "dismissed_done"/);

  const sidecarRead = sidecarSource.indexOf("runtime.readPopupCode(4");
  const sidecarClose = sidecarSource.indexOf(
    "runtime.dismissCodePopupForWebFill(4)",
    sidecarRead
  );
  const sidecarBuffer = sidecarSource.indexOf("popupCandidate =", sidecarClose);
  assert.ok(
    sidecarRead >= 0 && sidecarClose > sidecarRead && sidecarBuffer > sidecarClose,
    "popup code must be read, closed, and only then buffered"
  );
});

test("legacy automatic Allow entrypoints are removed", () => {
  assert.doesNotMatch(allowSource, /shouldDismissCodeBeforeAllow/);
  assert.doesNotMatch(
    allowSource,
    /cliclick|tryReturnKeyAllow|tryAppleScriptAllow|tryCliclickAllow|allow_return|pre_allow/
  );
  assert.doesNotMatch(
    popupSource,
    /waitForAllowClick|runClickAllowCg|CLICK_ALLOW_(?:SRC|BIN)|allow_return|pre_allow/
  );
  assert.doesNotMatch(
    popupReadSwiftSource,
    /case preAllow|case all = "all"|tryClickAllow|clickAllow\(|clickRightmostButton|clicked_allow/
  );
  assert.match(popupReadSwiftSource, /func probeState/);
  assert.match(popupReadSwiftSource, /func clickDone/);
});

test("Swift popup defaults to a read-only phase and has no implicit all phase", () => {
  assert.match(popupReadSwiftSource, /var phase = Phase\.(?:probe|readCode)/);
  assert.match(
    popupReadSwiftSource,
    /Phase\(rawValue: args\[i \+ 1\]\) \?\? \.(?:probe|readCode)/
  );
  assert.doesNotMatch(popupReadSwiftSource, /case preAllow/);
  assert.doesNotMatch(popupReadSwiftSource, /case all = "all"/);
  assert.doesNotMatch(popupReadSwiftSource, /phase == \.all/);
  assert.doesNotMatch(popupReadSwiftSource, /\?\? \.all/);
});

test("install has no cliclick guidance", () => {
  assert.doesNotMatch(installSource, /cliclick/);
  assert.match(installSource, /mac-2fa-click-allow/);
});

test("popup and OCR helpers expose only fixed diagnostics", () => {
  for (const [label, source] of [
    ["popup JS", popupSource],
    ["OCR JS", ocrSource],
    ["popup Swift", popupReadSwiftSource],
    ["OCR Swift", popupOcrSwiftSource],
  ]) {
    const diagnosticLines = source
      .split(/\r?\n/)
      .filter((line) => /console\.(?:log|warn)|logStep\(/.test(line));
    for (const line of diagnosticLines) {
      assert.doesNotMatch(
        line,
        /stderr|\\\((?:code|raw|fullText|cropText)|\$\{[^}]*(?:code|raw|stderr)/i,
        `${label} forwards sensitive diagnostics: ${line.trim()}`
      );
    }
  }

  assert.doesNotMatch(popupSource, /raw:\s*r\.raw|raw:\s*parsed\.raw/);
  assert.doesNotMatch(ocrSource, /return\s*\{\s*code,\s*raw/);
  assert.doesNotMatch(popupOcrSwiftSource, /let raw: String\?/);
});

test("OCR accepts only an exact six-digit helper code", () => {
  assert.equal(typeof ocrModule.parseOcrResult, "function");
  assert.deepEqual(
    ocrModule.parseOcrResult('{"ok":true,"code":"012345","source":"vision"}'),
    { code: "012345", source: "vision" }
  );
  assert.equal(ocrModule.parseOcrResult('{"ok":true,"code":"012 345"}'), null);
  assert.equal(ocrModule.parseOcrResult('{"ok":true,"code":"0123456"}'), null);
  assert.equal(ocrModule.parseOcrResult('{"ok":true,"raw":"012 345"}'), null);
  assert.doesNotMatch(ocrSource, /requireFormattedRaw|parsed\.raw/);
  assert.doesNotMatch(allowSource, /requireFormattedRaw/);
});

test("OCR screen-capture preflight exposes only fixed capability states", async () => {
  assert.equal(typeof ocrModule.parseOcrCapability, "function");
  assert.equal(typeof ocrModule.get2FAOcrCapability, "function");
  assert.equal(
    ocrModule.parseOcrCapability(
      '{"ok":true,"capability":"available","message":"preflight"}'
    ),
    "available"
  );
  assert.equal(
    ocrModule.parseOcrCapability(
      '{"ok":true,"capability":"permission_missing","message":"preflight"}'
    ),
    "permission_missing"
  );
  assert.equal(
    ocrModule.parseOcrCapability(
      '{"ok":true,"capability":"unexpected","message":"preflight"}'
    ),
    "unavailable"
  );
  assert.equal(ocrModule.parseOcrCapability("not-json"), "unavailable");

  const calls = [];
  const capability = await ocrModule.get2FAOcrCapability({
    isHelperAvailable: () => true,
    async execFileAsync(_binary, args) {
      calls.push([...args]);
      return {
        stdout:
          '{"ok":true,"capability":"available","message":"preflight"}\n',
        stderr: "",
      };
    },
  });
  assert.equal(capability, "available");
  assert.deepEqual(calls, [["--preflight-screen-capture"]]);
});

test("OCR permission denial is cached and never spawns capture attempts", async () => {
  const calls = [];
  const capabilityCache = {};
  const options = {
    capabilityCache,
    isHelperAvailable: () => true,
    async execFileAsync(_binary, args) {
      calls.push([...args]);
      assert.deepEqual(args, ["--preflight-screen-capture"]);
      return {
        stdout:
          '{"ok":true,"capability":"permission_missing","message":"preflight"}\n',
        stderr: "",
      };
    },
  };

  const first = await ocrModule.readPopupCodeViaOcr(4, options);
  const second = await ocrModule.readPopupCodeViaOcr(4, options);

  assert.deepEqual(first, {
    code: null,
    source: "vision",
    capability: "permission_missing",
  });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1, "permission denial must suppress later helper spawns");
});

test("OCR reports fixed unavailable capability without spawning a missing helper", async () => {
  let spawns = 0;
  const capability = await ocrModule.get2FAOcrCapability({
    isHelperAvailable: () => false,
    async execFileAsync() {
      spawns += 1;
      throw new Error("must not spawn");
    },
  });

  assert.equal(capability, "unavailable");
  assert.equal(spawns, 0);
});

test("OCR permission availability preflights before one constrained read", async () => {
  const calls = [];
  const result = await ocrModule.readPopupCodeViaOcr(4, {
    capabilityCache: {},
    isHelperAvailable: () => true,
    async execFileAsync(_binary, args) {
      calls.push([...args]);
      if (args[0] === "--preflight-screen-capture") {
        return {
          stdout:
            '{"ok":true,"capability":"available","message":"preflight"}\n',
          stderr: "",
        };
      }
      return {
        stdout: '{"ok":true,"code":"012345","source":"vision","message":"ok"}\n',
        stderr: "",
      };
    },
  });

  assert.deepEqual(result, { code: "012345", source: "vision" });
  assert.deepEqual(calls, [
    ["--preflight-screen-capture"],
    ["--timeout", "4"],
  ]);
});

test("popup code acquisition is AX-first even when legacy callers prefer OCR", async () => {
  const calls = [];
  const result = await allowModule.readPopupCode(8, {
    preferOcr: true,
    runtime: {
      async readPopupCodeViaSwift(timeoutSec) {
        calls.push(["ax", timeoutSec]);
        return { code: "123456", source: "swift_ax" };
      },
      async readPopupCodeViaOcr(timeoutSec) {
        calls.push(["ocr", timeoutSec]);
        return { code: "654321", source: "vision" };
      },
    },
  });

  assert.deepEqual(result, { code: "123456", source: "swift_ax" });
  assert.deepEqual(calls, [["ax", 2]]);
});

test("popup code acquisition falls back to OCR only after AX has no legal code", async () => {
  const calls = [];
  const result = await allowModule.readPopupCode(8, {
    runtime: {
      async readPopupCodeViaSwift(timeoutSec) {
        calls.push(["ax", timeoutSec]);
        return { code: "123 456", source: "swift_ax" };
      },
      async readPopupCodeViaOcr(timeoutSec) {
        calls.push(["ocr", timeoutSec]);
        return { code: "654321", source: "vision" };
      },
    },
  });

  assert.deepEqual(result, { code: "654321", source: "vision" });
  assert.deepEqual(calls, [
    ["ax", 2],
    ["ocr", 6],
  ]);
});

test("popup code acquisition returns fixed OCR unavailability for status", async () => {
  const unavailable = {
    code: null,
    source: "vision",
    capability: "permission_missing",
  };
  const result = await allowModule.readPopupCode(4, {
    runtime: {
      async readPopupCodeViaSwift() {
        return null;
      },
      async readPopupCodeViaOcr() {
        return unavailable;
      },
    },
  });

  assert.deepEqual(result, unavailable);
});

test("Swift OCR preflight checks permission without requesting or capturing", () => {
  const capability = sourceFunctionBody(
    popupOcrSwiftSource,
    "func screenCaptureCapability"
  );
  const preflightFlag = popupOcrSwiftSource.indexOf(
    'CommandLine.arguments[i] == "--preflight-screen-capture"'
  );
  const preflightDispatch = popupOcrSwiftSource.indexOf(
    "if preflightScreenCapture"
  );
  const captureDeadline = popupOcrSwiftSource.indexOf("let deadline");

  assert.match(capability, /CGPreflightScreenCaptureAccess\(\)/);
  assert.match(capability, /"available"/);
  assert.match(capability, /"permission_missing"/);
  assert.doesNotMatch(capability, /CGRequestScreenCaptureAccess|CGWindowListCreateImage/);
  assert.ok(preflightFlag >= 0, "missing preflight command-line flag");
  assert.ok(
    preflightDispatch > preflightFlag && preflightDispatch < captureDeadline,
    "preflight must return before any capture polling"
  );
  assert.doesNotMatch(popupOcrSwiftSource, /CGRequestScreenCaptureAccess/);
});

test("Swift OCR accepts contiguous digits only from the verified center crop", () => {
  const matcher = sourceFunctionBody(popupOcrSwiftSource, "func findFormattedCode");
  const ocr = sourceFunctionBody(popupOcrSwiftSource, "func tryOcrOnImage");
  const capture = sourceFunctionBody(popupOcrSwiftSource, "func captureDialog");
  const finder = sourceFunctionBody(popupOcrSwiftSource, "func findCodeDialogs");

  assert.match(matcher, /formattedCodePattern/);
  assert.match(matcher, /contiguousCodePattern/);
  assert.match(matcher, /if allowContiguous/);
  assert.match(ocr, /ocrLines[\s\S]*firstCode\(in: fullLines, allowContiguous: false\)/);
  assert.match(
    ocr,
    /cropping\(to: cropRect\)[\s\S]*firstCode\(in: cropLines, allowContiguous: true\)/
  );
  assert.doesNotMatch(ocr, /joined\(separator:/);
  assert.match(capture, /guard let wid = target\.windowID/);
  assert.match(finder, /guard let kind = candidateKind\(for: app\) else/);
  assert.match(finder, /isEligibleCodeWindow\(/);
  assert.match(finder, /windowIDFor\(win\)/);
});

test("Swift center-crop OCR requires two independent matching captures", () => {
  const ocr = sourceFunctionBody(popupOcrSwiftSource, "func tryOcrOnImage");
  const observe = sourceFunctionBody(
    popupOcrSwiftSource,
    "mutating func observeCenterCandidate"
  );
  const mainLoop = popupOcrSwiftSource.slice(
    popupOcrSwiftSource.indexOf("let deadline")
  );

  assert.match(popupOcrSwiftSource, /enum OcrCandidateSource: Equatable[\s\S]*case fullWindow[\s\S]*case centerCrop/);
  assert.match(popupOcrSwiftSource, /struct OcrCandidate[\s\S]*let code: String[\s\S]*let source: OcrCandidateSource/);
  assert.match(popupOcrSwiftSource, /var requiresStability: Bool[\s\S]*source == \.centerCrop/);
  assert.match(ocr, /OcrCandidate\(code: hit, source: \.fullWindow\)/);
  assert.match(ocr, /OcrCandidate\(code: hit, source: \.centerCrop\)/);
  assert.match(observe, /previous\?\.code == code/);
  assert.match(observe, /previous\?\.capturePass == capturePass - 1/);
  assert.match(observe, /states\[windowID\] = CenterCandidateState/);
  assert.match(mainLoop, /capturePass \+= 1/);
  assert.match(mainLoop, /var capturedWindowIDs = Set<CGWindowID>\(\)/);
  assert.match(mainLoop, /guard capturedWindowIDs\.insert\(wid\)\.inserted else \{ continue \}/);
  assert.match(
    mainLoop,
    /if candidate\.requiresStability[\s\S]*observeCenterCandidate\([\s\S]*else \{ continue \}[\s\S]*emit\(Output/
  );
});

test("Swift center-crop OCR resets on empty or changed captures", () => {
  const observe = sourceFunctionBody(
    popupOcrSwiftSource,
    "mutating func observeCenterCandidate"
  );
  const mainLoop = popupOcrSwiftSource.slice(
    popupOcrSwiftSource.indexOf("let deadline")
  );

  assert.match(observe, /states\[windowID\] = CenterCandidateState[\s\S]*return false/);
  assert.match(
    mainLoop,
    /guard let cg = await captureDialog\(target\) else \{[\s\S]*reset\(windowID: wid\)[\s\S]*continue/
  );
  assert.match(
    mainLoop,
    /guard let candidate = tryOcrOnImage\(cg\) else \{[\s\S]*reset\(windowID: wid\)[\s\S]*continue/
  );
  assert.match(mainLoop, /retainOnly\(capturedWindowIDs\)/);
});

test("Swift full-window formatted OCR remains a direct single-capture result", () => {
  const mainLoop = popupOcrSwiftSource.slice(
    popupOcrSwiftSource.indexOf("let deadline")
  );

  assert.match(
    mainLoop,
    /if candidate\.requiresStability[\s\S]*observeCenterCandidate[\s\S]*else \{[\s\S]*reset\(windowID: wid\)[\s\S]*\}[\s\S]*emit\(Output/
  );
});

test("production Allow guidance requires Accessibility without System Events", () => {
  assert.match(allowSource, /请确认终端已获辅助功能/);
  assert.doesNotMatch(allowSource, /System Events|辅助功能\s*\+\s*.*自动化/);
});

test("native Accessibility preflight is fixed and precedes popup enumeration", () => {
  assert.equal(typeof popupModule.checkNativeAccessibilityCapability, "function");
  assert.equal(typeof popupModule.promptNativeAccessibilityPermission, "function");
  assert.match(popupSource, /--preflight-accessibility/);
  assert.match(popupSource, /--prompt-accessibility/);
  assert.doesNotMatch(popupSource, /osascript|System Events/);

  const preflight = popupReadSwiftSource.indexOf(
    'args.contains("--preflight-accessibility")'
  );
  const prompt = popupReadSwiftSource.indexOf(
    'args.contains("--prompt-accessibility")'
  );
  const enumerate = popupReadSwiftSource.indexOf(
    "let windows = collectPriorityWindows()"
  );
  assert.ok(preflight >= 0 && prompt >= 0 && enumerate >= 0);
  assert.ok(preflight < enumerate && prompt < enumerate);
  assert.match(popupReadSwiftSource, /AXIsProcessTrusted\(\)/);
  assert.match(popupReadSwiftSource, /AXIsProcessTrustedWithOptions/);
  assert.match(popupReadSwiftSource, /kAXTrustedCheckOptionPrompt/);
  assert.match(
    popupReadSwiftSource,
    /let capability = trusted \? "available" : "permission_missing"/
  );
});

test("OCR path remains read-only, window-bound, memory-only, and secret-free", () => {
  assert.doesNotMatch(
    popupOcrSwiftSource,
    /AXUIElementPerformAction|CGEvent|CGRequestScreenCaptureAccess|screencapture|NSTemporaryDirectory|FileManager\.default|\.png/
  );
  assert.doesNotMatch(ocrSource, /screenshot|raw\s*:|stderr\s*:/i);
  assert.doesNotMatch(allowSource, /OCR[^\n]*(?:code|raw).*\$\{/i);
});

test("popup production modules use only the constrained Swift helper", () => {
  for (const source of [allowSource, popupSource]) {
    assert.doesNotMatch(
      source,
      /osascript|runAppleScriptPhase|readPopupCodeViaAppleScript/
    );
  }
});

test("OCR capture is window-id-only and stays in ScreenCaptureKit memory", () => {
  const capture = sourceFunctionBody(
    popupOcrSwiftSource,
    "func captureWindowByID"
  );
  const dispatch = sourceFunctionBody(popupOcrSwiftSource, "func captureDialog");

  assert.doesNotMatch(popupOcrSwiftSource, /captureRectScreencapture|paddedFrame/);
  assert.match(popupOcrSwiftSource, /import ScreenCaptureKit/);
  assert.match(ocrSource, /"ScreenCaptureKit"/);
  assert.doesNotMatch(popupOcrSwiftSource, /CGWindowListCreateImage/);
  assert.match(dispatch, /guard let wid = target\.windowID/);
  assert.match(dispatch, /await captureWindowByID\(wid\)/);
  assert.match(capture, /SCShareableContent\.excludingDesktopWindows/);
  assert.match(capture, /\$0\.windowID == wid/);
  assert.match(capture, /SCContentFilter\(desktopIndependentWindow: window\)/);
  assert.match(capture, /SCScreenshotManager\.captureImage/);
  assert.match(capture, /configuration\.showsCursor = false/);
  assert.doesNotMatch(
    popupOcrSwiftSource,
    /\bProcess\s*\(|screencapture|waitUntilExit|NSTemporaryDirectory|FileManager\.default|\.png/
  );
});

test("native helpers accept only explicit read-only Apple system roots", () => {
  for (const [label, source] of [
    ["click", swiftSource],
    ["popup", popupReadSwiftSource],
    ["ocr", popupOcrSwiftSource],
  ]) {
    const systemPath = sourceFunctionBody(source, "func isAppleSystemExecutable");
    assert.match(systemPath, /\/System\/Library\//, `${label} missing System Library root`);
    assert.match(systemPath, /\/System\/Applications\//, `${label} missing System Applications root`);
    assert.match(systemPath, /\/usr\/libexec\//, `${label} missing libexec root`);
    assert.doesNotMatch(systemPath, /hasPrefix\("\/System\/"\)/);
    assert.doesNotMatch(systemPath, /\/System\/Volumes\/Data/);
  }
});

test("OCR scans only trusted Apple authentication processes", () => {
  const finder = sourceFunctionBody(
    popupOcrSwiftSource,
    "func findCodeDialogs"
  );
  const guardIndex = finder.indexOf(
    "guard let kind = candidateKind(for: app) else"
  );
  const axIndex = finder.indexOf("AXUIElementCreateApplication");
  const eligibilityIndex = finder.indexOf("isEligibleCodeWindow(");
  const windowIDIndex = finder.indexOf("windowIDFor(win)");

  assert.match(popupOcrSwiftSource, /func isAppleSystemExecutable/);
  assert.match(popupOcrSwiftSource, /executableURL\.lastPathComponent/);
  assert.match(popupOcrSwiftSource, /dedicatedAuthExecutables/);
  assert.match(popupOcrSwiftSource, /sharedHostExecutables/);
  assert.ok(guardIndex >= 0, "missing authentication process guard");
  assert.ok(axIndex >= 0 && guardIndex < axIndex, "identity guard must precede AX enumeration");
  assert.ok(
    eligibilityIndex > axIndex && windowIDIndex > eligibilityIndex,
    "window eligibility must precede window-ID access"
  );
  assert.doesNotMatch(finder, /localizedName.*(?:guard|if)/);
});

test("Swift diagnostics never log raw accessibility text", () => {
  const logCalls = swiftSource
    .split(/\r?\n/)
    .filter((line) => line.includes("logStep("));

  for (const line of logCalls) {
    assert.doesNotMatch(line, /\\\((?:title|label|blob|text|buttonTitle)/);
  }
});

test("CGEvent constructs mouse-up before down and always releases after down", () => {
  const body = swiftFunctionBody("clickScreenPoint");
  const downCreate = body.indexOf("mouseType: .leftMouseDown");
  const upCreate = body.indexOf("mouseType: .leftMouseUp");
  const releaseGuard = body.indexOf("defer");
  const downPost = body.indexOf("down.post");

  assert.ok(downCreate >= 0 && upCreate >= 0 && downPost >= 0);
  assert.ok(upCreate < downPost, "mouse-up must exist before mouse-down is posted");
  assert.ok(
    releaseGuard >= 0 && releaseGuard < downPost,
    "mouse-up cleanup must be registered before mouse-down is posted"
  );
  assert.match(body.slice(releaseGuard), /up\.post/);
});

test("the element-center caller propagates clickScreenPoint failure", () => {
  const body = swiftFunctionBody("clickElementCenter");

  assert.match(body, /guard clickScreenPoint\(pt\) else/);
  assert.doesNotMatch(body, /_ = clickScreenPoint/);
});

test("npm keeps the real manual Allow command and adds a unit command", () => {
  assert.match(packageJson.scripts["test:2fa-allow"], /--manual(?:\s|$)/);
  assert.equal(
    packageJson.scripts["test:2fa-allow-unit"],
    "node scripts/test-2fa-allow.mjs"
  );
});

test("manual Allow command is observation-only and has no automatic click path", () => {
  const start = testSource.lastIndexOf("async function runManualTest()");
  const end = testSource.indexOf(
    'if (process.argv.includes("--manual"))',
    start
  );
  assert.ok(start >= 0 && end > start, "missing manual test entrypoint");
  const body = testSource.slice(start, end);

  assert.match(body, /probe2FAState\(3\)/);
  assert.match(body, /waitForManualAllow\(/);
  assert.match(body, /initialSawAllowDialog:\s*true/);
  assert.doesNotMatch(
    body,
    /tryAllowOnce|confirmAllowSuccess|waitForAllowClick/,
    "manual command must never invoke an automatic Allow path"
  );
  assert.doesNotMatch(
    allowSource,
    /export async function (?:waitForAllowClick|confirmAllowSuccess)|async function dismissStaleCodeDialogOnce/,
    "legacy automatic rotation entrypoints must be removed"
  );
});

async function runManualTest() {
  const state = await probe2FAState(3);
  console.log("当前弹窗状态:", state);
  if (state.action !== "has_allow_dialog") {
    console.log("未检测到「允许」弹窗，跳过手工点击测试");
    return;
  }

  const manual = await waitForManualAllow({
    timeoutMs: 30_000,
    initialSawAllowDialog: true,
  });
  console.log("等待结果:", manual);
  if (!manual.clicked) process.exitCode = 1;
}

if (process.argv.includes("--manual")) {
  await runManualTest();
} else {
  const failures = [];
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`not ok - ${name}`);
      console.error(error instanceof Error ? error.message : error);
    }
  }
  console.log(`2FA Allow tests: ${passed}/${tests.length} passed`);
  if (failures.length > 0) process.exitCode = 1;
}
