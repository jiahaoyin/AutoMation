#!/usr/bin/env swift
// 分阶段处理 macOS 2FA 弹窗：dismiss_stale | read_code | probe
// --phase dismiss_stale|read_code|probe

import ApplicationServices
import AppKit
import Foundation

struct Output: Codable {
    let ok: Bool
    let code: String?
    let action: String?
    let message: String
    let source: String?
}

struct AccessibilityCapabilityOutput: Codable {
    let capability: String
}

enum Phase: String {
    case dismissStale = "dismiss_stale"
    case dismissDone = "dismiss_done"
    case readCode = "read_code"
    case probe = "probe"
}

struct WindowScan {
    var blob: String = ""
    var code: String?
    var codeRaw: String?
    var hasAllow: Bool = false
    var hasDone: Bool = false
    var hasCodePrompt: Bool = false
}

func logStep(_ n: Int, _ msg: String) {
    FileHandle.standardError.write("[2FA-popup \(n)] \(msg)\n".data(using: .utf8)!)
}

func axCopy<T>(_ element: AXUIElement, _ attr: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
    return value as? T
}

func axString(_ element: AXUIElement, _ attr: String) -> String? {
    guard let v: CFTypeRef = axCopy(element, attr) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axCopy(element, kAXChildrenAttribute as String) ?? []
}

func axRole(_ element: AXUIElement) -> String {
    axString(element, kAXRoleAttribute as String) ?? ""
}

