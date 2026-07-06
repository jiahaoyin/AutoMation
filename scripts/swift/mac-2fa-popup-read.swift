#!/usr/bin/env swift
// 扫描 macOS 系统 2FA 弹窗：点「允许」、读取验证码（AX 全树遍历）
// JSON stdout: { "ok": true, "code": "072426", "action": "read_code", "message": "ok" }

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

func looksLike2FABlob(_ blob: String) -> Bool {
    let lower = blob.lowercased()
    if blob.contains("验证码") || lower.contains("verification code") { return true }
    if blob.contains("双重认证") || lower.contains("two-factor") { return true }
    if blob.contains("新设备") || lower.contains("new device") { return true }
    if blob.contains("Apple 账户") || blob.contains("Apple ID") { return true }
    if blob.contains("Apple 账户验证码") { return true }
    return false
}

func looksLikeCodeDisplay(_ text: String) -> Bool {
    let digits = text.filter(\.isNumber)
    guard digits.count == 6 else { return false }
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.range(of: #"^\d{3}\s\d{3}$"#, options: .regularExpression) != nil { return true }
    if t.range(of: #"^\d{6}$"#, options: .regularExpression) != nil { return true }
    return digits.count == 6 && text.filter(\.isNumber).count == 6
}

struct ScanResult {
    var blob: String = ""
    var code: String?
    var raw: String?
}

func walk(_ element: AXUIElement, depth: Int, maxDepth: Int, result: inout ScanResult) {
    if depth > maxDepth || result.code != nil { return }
    for t in axTexts(element) {
        result.blob += " " + t
        if looksLikeCodeDisplay(t), let c = extractSixDigits(t) {
            result.code = c
            result.raw = t
            return
        }
    }
    if result.code == nil, looksLike2FABlob(result.blob), let c = extractSixDigits(result.blob) {
        result.code = c
        result.raw = result.blob
        return
    }
    for child in axChildren(element) {
        walk(child, depth: depth + 1, maxDepth: maxDepth, result: &result)
        if result.code != nil { return }
    }
}

func scanElementForCode(_ root: AXUIElement, maxDepth: Int = 14, appName: String = "") -> (String, String)? {
    var result = ScanResult()
    walk(root, depth: 0, maxDepth: maxDepth, result: &result)
    guard let code = result.code else { return nil }
    if isPriorityApp(appName) || looksLike2FABlob(result.blob) { return (code, result.raw ?? code) }
    return nil
}

func pressButton(_ element: AXUIElement) -> Bool {
    if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return true }
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(60_000)
    return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func clickAllowInTree(_ root: AXUIElement, maxDepth: Int = 12) -> Bool {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    while !queue.isEmpty {
        let (node, depth) = queue.removeFirst()
        if depth > maxDepth { continue }
        if axRole(node) == kAXButtonRole as String {
            let title = axTexts(node).joined(separator: " ")
            if ["允许", "Allow"].contains(where: { title == $0 || title.contains($0) }) {
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
let excludeApps = ["Firefox", "Google Chrome", "Safari", "Microsoft Edge", "Arc", "Chromium"]

func isExcludedApp(_ name: String) -> Bool {
    excludeApps.contains { name.contains($0) }
}

func scanPass(clickAllow: Bool) -> (code: String?, action: String, source: String?, raw: String?) {
    var apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    apps.sort { a, b in
        let an = a.localizedName ?? ""
        let bn = b.localizedName ?? ""
        let ar = priorityApps.firstIndex { an.contains($0) } ?? 99
        let br = priorityApps.firstIndex { bn.contains($0) } ?? 99
        return ar < br
    }

    for app in apps {
        let appName = app.localizedName ?? ""
        if isExcludedApp(appName) { continue }
        if !isPriorityApp(appName) { continue }
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        for win in windowsForApp(appEl) {
            if let hit = scanElementForCode(win, appName: appName) {
                return (hit.0, "read_code", appName, hit.1)
            }
        }
        if let hit = scanElementForCode(appEl, maxDepth: 10, appName: appName) {
            return (hit.0, "read_code", appName, hit.1)
        }
    }

    for app in apps {
        let appName = app.localizedName ?? ""
        if isExcludedApp(appName) || isPriorityApp(appName) { continue }
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        for win in windowsForApp(appEl) {
            if let hit = scanElementForCode(win, appName: appName) {
                return (hit.0, "read_code", appName, hit.1)
            }
        }
    }

    if clickAllow {
        for app in apps {
            let name = app.localizedName ?? ""
            if !priorityApps.contains(where: { name.contains($0) }) && !name.contains("System Settings") { continue }
            let appEl = AXUIElementCreateApplication(app.processIdentifier)
            for win in windowsForApp(appEl) {
                if clickAllowInTree(win) { return (nil, "clicked_allow", nil, nil) }
            }
            if clickAllowInTree(appEl) { return (nil, "clicked_allow", nil, nil) }
        }
        for app in apps {
            let appEl = AXUIElementCreateApplication(app.processIdentifier)
            for win in windowsForApp(appEl) {
                if clickAllowInTree(win) { return (nil, "clicked_allow", nil, nil) }
            }
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
var i = 1
let args = CommandLine.arguments
while i < args.count {
    if args[i] == "--timeout", i + 1 < args.count {
        timeoutSec = Int(args[i + 1]) ?? timeoutSec
        i += 2
        continue
    }
    i += 1
}

let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))
var lastAction = ""

while Date() < deadline {
    let (code, action, source, raw) = scanPass(clickAllow: true)
    if let c = code {
        logStep(1, "code=\(c) source=\(source ?? "?") raw=\(raw ?? c)")
        emit(Output(ok: true, code: c, action: "read_code", message: "ok", source: source, raw: raw))
    }
    if action == "clicked_allow", lastAction != "clicked_allow" {
        logStep(2, "clicked Allow")
        lastAction = "clicked_allow"
        usleep(2_000_000)
    } else {
        usleep(350_000)
    }
}

emit(Output(ok: false, code: nil, action: lastAction.isEmpty ? "none" : lastAction, message: "timeout", source: nil, raw: nil))
