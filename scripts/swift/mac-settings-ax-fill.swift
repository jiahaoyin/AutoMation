#!/usr/bin/env swift
// mac-settings-ax-fill — 直接 AX API 填 System Settings 登录框
// 用法:
//   mac-settings-ax-fill --phase email --value "user@example.com"
//   mac-settings-ax-fill --phase continue
//   mac-settings-ax-fill --phase password --value "secret"
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
    let windowTitle: String?
    let fieldDescriptions: [String]?
}

let settingsBundleIds = ["com.apple.systempreferences", "com.apple.SystemSettings"]

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

func isTextInput(_ element: AXUIElement) -> Bool {
    let role = axRole(element)
    return role == kAXTextFieldRole as String || role == kAXTextAreaRole as String || role == kAXComboBoxRole as String
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
    let description: String
}

func bfsTextFields(root: AXUIElement, maxNodes: Int = 500) -> [FieldHit] {
    var queue: [AXUIElement] = [root]
    var hits: [FieldHit] = []
    var visited = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        if isTextInput(node), !isSearchField(node) {
            hits.append(FieldHit(element: node, description: axDescription(node)))
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

func postCmdV() {
    let src = CGEventSource(stateID: .combinedSessionState)
    let vDown = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: true)!
    vDown.flags = .maskCommand
    let vUp = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: false)!
    vUp.flags = .maskCommand
    vDown.post(tap: .cghidEventTap)
    vUp.post(tap: .cghidEventTap)
}

func focusField(_ field: AXUIElement) {
    AXUIElementPerformAction(field, kAXRaiseAction as CFString)
    usleep(120_000)
    AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(80_000)
}

func focusAndSetValue(_ field: AXUIElement, _ text: String, isEmail: Bool) -> Bool {
    focusField(field)

    if AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, text as CFString) == .success {
        usleep(250_000)
        if let val = axString(field, kAXValueAttribute as String) {
            if isEmail { return val.contains("@") }
            return val.count >= min(4, text.count)
        }
    }

    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    usleep(100_000)
    focusField(field)
    AXUIElementPerformAction(field, kAXPressAction as CFString)
    usleep(100_000)
    postCmdV()
    usleep(350_000)

    if let val = axString(field, kAXValueAttribute as String) {
        if isEmail { return val.contains("@") }
        return val.count >= min(4, text.count)
    }
    return false
}