func axTexts(_ element: AXUIElement) -> [String] {
    [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXRoleDescriptionAttribute]
        .compactMap { axString(element, $0 as String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
}

func extractSixDigits(_ text: String) -> String? {
    let digits = text.filter(\.isNumber)
    guard digits.count == 6 else { return nil }
    return String(digits)
}

func looksLikeCodeDisplay(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.range(
        of: #"^(?:\d{3}[\s\u00A0\u2009]+\d{3}|\d(?:[\s\u00A0\u2009]+\d){5}|\d{6})$"#,
        options: .regularExpression
    ) != nil
}

func formattedCodeInBlob(_ blob: String) -> String? {
    let pattern = #"(?<![0-9])(?:[0-9]{3}[\s\u00A0\u2009]+[0-9]{3}|[0-9](?:[\s\u00A0\u2009]+[0-9]){5})(?![0-9])"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
    let ns = blob as NSString
    let range = NSRange(location: 0, length: ns.length)
    guard let match = regex.firstMatch(in: blob, range: range) else { return nil }
    return ns.substring(with: match.range)
}

func hasCodeDisplayPrompt(_ blob: String) -> Bool {
    if blob.contains("在网页上输入此验证码") { return true }
    if blob.contains("在网页上输入") && blob.contains("验证码") { return true }
    if blob.contains("输入此验证码") { return true }
    if blob.contains("验证码以登录") { return true }
    if blob.contains("在網頁上輸入此驗證碼") { return true }
    if blob.contains("在網頁上輸入") && blob.contains("驗證碼") { return true }
    if blob.contains("輸入此驗證碼") { return true }
    if blob.contains("驗證碼以登入") { return true }
    let lower = blob.lowercased()
    if lower.contains("enter this verification code on the web") { return true }
    return false
}

func isPositiveAllowTitle(_ title: String) -> Bool {
    let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = normalized.lowercased()
    let negativeTitles = ["Don't Allow", "Do Not Allow", "不允许", "不允許"]
    if negativeTitles.contains(where: { normalized.localizedCaseInsensitiveContains($0) }) ||
        lower.contains("don't allow") || lower.contains("do not allow") {
        return false
    }
    if ["Allow", "允许", "允許"].contains(normalized) { return true }
    if normalized.contains("允许") || normalized.contains("允許") { return true }
    return lower.hasPrefix("allow ")
}

func isDoneTitle(_ title: String) -> Bool {
    let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return normalized.contains("完成") || normalized == "Done" || normalized == "OK" || normalized == "好"
}

func walkCollect(_ element: AXUIElement, depth: Int, maxDepth: Int, result: inout WindowScan) {
    if depth > maxDepth { return }
    for t in axTexts(element) {
        result.blob += " " + t
        if result.code == nil, looksLikeCodeDisplay(t), let c = extractSixDigits(t) {
            result.code = c
            result.codeRaw = t
        }
    }
    if axRole(element) == kAXButtonRole as String {
        let title = axTexts(element).joined(separator: " ")
        if isPositiveAllowTitle(title) { result.hasAllow = true }
        if isDoneTitle(title) { result.hasDone = true }
    }
    for child in axChildren(element) {
        walkCollect(child, depth: depth + 1, maxDepth: maxDepth, result: &result)
    }
}

func scanWindow(_ root: AXUIElement, maxDepth: Int = 14) -> WindowScan {
    var scan = WindowScan()
    walkCollect(root, depth: 0, maxDepth: maxDepth, result: &scan)
    scan.hasCodePrompt = hasCodeDisplayPrompt(scan.blob)
    if scan.hasCodePrompt,
       scan.code == nil,
       let raw = formattedCodeInBlob(scan.blob),
       let code = extractSixDigits(raw) {
        scan.code = code
        scan.codeRaw = raw
    }
    return scan
}

func pressButton(_ element: AXUIElement) -> Bool {
    if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return true }
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(80_000)
    return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func clickButtonInTree(_ root: AXUIElement, matchers: [(String) -> Bool], maxDepth: Int = 14) -> Bool {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    while !queue.isEmpty {
        let (node, depth) = queue.removeFirst()
        if depth > maxDepth { continue }
        if axRole(node) == kAXButtonRole as String {
            let title = axTexts(node).joined(separator: " ")
            if matchers.contains(where: { $0(title) }) {
                if pressButton(node) { return true }
            }
        }
        for child in axChildren(node) {
            queue.append((child, depth + 1))
        }
    }
    return false
}

func clickDone(_ win: AXUIElement) -> Bool {
    clickButtonInTree(win, matchers: [
        { isDoneTitle($0) },
    ])
}

let priorityApps = ["FollowUpUI", "CoreAuthUI", "CoreAuthentication", "AuthenticationServicesAgent", "SecurityAgent", "UserNotificationCenter", "akd", "loginwindow"]
let dedicatedAuthExecutables: Set<String> = ["FollowUpUI", "CoreAuthUI", "CoreAuthentication", "AuthenticationServicesAgent"]
let sharedHostExecutables: Set<String> = ["UserNotificationCenter", "loginwindow", "SecurityAgent", "akd"]
let dedicatedAuthBundleIDs: Set<String> = [
    "com.apple.FollowUpUI",
    "com.apple.CoreAuthUI",
    "com.apple.CoreAuthentication",
    "com.apple.AuthenticationServicesAgent",
]
let sharedHostBundleIDs: Set<String> = [
    "com.apple.UserNotificationCenter",
    "com.apple.loginwindow",
    "com.apple.SecurityAgent",
    "com.apple.akd",
]

enum CandidateKind {
    case dedicated
    case sharedHost
}

func isAppleSystemExecutable(_ executableURL: URL?) -> Bool {
    guard let path = executableURL?.standardizedFileURL.path else { return false }
    return path.hasPrefix("/System/Library/") ||
        path.hasPrefix("/System/Applications/") ||
        path.hasPrefix("/usr/libexec/")
}

func candidateKind(for app: NSRunningApplication) -> CandidateKind? {
    guard let executableURL = app.executableURL,
          isAppleSystemExecutable(executableURL) else { return nil }
    let executableName = executableURL.lastPathComponent
    let bundleIdentifier = app.bundleIdentifier ?? ""
    if dedicatedAuthExecutables.contains(executableName) || dedicatedAuthBundleIDs.contains(bundleIdentifier) {
        return .dedicated
    }
    if sharedHostExecutables.contains(executableName) || sharedHostBundleIDs.contains(bundleIdentifier) {
        return .sharedHost
    }
    return nil
}

func hasExplicitAppleAccountEvidence(_ blob: String) -> Bool {
    let lower = blob.lowercased()
    let markers = [
        "apple id",
        "apple account",
        "apple账户",
        "apple 账户",
        "apple帐户",
        "apple 帐户",
        "apple帐号",
        "apple 帐号",
        "apple帳戶",
        "apple 帳戶",
        "apple帳號",
        "apple 帳號",
    ]
    return markers.contains { lower.contains($0) }
}

func isEligibleCodeWindow(
    kind: CandidateKind,
    blob: String,
    hasCodePrompt: Bool,
    hasCodeDisplay: Bool = false
) -> Bool {
    switch kind {
    case .dedicated:
        return hasCodePrompt || hasCodeDisplay
    case .sharedHost:
        return hasCodePrompt && hasExplicitAppleAccountEvidence(blob)
    }
}

func isPriorityApp(_ name: String) -> Bool {
    if priorityApps.contains(where: { name.contains($0) }) { return true }
    if name.contains("Auth") || name.contains("FollowUp") || name.contains("Security") { return true }
    return false
}

func windowsForApp(_ appEl: AXUIElement) -> [AXUIElement] {
    var list: [AXUIElement] = axCopy(appEl, kAXWindowsAttribute as String) ?? []
    if let focused: AXUIElement = axCopy(appEl, kAXFocusedWindowAttribute as String) {
        if !list.contains(where: { $0 == focused }) { list.append(focused) }
    }
    if let main: AXUIElement = axCopy(appEl, kAXMainWindowAttribute as String) {
        if !list.contains(where: { $0 == main }) { list.append(main) }
    }
    return list
}

struct ScannedWindow {
    let appName: String
    let candidateKind: CandidateKind
    let window: AXUIElement
    let scan: WindowScan
}

func looksLikeAllowDialog(_ blob: String) -> Bool {
    if blob.contains("正用于") && blob.contains("登录") { return true }
    if blob.contains("正被用于") && blob.contains("登录") { return true }
    if blob.contains("正用於") && blob.contains("登入") { return true }
    if blob.contains("正被用於") && blob.contains("登入") { return true }
    let lower = blob.lowercased()
    let mentionsAppleAccount = lower.contains("apple id") || lower.contains("apple account")
    let mentionsLogin = lower.contains("sign in") || lower.contains("signing in") || lower.contains("log in")
    return mentionsAppleAccount && mentionsLogin
}

func collectPriorityWindows() -> [ScannedWindow] {
    var apps = NSWorkspace.shared.runningApplications
    apps.sort { a, b in
        let an = a.localizedName ?? ""
        let bn = b.localizedName ?? ""
        let ar = priorityApps.firstIndex { an.contains($0) } ?? 99
        let br = priorityApps.firstIndex { bn.contains($0) } ?? 99
        if ar != br { return ar < br }
        return an < bn
    }
    var out: [ScannedWindow] = []
    for app in apps {
        guard let kind = candidateKind(for: app) else { continue }
        let appName = app.localizedName ?? ""
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        for win in windowsForApp(appEl) {
            let scan = scanWindow(win)
            let relevant = scan.hasAllow || scan.hasCodePrompt || scan.code != nil || looksLikeAllowDialog(scan.blob)
            if relevant || isPriorityApp(appName) {
                out.append(ScannedWindow(appName: appName, candidateKind: kind, window: win, scan: scan))
            }
        }
    }
    return out
}

func tryDismissStale(_ windows: [ScannedWindow]) -> (Bool, String?, String?) {
    for item in windows {
        guard isEligibleCodeWindow(
            kind: item.candidateKind,
            blob: item.scan.blob,
            hasCodePrompt: item.scan.hasCodePrompt,
            hasCodeDisplay: item.scan.code != nil
        ) else { continue }
        let oldCode = item.scan.code
        if clickDone(item.window) {
            return (true, item.appName, oldCode)
        }
    }
    return (false, nil, nil)
}

func tryDismissDone(_ windows: [ScannedWindow]) -> (Bool, String?) {
    for item in windows {
        guard isEligibleCodeWindow(
            kind: item.candidateKind,
            blob: item.scan.blob,
            hasCodePrompt: item.scan.hasCodePrompt,
            hasCodeDisplay: item.scan.code != nil
        ) else { continue }
        if clickDone(item.window) {
            return (true, item.appName)
        }
    }
    return (false, nil)
}

func isActionableAllowWindow(_ item: ScannedWindow) -> Bool {
    guard item.scan.hasAllow && !item.scan.hasCodePrompt else { return false }
    switch item.candidateKind {
    case .dedicated:
        return true
    case .sharedHost:
        return looksLikeAllowDialog(item.scan.blob)
    }
}

func tryReadCode(_ windows: [ScannedWindow]) -> (String, String)? {
    for item in windows {
        guard isEligibleCodeWindow(
            kind: item.candidateKind,
            blob: item.scan.blob,
            hasCodePrompt: item.scan.hasCodePrompt,
            hasCodeDisplay: item.scan.code != nil
        ) else { continue }
        if let c = item.scan.code, let raw = item.scan.codeRaw, looksLikeCodeDisplay(raw) {
            return (c, item.appName)
        }
    }
    return nil
}

func probeState(_ windows: [ScannedWindow]) -> (String, String?) {
    for item in windows {
        guard isEligibleCodeWindow(
            kind: item.candidateKind,
            blob: item.scan.blob,
            hasCodePrompt: item.scan.hasCodePrompt,
            hasCodeDisplay: item.scan.code != nil
        ) else { continue }
        return ("has_code_dialog", item.appName)
    }
    for item in windows where isActionableAllowWindow(item) {
        return ("has_allow_dialog", item.appName)
    }
    return ("idle", nil)
}

func emit(_ output: Output) -> Never {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    if let data = try? enc.encode(output) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
    exit(output.ok ? 0 : 1)
}

func emitAction(_ action: String, source: String? = nil) -> Never {
    emit(Output(ok: action != "none", code: nil, action: action, message: "ok", source: source))
}

func emitAccessibilityCapability(prompt: Bool) -> Never {
    let trusted: Bool
    if prompt {
        let options = [
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
        ] as CFDictionary
        trusted = AXIsProcessTrustedWithOptions(options)
    } else {
        trusted = AXIsProcessTrusted()
    }
    let capability = trusted ? "available" : "permission_missing"
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(AccessibilityCapabilityOutput(capability: capability)) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
    exit(trusted ? 0 : 1)
}

let args = CommandLine.arguments
if args.contains("--preflight-accessibility") {
    emitAccessibilityCapability(prompt: false)
}
if args.contains("--prompt-accessibility") {
    emitAccessibilityCapability(prompt: true)
}

// AX failures otherwise look exactly like an empty window list. Report a fixed
// capability result so the collector can keep its fallback providers alive
// without misclassifying a permission problem as an idle popup state.
guard AXIsProcessTrusted() else {
    emit(Output(
        ok: false,
        code: nil,
        action: "accessibility_unavailable",
        message: "accessibility_unavailable",
        source: nil
    ))
}

var timeoutSec = 8
var phase = Phase.readCode
var i = 1
while i < args.count {
    if args[i] == "--timeout", i + 1 < args.count {
        timeoutSec = Int(args[i + 1]) ?? timeoutSec
        i += 2
        continue
    }
    if args[i] == "--phase", i + 1 < args.count {
        phase = Phase(rawValue: args[i + 1]) ?? .readCode
        i += 2
        continue
    }
    if args[i] == "--dismiss-stale" {
        phase = .dismissStale
        i += 1
        continue
    }
    i += 1
}

let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))
var stableCode: String?
var stableSource: String?
var stableHits = 0

