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
let appleIDSettingsExecutablePaths: Set<String> = [
    "/System/Library/ExtensionKit/Extensions/AppleIDSettings.appex/Contents/MacOS/AppleIDSettings",
    "/System/Applications/System Settings.app/Contents/PlugIns/AppleIDSettings.appex/Contents/MacOS/AppleIDSettings",
    "/System/Applications/System Settings.app/Contents/PlugIns/AccountsSettingsExtension.appex/Contents/MacOS/AccountsSettingsExtension",
]
let axSheetsAttribute = "AXSheets"
var cancelFilePath: String?
var verificationCodeRequested = false

let modernAccountUrls = [
    "x-apple.systempreferences:com.apple.AccountSettings.AccountsSettingsExtension",
]
let legacyAccountUrls = [
    "x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings",
    "x-apple.systempreferences:com.apple.preferences.AppleIDPref",
]
let signInSecurity = ["登录与安全性", "登入與安全性", "Sign-In & Security", "Sign-In and Security", "登录和安全性"]
let twoFactor = ["双重认证", "雙重認證", "Two-Factor Authentication", "双因素认证"]
let getCodeBtn = ["获取验证码", "取得驗證碼", "Get Verification Code", "Get a Verification Code"]
let appleAccountPageEvidence = signInSecurity + twoFactor + getCodeBtn

func orderedAccountUrls() -> [String] {
    let majorVersion = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
    return majorVersion >= 13
        ? modernAccountUrls + legacyAccountUrls
        : legacyAccountUrls + modernAccountUrls
}

func logStep(_ n: Int, _ msg: String) {
    FileHandle.standardError.write("[2FA-settings \(n)] \(msg)\n".data(using: .utf8)!)
}

func axCopy<T>(_ element: AXUIElement, _ attr: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
    return value as? T
}

func axElementArrayStrict(_ element: AXUIElement, _ attr: String) -> [AXUIElement]? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success,
          let elements = value as? [AXUIElement] else { return nil }
    return elements
}

func axOptionalElementStrict(
    _ element: AXUIElement,
    _ attr: String
) -> (known: Bool, value: AXUIElement?) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    if error == .success {
        guard let rawValue = value,
              CFGetTypeID(rawValue) == AXUIElementGetTypeID() else { return (false, nil) }
        return (true, rawValue as! AXUIElement)
    }
    if error == .noValue || error == .attributeUnsupported {
        return (true, nil)
    }
    return (false, nil)
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

func treeContainsExactText(
    _ root: AXUIElement,
    names: [String],
    expectedPid: pid_t,
    maxNodes: Int = 900
) -> Bool {
    guard isTrustedSystemSettingsProcess(expectedPid),
          elementBelongsToProcess(root, pid: expectedPid) else { return false }
    var queue: [AXUIElement] = [root]
    var seen: [AXUIElement] = []
    var visited = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        if seen.contains(where: { $0 == node }) { continue }
        seen.append(node)
        visited += 1
        if axBool(node, kAXHiddenAttribute as String) != true,
           axFrame(node) != nil,
           hasExactName(node, names: names) {
            return isTrustedSystemSettingsProcess(expectedPid)
        }
        queue.append(contentsOf: axSheets(node))
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
    var seen: [AXUIElement] = []
    var visited = 0
    var matches: [AXUIElement] = []
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        if seen.contains(where: { $0 == node }) { continue }
        seen.append(node)
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
        queue.append(contentsOf: axSheets(node))
        queue.append(contentsOf: axChildren(node))
    }
    guard isTrustedSystemSettingsProcess(expectedPid) else { return nil }
    return matches.count == 1 ? matches[0] : nil
}

func collectSheetRoots(_ appElement: AXUIElement, expectedPid: pid_t) -> [AXUIElement] {
    guard isTrustedSystemSettingsProcess(expectedPid),
          elementBelongsToProcess(appElement, pid: expectedPid) else { return [] }
    let focusedWindow: AXUIElement? = axCopy(
        appElement,
        kAXFocusedWindowAttribute as String
    )
    let traversalRoot: AXUIElement
    if let focusedWindow,
       elementBelongsToProcess(focusedWindow, pid: expectedPid),
       axRole(focusedWindow) == kAXWindowRole as String {
        traversalRoot = focusedWindow
    } else {
        traversalRoot = appElement
    }
    var dialogs: [AXUIElement] = []
    if isDedicatedDialogWindow(traversalRoot),
       axBool(traversalRoot, kAXHiddenAttribute as String) != true,
       axFrame(traversalRoot) != nil {
        dialogs.append(traversalRoot)
    }
    var queue = axSheets(traversalRoot) + axChildren(traversalRoot)
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
    guard isTrustedSystemSettingsProcess(expectedPid) else { return [] }
    return Array(dialogs.reversed())
}

