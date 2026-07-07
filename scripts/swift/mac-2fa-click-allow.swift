#!/usr/bin/env swift
// 点击 macOS「允许」弹窗：AX 定位 + CGEvent 鼠标点击 + 默认按钮
// JSON: { "ok": true, "action": "clicked_allow", "source": "FollowUpUI" }

import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

struct Output: Codable {
    let ok: Bool
    let action: String?
    let source: String?
    let message: String
    let x: Int?
    let y: Int?
}

var probeCoordsOnly = false

let priorityApps = ["FollowUpUI", "CoreAuthUI", "AuthenticationServicesAgent", "SecurityAgent", "UserNotificationCenter", "akd", "loginwindow"]

func logStep(_ msg: String) {
    FileHandle.standardError.write("[2FA-allow] \(msg)\n".data(using: .utf8)!)
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

func looksLikeAllowDialog(_ blob: String) -> Bool {
    if blob.contains("正用于登录") && blob.contains("新设备") && !blob.contains("在网页上输入此验证码") { return true }
    if blob.contains("正被用于") && blob.contains("登录") { return true }
    if blob.contains("不允许") && blob.contains("允许") { return true }
    if blob.lowercased().contains("don't allow") && blob.lowercased().contains("allow") { return true }
    return false
}

func looksLikeCodeDialog(_ blob: String) -> Bool {
    blob.contains("在网页上输入此验证码") || (blob.contains("在网页上输入") && blob.contains("验证码"))
}

func collectBlob(_ root: AXUIElement, depth: Int, maxDepth: Int, blob: inout String) {
    if depth > maxDepth { return }
    for t in axTexts(root) { blob += " " + t }
    for child in axChildren(root) {
        collectBlob(child, depth: depth + 1, maxDepth: maxDepth, blob: &blob)
    }
}

func blobOf(_ root: AXUIElement) -> String {
    var b = ""
    collectBlob(root, depth: 0, maxDepth: 16, blob: &b)
    return b
}

func pressButton(_ element: AXUIElement) -> Bool {
    if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return true }
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(80_000)
    return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func frameOf(_ element: AXUIElement) -> CGRect? {
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let posVal = posRef, let sizeVal = sizeRef else { return nil }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    guard AXValueGetValue(posVal as! AXValue, .cgPoint, &pt),
          AXValueGetValue(sizeVal as! AXValue, .cgSize, &sz) else { return nil }
    return CGRect(origin: pt, size: sz)
}

/// AX 与 CGEvent 均使用屏幕全局坐标，原点在主屏左上角
func cgClickPoint(from axFrame: CGRect) -> CGPoint {
    CGPoint(x: axFrame.midX, y: axFrame.midY)
}

func clickScreenPoint(_ pt: CGPoint, holdMs: UInt32 = 280) -> Bool {
    let source = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left) else {
        return false
    }
    down.post(tap: .cghidEventTap)
    usleep(holdMs * 1000)
    guard let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left) else {
        return false
    }
    up.post(tap: .cghidEventTap)
    usleep(80_000)
    if let up2 = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left) {
        up2.post(tap: .cghidEventTap)
    }
    return true
}

func postReturnKey() -> Bool {
    let source = CGEventSource(stateID: .hidSystemState)
    let vkReturn: CGKeyCode = 36
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: vkReturn, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: vkReturn, keyDown: false) else {
        return false
    }
    down.post(tap: .cghidEventTap)
    usleep(100_000)
    up.post(tap: .cghidEventTap)
    return true
}

func buttonTitle(_ element: AXUIElement) -> String {
    axTexts(element).joined(separator: " ")
}

func clickElementCenter(_ element: AXUIElement, label: String) -> CGPoint? {
    guard let frame = frameOf(element) else {
        logStep("no frame for button \"\(label)\"")
        return nil
    }
    let pt = cgClickPoint(from: frame)
    logStep("click \"\(label)\" at \(Int(pt.x)),\(Int(pt.y)) frame=\(Int(frame.origin.x)),\(Int(frame.origin.y)) \(Int(frame.width))x\(Int(frame.height))")
    _ = clickScreenPoint(pt)
    return pt
}

