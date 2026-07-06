#!/usr/bin/env swift
// 扫描 macOS 系统 2FA 弹窗：清理旧窗 → 点「允许」→ 读取当前验证码
// JSON stdout: { "ok": true, "code": "072426", "action": "read_code", ... }

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
    let digits = text.filter(\.isNumber)
    guard digits.count == 6 else { return false }
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.range(of: #"^\d{3}\s\d{3}$"#, options: .regularExpression) != nil { return true }
    if t.range(of: #"^\d{6}$"#, options: .regularExpression) != nil { return true }
    return false
}

/// 必须出现「在网页上输入此验证码」类文案，才认为是展示 6 位码的弹窗（排除旧窗/允许窗）
func hasCodeDisplayPrompt(_ blob: String) -> Bool {
    if blob.contains("在网页上输入此验证码") { return true }
    if blob.contains("在网页上输入") && blob.contains("验证码") { return true }
    if blob.contains("输入此验证码") { return true }
    let lower = blob.lowercased()
    if lower.contains("enter this verification code on the web") { return true }
    if lower.contains("enter the verification code on the web") { return true }
    return false
}

func looksLikeAllowPrompt(_ blob: String) -> Bool {
    if blob.contains("正用于登录") && blob.contains("新设备") { return true }
    if blob.contains("正在尝试登录") { return true }
    let lower = blob.lowercased()
    if lower.contains("trying to sign in") { return true }
    if lower.contains("sign in to a new") { return true }
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
        if ["允许", "Allow"].contains(where: { title == $0 }) { result.hasAllow = true }
        if ["完成", "Done", "好", "OK"].contains(where: { title == $0 }) { result.hasDone = true }
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
    usleep(60_000)
    return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func clickButtonInTree(_ root: AXUIElement, labels: [String], maxDepth: Int = 12) -> Bool {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    while !queue.isEmpty {
        let (node, depth) = queue.removeFirst()
        if depth > maxDepth { continue }
        if axRole(node) == kAXButtonRole as String {
            let title = axTexts(node).joined(separator: " ")
            if labels.contains(where: { title == $0 }) {
                if pressButton(node) { return true }
            }
        }
        for child in axChildren(node) {
            queue.append((child, depth + 1))
        }
    }
    return false
}

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

let priorityApps = ["FollowUpUI", "CoreAuthUI", "AuthenticationServicesAgent", "SecurityAgent", "UserNotificationCenter"]

struct ScannedWindow {
    let appName: String
    let window: AXUIElement
    let scan: WindowScan
}

func collectPriorityWindows() -> [ScannedWindow] {
    var apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
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

func scanPass() -> (code: String?, action: String, source: String?, raw: String?) {
    let windows = collectPriorityWindows()

    // 1) 关闭残留验证码窗（有「完成」+ 验证码展示文案）→ 避免读到上次 609574
    for item in windows where item.scan.hasDone && item.scan.hasCodePrompt {
        if clickButtonInTree(item.window, labels: ["完成", "Done", "好", "OK"]) {
            return (nil, "dismissed_stale", item.appName, nil)
        }
    }

    // 2) 允许窗：有「允许」、尚无「在网页上输入验证码」文案
    for item in windows where item.scan.hasAllow && !item.scan.hasCodePrompt {
        if looksLikeAllowPrompt(item.scan.blob) || item.scan.hasAllow {
            if clickButtonInTree(item.window, labels: ["允许", "Allow"]) {
                return (nil, "clicked_allow", item.appName, nil)
            }
        }
    }

    // 3) 仅当验证码展示窗出现时才读码（必须有 code prompt + NNN NNN）
    for item in windows where item.scan.hasCodePrompt {
        if let c = item.scan.code, let raw = item.scan.codeRaw {
            return (c, "read_code", item.appName, raw)
        }
    }

    return (nil, "none", nil, nil)
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

var timeoutSec = 8
var dismissOnly = false
var i = 1
let args = CommandLine.arguments
while i < args.count {
    if args[i] == "--timeout", i + 1 < args.count {
        timeoutSec = Int(args[i + 1]) ?? timeoutSec
        i += 2
        continue
    }
    if args[i] == "--dismiss-stale" {
        dismissOnly = true
        i += 1
        continue
    }
    i += 1
}

if dismissOnly {
    let windows = collectPriorityWindows()
    for item in windows where item.scan.hasDone && (item.scan.hasCodePrompt || item.scan.code != nil) {
        if clickButtonInTree(item.window, labels: ["完成", "Done", "好", "OK"]) {
            logStep(0, "dismissed stale dialog")
            emit(Output(ok: true, code: nil, action: "dismissed_stale", message: "ok", source: item.appName, raw: nil))
        }
    }
    emit(Output(ok: false, code: nil, action: "none", message: "no-stale", source: nil, raw: nil))
}

let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))
var lastAction = ""

while Date() < deadline {
    let (code, action, source, raw) = scanPass()
    if action == "dismissed_stale" {
        logStep(0, "dismissed stale from \(source ?? "?")")
        lastAction = action
        usleep(800_000)
        continue
    }
    if action == "clicked_allow" {
        if lastAction != "clicked_allow" {
            logStep(2, "clicked Allow on \(source ?? "?")")
        }
        lastAction = "clicked_allow"
        usleep(2_200_000)
        continue
    }
    if let c = code {
        logStep(1, "code=\(c) source=\(source ?? "?") raw=\(raw ?? c)")
        emit(Output(ok: true, code: c, action: "read_code", message: "ok", source: source, raw: raw))
    }
    usleep(400_000)
}

emit(Output(ok: false, code: nil, action: lastAction.isEmpty ? "none" : lastAction, message: "timeout", source: nil, raw: nil))
