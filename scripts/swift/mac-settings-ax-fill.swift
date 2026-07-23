#!/usr/bin/env swift
// mac-settings-ax-fill — 直接 AX API 填 System Settings 登录框
// 用法:
//   mac-settings-ax-fill --phase email
//   mac-settings-ax-fill --phase continue
//   mac-settings-ax-fill --phase password
//   mac-settings-ax-fill --phase dump
// JSON → stdout；[step N] → stderr

import ApplicationServices
import AppKit
import Foundation

struct Output: Codable {
    let ok: Bool
    let phase: String
    let message: String
    let textFieldCount: Int?
}

let settingsBundleIds = ["com.apple.systempreferences", "com.apple.SystemSettings"]

// These AX identifiers are stable across the English and Chinese System
// Settings login surfaces observed on macOS 15. Field position is not: the
// sidebar search field and retained username field pollute ordinal scans after
// the login UI rehydrates.
let usernameFieldIdentifier = "USERNAME_TEXT_FIELD"
let passwordFieldIdentifier = "PASSWORD_TEXT_FIELD"
let loginButtonIdentifier = "LOGIN_BUTTON"

let loginWindowMarkers = [
    "一个账户", "尽享 Apple", "电子邮件或电话号码",
    "Email or phone", "Email or Phone", "Sign in to your Apple",
    "登录", "登入", "Sign In", "Sign in",
]

func logStep(_ n: Int, _ msg: String) {
    FileHandle.standardError.write("[step \(n)] \(msg)\n".data(using: .utf8)!)
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
    [kAXDescriptionAttribute, kAXTitleAttribute, kAXRoleDescriptionAttribute, kAXPlaceholderValueAttribute]
        .compactMap { axString(element, $0 as String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: " | ")
}

func axIdentifier(_ element: AXUIElement) -> String {
    axString(element, kAXIdentifierAttribute as String)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

func isTextInput(_ element: AXUIElement) -> Bool {
    let role = axRole(element)
    return role == kAXTextFieldRole as String ||
        role == kAXTextAreaRole as String ||
        role == kAXComboBoxRole as String ||
        role == "AXSecureTextField"
}

func isSearchField(_ element: AXUIElement) -> Bool {
    let desc = axDescription(element)
    return desc.contains("搜索") || desc.contains("Search")
}

func isContainerRole(_ role: String) -> Bool {
    [kAXGroupRole, kAXScrollAreaRole, kAXSplitGroupRole, kAXTabGroupRole, kAXSplitterRole, kAXWindowRole, kAXSheetRole]
        .map { $0 as String }
        .contains(role)
}

struct FieldHit {
    let element: AXUIElement
}

struct LoginControlHit {
    let element: AXUIElement
}

func bfsElements(root: AXUIElement, maxNodes: Int = 600) -> [AXUIElement] {
    var queue: [AXUIElement] = [root]
    var elements: [AXUIElement] = []
    var visited = 0

    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        elements.append(node)
        queue.append(contentsOf: axChildren(node))
    }
    return elements
}

func findLoginControl(
    appElement: AXUIElement,
    identifier: String,
    matches: (AXUIElement) -> Bool
) -> LoginControlHit? {
    guard let window = findLoginWindow(appElement: appElement) else { return nil }
    guard let element = bfsElements(root: window).first(where: {
        axIdentifier($0) == identifier && matches($0)
    }) else {
        return nil
    }
    return LoginControlHit(element: element)
}

func waitForLoginControl(
    appElement: AXUIElement,
    identifier: String,
    timeoutMs: UInt32 = 12_000,
    requireEnabled: Bool = false,
    matches: (AXUIElement) -> Bool
) -> LoginControlHit? {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000)
    while true {
        if let hit = findLoginControl(
            appElement: appElement,
            identifier: identifier,
            matches: matches
        ) {
            if !requireEnabled || axBool(hit.element, kAXEnabledAttribute as String) == true {
                return hit
            }
        }
        if Date() >= deadline { return nil }
        usleep(120_000)
    }
}

func waitForLoginTextField(
    appElement: AXUIElement,
    identifier: String
) -> LoginControlHit? {
    waitForLoginControl(
        appElement: appElement,
        identifier: identifier,
        requireEnabled: true,
        matches: isTextInput
    )
}

func pressLoginButton(appElement: AXUIElement) -> Bool {
    guard waitForLoginControl(
        appElement: appElement,
        identifier: loginButtonIdentifier,
        requireEnabled: true,
        matches: { axRole($0) == kAXButtonRole as String }
    ) != nil else {
        return false
    }
    guard let liveHit = findLoginControl(
        appElement: appElement,
        identifier: loginButtonIdentifier,
        matches: { axRole($0) == kAXButtonRole as String }
    ), axBool(liveHit.element, kAXEnabledAttribute as String) == true else {
        return false
    }
    return AXUIElementPerformAction(liveHit.element, kAXPressAction as CFString) == .success
}

