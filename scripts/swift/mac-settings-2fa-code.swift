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
let axSheetsAttribute = "AXSheets"
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

func axSheets(_ element: AXUIElement) -> [AXUIElement] {
    axCopy(element, axSheetsAttribute) ?? []
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

let exactTextAttributes = [
    kAXTitleAttribute as String,
    kAXDescriptionAttribute as String,
    kAXValueAttribute as String,
]

let verificationAlertTitles = [
    "Apple 账户验证码",
    "Apple 帳戶驗證碼",
    "Apple 帳號驗證碼",
    "Apple Account Verification Code",
    "Apple ID Verification Code",
]

let verificationAlertCloseButtons = ["好", "OK"]

func normalizedAXText(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

func axExactTexts(_ element: AXUIElement) -> [String] {
    exactTextAttributes
        .compactMap { axString(element, $0) }
        .map(normalizedAXText)
        .filter { !$0.isEmpty }
}

func hasExactName(_ element: AXUIElement, names: [String]) -> Bool {
    let expected = Set(names.map(normalizedAXText))
    return axExactTexts(element).contains(where: expected.contains)
}

func sixDigitCodeCandidates(_ text: String) -> Set<String> {
    let candidate = normalizedAXText(text)
    let pattern = #"(?<![0-9])(?:[0-9]{3} [0-9]{3}|[0-9]{6})(?![0-9])"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let fullRange = NSRange(candidate.startIndex..<candidate.endIndex, in: candidate)
    var codes = Set<String>()
    for match in regex.matches(in: candidate, range: fullRange) {
        guard let range = Range(match.range, in: candidate) else { continue }
        codes.insert(String(candidate[range]).replacingOccurrences(of: " ", with: ""))
    }
    return codes
}

func axParent(_ element: AXUIElement) -> AXUIElement? {
    axCopy(element, kAXParentAttribute as String)
}

func isDedicatedDialogWindow(_ element: AXUIElement) -> Bool {
    guard axRole(element) == kAXWindowRole as String else { return false }
    let subrole = axString(element, kAXSubroleAttribute as String) ?? ""
    return subrole == "AXDialog" ||
        subrole == "AXSystemDialog" ||
        axBool(element, kAXModalAttribute as String) == true
}

func treeContainsExactText(_ root: AXUIElement, names: [String], maxNodes: Int = 900) -> Bool {
    var queue: [AXUIElement] = [root]
    var visited = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        if axBool(node, kAXHiddenAttribute as String) != true,
           axFrame(node) != nil,
           hasExactName(node, names: names) { return true }
        queue.append(contentsOf: axChildren(node))
    }
    return false
}

func elementBelongsToProcess(_ element: AXUIElement, pid: pid_t) -> Bool {
    var elementPid: pid_t = 0
    return AXUIElementGetPid(element, &elementPid) == .success && elementPid == pid
}

func supportsPressAction(_ element: AXUIElement) -> Bool {
    var actions: CFArray?
    guard AXUIElementCopyActionNames(element, &actions) == .success,
          let names = actions as? [String] else { return false }
    return names.contains(kAXPressAction as String)
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let position = axPoint(element, attribute: kAXPositionAttribute as String),
          let size = axSize(element, attribute: kAXSizeAttribute as String),
          position.x.isFinite,
          position.y.isFinite,
          size.width.isFinite,
          size.height.isFinite,
          size.width >= 8,
          size.height >= 8 else { return nil }
    return CGRect(origin: position, size: size)
}

func findExactButton(
    in root: AXUIElement,
    names: [String],
    expectedPid: pid_t,
    maxNodes: Int = 900
) -> AXUIElement? {
    guard isTrustedSystemSettingsProcess(expectedPid) else { return nil }
    var queue: [AXUIElement] = [root]
    var visited = 0
    var matches: [AXUIElement] = []
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        if axRole(node) == kAXButtonRole as String,
           elementBelongsToProcess(node, pid: expectedPid),
           axBool(node, kAXHiddenAttribute as String) != true,
           axBool(node, kAXEnabledAttribute as String) == true,
           supportsPressAction(node),
           hasExactName(node, names: names),
           let frame = axFrame(node),
           frame.width <= 1_000,
           frame.height <= 200,
           pointIsOnActiveDisplay(CGPoint(x: frame.midX, y: frame.midY)) {
            if !matches.contains(where: { $0 == node }) {
                matches.append(node)
            }
        }
        queue.append(contentsOf: axChildren(node))
    }
    return matches.count == 1 ? matches[0] : nil
}

