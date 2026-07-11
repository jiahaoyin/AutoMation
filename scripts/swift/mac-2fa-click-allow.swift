#!/usr/bin/env swift
// 点击 macOS「允许」弹窗：先锁定正向 AXButton，再尝试 CGEvent/AXPress
// JSON: { "ok": true, "action": "attempted_allow", "source": "FollowUpUI" }

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
var releaseLeftButtonOnly = false

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
    if blob.contains("正用於登入") && blob.contains("新裝置") && !blob.contains("在網頁上輸入此驗證碼") { return true }
    if blob.contains("正被用於") && blob.contains("登入") { return true }
    if blob.contains("不允许") && blob.contains("允许") { return true }
    if blob.contains("不允許") && blob.contains("允許") { return true }
    if blob.lowercased().contains("don't allow") && blob.lowercased().contains("allow") { return true }
    return false
}

func looksLikeAppleLoginDialog(_ blob: String) -> Bool {
    if blob.contains("正用于") && blob.contains("登录") { return true }
    if blob.contains("正被用于") && blob.contains("登录") { return true }
    if blob.contains("正用於") && blob.contains("登入") { return true }
    if blob.contains("正被用於") && blob.contains("登入") { return true }
    let lower = blob.lowercased()
    let mentionsAppleAccount = lower.contains("apple id") || lower.contains("apple account")
    let mentionsLogin = lower.contains("sign in") || lower.contains("signing in") || lower.contains("log in")
    return mentionsAppleAccount && mentionsLogin
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

func releaseLeftMouseButton() -> Bool {
    let source = CGEventSource(stateID: .hidSystemState)
    let position = CGEvent(source: source)?.location ?? .zero
    guard let up = CGEvent(
        mouseEventSource: source,
        mouseType: .leftMouseUp,
        mouseCursorPosition: position,
        mouseButton: .left
    ) else {
        return false
    }
    up.post(tap: .cghidEventTap)
    return true
}

func clickScreenPoint(_ pt: CGPoint, holdMs: UInt32 = 280) -> Bool {
    let source = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left),
          let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left) else {
        return false
    }
    defer {
        up.post(tap: .cghidEventTap)
        usleep(80_000)
    }
    down.post(tap: .cghidEventTap)
    usleep(holdMs * 1000)
    return true
}

func buttonTitle(_ element: AXUIElement) -> String {
    axTexts(element).joined(separator: " ")
}

func isPositiveAllowButton(_ element: AXUIElement) -> Bool {
    guard axRole(element) == kAXButtonRole as String else { return false }
    let title = buttonTitle(element).trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = title.lowercased()
    let negativeTitles = ["Don't Allow", "Do Not Allow", "不允许", "不允許"]
    if negativeTitles.contains(where: { title.localizedCaseInsensitiveContains($0) }) ||
        lower.contains("don't allow") || lower.contains("do not allow") {
        return false
    }
    let positiveTitles = ["Allow", "允许", "允許"]
    if positiveTitles.contains(title) || lower == "allow" { return true }
    if title.contains("允许") || title.contains("允許") { return true }
    return lower.hasPrefix("allow ")
}

func clickElementCenter(_ element: AXUIElement) -> CGPoint? {
    guard let frame = frameOf(element) else {
        logStep("Allow button has no usable frame")
        return nil
    }
    let pt = cgClickPoint(from: frame)
    logStep("attempting coordinate click on eligible Allow button")
    guard clickScreenPoint(pt) else {
        logStep("CGEvent creation failed for eligible Allow button")
        return nil
    }
    return pt
}

func findAllowButton(in root: AXUIElement) -> AXUIElement? {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    while !queue.isEmpty {
        let (node, depth) = queue.removeFirst()
        if depth > 18 { continue }
        if isPositiveAllowButton(node) { return node }
        for child in axChildren(node) { queue.append((child, depth + 1)) }
    }
    return nil
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

struct AllowTarget {
    let window: AXUIElement
    let button: AXUIElement
}

func findAllowTarget(in app: NSRunningApplication) -> AllowTarget? {
    guard let kind = candidateKind(for: app) else { return nil }
    let appEl = AXUIElementCreateApplication(app.processIdentifier)
    for win in windowsForApp(appEl) {
        let blob = blobOf(win)
        if looksLikeCodeDialog(blob) { continue }
        guard let button = findAllowButton(in: win) else { continue }
        let target = AllowTarget(window: win, button: button)
        switch kind {
        case .dedicated:
            return target
        case .sharedHost:
            if looksLikeAppleLoginDialog(blob) { return target }
        }
    }
    return nil
}

func probeAllowCoordinates(in app: NSRunningApplication) -> CGPoint? {
    guard let target = findAllowTarget(in: app), let frame = frameOf(target.button) else {
        return nil
    }
    return cgClickPoint(from: frame)
}

func tryClickAllowInApp(_ app: NSRunningApplication) -> (Bool, CGPoint?) {
    guard findAllowTarget(in: app) != nil else { return (false, nil) }
    app.activate(options: [.activateIgnoringOtherApps])
    usleep(250_000)
    guard let target = findAllowTarget(in: app) else { return (false, nil) }
    raiseWindow(target.window)
    usleep(150_000)

    logStep("found eligible Allow button")
    if let pt = clickElementCenter(target.button) { return (true, pt) }
    if pressButton(target.button) { return (true, nil) }
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
    if CommandLine.arguments[i] == "--release-left-button" {
        releaseLeftButtonOnly = true
        i += 1
        continue
    }
    i += 1
}

if releaseLeftButtonOnly {
    let released = releaseLeftMouseButton()
    emit(Output(
        ok: released,
        action: released ? "released_left_button" : "none",
        source: nil,
        message: released ? "ok" : "release_failed",
        x: nil,
        y: nil
    ))
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
        guard candidateKind(for: app) != nil else { continue }
        if probeCoordsOnly {
            if let pt = probeAllowCoordinates(in: app) {
                emit(Output(ok: true, action: "coords", source: name, message: "ok", x: Int(pt.x), y: Int(pt.y)))
            }
            continue
        }
        let (attempted, pt) = tryClickAllowInApp(app)
        if attempted {
            emit(Output(ok: true, action: "attempted_allow", source: name, message: "ok", x: pt.map { Int($0.x) }, y: pt.map { Int($0.y) }))
        }
    }
    usleep(350_000)
}

emit(Output(ok: false, action: "none", source: nil, message: "timeout", x: nil, y: nil))