func bfsTextFields(root: AXUIElement, maxNodes: Int = 500) -> [FieldHit] {
    var queue: [AXUIElement] = [root]
    var hits: [FieldHit] = []
    var visited = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        if isTextInput(node), !isSearchField(node) {
            hits.append(FieldHit(element: node))
        }
        if isContainerRole(axRole(node)) || visited == 1 {
            queue.append(contentsOf: axChildren(node))
        }
    }
    return hits
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

func findLoginWindow(appElement: AXUIElement) -> AXUIElement? {
    guard let windows: [AXUIElement] = axCopy(appElement, kAXWindowsAttribute as String) else { return nil }
    for w in windows {
        let title = axString(w, kAXTitleAttribute as String) ?? ""
        if loginWindowMarkers.contains(where: { title.contains($0) }) { return w }
    }
    return windows.first
}

func postCommandKey(_ key: CGKeyCode) {
    let src = CGEventSource(stateID: .combinedSessionState)
    let keyDown = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true)!
    keyDown.flags = .maskCommand
    let keyUp = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false)!
    keyUp.flags = .maskCommand
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)
}

func postCmdA() {
    postCommandKey(0x00)
}

func postCmdV() {
    postCommandKey(0x09)
}

func isEnabledAndFocused(_ field: AXUIElement) -> Bool {
    axBool(field, kAXEnabledAttribute as String) == true &&
        axBool(field, kAXFocusedAttribute as String) == true
}

func resolveFocusedLoginTextField(
    appElement: AXUIElement,
    identifier: String
) -> AXUIElement? {
    guard waitForLoginTextField(
        appElement: appElement,
        identifier: identifier
    ) != nil else {
        return nil
    }
    guard let liveHit = findLoginControl(
        appElement: appElement,
        identifier: identifier,
        matches: isTextInput
    ), axBool(liveHit.element, kAXEnabledAttribute as String) == true else {
        return nil
    }
    _ = AXUIElementPerformAction(liveHit.element, kAXRaiseAction as CFString)
    usleep(120_000)

    guard let readyHit = findLoginControl(
        appElement: appElement,
        identifier: identifier,
        matches: isTextInput
    ), axBool(readyHit.element, kAXEnabledAttribute as String) == true else {
        return nil
    }
    guard AXUIElementSetAttributeValue(
        readyHit.element,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    ) == .success else {
        return nil
    }
    usleep(80_000)

    guard let focusedHit = findLoginControl(
        appElement: appElement,
        identifier: identifier,
        matches: isTextInput
    ), isEnabledAndFocused(focusedHit.element) else {
        return nil
    }
    return focusedHit.element
}

func valueMatchesRequest(_ field: AXUIElement, _ text: String, isEmail: Bool) -> Bool {
    guard let value = axString(field, kAXValueAttribute as String) else { return false }
    if isEmail {
        return value.trimmingCharacters(in: .whitespacesAndNewlines) == text
    }
    return value.count >= min(4, text.count)
}