func visibleExactMatchCounts(
    appElement: AXUIElement,
    expectedPid: pid_t,
    names: [String],
    maxNodes: Int = 2_000
) -> (visible: Int, pressable: Int) {
    guard isTrustedSystemSettingsProcess(expectedPid) else { return (0, 0) }
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
    guard isTrustedSystemSettingsProcess(expectedPid) else { return (0, 0) }
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
    let sheets = collectSheetRoots(appElement, expectedPid: expectedPid).count
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
    guard isTrustedSystemSettingsProcess(expectedPid) else { return nil }
    var roots = collectWindows(appElement: appElement, expectedPid: expectedPid)
    if !roots.contains(where: { $0 == appElement }) { roots.append(appElement) }
    for window in roots {
        guard isTrustedSystemSettingsProcess(expectedPid) else { return nil }
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
                        guard isTrustedSystemSettingsProcess(expectedPid) else { return nil }
                        return current
                    }
                    if role == kAXWindowRole as String { break }
                    candidate = axParent(current)
                }
            }
            queue.append(contentsOf: axSheets(node))
            queue.append(contentsOf: axChildren(node))
        }
    }
    return nil
}

func findSixDigitCodeInAlert(
    _ root: AXUIElement,
    expectedPid: pid_t,
    maxNodes: Int = 600
) -> String? {
    guard isTrustedSystemSettingsProcess(expectedPid),
          elementBelongsToProcess(root, pid: expectedPid) else { return nil }
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
    guard isTrustedSystemSettingsProcess(expectedPid),
          candidates.count == 1 else { return nil }
    return candidates.first
}

