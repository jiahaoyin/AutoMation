#!/usr/bin/env swift
// 系统设置 → 登录与安全性 → 双重认证 → 获取验证码
// JSON stdout: { "ok": true, "code": "126835", "message": "ok" }

import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

struct Output: Codable {
    let ok: Bool
    let code: String?
    let message: String
    let screenshot: String?
    let raw: String?
}

let settingsBundleIds = ["com.apple.systempreferences", "com.apple.SystemSettings"]
var cancelFilePath: String?

let accountUrls = [
    "x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings",
    "x-apple.systempreferences:com.apple.preferences.AppleIDPref",
    "x-apple.systempreferences:com.apple.AccountSettings.AccountsSettingsExtension",
]

func logStep(_ n: Int, _ msg: String) {
    FileHandle.standardError.write("[2FA-settings \(n)] \(msg)\n".data(using: .utf8)!)
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

func axBool(_ element: AXUIElement, _ attr: String) -> Bool? {
    guard let v: CFTypeRef = axCopy(element, attr) else { return nil }
    if let b = v as? Bool { return b }
    if let n = v as? NSNumber { return n.boolValue }
    return nil
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axCopy(element, kAXChildrenAttribute as String) ?? []
}

func axRole(_ element: AXUIElement) -> String {
    axString(element, kAXRoleAttribute as String) ?? ""
}

func axDescription(_ element: AXUIElement) -> String {
    [kAXDescriptionAttribute, kAXTitleAttribute, kAXRoleDescriptionAttribute, kAXValueAttribute, kAXPlaceholderValueAttribute]
        .compactMap { axString(element, $0 as String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: " | ")
}

func isContainerRole(_ role: String) -> Bool {
    [kAXGroupRole, kAXScrollAreaRole, kAXSplitGroupRole, kAXTabGroupRole, kAXSplitterRole, kAXWindowRole, kAXSheetRole, kAXPopoverRole]
        .map { $0 as String }
        .contains(role)
}

func extractSixDigit(_ text: String) -> String? {
    let digits = text.filter(\.isNumber)
    guard digits.count >= 6 else { return nil }
    return String(digits.prefix(6))
}

func looksLikeFormattedCode(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.range(of: #"^\d{3}\s\d{3}$"#, options: .regularExpression) != nil
}

func hasSettingsCodeAlert(_ blob: String) -> Bool {
    if blob.contains("Apple 账户验证码") { return true }
    if blob.contains("账户验证码") && (blob.contains("好") || blob.contains("OK")) { return true }
    if blob.lowercased().contains("verification code") && (blob.contains("OK") || blob.contains("好")) { return true }
    if blob.contains("验证码") && blob.contains("好") { return true }
    return false
}

func blobDeep(_ root: AXUIElement, maxNodes: Int = 800) -> String {
    var queue: [AXUIElement] = [root]
    var visited = 0
    var blob = ""
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        blob += " " + axDescription(node)
        if isContainerRole(axRole(node)) || visited <= 3 {
            queue.append(contentsOf: axChildren(node))
        }
    }
    return blob
}

func findFormattedCodeInTree(_ root: AXUIElement, maxNodes: Int = 600) -> (String, String)? {
    var queue: [AXUIElement] = [root]
    var visited = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        let blob = axDescription(node)
        if axRole(node) == kAXStaticTextRole as String || axRole(node) == kAXGroupRole as String {
            if looksLikeFormattedCode(blob), let code = extractSixDigit(blob) {
                return (code, blob)
            }
        }
        if isContainerRole(axRole(node)) || visited <= 2 {
            queue.append(contentsOf: axChildren(node))
        }
    }
    return nil
}

func collectSheetRoots(_ appElement: AXUIElement) -> [AXUIElement] {
    var roots: [AXUIElement] = []
    for w in collectWindows(appElement: appElement) {
        roots.append(w)
        for child in axChildren(w) {
            let role = axRole(child)
            if role == kAXSheetRole as String || role == "AXDialog" {
                roots.append(child)
            }
        }
    }
    return roots
}

func scanCodeFromAlertOnly(appElement: AXUIElement) -> (String, String)? {
    for root in collectSheetRoots(appElement) {
        let blob = blobDeep(root)
        guard hasSettingsCodeAlert(blob) else { continue }
        let preview = String(blob.prefix(200)).replacingOccurrences(of: "\n", with: " ")
        logStep(6, "alert blob: \(preview)")
        if let hit = findFormattedCodeInTree(root) { return hit }
    }
    return nil
}

func findSettingsApp() -> NSRunningApplication? {
    for app in NSWorkspace.shared.runningApplications {
        if let bid = app.bundleIdentifier, settingsBundleIds.contains(bid) { return app }
    }
    return NSWorkspace.shared.runningApplications.first {
        let n = $0.localizedName ?? ""
        return n.contains("System Settings") || n.contains("系统设置")
    }
}

func openAppleAccountSettings() {
    for s in accountUrls {
        if let url = URL(string: s) {
            NSWorkspace.shared.open(url)
            return
        }
    }
    _ = NSWorkspace.shared.launchApplication(
        withBundleIdentifier: "com.apple.systempreferences",
        options: [],
        additionalEventParamDescriptor: nil,
        launchIdentifier: nil
    )
}

func pressElement(_ element: AXUIElement) -> Bool {
    if axBool(element, kAXEnabledAttribute as String) == false { return false }
    let err = AXUIElementPerformAction(element, kAXPressAction as CFString)
    if err == .success { return true }
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(80_000)
    return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func clickNamed(in root: AXUIElement, names: [String], maxNodes: Int = 700) -> Bool {
    var queue: [AXUIElement] = [root]
    var visited = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        let role = axRole(node)
        let blob = axDescription(node)
        let matched = names.contains { blob == $0 || blob.contains($0) }
        if matched {
            if role == kAXButtonRole as String || role == "AXLink" || role == kAXMenuItemRole as String {
                if pressElement(node) { return true }
            } else if pressElement(node) {
                return true
            }
        }
        if isContainerRole(role) || visited <= 3 {
            queue.append(contentsOf: axChildren(node))
        }
    }
    return false
}

func collectWindows(appElement: AXUIElement) -> [AXUIElement] {
    var wins: [AXUIElement] = axCopy(appElement, kAXWindowsAttribute as String) ?? []
    if let focused: AXUIElement = axCopy(appElement, kAXFocusedWindowAttribute as String) {
        if !wins.contains(where: { $0 == focused }) { wins.append(focused) }
    }
    return wins
}

func findCodeInTree(_ root: AXUIElement, maxNodes: Int = 900) -> String? {
    let blob = blobDeep(root)
    guard hasSettingsCodeAlert(blob) else { return nil }
    return findFormattedCodeInTree(root)?.0
}

func scanCode(appElement: AXUIElement) -> String? {
    scanCodeFromAlertOnly(appElement: appElement)?.0
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

func closeVerificationCodeAlert(appElement: AXUIElement) {
    let alertVisible = collectSheetRoots(appElement).contains {
        hasSettingsCodeAlert(blobDeep($0))
    }
    if alertVisible {
        _ = clickNamed(in: appElement, names: ["好", "OK", "Done", "完成"])
    }
}

func stopIfCancelled(appElement: AXUIElement? = nil) {
    guard let path = cancelFilePath,
          FileManager.default.fileExists(atPath: path) else { return }
    if let appElement {
        closeVerificationCodeAlert(appElement: appElement)
    }
    emit(Output(ok: false, code: nil, message: "cancelled", screenshot: nil, raw: nil))
}

func cancellablePause(_ microseconds: UInt32, appElement: AXUIElement? = nil) {
    var remaining = microseconds
    while remaining > 0 {
        stopIfCancelled(appElement: appElement)
        let step = min(remaining, 100_000)
        usleep(step)
        remaining -= step
    }
    stopIfCancelled(appElement: appElement)
}

func captureSheetScreenshot(appElement: AXUIElement, pid: pid_t, path: String) -> Bool {
    for root in collectSheetRoots(appElement) {
        let blob = blobDeep(root)
        guard hasSettingsCodeAlert(blob) else { continue }
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(root, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(root, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let posVal = posRef, let sizeVal = sizeRef else { continue }
        var pt = CGPoint.zero
        var sz = CGSize.zero
        guard AXValueGetValue(posVal as! AXValue, .cgPoint, &pt),
              AXValueGetValue(sizeVal as! AXValue, .cgSize, &sz) else { continue }
        let rect = CGRect(origin: pt, size: sz)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        task.arguments = ["-x", "-R", "\(Int(rect.origin.x)),\(Int(rect.origin.y)),\(Int(rect.width)),\(Int(rect.height))", path]
        do {
            try task.run()
            task.waitUntilExit()
            if task.terminationStatus == 0, FileManager.default.fileExists(atPath: path) { return true }
        } catch {
            continue
        }
    }
    return captureWindowScreenshot(pid: pid, path: path)
}

func captureWindowScreenshot(pid: pid_t, path: String) -> Bool {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let infoList = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return false
    }
    for info in infoList {
        guard let ownerPid = info[kCGWindowOwnerPID as String] as? pid_t, ownerPid == pid else { continue }
        guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        guard let wid = info[kCGWindowNumber as String] as? CGWindowID else { continue }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        task.arguments = ["-x", "-l", String(wid), path]
        do {
            try task.run()
            task.waitUntilExit()
            if task.terminationStatus == 0, FileManager.default.fileExists(atPath: path) { return true }
        } catch {
            continue
        }
    }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-x", path]
    do {
        try task.run()
        task.waitUntilExit()
        return task.terminationStatus == 0 && FileManager.default.fileExists(atPath: path)
    } catch {
        return false
    }
}

var timeoutSec = 90
var screenshotPath: String?
var i = 1
let args = CommandLine.arguments
while i < args.count {
    if args[i] == "--timeout", i + 1 < args.count {
        timeoutSec = Int(args[i + 1]) ?? timeoutSec
        i += 2
        continue
    }
    if args[i] == "--screenshot", i + 1 < args.count {
        screenshotPath = args[i + 1]
        i += 2
        continue
    }
    if args[i] == "--cancel-file", i + 1 < args.count {
        cancelFilePath = args[i + 1]
        i += 2
        continue
    }
    i += 1
}

stopIfCancelled()
logStep(1, "opening Apple Account settings")
openAppleAccountSettings()
cancellablePause(1_500_000)

guard let app = findSettingsApp() else {
    emit(Output(ok: false, code: nil, message: "System Settings not found", screenshot: nil, raw: nil))
}

app.activate(options: [.activateIgnoringOtherApps])
let appElement = AXUIElementCreateApplication(app.processIdentifier)
cancellablePause(900_000, appElement: appElement)
logStep(2, "pid=\(app.processIdentifier)")

let signInSecurity = ["登录与安全性", "Sign-In & Security", "Sign-In and Security", "登录和安全性"]
let twoFactor = ["双重认证", "Two-Factor Authentication", "双因素认证"]
let getCodeBtn = ["获取验证码", "Get Verification Code", "Get a Verification Code"]

stopIfCancelled(appElement: appElement)
logStep(3, "click Sign-In & Security")
guard clickNamed(in: appElement, names: signInSecurity) else {
    emit(Output(ok: false, code: nil, message: "Sign-In & Security row not found", screenshot: nil, raw: nil))
}
cancellablePause(1_200_000, appElement: appElement)

stopIfCancelled(appElement: appElement)
logStep(4, "click Two-Factor Authentication")
guard clickNamed(in: appElement, names: twoFactor) else {
    emit(Output(ok: false, code: nil, message: "Two-Factor Authentication not found", screenshot: nil, raw: nil))
}
cancellablePause(1_200_000, appElement: appElement)

stopIfCancelled(appElement: appElement)
logStep(5, "click Get Verification Code")
guard clickNamed(in: appElement, names: getCodeBtn) else {
    emit(Output(ok: false, code: nil, message: "Get Verification Code button not found", screenshot: nil, raw: nil))
}

logStep(6, "waiting for verification code alert…")
cancellablePause(2_500_000, appElement: appElement)

let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))
var code: String?
var codeRaw: String?
var stableHits = 0
while Date() < deadline {
    cancellablePause(500_000, appElement: appElement)
    if let hit = scanCodeFromAlertOnly(appElement: appElement) {
        if code == hit.0 && codeRaw == hit.1 {
            stableHits += 1
        } else {
            code = hit.0
            codeRaw = hit.1
            stableHits = 1
        }
        if stableHits >= 2 { break }
    } else {
        code = nil
        codeRaw = nil
        stableHits = 0
    }
}

guard let finalCode = code, let finalRaw = codeRaw else {
    emit(Output(ok: false, code: nil, message: "verification code alert not found", screenshot: nil, raw: nil))
}

logStep(7, "code=\(finalCode) raw=\(finalRaw)")

var savedShot: String?
if let shotPath = screenshotPath {
    cancellablePause(700_000, appElement: appElement)
    if captureSheetScreenshot(appElement: appElement, pid: app.processIdentifier, path: shotPath) {
        savedShot = shotPath
        logStep(8, "screenshot=\(shotPath)")
    } else {
        logStep(8, "screenshot failed")
    }
}

stopIfCancelled(appElement: appElement)
_ = clickNamed(in: appElement, names: ["好", "OK", "Done", "完成"])
stopIfCancelled(appElement: appElement)
emit(Output(ok: true, code: finalCode, message: "ok", screenshot: savedShot, raw: finalRaw))