func findAllowButton(in root: AXUIElement) -> AXUIElement? {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var buttons: [AXUIElement] = []
    while !queue.isEmpty {
        let (node, depth) = queue.removeFirst()
        if depth > 18 { continue }
        if axRole(node) == kAXButtonRole as String {
            buttons.append(node)
            let title = buttonTitle(node)
            if title == "允许" || title == "Allow" {
                return node
            }
            if title.contains("允许") && !title.contains("不允许") && !title.lowercased().contains("don't") {
                return node
            }
        }
        for child in axChildren(node) { queue.append((child, depth + 1)) }
    }
    if buttons.count >= 2 { return buttons.last }
    return buttons.last
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

func raiseWindow(_ win: AXUIElement) {
    AXUIElementPerformAction(win, kAXRaiseAction as CFString)
}

func tryClickAllowInApp(_ app: NSRunningApplication) -> (Bool, CGPoint?) {
    let appName = app.localizedName ?? ""
    app.activate(options: [.activateIgnoringOtherApps])
    usleep(250_000)
    let appEl = AXUIElementCreateApplication(app.processIdentifier)
    for win in windowsForApp(appEl) {
        let blob = blobOf(win)
        if looksLikeCodeDialog(blob) { continue }
        guard looksLikeAllowDialog(blob) else { continue }
        logStep("found allow dialog in \(appName): \(blob.prefix(80))")
        raiseWindow(win)
        usleep(150_000)

        if let defaultBtn: AXUIElement = axCopy(win, kAXDefaultButtonAttribute as String) {
            let title = buttonTitle(defaultBtn)
            logStep("default button: \"\(title)\"")
            if probeCoordsOnly, let frame = frameOf(defaultBtn) {
                return (true, cgClickPoint(from: frame))
            }
            if let pt = clickElementCenter(defaultBtn, label: title) { return (true, pt) }
            if pressButton(defaultBtn) { return (true, nil) }
        }
        if let btn = findAllowButton(in: win) {
            let title = buttonTitle(btn)
            if probeCoordsOnly, let frame = frameOf(btn) {
                return (true, cgClickPoint(from: frame))
            }
            if let pt = clickElementCenter(btn, label: title) { return (true, pt) }
            if pressButton(btn) { return (true, nil) }
        }
        logStep("fallback Return key for \(appName)")
        _ = postReturnKey()
        usleep(400_000)
        return (true, nil)
    }
    return (false, nil)
}

func emit(_ output: Output) -> Never {
    let enc = JSONEncoder()
    if let data = try? enc.encode(output) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
    exit(output.ok ? 0 : 1)
}

var timeoutSec = 6
var i = 1
while i < CommandLine.arguments.count {
    if CommandLine.arguments[i] == "--timeout", i + 1 < CommandLine.arguments.count {
        timeoutSec = Int(CommandLine.arguments[i + 1]) ?? timeoutSec
        i += 2
        continue
    }
    if CommandLine.arguments[i] == "--probe-coords" {
        probeCoordsOnly = true
        i += 1
        continue
    }
    i += 1
}

let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))
while Date() < deadline {
    var apps = NSWorkspace.shared.runningApplications
    apps.sort { a, b in
        let an = a.localizedName ?? ""
        let bn = b.localizedName ?? ""
        let ar = priorityApps.firstIndex { an.contains($0) } ?? 99
        let br = priorityApps.firstIndex { bn.contains($0) } ?? 99
        return ar < br
    }
    for app in apps {
        let name = app.localizedName ?? ""
        let isPriority = priorityApps.contains { name.contains($0) }
        if !isPriority && app.activationPolicy != .regular { continue }
        let (clicked, pt) = tryClickAllowInApp(app)
        if clicked {
            if probeCoordsOnly, let pt = pt {
                emit(Output(ok: true, action: "coords", source: name, message: "ok", x: Int(pt.x), y: Int(pt.y)))
            }
            emit(Output(ok: true, action: "clicked_allow", source: name, message: "ok", x: pt.map { Int($0.x) }, y: pt.map { Int($0.y) }))
        }
    }
    usleep(350_000)
}

emit(Output(ok: false, action: "none", source: nil, message: "timeout", x: nil, y: nil))
