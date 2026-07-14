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
let signInSecurity = [
    "登录与安全性", "登入與安全性", "Sign-In & Security", "Sign-In and Security", "登录和安全性",
    "密码与安全性", "密碼與安全性", "Password & Security", "Password and Security",
]
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
        if elementBelongsToProcess(node, pid: expectedPid),
           axBool(node, kAXHiddenAttribute as String) != true,
           axFrame(node) != nil,
           hasExactName(node, names: names) {
            return isTrustedSystemSettingsProcess(expectedPid)
        }
        queue.append(contentsOf: axSheets(node))
        queue.append(contentsOf: axChildren(node))
    }
    return false
}

func elementProcessIdentifier(_ element: AXUIElement) -> pid_t? {
    var elementPid: pid_t = 0
    return AXUIElementGetPid(element, &elementPid) == .success ? elementPid : nil
}

func elementBelongsToProcess(_ element: AXUIElement, pid: pid_t) -> Bool {
    elementProcessIdentifier(element) == pid
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

func firstVisibleExactMatchOwner(
    appElement: AXUIElement,
    rootPid: pid_t,
    names: [String],
    maxNodes: Int = 2_000
) -> NSRunningApplication? {
    guard trustedSettingsUIOwner(processIdentifier: rootPid) != nil,
          elementBelongsToProcess(appElement, pid: rootPid) else { return nil }
    var queue = axSheets(appElement) + axChildren(appElement)
    var seen: [AXUIElement] = []
    var cursor = 0
    var visited = 0
    while cursor < queue.count && visited < maxNodes {
        let node = queue[cursor]
        cursor += 1
        if seen.contains(where: { $0 == node }) { continue }
        seen.append(node)
        visited += 1
        if axBool(node, kAXHiddenAttribute as String) != true,
           axFrame(node) != nil,
           hasExactName(node, names: names),
           let nodePid = elementProcessIdentifier(node),
           let owner = trustedSettingsUIOwner(processIdentifier: nodePid),
           owner.processIdentifier == nodePid,
           elementBelongsToProcess(node, pid: nodePid) {
            return owner
        }
        queue.append(contentsOf: axSheets(node))
        queue.append(contentsOf: axChildren(node))
    }
    return nil
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
        if elementBelongsToProcess(node, pid: expectedPid),
           (role == kAXStaticTextRole as String ||
            role == kAXGroupRole as String) {
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

func trustedSettingsUIOwner(processIdentifier pid: pid_t) -> NSRunningApplication? {
    guard let app = NSRunningApplication(processIdentifier: pid),
          !app.isTerminated else { return nil }
    if isTrustedAppleIDSettingsExtension(app) {
        let extensions = NSWorkspace.shared.runningApplications.filter(
            isTrustedAppleIDSettingsExtension
        )
        return extensions.count == 1 && extensions[0].processIdentifier == pid
            ? app
            : nil
    }
    guard isTrustedSystemSettings(app) else { return nil }
    let settingsApps = NSWorkspace.shared.runningApplications.filter(isTrustedSystemSettings)
    return settingsApps.count == 1 && settingsApps[0].processIdentifier == pid
        ? app
        : nil
}

func isTrustedSystemSettingsProcess(_ pid: pid_t) -> Bool {
    trustedSettingsUIOwner(processIdentifier: pid) != nil
}

func waitForSettingsApp(timeoutMs: Int) -> NSRunningApplication? {
    let deadline = Date().addingTimeInterval(TimeInterval(max(0, timeoutMs)) / 1000.0)
    repeat {
        stopIfCancelled()
        let matches = NSWorkspace.shared.runningApplications.filter(isTrustedSystemSettings)
        if matches.count == 1 { return matches[0] }
        if matches.count > 1 || Date() >= deadline { return nil }
        let pauseMs = remainingMilliseconds(until: deadline, cappedAt: 100)
        if pauseMs <= 0 { return nil }
        cancellablePause(UInt32(pauseMs * 1_000))
    } while true
}

func uniqueTrustedSettingsApp() -> NSRunningApplication? {
    let matches = NSWorkspace.shared.runningApplications.filter(isTrustedSystemSettings)
    return matches.count == 1 ? matches[0] : nil
}

func remainingMilliseconds(until deadline: Date, cappedAt cap: Int) -> Int {
    min(max(0, Int(deadline.timeIntervalSinceNow * 1_000)), max(0, cap))
}

func waitForAppleAccountSettingsPage(
    timeoutMs: Int,
    deadline: Date
) -> NSRunningApplication? {
    let timeoutDeadline = Date().addingTimeInterval(
        TimeInterval(max(0, timeoutMs)) / 1000.0
    )
    let boundedDeadline = min(deadline, timeoutDeadline)
    repeat {
        stopIfCancelled()
        if Date() >= boundedDeadline { return nil }
        let matches = NSWorkspace.shared.runningApplications.filter(
            isTrustedAppleIDSettingsExtension
        )
        if matches.count > 1 { return nil }
        var rootPids: [pid_t] = matches.map(\.processIdentifier)
        if let settingsHost = uniqueTrustedSettingsApp(),
           !rootPids.contains(settingsHost.processIdentifier) {
            rootPids.append(settingsHost.processIdentifier)
        }
        for rootPid in rootPids {
            let appElement = AXUIElementCreateApplication(rootPid)
            if let owner = firstVisibleExactMatchOwner(
                appElement: appElement,
                rootPid: rootPid,
                names: appleAccountPageEvidence,
                maxNodes: 2_000
            ) {
                stopIfCancelled()
                guard Date() < boundedDeadline else { return nil }
                guard trustedSettingsUIOwner(
                    processIdentifier: owner.processIdentifier
                )?.processIdentifier == owner.processIdentifier else { return nil }
                logStep(1, "Apple Account settings page ready")
                return owner
            }
        }
        let pauseMs = remainingMilliseconds(until: boundedDeadline, cappedAt: 50)
        if pauseMs <= 0 { return nil }
        cancellablePause(UInt32(pauseMs * 1_000))
    } while true
}

func openAppleAccountSettings(deadline: Date) -> NSRunningApplication? {
    let expectsExtension = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 13
    for s in orderedAccountUrls() {
        stopIfCancelled()
        guard Date() < deadline else { return nil }
        guard let url = URL(string: s), NSWorkspace.shared.open(url) else { continue }
        if !expectsExtension {
            stopIfCancelled()
            guard Date() < deadline else { return nil }
            return waitForSettingsApp(
                timeoutMs: remainingMilliseconds(until: deadline, cappedAt: 4_000)
            )
        }
        if let owner = waitForAppleAccountSettingsPage(
            timeoutMs: 5_000,
            deadline: deadline
        ) {
            return owner
        }
    }
    guard !expectsExtension, Date() < deadline else { return nil }
    stopIfCancelled()
    guard NSWorkspace.shared.launchApplication(
        withBundleIdentifier: "com.apple.systempreferences",
        options: [],
        additionalEventParamDescriptor: nil,
        launchIdentifier: nil
    ) else { return nil }
    return waitForSettingsApp(
        timeoutMs: remainingMilliseconds(until: deadline, cappedAt: 4_000)
    )
}

func actionMayProceed(
    deadline: Date?,
    appElement: AXUIElement,
    expectedPid: pid_t
) -> Bool {
    if deadline != nil {
        stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
    }
    guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
    return deadline.map { Date() < $0 } ?? true
}

func pressElement(
    _ element: AXUIElement,
    appElement: AXUIElement,
    expectedPid: pid_t,
    deadline: Date? = nil
) -> Bool {
    guard actionMayProceed(
              deadline: deadline,
              appElement: appElement,
              expectedPid: expectedPid
          ),
          settingsActionScopeAllowsElement(
              element,
              appElement: appElement,
              expectedPid: expectedPid
          ),
          elementBelongsToProcess(element, pid: expectedPid),
          axBool(element, kAXEnabledAttribute as String) == true else { return false }
    guard actionMayProceed(
        deadline: deadline,
        appElement: appElement,
        expectedPid: expectedPid
    ) else { return false }
    let err = AXUIElementPerformAction(element, kAXPressAction as CFString)
    if err == .success { return true }
    guard actionMayProceed(
              deadline: deadline,
              appElement: appElement,
              expectedPid: expectedPid
          ),
          settingsActionScopeAllowsElement(
              element,
              appElement: appElement,
              expectedPid: expectedPid
          ) else { return false }
    guard actionMayProceed(
        deadline: deadline,
        appElement: appElement,
        expectedPid: expectedPid
    ) else { return false }
    _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if let deadline {
        let pauseMs = remainingMilliseconds(until: deadline, cappedAt: 80)
        guard pauseMs > 0 else { return false }
        cancellablePause(
            UInt32(pauseMs * 1_000),
            appElement: appElement,
            expectedPid: expectedPid
        )
    } else {
        usleep(80_000)
    }
    guard actionMayProceed(
              deadline: deadline,
              appElement: appElement,
              expectedPid: expectedPid
          ),
          settingsActionScopeAllowsElement(
              element,
              appElement: appElement,
              expectedPid: expectedPid
          ),
          elementBelongsToProcess(element, pid: expectedPid) else { return false }
    guard actionMayProceed(
        deadline: deadline,
        appElement: appElement,
        expectedPid: expectedPid
    ) else { return false }
    return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func pressExactButton(
    _ element: AXUIElement,
    appElement: AXUIElement,
    expectedPid: pid_t,
    names: [String],
    deadline: Date? = nil
) -> Bool {
    guard actionMayProceed(
              deadline: deadline,
              appElement: appElement,
              expectedPid: expectedPid
          ),
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
        expectedPid: expectedPid,
        deadline: deadline
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

enum WindowlessOwnerStatus: String {
    case ownerUntrusted = "owner_untrusted"
    case rootPidInvalid = "root_pid_invalid"
    case windowsUnavailable = "windows_unavailable"
    case windowPidInvalid = "window_pid_invalid"
    case windowRoleInvalid = "window_role_invalid"
    case standardWindowPresent = "standard_window_present"
    case ownerChanged = "owner_changed"
    case eligible
}

func windowlessAppleIDSettingsStatus(
    appElement: AXUIElement,
    expectedPid: pid_t
) -> WindowlessOwnerStatus {
    guard isTrustedSystemSettingsProcess(expectedPid),
          let owner = NSRunningApplication(processIdentifier: expectedPid),
          isTrustedAppleIDSettingsExtension(owner) else { return .ownerUntrusted }
    guard elementBelongsToProcess(appElement, pid: expectedPid) else {
        return .rootPidInvalid
    }
    guard let candidates = axElementArrayStrict(
        appElement,
        kAXWindowsAttribute as String
    ) else { return .windowsUnavailable }
    var hasStandardWindow = false
    for candidate in candidates {
        guard elementBelongsToProcess(candidate, pid: expectedPid) else {
            return .windowPidInvalid
        }
        guard let role = axString(candidate, kAXRoleAttribute as String),
              !role.isEmpty else { return .windowRoleInvalid }
        if role == kAXWindowRole as String { hasStandardWindow = true }
    }
    if hasStandardWindow { return .standardWindowPresent }
    return isTrustedSystemSettingsProcess(expectedPid) ? .eligible : .ownerChanged
}

func isWindowlessAppleIDSettingsOwner(
    appElement: AXUIElement,
    expectedPid: pid_t
) -> Bool {
    windowlessAppleIDSettingsStatus(
        appElement: appElement,
        expectedPid: expectedPid
    ) == .eligible
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
    appElement: AXUIElement,
    expectedPid: pid_t,
    names: [String],
    deadline: Date? = nil
) -> Bool {
    let focusTimeoutMs = deadline.map {
        remainingMilliseconds(until: $0, cappedAt: 1_500)
    } ?? 1_500
    guard focusTimeoutMs > 0,
          actionMayProceed(
              deadline: deadline,
              appElement: appElement,
              expectedPid: expectedPid
          ),
          let settingsApp = uniqueTrustedSettingsApp(),
          let buttonWindow = axWindowForElement(element, expectedPid: expectedPid),
          focusTrustedSettingsWindow(
              buttonWindow,
              app: settingsApp,
              expectedPid: expectedPid,
              timeoutMs: focusTimeoutMs
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

    guard actionMayProceed(
              deadline: deadline,
              appElement: appElement,
              expectedPid: expectedPid
          ),
          elementBelongsToProcess(element, pid: expectedPid) else { return false }
    guard actionMayProceed(
        deadline: deadline,
        appElement: appElement,
        expectedPid: expectedPid
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
    deadline: Date,
    maxNodes: Int = 2_000
) -> Bool {
    guard actionMayProceed(
        deadline: deadline,
        appElement: root,
        expectedPid: expectedPid
    ) else { return false }
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
    guard actionMayProceed(
              deadline: deadline,
              appElement: root,
              expectedPid: expectedPid
          ),
          matches.count == 1 else { return false }
    guard settingsActionScopeAllowsElement(
        matches[0],
        appElement: root,
        expectedPid: expectedPid
    ) else { return false }
    return pressElement(
        matches[0],
        appElement: root,
        expectedPid: expectedPid,
        deadline: deadline
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
        if Date() >= deadline { return false }
        if focusedWindowForProcess(expectedPid) == window { return true }
        usleep(100_000)
    } while true
}

func focusExistingSettingsWindow(
    app: NSRunningApplication,
    appElement: AXUIElement,
    expectedPid: pid_t,
    deadline: Date
) -> Bool {
    guard Date() < deadline,
          isTrustedSystemSettings(app),
          app.processIdentifier == expectedPid,
          isTrustedSystemSettingsProcess(expectedPid) else { return false }
    if let focusedWindow = focusedWindowForProcess(expectedPid),
       axBool(focusedWindow, kAXHiddenAttribute as String) != true,
       axFrame(focusedWindow) != nil {
        return true
    }
    let visibleWindows = collectWindows(
        appElement: appElement,
        expectedPid: expectedPid
    ).filter {
        elementBelongsToProcess($0, pid: expectedPid) &&
            axRole($0) == kAXWindowRole as String &&
            axBool($0, kAXHiddenAttribute as String) != true &&
            axFrame($0) != nil
    }
    let mainWindows = visibleWindows.filter {
        axBool($0, kAXMainAttribute as String) == true
    }
    let target = mainWindows.count == 1
        ? mainWindows[0]
        : visibleWindows.count == 1 ? visibleWindows[0] : nil
    let focusTimeoutMs = remainingMilliseconds(until: deadline, cappedAt: 500)
    guard let target, focusTimeoutMs > 0 else { return false }
    return focusTrustedSettingsWindow(
        target,
        app: app,
        expectedPid: expectedPid,
        timeoutMs: focusTimeoutMs
    )
}

func activateSystemSettings(
    _ app: NSRunningApplication,
    appElement: AXUIElement,
    expectedPid: pid_t,
    deadline: Date,
    timeoutMs: Int = 4_000
) -> Bool {
    stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
    guard Date() < deadline,
          isTrustedSystemSettings(app),
          isTrustedSystemSettingsProcess(expectedPid) else { return false }

    let initialWindowlessStatus = windowlessAppleIDSettingsStatus(
        appElement: appElement,
        expectedPid: expectedPid
    )
    if initialWindowlessStatus == .eligible,
       treeContainsExactText(
           appElement,
           names: appleAccountPageEvidence,
           expectedPid: expectedPid,
           maxNodes: 2_000
       ), Date() < deadline {
        return true
    }
    stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
    guard Date() < deadline else { return false }

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

    let timeoutDeadline = Date().addingTimeInterval(
        TimeInterval(max(0, timeoutMs)) / 1000.0
    )
    let boundedDeadline = min(deadline, timeoutDeadline)
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
    var lastWindowlessStatus = WindowlessOwnerStatus.ownerUntrusted.rawValue
    repeat {
        stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
        if Date() >= boundedDeadline { break }
        guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
        if let focusedWindow = focusedWindowForProcess(expectedPid),
           axBool(focusedWindow, kAXHiddenAttribute as String) != true,
           axFrame(focusedWindow) != nil {
            return true
        }
        let windowlessStatus = windowlessAppleIDSettingsStatus(
            appElement: appElement,
            expectedPid: expectedPid
        )
        lastWindowlessStatus = windowlessStatus.rawValue
        if windowlessStatus == .eligible, treeContainsExactText(
                appElement,
                names: appleAccountPageEvidence,
                expectedPid: expectedPid,
                maxNodes: 2_000
            ), Date() < boundedDeadline {
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
        let focusTimeoutMs = remainingMilliseconds(
            until: boundedDeadline,
            cappedAt: 500
        )
        if let target,
           focusTimeoutMs > 0,
           focusTrustedSettingsWindow(
               target,
               app: app,
               expectedPid: expectedPid,
               timeoutMs: focusTimeoutMs
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
        let pauseMs = remainingMilliseconds(until: boundedDeadline, cappedAt: 100)
        if pauseMs <= 0 { break }
        cancellablePause(
            UInt32(pauseMs * 1_000),
            appElement: appElement,
            expectedPid: expectedPid
        )
    } while true

    logStep(
        1,
        "activation state trusted=\(AXIsProcessTrusted() ? 1 : 0) active=\(app.isActive ? 1 : 0) windows=\(lastWindowCount) pid=\(lastPidCount) roleWindow=\(lastRoleCount) roleEmpty=\(lastRoleEmptyCount) roleSheet=\(lastRoleSheetCount) roleGroup=\(lastRoleGroupCount) roleOther=\(lastRoleOtherCount) hidden=\(lastHiddenCount) frameMissing=\(lastFrameMissingCount) unhidden=\(lastUnhiddenCount) framed=\(lastFramedCount) minimized=\(lastMinimizedCount) visible=\(lastVisibleCount) dialogs=\(lastDialogCount) main=\(lastMainCount) windowless=\(lastWindowlessStatus)"
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
                    appElement: appElement,
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
    timeoutMs: Int,
    deadline: Date
) -> Bool {
    let timeoutDeadline = Date().addingTimeInterval(
        TimeInterval(max(0, timeoutMs)) / 1000.0
    )
    let boundedDeadline = min(deadline, timeoutDeadline)
    repeat {
        stopIfCancelled(appElement: appElement, expectedPid: expectedPid)
        if Date() >= boundedDeadline { return false }
        guard isTrustedSystemSettingsProcess(expectedPid) else { return false }
        if hasVerificationCodeAlert(appElement: appElement, expectedPid: expectedPid) {
            return actionMayProceed(
                deadline: boundedDeadline,
                appElement: appElement,
                expectedPid: expectedPid
            )
        }
        let pauseMs = remainingMilliseconds(until: boundedDeadline, cappedAt: 100)
        if pauseMs <= 0 { return false }
        cancellablePause(
            UInt32(pauseMs * 1_000),
            appElement: appElement,
            expectedPid: expectedPid
        )
    } while true
}

func requestVerificationCodeAlert(
    appElement: AXUIElement,
    expectedPid: pid_t,
    twoFactorNames: [String],
    buttonNames: [String],
    deadline: Date
) -> Bool {
    guard actionMayProceed(
        deadline: deadline,
        appElement: appElement,
        expectedPid: expectedPid
    ) else { return false }
    if hasVerificationCodeAlert(appElement: appElement, expectedPid: expectedPid) {
        let closeWaitMs = remainingMilliseconds(until: deadline, cappedAt: 1_000)
        guard closeWaitMs > 0 else { return false }
        guard closeVerificationCodeAlert(
            appElement: appElement,
            expectedPid: expectedPid,
            waitForAlertMs: closeWaitMs
        ), actionMayProceed(
            deadline: deadline,
            appElement: appElement,
            expectedPid: expectedPid
        ), !hasVerificationCodeAlert(appElement: appElement, expectedPid: expectedPid) else {
            return false
        }
    }

    for attempt in 1...3 {
        guard actionMayProceed(
            deadline: deadline,
            appElement: appElement,
            expectedPid: expectedPid
        ) else { return false }
        if hasVerificationCodeAlert(appElement: appElement, expectedPid: expectedPid) {
            return actionMayProceed(
                deadline: deadline,
                appElement: appElement,
                expectedPid: expectedPid
            )
        }
        let button = findGetCodeButton(
            appElement: appElement,
            expectedPid: expectedPid,
            twoFactorNames: twoFactorNames,
            buttonNames: buttonNames
        )
        guard actionMayProceed(
            deadline: deadline,
            appElement: appElement,
            expectedPid: expectedPid
        ) else { return false }
        guard let button else {
            if waitForVerificationCodeAlert(
                appElement: appElement,
                expectedPid: expectedPid,
                timeoutMs: 250,
                deadline: deadline
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
                names: buttonNames,
                deadline: deadline
            )
        } else {
            _ = clickElementAtVerifiedFrame(
                button,
                appElement: appElement,
                expectedPid: expectedPid,
                names: buttonNames,
                deadline: deadline
            )
        }

        if waitForVerificationCodeAlert(
            appElement: appElement,
            expectedPid: expectedPid,
            timeoutMs: 2_000,
            deadline: deadline
        ) {
            return true
        }
    }
    return waitForVerificationCodeAlert(
        appElement: appElement,
        expectedPid: expectedPid,
        timeoutMs: 500,
        deadline: deadline
    )
}

enum VerificationPreparationResult {
    case ready
    case ownerLost
    case timedOut
    case twoFactorNotFound
    case alertNotOpened
}

func prepareVerificationCodeAlert(
    appElement: AXUIElement,
    expectedPid: pid_t,
    deadline: Date
) -> VerificationPreparationResult {
    guard actionMayProceed(
        deadline: deadline,
        appElement: appElement,
        expectedPid: expectedPid
    ) else {
        return isTrustedSystemSettingsProcess(expectedPid) ? .timedOut : .ownerLost
    }
    guard actionMayProceed(
        deadline: deadline,
        appElement: appElement,
        expectedPid: expectedPid
    ) else {
        return isTrustedSystemSettingsProcess(expectedPid) ? .timedOut : .ownerLost
    }
    let existingButton = findGetCodeButton(
        appElement: appElement,
        expectedPid: expectedPid,
        twoFactorNames: twoFactor,
        buttonNames: getCodeBtn
    )
    guard actionMayProceed(
        deadline: deadline,
        appElement: appElement,
        expectedPid: expectedPid
    ) else {
        return isTrustedSystemSettingsProcess(expectedPid) ? .timedOut : .ownerLost
    }
    if existingButton != nil {
        logStep(3, "Sign-In & Security already open")
        logStep(4, "Two-Factor Authentication already open")
    } else {
        logStep(3, "click Sign-In & Security")
        if clickNamed(
            in: appElement,
            names: signInSecurity,
            expectedPid: expectedPid,
            deadline: deadline
        ) {
            let pauseMs = remainingMilliseconds(until: deadline, cappedAt: 1_200)
            guard pauseMs > 0 else { return .timedOut }
            cancellablePause(
                UInt32(pauseMs * 1_000),
                appElement: appElement,
                expectedPid: expectedPid
            )
        }
        guard actionMayProceed(
            deadline: deadline,
            appElement: appElement,
            expectedPid: expectedPid
        ) else {
            return isTrustedSystemSettingsProcess(expectedPid) ? .timedOut : .ownerLost
        }

        if findGetCodeButton(
            appElement: appElement,
            expectedPid: expectedPid,
            twoFactorNames: twoFactor,
            buttonNames: getCodeBtn
        ) != nil {
            logStep(4, "Two-Factor Authentication already open")
        } else {
            logStep(4, "click Two-Factor Authentication")
            let openedTwoFactor = clickNamed(
                in: appElement,
                names: twoFactor,
                expectedPid: expectedPid,
                deadline: deadline
            )
            if !openedTwoFactor {
                let fallbackButton = findGetCodeButton(
                   appElement: appElement,
                   expectedPid: expectedPid,
                   twoFactorNames: twoFactor,
                   buttonNames: getCodeBtn
                )
                guard actionMayProceed(
                    deadline: deadline,
                    appElement: appElement,
                    expectedPid: expectedPid
                ) else {
                    return isTrustedSystemSettingsProcess(expectedPid)
                        ? .timedOut
                        : .ownerLost
                }
                if fallbackButton == nil {
                    return .twoFactorNotFound
                }
            }
            let pauseMs = remainingMilliseconds(until: deadline, cappedAt: 1_200)
            guard pauseMs > 0 else { return .timedOut }
            cancellablePause(
                UInt32(pauseMs * 1_000),
                appElement: appElement,
                expectedPid: expectedPid
            )
            guard actionMayProceed(
                deadline: deadline,
                appElement: appElement,
                expectedPid: expectedPid
            ) else {
                return isTrustedSystemSettingsProcess(expectedPid) ? .timedOut : .ownerLost
            }
        }
    }

    guard actionMayProceed(
        deadline: deadline,
        appElement: appElement,
        expectedPid: expectedPid
    ) else {
        return isTrustedSystemSettingsProcess(expectedPid) ? .timedOut : .ownerLost
    }
    logStep(5, "click Get Verification Code")
    let alertRequested = requestVerificationCodeAlert(
        appElement: appElement,
        expectedPid: expectedPid,
        twoFactorNames: twoFactor,
        buttonNames: getCodeBtn,
        deadline: deadline
    )
    guard actionMayProceed(
        deadline: deadline,
        appElement: appElement,
        expectedPid: expectedPid
    ) else {
        return isTrustedSystemSettingsProcess(expectedPid) ? .timedOut : .ownerLost
    }
    guard alertRequested else {
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
guard AXIsProcessTrusted() else {
    logStep(0, "Accessibility permission unavailable")
    emit(Output(ok: false, code: nil, message: "Accessibility permission unavailable"))
}
let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))

for uiOwnerAttempt in 1...2 {
    stopIfCancelled()
    if uiOwnerAttempt == 1 {
        logStep(1, "opening Apple Account settings")
    } else {
        logStep(1, "recovering Apple Account settings UI")
    }
    guard Date() < deadline,
          let settingsUIApp = openAppleAccountSettings(deadline: deadline) else { continue }
    let appElement = AXUIElementCreateApplication(settingsUIApp.processIdentifier)
    let settingsPid = settingsUIApp.processIdentifier
    let expectsExtension = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 13
    guard !settingsUIApp.isTerminated,
          isTrustedSystemSettingsProcess(settingsPid) else { continue }

    var settingsHost: NSRunningApplication?
    if isTrustedSystemSettings(settingsUIApp) {
        settingsHost = settingsUIApp
    } else {
        guard expectsExtension,
              isTrustedAppleIDSettingsExtension(settingsUIApp) else { continue }
    }
    if !expectsExtension {
        guard settingsHost?.processIdentifier == settingsPid else { continue }
    }

    let verifiedWindowlessOwner = windowlessAppleIDSettingsStatus(
        appElement: appElement,
        expectedPid: settingsPid
    ) == .eligible
    let modernHostOwner = expectsExtension && isTrustedSystemSettings(settingsUIApp)
    if modernHostOwner {
        guard let app = settingsHost,
              focusExistingSettingsWindow(
                  app: app,
                  appElement: appElement,
                  expectedPid: settingsPid,
                  deadline: deadline
              ) else { continue }
    } else if !verifiedWindowlessOwner {
        guard let app = settingsHost ?? waitForSettingsApp(
            timeoutMs: remainingMilliseconds(until: deadline, cappedAt: 4_000)
        ) else { continue }
        guard activateSystemSettings(
            app,
            appElement: appElement,
            expectedPid: settingsPid,
            deadline: deadline
        ) else {
            continue
        }
        let readyPauseMs = remainingMilliseconds(until: deadline, cappedAt: 300)
        guard readyPauseMs > 0 else { continue }
        cancellablePause(
            UInt32(readyPauseMs * 1_000),
            appElement: appElement,
            expectedPid: settingsPid
        )
        guard Date() < deadline else { continue }
        guard isTrustedSystemSettingsProcess(settingsPid) else { continue }
        let settledEvidence = visibleExactMatchCounts(
            appElement: appElement,
            expectedPid: settingsPid,
            names: appleAccountPageEvidence,
            maxNodes: 2_000
        )
        guard settledEvidence.visible > 0 else { continue }
    }
    stopIfCancelled(appElement: appElement, expectedPid: settingsPid)
    guard Date() < deadline else { continue }
    guard isTrustedSystemSettingsProcess(settingsPid) else { continue }
    logStep(2, "System Settings ready")

    switch prepareVerificationCodeAlert(
        appElement: appElement,
        expectedPid: settingsPid,
        deadline: deadline
    ) {
    case .ownerLost:
        continue
    case .timedOut:
        continue
    case .twoFactorNotFound:
        if uiOwnerAttempt < 2 { continue }
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
        let pollPauseMs = remainingMilliseconds(until: deadline, cappedAt: 250)
        if pollPauseMs <= 0 { break }
        cancellablePause(
            UInt32(pollPauseMs * 1_000),
            appElement: appElement,
            expectedPid: settingsPid
        )
        guard Date() < deadline else { break }
        guard isTrustedSystemSettingsProcess(settingsPid) else {
            ownerLost = true
            break
        }
        let detectedCode = scanCodeFromAlertOnly(
            appElement: appElement,
            expectedPid: settingsPid
        )
        guard Date() < deadline else { break }
        if let detectedCode {
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

    guard Date() < deadline, stableHits >= 2, let finalCode = code else {
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
