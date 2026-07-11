#!/usr/bin/env swift
// 系统设置 → 登录与安全性 → 双重认证 → 获取验证码
// JSON stdout: { "ok": true, "code": "<six digits>", "message": "ok" }

import ApplicationServices
import AppKit
import Foundation

struct Output: Codable {
    let ok: Bool
    let code: String?
    let message: String
}

let settingsBundleIds: Set<String> = ["com.apple.systempreferences", "com.apple.SystemSettings"]
let settingsExecutableNames: Set<String> = ["System Settings", "System Preferences"]
var cancelFilePath: String?
var verificationCodeRequested = false

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
    if blob.contains("Apple 帳戶驗證碼") || blob.contains("Apple 帳號驗證碼") { return true }
    if (blob.contains("帳戶驗證碼") || blob.contains("帳號驗證碼")) && (blob.contains("好") || blob.contains("OK")) { return true }
    if blob.lowercased().contains("verification code") && (blob.contains("OK") || blob.contains("好")) { return true }
    if blob.contains("验证码") && blob.contains("好") { return true }
    if blob.contains("驗證碼") && blob.contains("好") { return true }
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

func findFormattedCodeInTree(_ root: AXUIElement, maxNodes: Int = 600) -> String? {
    var queue: [AXUIElement] = [root]
    var visited = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        let blob = axDescription(node)
        if axRole(node) == kAXStaticTextRole as String || axRole(node) == kAXGroupRole as String {
            if looksLikeFormattedCode(blob), let code = extractSixDigit(blob) {
                return code
            }
        }
        if isContainerRole(axRole(node)) || visited <= 2 {
            queue.append(contentsOf: axChildren(node))
        }
    }
    return nil
}

func collectSheetRoots(_ appElement: AXUIElement) -> [AXUIElement] {
    var sheets: [AXUIElement] = []
    var windows: [AXUIElement] = []
    for w in collectWindows(appElement: appElement) {
        windows.append(w)
        for child in axChildren(w) {
            let role = axRole(child)
            if role == kAXSheetRole as String || role == "AXDialog" {
                sheets.append(child)
            }
        }
    }
    return sheets + windows
}

func scanCodeFromAlertOnly(appElement: AXUIElement) -> String? {
    for root in collectSheetRoots(appElement) {
        let blob = blobDeep(root)
        guard hasSettingsCodeAlert(blob) else { continue }
        if let code = findFormattedCodeInTree(root) { return code }
    }
    return nil
}

func isAppleSystemExecutable(_ executableURL: URL?) -> Bool {
    guard let path = executableURL?.standardizedFileURL.path else { return false }
    return path.hasPrefix("/System/Library/") ||
        path.hasPrefix("/System/Applications/") ||
        path.hasPrefix("/usr/libexec/")
}

func isTrustedSystemSettings(_ app: NSRunningApplication) -> Bool {
    guard let bundleIdentifier = app.bundleIdentifier,
          settingsBundleIds.contains(bundleIdentifier),
          let executableURL = app.executableURL,
          isAppleSystemExecutable(executableURL) else { return false }
    return settingsExecutableNames.contains(executableURL.lastPathComponent)
}

func findSettingsApp() -> NSRunningApplication? {
    for app in NSWorkspace.shared.runningApplications {
        guard isTrustedSystemSettings(app) else { continue }
        return app
    }
    return nil
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

func emit(_ output: Output) -> Never {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    if let data = try? enc.encode(output) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
    exit(output.ok ? 0 : 1)
}

func closeVerificationCodeAlert(appElement: AXUIElement, waitForAlertMs: Int = 0) {
    let deadline = Date().addingTimeInterval(TimeInterval(max(0, waitForAlertMs)) / 1000.0)
    repeat {
        for root in collectSheetRoots(appElement) {
            guard hasSettingsCodeAlert(blobDeep(root)) else { continue }
            if clickNamed(in: root, names: ["好", "OK", "Done", "完成"]) {
                return
            }
        }
        if Date() >= deadline { return }
        usleep(100_000)
    } while true
}

func stopIfCancelled(appElement: AXUIElement? = nil) {
    guard let path = cancelFilePath,
          FileManager.default.fileExists(atPath: path) else { return }
    if let appElement {
        closeVerificationCodeAlert(
            appElement: appElement,
            waitForAlertMs: verificationCodeRequested ? 3_000 : 0
        )
    }
    emit(Output(ok: false, code: nil, message: "cancelled"))
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

var timeoutSec = 90
var i = 1
let args = CommandLine.arguments
while i < args.count {
    if args[i] == "--timeout", i + 1 < args.count {
        timeoutSec = Int(args[i + 1]) ?? timeoutSec
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
    emit(Output(ok: false, code: nil, message: "System Settings not found"))
}

app.activate(options: [.activateIgnoringOtherApps])
let appElement = AXUIElementCreateApplication(app.processIdentifier)
cancellablePause(900_000, appElement: appElement)
logStep(2, "System Settings ready")

let signInSecurity = ["登录与安全性", "登入與安全性", "Sign-In & Security", "Sign-In and Security", "登录和安全性"]
let twoFactor = ["双重认证", "雙重認證", "Two-Factor Authentication", "双因素认证"]
let getCodeBtn = ["获取验证码", "取得驗證碼", "Get Verification Code", "Get a Verification Code"]

stopIfCancelled(appElement: appElement)
logStep(3, "click Sign-In & Security")
guard clickNamed(in: appElement, names: signInSecurity) else {
    emit(Output(ok: false, code: nil, message: "Sign-In & Security row not found"))
}
cancellablePause(1_200_000, appElement: appElement)

stopIfCancelled(appElement: appElement)
logStep(4, "click Two-Factor Authentication")
guard clickNamed(in: appElement, names: twoFactor) else {
    emit(Output(ok: false, code: nil, message: "Two-Factor Authentication not found"))
}
cancellablePause(1_200_000, appElement: appElement)

stopIfCancelled(appElement: appElement)
logStep(5, "click Get Verification Code")
guard clickNamed(in: appElement, names: getCodeBtn) else {
    emit(Output(ok: false, code: nil, message: "Get Verification Code button not found"))
}
verificationCodeRequested = true

logStep(6, "waiting for verification code alert…")
cancellablePause(2_500_000, appElement: appElement)

let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))
var code: String?
var stableHits = 0
while Date() < deadline {
    cancellablePause(500_000, appElement: appElement)
    if let detectedCode = scanCodeFromAlertOnly(appElement: appElement) {
        if code == detectedCode {
            stableHits += 1
        } else {
            code = detectedCode
            stableHits = 1
        }
        if stableHits >= 2 { break }
    } else {
        code = nil
        stableHits = 0
    }
}

guard let finalCode = code else {
    closeVerificationCodeAlert(appElement: appElement, waitForAlertMs: 1_000)
    emit(Output(ok: false, code: nil, message: "verification code alert not found"))
}

logStep(7, "verification code detected")

stopIfCancelled(appElement: appElement)
closeVerificationCodeAlert(appElement: appElement, waitForAlertMs: 2_000)
stopIfCancelled(appElement: appElement)
emit(Output(ok: true, code: finalCode, message: "ok"))