func collectSheetRoots(_ appElement: AXUIElement) -> [AXUIElement] {
    guard let focusedWindow: AXUIElement = axCopy(
        appElement,
        kAXFocusedWindowAttribute as String
    ) else { return [] }
    var dialogs: [AXUIElement] = []
    if isDedicatedDialogWindow(focusedWindow),
       axBool(focusedWindow, kAXHiddenAttribute as String) != true,
       axFrame(focusedWindow) != nil {
        dialogs.append(focusedWindow)
    }
    var queue = axSheets(focusedWindow) + axChildren(focusedWindow)
    var seen: [AXUIElement] = []
    var visited = 0
    while !queue.isEmpty && visited < 1_200 {
        let node = queue.removeFirst()
        if seen.contains(where: { $0 == node }) { continue }
        seen.append(node)
        visited += 1
        let role = axRole(node)
        let isDialog = role == "AXDialog" ||
            (role == kAXWindowRole as String && isDedicatedDialogWindow(node))
        if (role == kAXSheetRole as String || isDialog || role == kAXPopoverRole as String),
           axBool(node, kAXHiddenAttribute as String) != true,
           axFrame(node) != nil {
            dialogs.append(node)
        }
        queue.append(contentsOf: axSheets(node))
        queue.append(contentsOf: axChildren(node))
    }
    return Array(dialogs.reversed())
}

func visibleExactMatchCounts(
    appElement: AXUIElement,
    expectedPid: pid_t,
    names: [String],
    maxNodes: Int = 2_000
) -> (visible: Int, pressable: Int) {
    var queue = axSheets(appElement) + axChildren(appElement)
    var seen: [AXUIElement] = []
    var visited = 0
    var visible = 0
    var pressable = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        if seen.contains(where: { $0 == node }) { continue }
        seen.append(node)
        visited += 1
        if elementBelongsToProcess(node, pid: expectedPid),
           axBool(node, kAXHiddenAttribute as String) != true,
           axFrame(node) != nil,
           hasExactName(node, names: names) {
            visible += 1
            if axBool(node, kAXEnabledAttribute as String) == true,
               supportsPressAction(node) {
                pressable += 1
            }
        }
        queue.append(contentsOf: axSheets(node))
        queue.append(contentsOf: axChildren(node))
    }
    return (visible, pressable)
}

func logNavigationState(
    appElement: AXUIElement,
    expectedPid: pid_t,
    signInNames: [String],
    twoFactorNames: [String],
    buttonNames: [String]
) {
    let signIn = visibleExactMatchCounts(
        appElement: appElement,
        expectedPid: expectedPid,
        names: signInNames
    )
    let twoFactor = visibleExactMatchCounts(
        appElement: appElement,
        expectedPid: expectedPid,
        names: twoFactorNames
    )
    let focused = focusedWindowForProcess(expectedPid) == nil ? 0 : 1
    let sheets = collectSheetRoots(appElement).count
    let getCode = findGetCodeButton(
        appElement: appElement,
        expectedPid: expectedPid,
        twoFactorNames: twoFactorNames,
        buttonNames: buttonNames
    ) == nil ? 0 : 1
    logStep(
        2,
        "navigation state focused=\(focused) sheets=\(sheets) signInVisible=\(signIn.visible) signInPressable=\(signIn.pressable) twoFactorVisible=\(twoFactor.visible) twoFactorPressable=\(twoFactor.pressable) getCode=\(getCode)"
    )
}