while Date() < deadline {
    let windows = collectPriorityWindows()

    if phase == .dismissDone {
        let (dismissed, src) = tryDismissDone(windows)
        if dismissed {
            logStep(0, "dismissed completed code dialog")
            emit(Output(ok: true, code: nil, action: "dismissed_done", message: "ok", source: src))
        }
    }

    if phase == .dismissStale {
        let (dismissed, src, oldCode) = tryDismissStale(windows)
        if dismissed {
            logStep(0, "dismissed stale code dialog")
            if phase == .dismissStale {
                emit(Output(ok: true, code: oldCode, action: "dismissed_stale", message: "ok", source: src))
            }
            usleep(900_000)
            continue
        }
    }

    if phase == .readCode {
        if let (code, src) = tryReadCode(windows) {
            if stableCode == code {
                stableHits += 1
            } else {
                stableCode = code
                stableSource = src
                stableHits = 1
            }
            if stableHits >= 1 {
                logStep(1, "verification code acquired")
                emit(Output(ok: true, code: code, action: "read_code", message: "ok", source: src))
            }
        } else {
            stableCode = nil
            stableSource = nil
            stableHits = 0
        }
    }

    if phase == .probe {
        let (state, src) = probeState(windows)
        emit(Output(ok: state != "idle", code: nil, action: state, message: "ok", source: src))
    }

    usleep(400_000)
}

emit(Output(ok: false, code: nil, action: "none", message: "timeout", source: nil))
