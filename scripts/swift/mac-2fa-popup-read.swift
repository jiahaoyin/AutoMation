#!/usr/bin/env swift
// 分阶段处理 macOS 2FA 弹窗：dismiss_stale → pre_allow → read_code
// --phase dismiss_stale|pre_allow|read_code

import ApplicationServices
import AppKit
import Foundation

struct Output: Codable {
    let ok: Bool
    let code: String?
    let action: String?
    let message: String
    let source: String?
    let raw: String?
}

enum Phase: String {
    case dismissStale = "dismiss_stale"
    case preAllow = "pre_allow"
    case readCode = "read_code"
    case probe = "probe"
    case all = "all"
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
    guard digits.count >= 6 else { return nil }
    return String(digits.prefix(6))
}

func looksLikeCodeDisplay(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.range(of: #"^\d{3}\s\d{3}$"#, options: .regularExpression) != nil
}

func hasCodeDisplayPrompt(_ blob: String) -> Bool {
    if blob.contains("在网页上输入此验证码") { return true }
    if blob.contains("在网页上输入") && blob.contains("验证码") { return true }
    if blob.contains("输入此验证码") { return true }
    let lower = blob.lowercased()
    if lower.contains("enter this verification code on the web") { return true }
    return false
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
        if title.contains("允许") || title == "Allow" { result.hasAllow = true }
        if title.contains("完成") || title == "Done" || title == "OK" || title.contains("好") { result.hasDone = true }
    }
    for child in axChildren(element) {
        walkCollect(child, depth: depth + 1, maxDepth: maxDepth, result: &result)
    }
}

func scanWindow(_ root: AXUIElement, maxDepth: Int = 14) -> WindowScan {
    var scan = WindowScan()
    walkCollect(root, depth: 0, maxDepth: maxDepth, result: &scan)
    scan.hasCodePrompt = hasCodeDisplayPrompt(scan.blob)
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
        { $0.contains("完成") || $0 == "Done" || $0 == "OK" },
    ])
}

func clickAllow(_ win: AXUIElement) -> Bool {
    clickButtonInTree(win, matchers: [
        { $0 == "允许" || $0 == "Allow" || $0.contains("允许") },
    ])
}

let priorityApps = ["FollowUpUI", "CoreAuthUI", "AuthenticationServicesAgent", "SecurityAgent", "UserNotificationCenter"]

func isPriorityApp(_ name: String) -> Bool {
    priorityApps.contains { name.contains($0) }
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
    let window: AXUIElement
    let scan: WindowScan
}

func looksLikeAllowDialog(_ blob: String) -> Bool {
    if blob.contains("正用于登录") && blob.contains("新设备") { return true }
    if blob.contains("正被用于") && blob.contains("登录") { return true }
    if blob.contains("不允许") && blob.contains("允许") { return true }
    return false
}

func collectButtons(_ root: AXUIElement, maxDepth: Int = 14) -> [AXUIElement] {
    var out: [AXUIElement] = []
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    while !queue.isEmpty {
        let (node, depth) = queue.removeFirst()
        if depth > maxDepth { continue }
        if axRole(node) == kAXButtonRole as String { out.append(node) }
        for child in axChildren(node) { queue.append((child, depth + 1)) }
    }
    return out
}

func clickRightmostButton(_ root: AXUIElement) -> Bool {
    let buttons = collectButtons(root)
    guard let last = buttons.last else { return false }
    return pressButton(last)
}

func collectPriorityWindows() -> [ScannedWindow] {
    var apps = NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular || $0.activationPolicy == .accessory
    }
    apps.sort { a, b in
        let an = a.localizedName ?? ""
        let bn = b.localizedName ?? ""
        let ar = priorityApps.firstIndex { an.contains($0) } ?? 99
        let br = priorityApps.firstIndex { bn.contains($0) } ?? 99
        return ar < br
    }
    var out: [ScannedWindow] = []
    for app in apps {
        let appName = app.localizedName ?? ""
        guard isPriorityApp(appName) else { continue }
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        for win in windowsForApp(appEl) {
            out.append(ScannedWindow(appName: appName, window: win, scan: scanWindow(win)))
        }
    }
    return out
}