func findVerificationCodeAlertRoot(
    appElement: AXUIElement,
    expectedPid: pid_t
) -> AXUIElement? {
    for window in collectWindows(appElement: appElement) {
        var queue: [AXUIElement] = [window]
        var visited = 0
        while !queue.isEmpty && visited < 1_500 {
            let node = queue.removeFirst()
            visited += 1
            if hasExactName(node, names: verificationAlertTitles) {
                var candidate: AXUIElement? = node
                for _ in 0..<10 {
                    guard let current = candidate,
                          elementBelongsToProcess(current, pid: expectedPid) else { break }
                    let role = axRole(current)
                    if role == kAXApplicationRole as String {
                        break
                    }
                    if role == kAXWindowRole as String && !isDedicatedDialogWindow(current) {
                        break
                    }
                    if findExactButton(
                        in: current,
                        names: verificationAlertCloseButtons,
                        expectedPid: expectedPid,
                        maxNodes: 300
                    ) != nil {
                        return current
                    }
                    if role == kAXWindowRole as String { break }
                    candidate = axParent(current)
                }
            }
            queue.append(contentsOf: axChildren(node))
        }
    }
    return nil
}

func findSixDigitCodeInAlert(_ root: AXUIElement, maxNodes: Int = 600) -> String? {
    var queue: [AXUIElement] = [root]
    var visited = 0
    var candidates = Set<String>()
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        let role = axRole(node)
        if role == kAXStaticTextRole as String || role == kAXGroupRole as String {
            for text in axExactTexts(node) {
                candidates.formUnion(sixDigitCodeCandidates(text))
            }
        }
        queue.append(contentsOf: axChildren(node))
    }
    guard candidates.count == 1 else { return nil }
    return candidates.first
}

func scanCodeFromAlertOnly(appElement: AXUIElement, expectedPid: pid_t) -> String? {
    guard let alert = findVerificationCodeAlertRoot(
        appElement: appElement,
        expectedPid: expectedPid
    ) else { return nil }
    return findSixDigitCodeInAlert(alert)
}

func hasVerificationCodeAlert(appElement: AXUIElement, expectedPid: pid_t) -> Bool {
    findVerificationCodeAlertRoot(appElement: appElement, expectedPid: expectedPid) != nil
}