func clickButton(in root: AXUIElement, names: [String]) -> Bool {
    var queue: [AXUIElement] = [root]
    var visited = 0
    while !queue.isEmpty && visited < 400 {
        let node = queue.removeFirst()
        visited += 1
        if axRole(node) == kAXButtonRole as String {
            let title = axString(node, kAXTitleAttribute as String) ?? axDescription(node)
            for name in names where title == name || title.contains(name) {
                if axBool(node, kAXEnabledAttribute as String) != false {
                    AXUIElementPerformAction(node, kAXPressAction as CFString)
                    return true
                }
            }
        }
        if isContainerRole(axRole(node)) {
            queue.append(contentsOf: axChildren(node))
        }
    }
    return false
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
var value = ""
var i = 1
let args = CommandLine.arguments
while i < args.count {
    if args[i] == "--phase", i + 1 < args.count { phase = args[i + 1]; i += 2; continue }
    if args[i] == "--value", i + 1 < args.count { value = args[i + 1]; i += 2; continue }
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
    emit(Output(ok: false, phase: phase, message: "System Settings process not found", textFieldCount: nil, windowTitle: nil, fieldDescriptions: nil))
}

app.activate(options: [.activateIgnoringOtherApps])
usleep(700_000)

let appElement = AXUIElementCreateApplication(app.processIdentifier)
logStep(2, "found System Settings pid=\(app.processIdentifier)")

guard let window = findLoginWindow(appElement: appElement) else {
    emit(Output(ok: false, phase: phase, message: "login window not found", textFieldCount: nil, windowTitle: nil, fieldDescriptions: nil))
}

let winTitle = axString(window, kAXTitleAttribute as String) ?? ""
logStep(3, "found window title=\(winTitle)")

var fields = bfsTextFields(root: window)
let descs = fields.map(\.description)
logStep(4, "BFS found \(fields.count) non-search text fields: \(descs.joined(separator: "; "))")

if phase == "dump" {
    emit(Output(ok: true, phase: "dump", message: "ok", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: descs))
}

switch phase {
case "email":
    guard !value.isEmpty else {
        emit(Output(ok: false, phase: phase, message: "missing --value", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: descs))
    }
    guard let f = fields.first else {
        emit(Output(ok: false, phase: phase, message: "no email field", textFieldCount: 0, windowTitle: winTitle, fieldDescriptions: descs))
    }
    logStep(5, "filling email")
    guard focusAndSetValue(f.element, value, isEmail: true) else {
        emit(Output(ok: false, phase: phase, message: "email verification failed", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: descs))
    }
    logStep(6, "email ok")
    emit(Output(ok: true, phase: phase, message: "ok", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: descs))

case "continue":
    logStep(7, "clicking continue")
    guard clickButton(in: window, names: ["Continue", "继续", "Next", "下一步"]) else {
        emit(Output(ok: false, phase: phase, message: "continue button not found", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: descs))
    }
    logStep(8, "continue ok")
    emit(Output(ok: true, phase: phase, message: "ok", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: descs))

case "password":
    guard !value.isEmpty else {
        emit(Output(ok: false, phase: phase, message: "missing --value", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: descs))
    }
    fields = bfsTextFields(root: window)
    let pwdHit = fields.count >= 2 ? fields[1] : fields.last
    guard let pf = pwdHit else {
        emit(Output(ok: false, phase: phase, message: "password field not found", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: fields.map(\.description)))
    }
    logStep(9, "filling password")
    guard focusAndSetValue(pf.element, value, isEmail: false) else {
        emit(Output(ok: false, phase: phase, message: "password fill failed", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: fields.map(\.description)))
    }
    logStep(10, "password ok")
    _ = clickButton(in: window, names: ["Sign In", "Sign in", "登录", "登入", "Continue", "继续"])
    logStep(11, "submit clicked")
    emit(Output(ok: true, phase: phase, message: "ok", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: fields.map(\.description)))

case "all":
    let appleId = value.isEmpty ? (ProcessInfo.processInfo.environment["APPLE_SCRIPT_APPLE_ID"] ?? "") : value
    let password = ProcessInfo.processInfo.environment["APPLE_SCRIPT_PASSWORD"] ?? ""
    guard !appleId.isEmpty else {
        emit(Output(ok: false, phase: phase, message: "missing apple id", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: descs))
    }
    guard let emailHit = fields.first else {
        emit(Output(ok: false, phase: phase, message: "no email field", textFieldCount: 0, windowTitle: winTitle, fieldDescriptions: descs))
    }
    logStep(5, "filling email (all phase)")
    guard focusAndSetValue(emailHit.element, appleId, isEmail: true) else {
        emit(Output(ok: false, phase: phase, message: "email failed", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: descs))
    }
    logStep(6, "email ok — clicking continue")
    _ = clickButton(in: window, names: ["Continue", "继续", "Next", "下一步"])
    usleep(2_000_000)
    fields = bfsTextFields(root: window)
    if !password.isEmpty, fields.count >= 2 {
        logStep(9, "filling password (all phase)")
        if focusAndSetValue(fields[1].element, password, isEmail: false) {
            logStep(10, "password ok")
            _ = clickButton(in: window, names: ["Sign In", "Sign in", "登录", "登入"])
        }
    } else if !password.isEmpty, fields.count == 1 {
        logStep(9, "password field not visible yet — email-only step done")
    }
    emit(Output(ok: true, phase: phase, message: "ok", textFieldCount: fields.count, windowTitle: winTitle, fieldDescriptions: fields.map(\.description)))

default:
    emit(Output(ok: false, phase: phase, message: "unknown phase: \(phase)", textFieldCount: nil, windowTitle: winTitle, fieldDescriptions: descs))
}