func tryDismissStale(_ windows: [ScannedWindow]) -> (Bool, String?, String?, String?) {
    for item in windows where item.scan.hasCodePrompt || item.scan.code != nil {
        let oldCode = item.scan.code
        let oldRaw = item.scan.codeRaw
        if clickDone(item.window) {
            return (true, item.appName, oldCode, oldRaw)
        }
    }
    return (false, nil, nil, nil)
}

func tryClickAllow(_ windows: [ScannedWindow]) -> (Bool, String?) {
    for item in windows where item.scan.hasAllow && !item.scan.hasCodePrompt {
        if clickAllow(item.window) { return (true, item.appName) }
    }
    for item in windows where looksLikeAllowDialog(item.scan.blob) && !item.scan.hasCodePrompt {
        if clickAllow(item.window) { return (true, item.appName) }
        if clickRightmostButton(item.window) { return (true, item.appName) }
    }
    for item in windows where item.scan.hasAllow {
        if clickAllow(item.window) { return (true, item.appName) }
    }
    return (false, nil)
}

func tryReadCode(_ windows: [ScannedWindow]) -> (String, String, String)? {
    for item in windows where item.scan.hasCodePrompt {
        if let c = item.scan.code, let raw = item.scan.codeRaw, looksLikeCodeDisplay(raw) {
            return (c, item.appName, raw)
        }
    }
    return nil
}

func probeState(_ windows: [ScannedWindow]) -> (String, String?) {
    for item in windows where item.scan.hasCodePrompt {
        return ("has_code_dialog", item.appName)
    }
    for item in windows where item.scan.hasAllow || (looksLikeAllowDialog(item.scan.blob) && !item.scan.hasCodePrompt) {
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
    emit(Output(ok: action != "none", code: nil, action: action, message: "ok", source: source, raw: nil))
}

var timeoutSec = 8
var phase = Phase.all
var i = 1
let args = CommandLine.arguments
while i < args.count {
    if args[i] == "--timeout", i + 1 < args.count {
        timeoutSec = Int(args[i + 1]) ?? timeoutSec
        i += 2
        continue
    }
    if args[i] == "--phase", i + 1 < args.count {
        phase = Phase(rawValue: args[i + 1]) ?? .all
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
var stableRaw: String?
var stableSource: String?
var stableHits = 0

while Date() < deadline {
    let windows = collectPriorityWindows()

    if phase == .dismissStale || phase == .preAllow || phase == .all {
        let (dismissed, src, oldCode, oldRaw) = tryDismissStale(windows)
        if dismissed {
            logStep(0, "dismissed stale from \(src ?? "?") code=\(oldCode ?? "?")")
            if phase == .dismissStale {
                emit(Output(ok: true, code: oldCode, action: "dismissed_stale", message: "ok", source: src, raw: oldRaw))
            }
            usleep(900_000)
            continue
        }
    }

    if phase == .preAllow || phase == .all {
        let (allowed, src) = tryClickAllow(windows)
        if allowed {
            logStep(2, "clicked Allow on \(src ?? "?")")
            if phase == .preAllow { emitAction("clicked_allow", source: src) }
            usleep(2_200_000)
            continue
        }
    }

    if phase == .readCode || phase == .all {
        if let (code, src, raw) = tryReadCode(windows) {
            if stableCode == code && stableRaw == raw {
                stableHits += 1
            } else {
                stableCode = code
                stableRaw = raw
                stableSource = src
                stableHits = 1
            }
            if stableHits >= 2 {
                logStep(1, "code=\(code) source=\(src) raw=\(raw)")
                emit(Output(ok: true, code: code, action: "read_code", message: "ok", source: src, raw: raw))
            }
        } else {
            stableCode = nil
            stableRaw = nil
            stableSource = nil
            stableHits = 0
        }
    }

    if phase == .probe {
        let (state, src) = probeState(windows)
        emit(Output(ok: state != "idle", code: nil, action: state, message: "ok", source: src, raw: nil))
    }

    usleep(400_000)
}

emit(Output(ok: false, code: nil, action: "none", message: "timeout", source: nil, raw: nil))