func focusAndSetLoginValue(
    appElement: AXUIElement,
    identifier: String,
    text: String,
    isEmail: Bool
) -> Bool {
    guard let focusedField = resolveFocusedLoginTextField(
        appElement: appElement,
        identifier: identifier
    ) else {
        return false
    }

    _ = AXUIElementSetAttributeValue(focusedField, kAXValueAttribute as CFString, text as CFString)
    usleep(200_000)
    guard let afterValueHit = findLoginControl(
        appElement: appElement,
        identifier: identifier,
        matches: isTextInput
    ), isEnabledAndFocused(afterValueHit.element) else {
        return false
    }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    usleep(100_000)
    guard let beforeSelectHit = findLoginControl(
        appElement: appElement,
        identifier: identifier,
        matches: isTextInput
    ), isEnabledAndFocused(beforeSelectHit.element) else {
        return false
    }
    postCmdA()
    usleep(100_000)

    guard let beforePasteHit = findLoginControl(
        appElement: appElement,
        identifier: identifier,
        matches: isTextInput
    ), isEnabledAndFocused(beforePasteHit.element) else {
        return false
    }
    postCmdV()
    usleep(350_000)

    guard let finalHit = findLoginControl(
        appElement: appElement,
        identifier: identifier,
        matches: isTextInput
    ), axBool(finalHit.element, kAXEnabledAttribute as String) == true else {
        return false
    }
    return valueMatchesRequest(finalHit.element, text, isEmail: isEmail)
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

var phase = "all"
var i = 1
let args = CommandLine.arguments
while i < args.count {
    if args[i] == "--phase", i + 1 < args.count { phase = args[i + 1]; i += 2; continue }
    i += 1
}

logStep(1, "activating System Settings")
_ = NSWorkspace.shared.launchApplication(
    withBundleIdentifier: "com.apple.systempreferences",
    options: [],
    additionalEventParamDescriptor: nil,
    launchIdentifier: nil
)
usleep(900_000)

guard let app = findSettingsApp() else {
    emit(Output(ok: false, phase: phase, message: "System Settings process not found", textFieldCount: nil))
}

app.activate(options: [.activateIgnoringOtherApps])
usleep(700_000)

let appElement = AXUIElementCreateApplication(app.processIdentifier)
logStep(2, "found System Settings pid=\(app.processIdentifier)")

guard let window = findLoginWindow(appElement: appElement) else {
    emit(Output(ok: false, phase: phase, message: "login window not found", textFieldCount: nil))
}

logStep(3, "found login window")

let fields = bfsTextFields(root: window)
logStep(4, "BFS found \(fields.count) non-search text fields")

if phase == "dump" {
    emit(Output(ok: true, phase: "dump", message: "ok", textFieldCount: fields.count))
}

switch phase {
case "email":
    let email = ProcessInfo.processInfo.environment["APPLE_SCRIPT_APPLE_ID"] ?? ""
    guard !email.isEmpty else {
        emit(Output(ok: false, phase: phase, message: "missing email value", textFieldCount: fields.count))
    }
    guard waitForLoginTextField(
        appElement: appElement,
        identifier: usernameFieldIdentifier
    ) != nil else {
        emit(Output(ok: false, phase: phase, message: "exact username field not found", textFieldCount: fields.count))
    }
    logStep(5, "filling email")
    guard focusAndSetLoginValue(
        appElement: appElement,
        identifier: usernameFieldIdentifier,
        text: email,
        isEmail: true
    ) else {
        emit(Output(ok: false, phase: phase, message: "email verification failed", textFieldCount: fields.count))
    }
    logStep(6, "email ok")
    emit(Output(ok: true, phase: phase, message: "ok", textFieldCount: fields.count))

case "continue":
    logStep(7, "clicking continue")
    guard pressLoginButton(appElement: appElement) else {
        emit(Output(ok: false, phase: phase, message: "enabled login button not found", textFieldCount: fields.count))
    }
    logStep(8, "continue ok")
    emit(Output(ok: true, phase: phase, message: "ok", textFieldCount: fields.count))

case "password":
    let password = ProcessInfo.processInfo.environment["APPLE_SCRIPT_PASSWORD"] ?? ""
    guard !password.isEmpty else {
        emit(Output(ok: false, phase: phase, message: "missing password value", textFieldCount: fields.count))
    }
    guard waitForLoginTextField(
        appElement: appElement,
        identifier: passwordFieldIdentifier
    ) != nil else {
        emit(Output(ok: false, phase: phase, message: "exact password field not found", textFieldCount: fields.count))
    }
    logStep(9, "filling password")
    guard focusAndSetLoginValue(
        appElement: appElement,
        identifier: passwordFieldIdentifier,
        text: password,
        isEmail: false
    ) else {
        emit(Output(ok: false, phase: phase, message: "password fill failed", textFieldCount: fields.count))
    }
    logStep(10, "password ok")
    guard pressLoginButton(appElement: appElement) else {
        emit(Output(ok: false, phase: phase, message: "enabled login button not found after password", textFieldCount: fields.count))
    }
    logStep(11, "submit clicked")
    emit(Output(ok: true, phase: phase, message: "ok", textFieldCount: fields.count))

case "all":
    let appleId = ProcessInfo.processInfo.environment["APPLE_SCRIPT_APPLE_ID"] ?? ""
    let password = ProcessInfo.processInfo.environment["APPLE_SCRIPT_PASSWORD"] ?? ""
    guard !appleId.isEmpty else {
        emit(Output(ok: false, phase: phase, message: "missing apple id", textFieldCount: fields.count))
    }
    guard !password.isEmpty else {
        emit(Output(ok: false, phase: phase, message: "missing password value", textFieldCount: fields.count))
    }
    guard waitForLoginTextField(
        appElement: appElement,
        identifier: usernameFieldIdentifier
    ) != nil else {
        emit(Output(ok: false, phase: phase, message: "exact username field not found", textFieldCount: fields.count))
    }
    logStep(5, "filling email (all phase)")
    guard focusAndSetLoginValue(
        appElement: appElement,
        identifier: usernameFieldIdentifier,
        text: appleId,
        isEmail: true
    ) else {
        emit(Output(ok: false, phase: phase, message: "email failed", textFieldCount: fields.count))
    }
    logStep(6, "email ok — clicking continue")
    guard pressLoginButton(appElement: appElement) else {
        emit(Output(ok: false, phase: phase, message: "enabled login button not found", textFieldCount: fields.count))
    }
    guard waitForLoginTextField(
        appElement: appElement,
        identifier: passwordFieldIdentifier
    ) != nil else {
        emit(Output(ok: false, phase: phase, message: "exact password field not found", textFieldCount: fields.count))
    }
    logStep(9, "filling password (all phase)")
    guard focusAndSetLoginValue(
        appElement: appElement,
        identifier: passwordFieldIdentifier,
        text: password,
        isEmail: false
    ) else {
        emit(Output(ok: false, phase: phase, message: "password fill failed", textFieldCount: fields.count))
    }
    logStep(10, "password ok")
    guard pressLoginButton(appElement: appElement) else {
        emit(Output(ok: false, phase: phase, message: "enabled login button not found after password", textFieldCount: fields.count))
    }
    emit(Output(ok: true, phase: phase, message: "ok", textFieldCount: fields.count))

default:
    emit(Output(ok: false, phase: phase, message: "unknown phase: \(phase)", textFieldCount: nil))
}