func scanCodeFromAlertOnly(appElement: AXUIElement, expectedPid: pid_t) -> String? {
    guard let alert = findVerificationCodeAlertRoot(
        appElement: appElement,
        expectedPid: expectedPid
    ) else { return nil }
    return findSixDigitCodeInAlert(alert, expectedPid: expectedPid)
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
    guard isTrustedSystemSettingsProcess(expectedPid) else { return nil }
    var roots = collectSheetRoots(appElement, expectedPid: expectedPid)
    if roots.isEmpty { roots = [appElement] }
    var matches: [AXUIElement] = []
    for root in roots {
        guard elementBelongsToProcess(root, pid: expectedPid),
              treeContainsExactText(
                  root,
                  names: twoFactorNames,
                  expectedPid: expectedPid,
                  maxNodes: 2_000
              ),
              let button = findExactButton(
                  in: root,
                  names: buttonNames,
                  expectedPid: expectedPid,
                  maxNodes: 2_000
              ) else { continue }
        guard settingsActionScopeAllowsElement(
            button,
            appElement: appElement,
            expectedPid: expectedPid
        ) else { continue }
        if !matches.contains(where: { $0 == button }) { matches.append(button) }
    }
    guard isTrustedSystemSettingsProcess(expectedPid),
          matches.count == 1 else { return nil }
    return matches[0]
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

func isTrustedAppleIDSettingsExtension(_ app: NSRunningApplication) -> Bool {
    guard let path = app.executableURL?.standardizedFileURL.path else { return false }
    return appleIDSettingsExecutablePaths.contains(path)
}

func isTrustedSystemSettingsProcess(_ pid: pid_t) -> Bool {
    let extensions = NSWorkspace.shared.runningApplications.filter(
        isTrustedAppleIDSettingsExtension
    )
    if extensions.count == 1 {
        return extensions[0].processIdentifier == pid
    }
    guard extensions.isEmpty,
          ProcessInfo.processInfo.operatingSystemVersion.majorVersion < 13,
          let app = NSRunningApplication(processIdentifier: pid),
          isTrustedSystemSettings(app) else { return false }
    let settingsApps = NSWorkspace.shared.runningApplications.filter(isTrustedSystemSettings)
    return settingsApps.count == 1 && settingsApps[0].processIdentifier == pid
}

func findSettingsApp() -> NSRunningApplication? {
    for app in NSWorkspace.shared.runningApplications {
        guard isTrustedSystemSettings(app) else { continue }
        return app
    }
    return nil
}

func findAppleIDSettingsExtension() -> NSRunningApplication? {
    let matches = NSWorkspace.shared.runningApplications.filter(
        isTrustedAppleIDSettingsExtension
    )
    return matches.count == 1 ? matches[0] : nil
}

func waitForAppleAccountSettingsPage(timeoutMs: Int) -> Bool {
    let deadline = Date().addingTimeInterval(TimeInterval(max(0, timeoutMs)) / 1000.0)
    repeat {
        let matches = NSWorkspace.shared.runningApplications.filter(
            isTrustedAppleIDSettingsExtension
        )
        if matches.count > 1 { return false }
        if matches.count == 1 {
            let pid = matches[0].processIdentifier
            let appElement = AXUIElementCreateApplication(pid)
            if treeContainsExactText(
                appElement,
                names: appleAccountPageEvidence,
                expectedPid: pid,
                maxNodes: 2_000
            ) {
                return true
            }
        }
        if Date() >= deadline { return false }
        usleep(100_000)
    } while true
}

func waitForSettingsUIOwner(
    fallbackApp: NSRunningApplication,
    timeoutMs: Int = 4_000
) -> NSRunningApplication? {
    let deadline = Date().addingTimeInterval(TimeInterval(max(0, timeoutMs)) / 1000.0)
    repeat {
        let matches = NSWorkspace.shared.runningApplications.filter(
            isTrustedAppleIDSettingsExtension
        )
        if matches.count == 1 { return matches[0] }
        if matches.count > 1 { return nil }
        if Date() >= deadline {
            return isTrustedSystemSettingsProcess(fallbackApp.processIdentifier)
                ? fallbackApp
                : nil
        }
        usleep(100_000)
    } while true
}

@discardableResult
func openAppleAccountSettings() -> Bool {
    let expectsExtension = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 13
    for s in orderedAccountUrls() {
        guard let url = URL(string: s), NSWorkspace.shared.open(url) else { continue }
        if !expectsExtension || waitForAppleAccountSettingsPage(timeoutMs: 3_000) {
            return true
        }
    }
    return NSWorkspace.shared.launchApplication(
        withBundleIdentifier: "com.apple.systempreferences",
        options: [],
        additionalEventParamDescriptor: nil,
        launchIdentifier: nil
    )
}

func pressElement(
    _ element: AXUIElement,
    appElement: AXUIElement,
    expectedPid: pid_t
) -> Bool {
    guard isTrustedSystemSettingsProcess(expectedPid),
          settingsActionScopeAllowsElement(
              element,
              appElement: appElement,
              expectedPid: expectedPid
          ),
          elementBelongsToProcess(element, pid: expectedPid),
          axBool(element, kAXEnabledAttribute as String) == true else { return false }
    let err = AXUIElementPerformAction(element, kAXPressAction as CFString)
    if err == .success { return true }
    guard settingsActionScopeAllowsElement(
        element,
        appElement: appElement,
        expectedPid: expectedPid
    ) else { return false }
    _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(80_000)
    guard settingsActionScopeAllowsElement(
              element,
              appElement: appElement,
              expectedPid: expectedPid
          ),
          elementBelongsToProcess(element, pid: expectedPid) else { return false }
    return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func pressExactButton(
    _ element: AXUIElement,
    appElement: AXUIElement,
    expectedPid: pid_t,
    names: [String]
) -> Bool {
    guard isTrustedSystemSettingsProcess(expectedPid),
          settingsActionScopeAllowsElement(
              element,
              appElement: appElement,
              expectedPid: expectedPid
          ),
          axRole(element) == kAXButtonRole as String,
          elementBelongsToProcess(element, pid: expectedPid),
          axBool(element, kAXEnabledAttribute as String) == true,
          supportsPressAction(element),
          hasExactName(element, names: names) else { return false }
    return pressElement(
        element,
        appElement: appElement,
        expectedPid: expectedPid
    )
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

func axWindowForElement(_ element: AXUIElement, expectedPid: pid_t) -> AXUIElement? {
    guard isTrustedSystemSettingsProcess(expectedPid),
          elementBelongsToProcess(element, pid: expectedPid) else { return nil }
    if let window: AXUIElement = axCopy(element, kAXWindowAttribute as String) {
        guard isTrustedSystemSettingsProcess(expectedPid),
              elementBelongsToProcess(window, pid: expectedPid) else { return nil }
        return window
    }
    var current = element
    for _ in 0..<12 {
        guard let parent = axParent(current) else { return nil }
        if axRole(parent) == kAXWindowRole as String {
            return isTrustedSystemSettingsProcess(expectedPid) ? parent : nil
        }
        current = parent
    }
    return nil
}

func focusedWindowForProcess(_ pid: pid_t) -> AXUIElement? {
    guard isTrustedSystemSettingsProcess(pid) else { return nil }
    let appElement = AXUIElementCreateApplication(pid)
    guard let window: AXUIElement = axCopy(appElement, kAXFocusedWindowAttribute as String),
          axRole(window) == kAXWindowRole as String,
          elementBelongsToProcess(window, pid: pid) else { return nil }
    return window
}

func isWindowlessAppleIDSettingsOwner(
    appElement: AXUIElement,
    expectedPid: pid_t
) -> Bool {
    guard isTrustedSystemSettingsProcess(expectedPid),
          elementBelongsToProcess(appElement, pid: expectedPid),
          let owner = NSRunningApplication(processIdentifier: expectedPid),
          isTrustedAppleIDSettingsExtension(owner) else { return false }
    guard var candidates = axElementArrayStrict(
        appElement,
        kAXWindowsAttribute as String
    ) else { return false }
    let focused = axOptionalElementStrict(
        appElement,
        kAXFocusedWindowAttribute as String
    )
    let main = axOptionalElementStrict(
        appElement,
        kAXMainWindowAttribute as String
    )
    guard focused.known, main.known else { return false }
    if let focused = focused.value {
        candidates.append(focused)
    }
    if let main = main.value {
        candidates.append(main)
    }
    var hasStandardWindow = false
    for candidate in candidates {
        guard elementBelongsToProcess(candidate, pid: expectedPid),
              let role = axString(candidate, kAXRoleAttribute as String),
              !role.isEmpty else { return false }
        if role == kAXWindowRole as String { hasStandardWindow = true }
    }
    return !hasStandardWindow && isTrustedSystemSettingsProcess(expectedPid)
}

func settingsActionScopeAllowsElement(
    _ element: AXUIElement,
    appElement: AXUIElement,
    expectedPid: pid_t
) -> Bool {
    guard isTrustedSystemSettingsProcess(expectedPid),
          elementBelongsToProcess(element, pid: expectedPid) else { return false }
    if let focusedWindow = focusedWindowForProcess(expectedPid) {
        guard axWindowForElement(
            element,
            expectedPid: expectedPid
        ) == focusedWindow else { return false }
        return isTrustedSystemSettingsProcess(expectedPid)
    }
    return isWindowlessAppleIDSettingsOwner(
        appElement: appElement,
        expectedPid: expectedPid
    )
}

func hitTestMatchesButton(
    _ button: AXUIElement,
    at point: CGPoint,
    expectedPid: pid_t
) -> Bool {
    guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
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
        if node == button { return isTrustedSystemSettingsProcess(expectedPid) }
        current = axParent(node)
    }
    return false
}

func clickElementAtVerifiedFrame(
    _ element: AXUIElement,
    expectedPid: pid_t,
    names: [String]
) -> Bool {
    guard isTrustedSystemSettingsProcess(expectedPid),
          let settingsApp = findSettingsApp(),
          let buttonWindow = axWindowForElement(element, expectedPid: expectedPid),
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

    guard isTrustedSystemSettingsProcess(expectedPid),
          elementBelongsToProcess(element, pid: expectedPid) else { return false }
    defer { mouseUp.post(tap: .cghidEventTap) }
    mouseDown.post(tap: .cghidEventTap)
    usleep(80_000)
    return true
}

func clickNamed(
    in root: AXUIElement,
    names: [String],
    expectedPid: pid_t,
    maxNodes: Int = 2_000
) -> Bool {
    guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
    var queue: [AXUIElement] = [root]
    var seen: [AXUIElement] = []
    var matches: [AXUIElement] = []
    var visited = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        if seen.contains(where: { $0 == node }) { continue }
        seen.append(node)
        visited += 1
        if hasExactName(node, names: names),
           elementBelongsToProcess(node, pid: expectedPid),
           axBool(node, kAXHiddenAttribute as String) != true,
           axBool(node, kAXEnabledAttribute as String) == true,
           supportsPressAction(node),
           axFrame(node) != nil,
           settingsActionScopeAllowsElement(
               node,
               appElement: root,
               expectedPid: expectedPid
           ),
           !matches.contains(where: { $0 == node }) {
            matches.append(node)
        }
        queue.append(contentsOf: axSheets(node))
        queue.append(contentsOf: axChildren(node))
    }
    guard isTrustedSystemSettingsProcess(expectedPid),
          matches.count == 1 else { return false }
    guard settingsActionScopeAllowsElement(
        matches[0],
        appElement: root,
        expectedPid: expectedPid
    ) else { return false }
    return pressElement(
        matches[0],
        appElement: root,
        expectedPid: expectedPid
    )
}

func collectWindows(appElement: AXUIElement, expectedPid: pid_t) -> [AXUIElement] {
    guard isTrustedSystemSettingsProcess(expectedPid) else { return [] }
    var wins: [AXUIElement] = axCopy(appElement, kAXWindowsAttribute as String) ?? []
    if let focused: AXUIElement = axCopy(appElement, kAXFocusedWindowAttribute as String) {
        if !wins.contains(where: { $0 == focused }) { wins.append(focused) }
    }
    return isTrustedSystemSettingsProcess(expectedPid) ? wins : []
}

func focusTrustedSettingsWindow(
    _ window: AXUIElement,
    app: NSRunningApplication,
    expectedPid: pid_t,
    timeoutMs: Int
) -> Bool {
    guard isTrustedSystemSettings(app),
          isTrustedSystemSettingsProcess(expectedPid),
          elementBelongsToProcess(window, pid: expectedPid),
          axRole(window) == kAXWindowRole as String,
          axBool(window, kAXHiddenAttribute as String) != true,
          axFrame(window) != nil else { return false }

    guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
    _ = app.unhide()
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
        guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
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
    guard isTrustedSystemSettings(app),
          isTrustedSystemSettingsProcess(expectedPid) else { return false }

    _ = app.unhide()
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
    _ = AXUIElementSetAttributeValue(
        appElement,
        kAXHiddenAttribute as CFString,
        kCFBooleanFalse
    )

    let deadline = Date().addingTimeInterval(TimeInterval(max(0, timeoutMs)) / 1000.0)
    var lastWindowCount = 0
    var lastVisibleCount = 0
    var lastDialogCount = 0
    var lastMainCount = 0
    var lastPidCount = 0
    var lastRoleCount = 0
    var lastUnhiddenCount = 0
    var lastFramedCount = 0
    var lastMinimizedCount = 0
    var lastRoleEmptyCount = 0
    var lastRoleSheetCount = 0
    var lastRoleGroupCount = 0
    var lastRoleOtherCount = 0
    var lastHiddenCount = 0
    var lastFrameMissingCount = 0
    repeat {
        guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
        if let focusedWindow = focusedWindowForProcess(expectedPid),
           axBool(focusedWindow, kAXHiddenAttribute as String) != true,
           axFrame(focusedWindow) != nil {
            return true
        }
        if isWindowlessAppleIDSettingsOwner(
            appElement: appElement,
            expectedPid: expectedPid
        ), treeContainsExactText(
                appElement,
                names: appleAccountPageEvidence,
                expectedPid: expectedPid,
                maxNodes: 2_000
            ) {
            return true
        }

        let windows = collectWindows(appElement: appElement, expectedPid: expectedPid)
        let pidWindows = windows.filter {
            elementBelongsToProcess($0, pid: expectedPid)
        }
        let roleWindows = pidWindows.filter {
            axRole($0) == kAXWindowRole as String
        }
        for window in roleWindows {
            if axBool(window, kAXMinimizedAttribute as String) == true {
                _ = AXUIElementSetAttributeValue(
                    window,
                    kAXMinimizedAttribute as CFString,
                    kCFBooleanFalse
                )
            }
        }
        let unhiddenWindows = roleWindows.filter {
            axBool($0, kAXHiddenAttribute as String) != true
        }
        let framedWindows = unhiddenWindows.filter { axFrame($0) != nil }
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
        lastPidCount = pidWindows.count
        lastRoleCount = roleWindows.count
        lastUnhiddenCount = unhiddenWindows.count
        lastFramedCount = framedWindows.count
        lastMinimizedCount = roleWindows.filter {
            axBool($0, kAXMinimizedAttribute as String) == true
        }.count
        lastRoleEmptyCount = pidWindows.filter { axRole($0).isEmpty }.count
        lastRoleSheetCount = pidWindows.filter {
            axRole($0) == kAXSheetRole as String
        }.count
        lastRoleGroupCount = pidWindows.filter {
            axRole($0) == kAXGroupRole as String
        }.count
        lastRoleOtherCount = max(
            0,
            pidWindows.count - lastRoleEmptyCount - lastRoleCount -
                lastRoleSheetCount - lastRoleGroupCount
        )
        lastHiddenCount = pidWindows.filter {
            axBool($0, kAXHiddenAttribute as String) == true
        }.count
        lastFrameMissingCount = pidWindows.filter { axFrame($0) == nil }.count
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
        _ = app.unhide()
        _ = app.activate(options: [.activateAllWindows])
        _ = AXUIElementSetAttributeValue(
            appElement,
            kAXHiddenAttribute as CFString,
            kCFBooleanFalse
        )
        if Date() >= deadline { break }
        usleep(100_000)
    } while true

    logStep(
        1,
        "activation state trusted=\(AXIsProcessTrusted() ? 1 : 0) active=\(app.isActive ? 1 : 0) windows=\(lastWindowCount) pid=\(lastPidCount) roleWindow=\(lastRoleCount) roleEmpty=\(lastRoleEmptyCount) roleSheet=\(lastRoleSheetCount) roleGroup=\(lastRoleGroupCount) roleOther=\(lastRoleOtherCount) hidden=\(lastHiddenCount) frameMissing=\(lastFrameMissingCount) unhidden=\(lastUnhiddenCount) framed=\(lastFramedCount) minimized=\(lastMinimizedCount) visible=\(lastVisibleCount) dialogs=\(lastDialogCount) main=\(lastMainCount)"
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
    guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
    let deadline = Date().addingTimeInterval(TimeInterval(max(0, waitForAlertMs)) / 1000.0)
    var pressAttempts = 0
    var coordinateFallbackUsed = false
    repeat {
        guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
        guard let alert = findVerificationCodeAlertRoot(
            appElement: appElement,
            expectedPid: expectedPid
        ) else {
            if Date() >= deadline {
                return isTrustedSystemSettingsProcess(expectedPid)
            }
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
                    appElement: appElement,
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
            guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
            let alertGone = findVerificationCodeAlertRoot(
                appElement: appElement,
                expectedPid: expectedPid
            ) == nil
            guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
            return alertGone
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
        guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
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
    guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
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
        guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
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
                appElement: appElement,
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

enum VerificationPreparationResult {
    case ready
    case ownerLost
    case twoFactorNotFound
    case alertNotOpened
}

func prepareVerificationCodeAlert(
    appElement: AXUIElement,
    expectedPid: pid_t
) -> VerificationPreparationResult {
    guard isTrustedSystemSettingsProcess(expectedPid) else { return .ownerLost }
    logNavigationState(
        appElement: appElement,
        expectedPid: expectedPid,
        signInNames: signInSecurity,
        twoFactorNames: twoFactor,
        buttonNames: getCodeBtn
    )

    stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
    if findGetCodeButton(
        appElement: appElement,
        expectedPid: expectedPid,
        twoFactorNames: twoFactor,
        buttonNames: getCodeBtn
    ) != nil {
        logStep(3, "Sign-In & Security already open")
        logStep(4, "Two-Factor Authentication already open")
    } else {
        logStep(3, "click Sign-In & Security")
        if clickNamed(in: appElement, names: signInSecurity, expectedPid: expectedPid) {
            cancellablePause(1_200_000, appElement: appElement, expectedPid: expectedPid)
        }
        guard isTrustedSystemSettingsProcess(expectedPid) else { return .ownerLost }

        stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
        if findGetCodeButton(
            appElement: appElement,
            expectedPid: expectedPid,
            twoFactorNames: twoFactor,
            buttonNames: getCodeBtn
        ) != nil {
            logStep(4, "Two-Factor Authentication already open")
        } else {
            logStep(4, "click Two-Factor Authentication")
            if !clickNamed(in: appElement, names: twoFactor, expectedPid: expectedPid),
               findGetCodeButton(
                   appElement: appElement,
                   expectedPid: expectedPid,
                   twoFactorNames: twoFactor,
                   buttonNames: getCodeBtn
               ) == nil {
                return isTrustedSystemSettingsProcess(expectedPid)
                    ? .twoFactorNotFound
                    : .ownerLost
            }
            cancellablePause(1_200_000, appElement: appElement, expectedPid: expectedPid)
            guard isTrustedSystemSettingsProcess(expectedPid) else { return .ownerLost }
        }
    }

    stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
    logStep(5, "click Get Verification Code")
    guard requestVerificationCodeAlert(
        appElement: appElement,
        expectedPid: expectedPid,
        twoFactorNames: twoFactor,
        buttonNames: getCodeBtn
    ) else {
        return isTrustedSystemSettingsProcess(expectedPid)
            ? .alertNotOpened
            : .ownerLost
    }
    return .ready
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
let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))

for uiOwnerAttempt in 1...2 {
    stopIfCancelled()
    if uiOwnerAttempt == 1 {
        logStep(1, "opening Apple Account settings")
    } else {
        logStep(1, "recovering Apple Account settings UI")
    }
    guard Date() < deadline, openAppleAccountSettings() else { continue }
    cancellablePause(1_500_000)

    guard let app = findSettingsApp(),
          let settingsUIApp = waitForSettingsUIOwner(fallbackApp: app) else { continue }
    let appElement = AXUIElementCreateApplication(settingsUIApp.processIdentifier)
    let settingsPid = settingsUIApp.processIdentifier
    guard activateSystemSettings(
        app,
        appElement: appElement,
        expectedPid: settingsPid
    ) else {
        if isTrustedSystemSettingsProcess(settingsPid) {
            emit(Output(ok: false, code: nil, message: "System Settings focus unavailable"))
        }
        continue
    }
    cancellablePause(300_000, appElement: appElement, expectedPid: settingsPid)
    guard isTrustedSystemSettingsProcess(settingsPid) else { continue }
    logStep(2, "System Settings ready")

    switch prepareVerificationCodeAlert(
        appElement: appElement,
        expectedPid: settingsPid
    ) {
    case .ownerLost:
        continue
    case .twoFactorNotFound:
        emit(Output(ok: false, code: nil, message: "Two-Factor Authentication not found"))
    case .alertNotOpened:
        _ = closeVerificationCodeAlert(
            appElement: appElement,
            expectedPid: settingsPid,
            waitForAlertMs: 1_000
        )
        guard isTrustedSystemSettingsProcess(settingsPid) else { continue }
        emit(Output(ok: false, code: nil, message: "verification code alert was not opened"))
    case .ready:
        break
    }

    logStep(6, "waiting for verification code alert…")
    var code: String?
    var stableHits = 0
    var ownerLost = false
    while Date() < deadline {
        cancellablePause(250_000, appElement: appElement, expectedPid: settingsPid)
        guard isTrustedSystemSettingsProcess(settingsPid) else {
            ownerLost = true
            break
        }
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
    if ownerLost { continue }

    guard stableHits >= 2, let finalCode = code else {
        _ = closeVerificationCodeAlert(
            appElement: appElement,
            expectedPid: settingsPid,
            waitForAlertMs: 1_000
        )
        guard isTrustedSystemSettingsProcess(settingsPid) else { continue }
        emit(Output(ok: false, code: nil, message: "verification code alert not found"))
    }

    logStep(7, "verification code detected")
    stopIfCancelled(appElement: appElement, expectedPid: settingsPid)
    let closed = closeVerificationCodeAlert(
        appElement: appElement,
        expectedPid: settingsPid,
        waitForAlertMs: 2_000
    )
    guard isTrustedSystemSettingsProcess(settingsPid) else { continue }
    guard closed else {
        emit(Output(ok: false, code: nil, message: "verification code alert cleanup failed"))
    }
    stopIfCancelled(appElement: appElement, expectedPid: settingsPid)
    emit(Output(ok: true, code: finalCode, message: "ok"))
}

emit(Output(ok: false, code: nil, message: "Apple Account settings UI unavailable"))
