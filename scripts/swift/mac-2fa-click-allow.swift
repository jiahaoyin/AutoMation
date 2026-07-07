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
    if blob.contains("正用于登录") && blob.contains("新设备") { return true }
    if blob.contains("正被用于") && blob.contains("登录") { return true }
    if blob.contains("不允许") && blob.contains("允许") { return true }
    if blob.lowercased().contains("don't allow") && blob.lowercased().contains("allow") { return true }
    return false
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

/// AX 全局坐标（左上原点）→ CGEvent 屏幕坐标
func cgClickPoint(from axFrame: CGRect) -> CGPoint {
    let axCenter = CGPoint(x: axFrame.midX, y: axFrame.midY)
    let screens = NSScreen.screens
    guard !screens.isEmpty else { return axCenter }

    let mainMaxY = screens.map { $0.frame.maxY }.max() ?? 0
    for screen in screens {
        let f = screen.frame
        let topLeftY = mainMaxY - f.maxY
        let axRect = CGRect(x: f.origin.x, y: topLeftY, width: f.width, height: f.height)
        if axRect.contains(axCenter) {
            return axCenter
        }
    }

    // 单屏回退：部分系统 AX Y 需翻转
    if let main = NSScreen.main {
        let flipped = CGPoint(x: axCenter.x, y: main.frame.height - axCenter.y)
        logStep("ax center \(Int(axCenter.x)),\(Int(axCenter.y)) → cg \(Int(flipped.x)),\(Int(flipped.y))")
        return flipped
    }
    return axCenter
}

func clickScreenPoint(_ pt: CGPoint) -> Bool {
    let source = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left) else {
        return false
    }
    down.post(tap: .cghidEventTap)
    usleep(180_000)
    guard let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left) else {
        return false
    }
    up.post(tap: .cghidEventTap)
    usleep(60_000)
    // 防止「按下未弹起」：再发一次 mouseUp
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
    usleep(80_000)
    up.post(tap: .cghidEventTap)
    return true
}

func clickElementCenter(_ element: AXUIElement) -> CGPoint? {
    guard let frame = frameOf(element) else { return nil }
    let pt = cgClickPoint(from: frame)
    logStep("click at \(Int(pt.x)),\(Int(pt.y))")
    _ = clickScreenPoint(pt)
    return pt
}

func probeAllowButton(in root: AXUIElement) -> (AXUIElement, CGPoint)? {
    if let defaultBtn: AXUIElement = axCopy(root, kAXDefaultButtonAttribute as String),
       let frame = frameOf(defaultBtn) {
        return (defaultBtn, cgClickPoint(from: frame))
    }
    if let btn = findAllowButton(in: root), let frame = frameOf(btn) {
        return (btn, cgClickPoint(from: frame))
    }
    return nil
}

func findAllowButton(in root: AXUIElement) -> AXUIElement? {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var buttons: [AXUIElement] = []
    while !queue.isEmpty {
        let (node, depth) = queue.removeFirst()
        if depth > 18 { continue }
        if axRole(node) == kAXButtonRole as String {
            buttons.append(node)
            let title = axTexts(node).joined(separator: " ")
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

func tryClickAllowInApp(_ app: NSRunningApplication) -> (Bool, CGPoint?) {
    let appName = app.localizedName ?? ""
    app.activate(options: [.activateIgnoringOtherApps])
    usleep(200_000)
    let appEl = AXUIElementCreateApplication(app.processIdentifier)
    for win in windowsForApp(appEl) {
        let blob = blobOf(win)
        guard looksLikeAllowDialog(blob) else { continue }
        logStep("found allow dialog in \(appName)")
        _ = postReturnKey()
        usleep(350_000)
        if let defaultBtn: AXUIElement = axCopy(win, kAXDefaultButtonAttribute as String) {
            if probeCoordsOnly, let frame = frameOf(defaultBtn) {
                return (true, cgClickPoint(from: frame))
            }
            if let pt = clickElementCenter(defaultBtn) { return (true, pt) }
            if pressButton(defaultBtn) { return (true, nil) }
        }
        if let btn = findAllowButton(in: win) {
            if probeCoordsOnly, let frame = frameOf(btn) {
                return (true, cgClickPoint(from: frame))
            }
            if let pt = clickElementCenter(btn) { return (true, pt) }
            if pressButton(btn) { return (true, nil) }
        }
    }
    if looksLikeAllowDialog(blobOf(appEl)), let btn = findAllowButton(in: appEl) {
        if probeCoordsOnly, let frame = frameOf(btn) {
            return (true, cgClickPoint(from: frame))
        }
        if pressButton(btn) { return (true, clickElementCenter(btn)) }
        if let pt = clickElementCenter(btn) { return (true, pt) }
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