func findGetCodeButton(
    appElement: AXUIElement,
    expectedPid: pid_t,
    twoFactorNames: [String],
    buttonNames: [String]
) -> AXUIElement? {
    guard let focusedWindow = focusedWindowForProcess(expectedPid) else { return nil }
    var matches: [AXUIElement] = []
    for root in collectSheetRoots(appElement) {
        guard elementBelongsToProcess(root, pid: expectedPid),
              treeContainsExactText(root, names: twoFactorNames) else { continue }
        if let button = findExactButton(
            in: root,
            names: buttonNames,
            expectedPid: expectedPid
        ), axWindowForElement(button) == focusedWindow {
            if !matches.contains(where: { $0 == button }) {
                matches.append(button)
            }
        }
    }
    return matches.count == 1 ? matches[0] : nil
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

func isTrustedSystemSettingsProcess(_ pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
    return isTrustedSystemSettings(app)
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

func pressExactButton(
    _ element: AXUIElement,
    expectedPid: pid_t,
    names: [String]
) -> Bool {
    guard isTrustedSystemSettingsProcess(expectedPid),
          axRole(element) == kAXButtonRole as String,
          elementBelongsToProcess(element, pid: expectedPid),
          axBool(element, kAXEnabledAttribute as String) == true,
          supportsPressAction(element),
          hasExactName(element, names: names) else { return false }
    return pressElement(element)
}

func axPoint(_ element: AXUIElement, attribute: String) -> CGPoint? {
    guard let value: CFTypeRef = axCopy(element, attribute),
          CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func axSize(_ element: AXUIElement, attribute: String) -> CGSize? {
    guard let value: CFTypeRef = axCopy(element, attribute),
          CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func pointIsOnActiveDisplay(_ point: CGPoint) -> Bool {
    var displayCount: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &displayCount) == .success,
          displayCount > 0 else { return false }
    let capacity = displayCount
    var displayIds = Array(repeating: CGDirectDisplayID(), count: Int(displayCount))
    let status = displayIds.withUnsafeMutableBufferPointer { buffer in
        CGGetActiveDisplayList(capacity, buffer.baseAddress, &displayCount)
    }
    guard status == .success else {
        return false
    }
    return displayIds.prefix(Int(displayCount)).contains {
        CGDisplayBounds($0).contains(point)
    }
}

func axWindowForElement(_ element: AXUIElement) -> AXUIElement? {
    if let window: AXUIElement = axCopy(element, kAXWindowAttribute as String) {
        return window
    }
    var current = element
    for _ in 0..<12 {
        guard let parent = axParent(current) else { return nil }
        if axRole(parent) == kAXWindowRole as String { return parent }
        current = parent
    }
    return nil
}

func focusedWindowForProcess(_ pid: pid_t) -> AXUIElement? {
    let appElement = AXUIElementCreateApplication(pid)
    guard let window: AXUIElement = axCopy(appElement, kAXFocusedWindowAttribute as String),
          axRole(window) == kAXWindowRole as String,
          elementBelongsToProcess(window, pid: pid) else { return nil }
    return window
}

func hitTestMatchesButton(
    _ button: AXUIElement,
    at point: CGPoint,
    expectedPid: pid_t
) -> Bool {
    let systemWide = AXUIElementCreateSystemWide()
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(
        systemWide,
        Float(point.x),
        Float(point.y),
        &hit
    ) == .success,
          let hit,
          elementBelongsToProcess(hit, pid: expectedPid) else { return false }

    var current: AXUIElement? = hit
    for _ in 0..<8 {
        guard let node = current else { break }
        if node == button { return true }
        current = axParent(node)
    }
    return false
}

func clickElementAtVerifiedFrame(
    _ element: AXUIElement,
    expectedPid: pid_t,
    names: [String]
) -> Bool {
    guard let settingsApp = NSRunningApplication(processIdentifier: expectedPid),
          isTrustedSystemSettings(settingsApp),
          let buttonWindow = axWindowForElement(element),
          focusTrustedSettingsWindow(
              buttonWindow,
              app: settingsApp,
              expectedPid: expectedPid,
              timeoutMs: 1_500
          ),
          let buttonFrame = axFrame(element),
          buttonFrame.width >= 24,
          buttonFrame.width <= 500,
          buttonFrame.height >= 16,
          buttonFrame.height <= 120,
          let focusedWindow = focusedWindowForProcess(expectedPid),
          buttonWindow == focusedWindow,
          let focusedFrame = axFrame(focusedWindow),
          focusedFrame.contains(buttonFrame) else { return false }
    guard axRole(element) == kAXButtonRole as String,
          elementBelongsToProcess(element, pid: expectedPid),
          axBool(element, kAXEnabledAttribute as String) == true,
          supportsPressAction(element),
          hasExactName(element, names: names),
          pointIsOnActiveDisplay(CGPoint(x: buttonFrame.midX, y: buttonFrame.midY)),
          hitTestMatchesButton(
              element,
              at: CGPoint(x: buttonFrame.midX, y: buttonFrame.midY),
              expectedPid: expectedPid
          ) else { return false }

    let target = CGPoint(x: buttonFrame.midX, y: buttonFrame.midY)
    guard pointIsOnActiveDisplay(target),
          let source = CGEventSource(stateID: .hidSystemState),
          let mouseDown = CGEvent(
              mouseEventSource: source,
              mouseType: .leftMouseDown,
              mouseCursorPosition: target,
              mouseButton: .left
          ),
          let mouseUp = CGEvent(
              mouseEventSource: source,
              mouseType: .leftMouseUp,
              mouseCursorPosition: target,
              mouseButton: .left
          ) else { return false }

    defer { mouseUp.post(tap: .cghidEventTap) }
    mouseDown.post(tap: .cghidEventTap)
    usleep(80_000)
    return true
}

func clickNamed(
    in root: AXUIElement,
    names: [String],
    expectedPid: pid_t,
    maxNodes: Int = 700
) -> Bool {
    guard let focusedWindow = focusedWindowForProcess(expectedPid) else { return false }
    var queue: [AXUIElement] = [root]
    var visited = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        let role = axRole(node)
        let blob = axDescription(node)
        let matched = names.contains { blob == $0 || blob.contains($0) }
        if matched,
           elementBelongsToProcess(node, pid: expectedPid),
           axBool(node, kAXHiddenAttribute as String) != true,
           axBool(node, kAXEnabledAttribute as String) == true,
           supportsPressAction(node),
           axFrame(node) != nil,
           axWindowForElement(node) == focusedWindow,
           pressElement(node) {
            return true
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

func focusTrustedSettingsWindow(
    _ window: AXUIElement,
    app: NSRunningApplication,
    expectedPid: pid_t,
    timeoutMs: Int
) -> Bool {
    guard isTrustedSystemSettings(app),
          elementBelongsToProcess(window, pid: expectedPid),
          axRole(window) == kAXWindowRole as String,
          axBool(window, kAXHiddenAttribute as String) != true,
          axFrame(window) != nil else { return false }

    _ = app.activate(options: [.activateAllWindows])
    _ = AXUIElementSetAttributeValue(
        window,
        kAXMainAttribute as CFString,
        kCFBooleanTrue
    )
    _ = AXUIElementSetAttributeValue(
        window,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    )
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)

    let deadline = Date().addingTimeInterval(TimeInterval(max(0, timeoutMs)) / 1000.0)
    repeat {
        if focusedWindowForProcess(expectedPid) == window { return true }
        if Date() >= deadline { return false }
        usleep(100_000)
    } while true
}

func activateSystemSettings(
    _ app: NSRunningApplication,
    appElement: AXUIElement,
    expectedPid: pid_t,
    timeoutMs: Int = 4_000
) -> Bool {
    guard isTrustedSystemSettings(app), app.processIdentifier == expectedPid else { return false }

    if let bundleURL = app.bundleURL {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(
            at: bundleURL,
            configuration: configuration
        ) { _, _ in }
    }
    _ = app.activate(options: [.activateAllWindows])

    let deadline = Date().addingTimeInterval(TimeInterval(max(0, timeoutMs)) / 1000.0)
    var lastWindowCount = 0
    var lastVisibleCount = 0
    var lastDialogCount = 0
    var lastMainCount = 0
    repeat {
        if focusedWindowForProcess(expectedPid) != nil { return true }

        let windows = collectWindows(appElement: appElement)
        let visibleWindows = windows.filter {
            elementBelongsToProcess($0, pid: expectedPid) &&
                axRole($0) == kAXWindowRole as String &&
                axBool($0, kAXHiddenAttribute as String) != true &&
                axFrame($0) != nil
        }
        let dialogs = visibleWindows.filter(isDedicatedDialogWindow)
        let mainWindows = visibleWindows.filter {
            axBool($0, kAXMainAttribute as String) == true
        }
        lastWindowCount = windows.count
        lastVisibleCount = visibleWindows.count
        lastDialogCount = dialogs.count
        lastMainCount = mainWindows.count
        let target = dialogs.count == 1
            ? dialogs[0]
            : mainWindows.count == 1
                ? mainWindows[0]
                : visibleWindows.count == 1 ? visibleWindows[0] : nil
        if let target,
           focusTrustedSettingsWindow(
               target,
               app: app,
               expectedPid: expectedPid,
               timeoutMs: 500
           ) {
            return true
        }
        if Date() >= deadline { break }
        usleep(100_000)
    } while true

    logStep(
        1,
        "activation state trusted=\(AXIsProcessTrusted() ? 1 : 0) active=\(app.isActive ? 1 : 0) windows=\(lastWindowCount) visible=\(lastVisibleCount) dialogs=\(lastDialogCount) main=\(lastMainCount)"
    )
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

@discardableResult
func closeVerificationCodeAlert(
    appElement: AXUIElement,
    expectedPid: pid_t,
    waitForAlertMs: Int = 0
) -> Bool {
    let deadline = Date().addingTimeInterval(TimeInterval(max(0, waitForAlertMs)) / 1000.0)
    var pressAttempts = 0
    var coordinateFallbackUsed = false
    repeat {
        guard let alert = findVerificationCodeAlertRoot(
            appElement: appElement,
            expectedPid: expectedPid
        ) else {
            if Date() >= deadline { return true }
            usleep(100_000)
            continue
        }
        if let closeButton = findExactButton(
            in: alert,
            names: verificationAlertCloseButtons,
            expectedPid: expectedPid
        ) {
            if pressAttempts < 2 {
                _ = pressExactButton(
                    closeButton,
                    expectedPid: expectedPid,
                    names: verificationAlertCloseButtons
                )
                pressAttempts += 1
            } else if !coordinateFallbackUsed {
                _ = clickElementAtVerifiedFrame(
                    closeButton,
                    expectedPid: expectedPid,
                    names: verificationAlertCloseButtons
                )
                coordinateFallbackUsed = true
            }
        }
        if Date() >= deadline {
            return findVerificationCodeAlertRoot(
                appElement: appElement,
                expectedPid: expectedPid
            ) == nil
        }
        usleep(100_000)
    } while true
}

func stopIfCancelled(appElement: AXUIElement? = nil, expectedPid: pid_t? = nil) {
    guard let path = cancelFilePath,
          FileManager.default.fileExists(atPath: path) else { return }
    if let appElement, let expectedPid {
        closeVerificationCodeAlert(
            appElement: appElement,
            expectedPid: expectedPid,
            waitForAlertMs: verificationCodeRequested ? 3_000 : 0
        )
    }
    emit(Output(ok: false, code: nil, message: "cancelled"))
}

func cancellablePause(
    _ microseconds: UInt32,
    appElement: AXUIElement? = nil,
    expectedPid: pid_t? = nil
) {
    var remaining = microseconds
    while remaining > 0 {
        stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
        let step = min(remaining, 100_000)
        usleep(step)
        remaining -= step
    }
    stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
}

func waitForVerificationCodeAlert(
    appElement: AXUIElement,
    expectedPid: pid_t,
    timeoutMs: Int
) -> Bool {
    let deadline = Date().addingTimeInterval(TimeInterval(max(0, timeoutMs)) / 1000.0)
    repeat {
        stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
        if hasVerificationCodeAlert(appElement: appElement, expectedPid: expectedPid) {
            return true
        }
        if Date() >= deadline { return false }
        usleep(100_000)
    } while true
}

func requestVerificationCodeAlert(
    appElement: AXUIElement,
    expectedPid: pid_t,
    twoFactorNames: [String],
    buttonNames: [String]
) -> Bool {
    if hasVerificationCodeAlert(appElement: appElement, expectedPid: expectedPid) {
        guard closeVerificationCodeAlert(
            appElement: appElement,
            expectedPid: expectedPid,
            waitForAlertMs: 1_000
        ), !hasVerificationCodeAlert(appElement: appElement, expectedPid: expectedPid) else {
            return false
        }
    }

    for attempt in 1...3 {
        stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
        if hasVerificationCodeAlert(appElement: appElement, expectedPid: expectedPid) {
            return true
        }
        guard let button = findGetCodeButton(
            appElement: appElement,
            expectedPid: expectedPid,
            twoFactorNames: twoFactorNames,
            buttonNames: buttonNames
        ) else {
            if waitForVerificationCodeAlert(
                appElement: appElement,
                expectedPid: expectedPid,
                timeoutMs: 250
            ) {
                return true
            }
            continue
        }

        verificationCodeRequested = true
        if attempt < 3 {
            _ = pressExactButton(
                button,
                expectedPid: expectedPid,
                names: buttonNames
            )
        } else {
            _ = clickElementAtVerifiedFrame(
                button,
                expectedPid: expectedPid,
                names: buttonNames
            )
        }

        if waitForVerificationCodeAlert(
            appElement: appElement,
            expectedPid: expectedPid,
            timeoutMs: 2_000
        ) {
            return true
        }
    }
    return waitForVerificationCodeAlert(
        appElement: appElement,
        expectedPid: expectedPid,
        timeoutMs: 500
    )
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

let appElement = AXUIElementCreateApplication(app.processIdentifier)
let settingsPid = app.processIdentifier
guard activateSystemSettings(
    app,
    appElement: appElement,
    expectedPid: settingsPid
) else {
    emit(Output(ok: false, code: nil, message: "System Settings focus unavailable"))
}
cancellablePause(300_000, appElement: appElement, expectedPid: settingsPid)
logStep(2, "System Settings ready")

let signInSecurity = ["登录与安全性", "登入與安全性", "Sign-In & Security", "Sign-In and Security", "登录和安全性"]
let twoFactor = ["双重认证", "雙重認證", "Two-Factor Authentication", "双因素认证"]
let getCodeBtn = ["获取验证码", "取得驗證碼", "Get Verification Code", "Get a Verification Code"]

logNavigationState(
    appElement: appElement,
    expectedPid: settingsPid,
    signInNames: signInSecurity,
    twoFactorNames: twoFactor,
    buttonNames: getCodeBtn
)

stopIfCancelled(appElement: appElement, expectedPid: settingsPid)
if findGetCodeButton(
    appElement: appElement,
    expectedPid: settingsPid,
    twoFactorNames: twoFactor,
    buttonNames: getCodeBtn
) != nil {
    logStep(3, "Sign-In & Security already open")
    logStep(4, "Two-Factor Authentication already open")
} else {
    logStep(3, "click Sign-In & Security")
    if clickNamed(in: appElement, names: signInSecurity, expectedPid: settingsPid) {
        cancellablePause(1_200_000, appElement: appElement, expectedPid: settingsPid)
    }

    stopIfCancelled(appElement: appElement, expectedPid: settingsPid)
    if findGetCodeButton(
        appElement: appElement,
        expectedPid: settingsPid,
        twoFactorNames: twoFactor,
        buttonNames: getCodeBtn
    ) != nil {
        logStep(4, "Two-Factor Authentication already open")
    } else {
        logStep(4, "click Two-Factor Authentication")
        if !clickNamed(in: appElement, names: twoFactor, expectedPid: settingsPid),
           findGetCodeButton(
               appElement: appElement,
               expectedPid: settingsPid,
               twoFactorNames: twoFactor,
               buttonNames: getCodeBtn
           ) == nil {
            emit(Output(ok: false, code: nil, message: "Two-Factor Authentication not found"))
        }
        cancellablePause(1_200_000, appElement: appElement, expectedPid: settingsPid)
    }
}

stopIfCancelled(appElement: appElement, expectedPid: settingsPid)
logStep(5, "click Get Verification Code")
guard requestVerificationCodeAlert(
    appElement: appElement,
    expectedPid: settingsPid,
    twoFactorNames: twoFactor,
    buttonNames: getCodeBtn
) else {
    closeVerificationCodeAlert(
        appElement: appElement,
        expectedPid: settingsPid,
        waitForAlertMs: 1_000
    )
    emit(Output(ok: false, code: nil, message: "verification code alert was not opened"))
}

logStep(6, "waiting for verification code alert…")

let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))
var code: String?
var stableHits = 0
while Date() < deadline {
    cancellablePause(250_000, appElement: appElement, expectedPid: settingsPid)
    if let detectedCode = scanCodeFromAlertOnly(
        appElement: appElement,
        expectedPid: settingsPid
    ) {
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

guard stableHits >= 2, let finalCode = code else {
    closeVerificationCodeAlert(
        appElement: appElement,
        expectedPid: settingsPid,
        waitForAlertMs: 1_000
    )
    emit(Output(ok: false, code: nil, message: "verification code alert not found"))
}

logStep(7, "verification code detected")

stopIfCancelled(appElement: appElement, expectedPid: settingsPid)
guard closeVerificationCodeAlert(
    appElement: appElement,
    expectedPid: settingsPid,
    waitForAlertMs: 2_000
) else {
    emit(Output(ok: false, code: nil, message: "verification code alert cleanup failed"))
}
stopIfCancelled(appElement: appElement, expectedPid: settingsPid)
emit(Output(ok: true, code: finalCode, message: "ok"))
