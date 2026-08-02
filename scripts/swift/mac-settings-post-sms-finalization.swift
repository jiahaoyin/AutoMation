#!/usr/bin/env swift
// Optional supervised post-SMS System Settings helper.
// It handles only the four modal surfaces observed in the supplied AX
// evidence: terms acceptance, the Mac password prompt, the AX-invisible
// iPhone passcode sheet, and the Find My Mac location choice. Every action is
// rebound to the current trusted owner/window before it is emitted.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(
    _ element: AXUIElement,
    _ windowID: UnsafeMutablePointer<CGWindowID>
) -> AXError

private struct UnlockBinding: Codable, Equatable {
    let axOwnerPid: Int32
    let visualOwnerPid: Int32
    let windowId: UInt32

    var axOwnerPID: pid_t { pid_t(axOwnerPid) }
    var visualOwnerPID: pid_t { pid_t(visualOwnerPid) }
    var windowID: CGWindowID { CGWindowID(windowId) }
}

private struct Output: Codable {
    let ok: Bool
    let stage: String
    let digits: Int?
    let binding: UnlockBinding?

    init(ok: Bool, stage: String, digits: Int?, binding: UnlockBinding? = nil) {
        self.ok = ok
        self.stage = stage
        self.digits = digits
        self.binding = binding
    }
}

private struct BoundSettingsWindow {
    let binding: UnlockBinding
    let frame: CGRect
}

private struct UnlockTarget {
    let binding: UnlockBinding
    let window: AXUIElement
    let cancelButton: AXUIElement
    let continueButton: AXUIElement
}

private enum ModalKind: Equatable {
    case terms
    case macPassword
    case location
}

private struct ModalTarget {
    let kind: ModalKind
    let binding: UnlockBinding
    let surface: AXUIElement
    let primaryButton: AXUIElement
    let secondaryButton: AXUIElement?
    let checkbox: AXUIElement?
    let passwordField: AXUIElement?
}

private let settingsBundleIDs: Set<String> = [
    "com.apple.SystemSettings",
    "com.apple.systempreferences",
]

private let appleIDSettingsExecutablePaths: Set<String> = [
    "/System/Library/ExtensionKit/Extensions/AppleIDSettings.appex/Contents/MacOS/AppleIDSettings",
    "/System/Applications/System Settings.app/Contents/PlugIns/AppleIDSettings.appex/Contents/MacOS/AppleIDSettings",
    "/System/Applications/System Settings.app/Contents/PlugIns/AccountsSettingsExtension.appex/Contents/MacOS/AccountsSettingsExtension",
]

private let cancelLabels: Set<String> = [
    "cancel",
    "\u{53D6}\u{6D88}",
]

private let continueLabels: Set<String> = [
    "continue",
    "next",
    "\u{7EE7}\u{7EED}",
    "\u{7E7C}\u{7E8C}",
]

private let agreeLabels: Set<String> = [
    "agree",
    "accept",
    "\u{540C}\u{610F}",
    "\u{63A5}\u{53D7}",
]

private let laterLabels: Set<String> = [
    "later",
    "not now",
    "\u{4EE5}\u{540E}",
    "\u{7A0D}\u{540E}",
]

private let allowLabels: Set<String> = [
    "allow",
    "\u{5141}\u{8BB8}",
]

private let termsMarkers = [
    "terms and conditions",
    "terms of service",
    "\u{6761}\u{6B3E}\u{4E0E}\u{6761}\u{4EF6}",
    "\u{670D}\u{52A1}\u{6761}\u{6B3E}",
]

private let macPasswordContextMarkers = [
    "mac",
    "computer",
    "this mac",
    "\u{672C}\u{673A}",
    "\u{7535}\u{8111}",
]

private let passwordMarkers = [
    "password",
    "passcode",
    "\u{5BC6}\u{7801}",
    "\u{5BC6}\u{78BC}",
]

private let locationMarkers = [
    "find my mac",
    "\u{67E5}\u{627E}\u{6211}\u{7684} mac",
    "\u{67E5}\u{627E}\u{6211}\u{7684}\u{7535}\u{8111}",
]

private let fixedMacPasswords: Set<String> = ["0000", "000000"]

private let appleAccountMarkers = [
    "apple account",
    "apple id",
    "apple\u{8D26}\u{6237}",
    "apple \u{8D26}\u{6237}",
    "apple\u{5E10}\u{6237}",
    "apple \u{5E10}\u{6237}",
    "apple\u{5E33}\u{6236}",
    "apple \u{5E33}\u{6236}",
    "apple\u{8D26}\u{53F7}",
    "apple \u{8D26}\u{53F7}",
    "apple\u{5E33}\u{865F}",
    "apple \u{5E33}\u{865F}",
]

private let unlockSecondaryMarkers = [
    "\u{4E0D}\u{77E5}\u{9053}\u{5BC6}\u{7801}",
    "\u{5FD8}\u{8BB0}\u{5BC6}\u{7801}",
    "\u{4E0D}\u{77E5}\u{9053}\u{5BC6}\u{78BC}",
    "\u{5FD8}\u{8A18}\u{5BC6}\u{78BC}",
    "don't know password",
    "forgot password",
]

private func emit(_ output: Output) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(output) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
    exit(output.ok ? 0 : 1)
}

private func axCopy<T>(_ element: AXUIElement, _ attribute: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? T
}

private func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let value: CFTypeRef = axCopy(element, attribute) else { return nil }
    if let value = value as? String { return value }
    if let value = value as? NSNumber { return value.stringValue }
    return nil
}

private func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    guard let value: CFTypeRef = axCopy(element, attribute) else { return nil }
    if let value = value as? Bool { return value }
    if let value = value as? NSNumber { return value.boolValue }
    return nil
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axCopy(element, kAXChildrenAttribute as String) ?? []
}

private func axSheets(_ element: AXUIElement) -> [AXUIElement] {
    axCopy(element, "AXSheets") ?? []
}

private func axParent(_ element: AXUIElement) -> AXUIElement? {
    axCopy(element, kAXParentAttribute as String)
}

private func axRole(_ element: AXUIElement) -> String {
    axString(element, kAXRoleAttribute as String) ?? ""
}

private func axIdentifier(_ element: AXUIElement) -> String {
    axString(element, kAXIdentifierAttribute as String) ?? ""
}

private func axFrame(_ element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXPositionAttribute as CFString,
        &positionValue
    ) == .success,
    AXUIElementCopyAttributeValue(
        element,
        kAXSizeAttribute as CFString,
        &sizeValue
    ) == .success,
    let positionValue,
    let sizeValue,
    CFGetTypeID(positionValue) == AXValueGetTypeID(),
    CFGetTypeID(sizeValue) == AXValueGetTypeID() else {
        return nil
    }
    let position = positionValue as! AXValue
    let size = sizeValue as! AXValue

    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &point),
          AXValueGetValue(size, .cgSize, &dimensions),
          point.x.isFinite,
          point.y.isFinite,
          dimensions.width > 0,
          dimensions.height > 0 else {
        return nil
    }
    return CGRect(origin: point, size: dimensions)
}

private func directTexts(_ element: AXUIElement) -> [String] {
    [
        kAXTitleAttribute as String,
        kAXDescriptionAttribute as String,
        kAXValueAttribute as String,
        kAXPlaceholderValueAttribute as String,
        kAXHelpAttribute as String,
    ]
        .compactMap { axString(element, $0) }
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
}

private func normalized(_ text: String) -> String {
    text
        .split(whereSeparator: { $0.isWhitespace })
        .joined(separator: " ")
        .lowercased()
}

private func elementPID(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

private func belongsTo(_ element: AXUIElement, pid: pid_t) -> Bool {
    elementPID(element) == pid
}

private func belongsToTrustedOwners(
    _ element: AXUIElement,
    allowedPIDs: Set<pid_t>
) -> Bool {
    guard let pid = elementPID(element) else { return false }
    return allowedPIDs.contains(pid)
}

private func axElementsEqual(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool {
    CFEqual(lhs, rhs)
}

private func isVisible(_ element: AXUIElement) -> Bool {
    axBool(element, kAXHiddenAttribute as String) != true
}

private func isEnabled(_ element: AXUIElement) -> Bool {
    axBool(element, kAXEnabledAttribute as String) == true
}

// The macOS password sheet is SwiftUI-backed on some Sequoia builds and omits
// AXEnabled even though the secure field and Continue button are actionable.
// Keep the strict gate for every other surface; only an explicit false means
// disabled on this one scoped path.
private func isNotExplicitlyDisabled(_ element: AXUIElement) -> Bool {
    axBool(element, kAXEnabledAttribute as String) != false
}

private func supportsPress(_ element: AXUIElement) -> Bool {
    var actions: CFArray?
    guard AXUIElementCopyActionNames(element, &actions) == .success,
          let names = actions as? [String] else {
        return false
    }
    return names.contains(kAXPressAction as String)
}

private func isTrustedSystemSettingsHost(_ app: NSRunningApplication) -> Bool {
    guard let bundleID = app.bundleIdentifier,
          settingsBundleIDs.contains(bundleID),
          let path = app.executableURL?.standardizedFileURL.path else {
        return false
    }
    return path.hasPrefix("/System/")
}

private func isTrustedAppleIDSettingsExtension(_ app: NSRunningApplication) -> Bool {
    guard let path = app.executableURL?.standardizedFileURL.path else { return false }
    return appleIDSettingsExecutablePaths.contains(path)
}

private func trustedSettingsVisualOwner(_ pid: pid_t) -> NSRunningApplication? {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
        return nil
    }
    if isTrustedSystemSettingsHost(app) {
        let owners = NSWorkspace.shared.runningApplications.filter(isTrustedSystemSettingsHost)
        return owners.count == 1 && owners[0].processIdentifier == pid ? app : nil
    }
    if isTrustedAppleIDSettingsExtension(app) {
        let owners = NSWorkspace.shared.runningApplications.filter(isTrustedAppleIDSettingsExtension)
        return owners.count == 1 && owners[0].processIdentifier == pid ? app : nil
    }
    return nil
}

private func uniqueTrustedSettingsHost() -> NSRunningApplication? {
    let hosts = NSWorkspace.shared.runningApplications.filter(isTrustedSystemSettingsHost)
    return hosts.count == 1 ? hosts[0] : nil
}

// AppleIDSettings can own the AX subtree while the visible CGWindow remains
// owned by System Settings. Keep those identities distinct throughout the
// visual and input path.
private func visualHostForAXOwner(_ axOwnerPID: pid_t) -> NSRunningApplication? {
    guard let axOwner = trustedSettingsVisualOwner(axOwnerPID) else { return nil }
    if isTrustedSystemSettingsHost(axOwner) {
        return axOwner
    }
    guard isTrustedAppleIDSettingsExtension(axOwner),
          let host = uniqueTrustedSettingsHost(),
          host.processIdentifier != axOwnerPID else {
        return nil
    }
    return host
}

private func focusedWindowForTrustedSettingsHost(
    _ visualOwnerPID: pid_t
) -> (element: AXUIElement, frame: CGRect, windowID: CGWindowID)? {
    guard let host = uniqueTrustedSettingsHost(),
          host.processIdentifier == visualOwnerPID else {
        return nil
    }
    let appElement = AXUIElementCreateApplication(visualOwnerPID)
    guard let window: AXUIElement = axCopy(appElement, kAXFocusedWindowAttribute as String),
          belongsTo(window, pid: visualOwnerPID),
          axRole(window) == kAXWindowRole as String,
          isVisible(window),
          let frame = axFrame(window),
          let windowID = elementWindowID(window) else {
        return nil
    }
    return (window, frame, windowID)
}

private func frame(_ inner: CGRect, isWithin outer: CGRect, tolerance: CGFloat = 1.0) -> Bool {
    outer.insetBy(dx: -tolerance, dy: -tolerance).contains(inner)
}

private func windowsForApp(_ appElement: AXUIElement) -> [AXUIElement] {
    var windows: [AXUIElement] = axCopy(appElement, kAXWindowsAttribute as String) ?? []
    let focused: AXUIElement? = axCopy(appElement, kAXFocusedWindowAttribute as String)
    let main: AXUIElement? = axCopy(appElement, kAXMainWindowAttribute as String)
    for candidate in [focused, main].compactMap({ $0 }) where !windows.contains(where: { $0 == candidate }) {
        windows.append(candidate)
    }
    return windows
}

private func isSurfaceRole(_ element: AXUIElement) -> Bool {
    let role = axRole(element)
    return role == kAXWindowRole as String || role == "AXDialog" || role == "AXSheet"
}

// Most System Settings prompts are AXWindow/AXSheet descendants, but the
// AppleIDSettings extension can expose a modal as a top-level AXDialog or
// AXSheet. Enumerate only those trusted surface roles and their descendants;
// arbitrary application-root controls never become a recovery surface.
private func surfaceRoots(
    for appElement: AXUIElement,
    allowedPIDs: Set<pid_t>
) -> [AXUIElement] {
    var roots = windowsForApp(appElement)
    var queue = axChildren(appElement) + axSheets(appElement)
    if let focused: AXUIElement = axCopy(appElement, kAXFocusedUIElementAttribute as String) {
        queue.append(focused)
    }
    var seen: [AXUIElement] = []
    while !queue.isEmpty && seen.count < 1_024 {
        let current = queue.removeFirst()
        if seen.contains(where: { axElementsEqual($0, current) }) { continue }
        seen.append(current)
        guard belongsToTrustedOwners(current, allowedPIDs: allowedPIDs), isVisible(current) else {
            continue
        }
        if isSurfaceRole(current) && !roots.contains(where: { axElementsEqual($0, current) }) {
            roots.append(current)
        }
        // Walk only trusted surface containers. This discovers a dialog/sheet
        // nested below an AXWindow without flooding the tree with every text
        // field and button in the page.
        if isSurfaceRole(current) {
            queue.append(contentsOf: axChildren(current))
            queue.append(contentsOf: axSheets(current))
        }
    }
    return roots
}

private func activeSurfaceRoot(
    _ root: AXUIElement,
    allowedPIDs: Set<pid_t>
) -> AXUIElement? {
    guard isSurfaceRole(root),
          belongsToTrustedOwners(root, allowedPIDs: allowedPIDs),
          isVisible(root) else {
        return nil
    }
    let sheets = axSheets(root).filter {
        belongsToTrustedOwners($0, allowedPIDs: allowedPIDs) && isVisible($0)
    }
    guard sheets.count <= 1 else { return nil }
    guard let sheet = sheets.first else { return root }
    return activeSurfaceRoot(sheet, allowedPIDs: allowedPIDs)
}

private func visibleNodes(
    _ root: AXUIElement,
    allowedPIDs: Set<pid_t>,
    limit: Int = 1_200
) -> [AXUIElement] {
    var queue: [AXUIElement] = [root]
    var seen: [AXUIElement] = []
    var nodes: [AXUIElement] = []
    while !queue.isEmpty && nodes.count < limit {
        let current = queue.removeFirst()
        if seen.contains(where: { $0 == current }) { continue }
        seen.append(current)
        guard belongsToTrustedOwners(current, allowedPIDs: allowedPIDs), isVisible(current) else {
            continue
        }
        nodes.append(current)
        queue.append(contentsOf: axChildren(current))
        queue.append(contentsOf: axSheets(current))
    }
    return nodes
}

private func textBlob(_ nodes: [AXUIElement]) -> String {
    nodes.flatMap(directTexts).joined(separator: " ")
}

private func looksLikeIPhoneUnlockSheet(_ text: String) -> Bool {
    let value = normalized(text)
    let hasChineseUnlock = value.contains("\u{89E3}\u{9501}") || value.contains("\u{89E3}\u{9396}")
    let hasChinesePasscode = value.contains("\u{5BC6}\u{7801}") || value.contains("\u{5BC6}\u{78BC}")
    if value.contains("iphone") && hasChineseUnlock && hasChinesePasscode {
        return true
    }
    let hasIPhone = value.contains("iphone")
    let hasPasscode = value.contains("passcode") || value.contains("password")
    return hasIPhone && hasPasscode &&
        (value.contains("unlock") || value.contains("enter"))
}

private func hasUnlockSecondaryEvidence(_ text: String) -> Bool {
    let value = normalized(text)
    return appleAccountMarkers.contains(where: { value.contains($0) }) ||
        unlockSecondaryMarkers.contains(where: { value.contains($0) })
}

private func buttonMatches(
    _ element: AXUIElement,
    labels: Set<String>,
    requireEnabled: Bool = true,
    identifier: String? = nil
) -> Bool {
    guard axRole(element) == kAXButtonRole as String,
          isVisible(element),
          axFrame(element) != nil else {
        return false
    }
    if let identifier, axIdentifier(element) != identifier { return false }
    if requireEnabled && (!isEnabled(element) || !supportsPress(element)) { return false }
    return directTexts(element).contains { labels.contains(normalized($0)) }
}

private func textContainsAny(_ texts: [String], _ markers: [String]) -> Bool {
    let value = normalized(texts.joined(separator: " "))
    return markers.contains(where: { value.contains(normalized($0)) })
}

private func hasTermsEvidence(_ text: String) -> Bool {
    textContainsAny([text], termsMarkers)
}

private func hasMacPasswordEvidence(_ text: String) -> Bool {
    let value = normalized(text)
    let hasContext = macPasswordContextMarkers.contains { value.contains(normalized($0)) }
    let hasPasswordLabel = passwordMarkers.contains { value.contains(normalized($0)) }
    return hasContext && hasPasswordLabel
}

private func hasLocationEvidence(_ text: String) -> Bool {
    textContainsAny([text], locationMarkers)
}

private func isTextInput(_ element: AXUIElement) -> Bool {
    let role = axRole(element)
    return role == kAXTextFieldRole as String || role == "AXSecureTextField"
}

private func hasPasswordFieldEvidence(_ element: AXUIElement) -> Bool {
    if textContainsAny(directTexts(element), passwordMarkers) {
        return true
    }
    let identifier = normalized(axIdentifier(element))
    if passwordMarkers.contains(where: { identifier.contains(normalized($0)) }) {
        return true
    }
    var parent = axParent(element)
    for _ in 0..<4 {
        guard let node = parent else { break }
        if textContainsAny(directTexts(node), passwordMarkers) {
            return true
        }
        parent = axParent(node)
    }
    return false
}

private func isMacPasswordField(_ element: AXUIElement) -> Bool {
    guard isTextInput(element),
          isVisible(element),
          isNotExplicitlyDisabled(element),
          axFrame(element) != nil else {
        return false
    }
    return hasPasswordFieldEvidence(element)
}

private func checkboxIsSelected(_ element: AXUIElement) -> Bool {
    if axBool(element, kAXValueAttribute as String) == true { return true }
    return axString(element, kAXValueAttribute as String) == "1"
}

private func nearestButton(
    to element: AXUIElement,
    in nodes: [AXUIElement],
    labels: Set<String>,
    excludingIdentifiers: Set<String> = []
) -> AXUIElement? {
    guard let sourceFrame = axFrame(element) else { return nil }
    let candidates = nodes.compactMap { candidate -> (AXUIElement, CGFloat)? in
        guard !excludingIdentifiers.contains(axIdentifier(candidate)),
              buttonMatches(candidate, labels: labels, requireEnabled: false),
              let frame = axFrame(candidate) else {
            return nil
        }
        let distance = hypot(frame.midX - sourceFrame.midX, frame.midY - sourceFrame.midY)
        return (candidate, distance)
    }.sorted { $0.1 < $1.1 }
    guard let first = candidates.first else { return nil }
    guard candidates.count == 1 || candidates[1].1 - first.1 >= 8 else { return nil }
    return first.0
}

private func elementWindowID(_ element: AXUIElement) -> CGWindowID? {
    var windowID: CGWindowID = 0
    return _AXUIElementGetWindow(element, &windowID) == .success && windowID != 0
        ? windowID
        : nil
}

private func resolveOnScreenWindowID(pid: pid_t, near frame: CGRect) -> CGWindowID? {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let allWindows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    let center = CGPoint(x: frame.midX, y: frame.midY)
    let area = max(1, frame.width * frame.height)
    var candidates: [(id: CGWindowID, score: CGFloat)] = []

    for info in allWindows {
        guard let ownerPID = info[kCGWindowOwnerPID as String] as? NSNumber,
              pid_t(ownerPID.int32Value) == pid,
              let number = info[kCGWindowNumber as String] as? NSNumber,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let candidate = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              candidate.width > 80,
              candidate.height > 60 else {
            continue
        }
        let intersection = frame.intersection(candidate)
        let intersects = !intersection.isNull && !intersection.isEmpty
        let candidateCenter = CGPoint(x: candidate.midX, y: candidate.midY)
        guard intersects || candidate.contains(center) || frame.contains(candidateCenter) else {
            continue
        }
        let overlapPenalty = intersects ? 1 - (intersection.width * intersection.height / area) : 1
        let sizePenalty = abs(candidate.width - frame.width) / max(1, frame.width) +
            abs(candidate.height - frame.height) / max(1, frame.height)
        let centerPenalty = hypot(candidateCenter.x - center.x, candidateCenter.y - center.y) /
            max(1, max(frame.width, frame.height))
        candidates.append((CGWindowID(number.uint32Value), overlapPenalty + sizePenalty + centerPenalty))
    }

    candidates.sort { $0.score < $1.score }
    guard let best = candidates.first else { return nil }
    guard candidates.count == 1 || abs(candidates[1].score - best.score) >= 0.01 else {
        return nil
    }
    return best.id
}

private func onScreenWindowFrame(
    pid: pid_t,
    windowID: CGWindowID,
    near surfaceFrame: CGRect? = nil
) -> CGRect? {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    for info in windows {
        guard let owner = info[kCGWindowOwnerPID as String] as? NSNumber,
              pid_t(owner.int32Value) == pid,
              let number = info[kCGWindowNumber as String] as? NSNumber,
              CGWindowID(number.uint32Value) == windowID,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let candidateFrame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              candidateFrame.width > 80,
              candidateFrame.height > 60,
              let alpha = info[kCGWindowAlpha as String] as? NSNumber,
              alpha.doubleValue > 0 else {
            continue
        }
        if let surfaceFrame,
           !frame(surfaceFrame, isWithin: candidateFrame, tolerance: 4),
           surfaceFrame.intersection(candidateFrame).isNull {
            continue
        }
        return candidateFrame
    }
    return nil
}

private func trustedOwnerPID(
    for elements: [AXUIElement],
    fallback: pid_t
) -> pid_t? {
    guard !elements.isEmpty else {
        return trustedSettingsVisualOwner(fallback) == nil ? nil : fallback
    }
    let owners = elements.compactMap(elementPID)
    guard owners.count == elements.count,
          let first = owners.first,
          owners.allSatisfy({ $0 == first }),
          trustedSettingsVisualOwner(first) != nil else {
        return nil
    }
    return first
}

private func bindingForSurfaceElements(
    axOwnerPID: pid_t,
    surface: AXUIElement,
    surfaceFrame: CGRect?,
    elements: [AXUIElement]
) -> UnlockBinding? {
    guard let resolvedAXOwnerPID = trustedOwnerPID(for: elements, fallback: axOwnerPID),
          let visualHost = visualHostForAXOwner(resolvedAXOwnerPID),
          let surfaceFrame = surfaceFrame else {
        return nil
    }
    let visualOwnerPID = visualHost.processIdentifier
    let elementWindowIDs = elements.compactMap(elementWindowID)
    guard elementWindowIDs.count != elements.count || Set(elementWindowIDs).count == 1 else {
        return nil
    }
    let controlsWindowID: CGWindowID? = {
        guard !elementWindowIDs.isEmpty else { return nil }
        let uniqueWindowIDs = Set(elementWindowIDs)
        return uniqueWindowIDs.count == 1 ? uniqueWindowIDs.first : nil
    }()
    let directWindowID = controlsWindowID.flatMap { candidateID in
        onScreenWindowFrame(
            pid: visualOwnerPID,
            windowID: candidateID,
            near: elements.compactMap(axFrame).first ?? surfaceFrame
        ) == nil ? nil : candidateID
    } ?? elementWindowID(surface).flatMap { candidateID in
        onScreenWindowFrame(
            pid: visualOwnerPID,
            windowID: candidateID,
            near: surfaceFrame
        ) == nil ? nil : candidateID
    }
    let resolvedWindowID = directWindowID ?? resolveOnScreenWindowID(
        pid: visualOwnerPID,
        near: surfaceFrame
    )
    guard let windowID = resolvedWindowID,
          let visualWindowFrame = onScreenWindowFrame(
              pid: visualOwnerPID,
              windowID: windowID,
              near: surfaceFrame
          ) else {
        return nil
    }
    if !frame(surfaceFrame, isWithin: visualWindowFrame, tolerance: 4) {
        // A broad AXWindow can contain an independently composited modal. Once
        // every target control resolves to the same trusted CGWindow, accepting
        // the inverse containment binds the modal (for example 608) instead of
        // its host window (for example 446).
        guard !elements.isEmpty,
              frame(visualWindowFrame, isWithin: surfaceFrame, tolerance: 4) else {
            return nil
        }
    }
    guard elements.allSatisfy({ element in
        guard isDescendant(element, of: surface),
               let elementFrame = axFrame(element) else {
            return false
        }
        return frame(elementFrame, isWithin: visualWindowFrame, tolerance: 4)
    }) else {
        return nil
    }
    return UnlockBinding(
        axOwnerPid: Int32(resolvedAXOwnerPID),
        visualOwnerPid: Int32(visualOwnerPID),
        windowId: UInt32(windowID)
    )
}

private func isDescendant(_ element: AXUIElement, of ancestor: AXUIElement) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<32 {
        guard let node = current else { return false }
        if axElementsEqual(node, ancestor) { return true }
        current = axParent(node)
    }
    return false
}

private func isTrustedDescendant(
    _ element: AXUIElement,
    of ancestor: AXUIElement,
    ownerPIDs: Set<pid_t>
) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<32 {
        guard let node = current,
              belongsToTrustedOwners(node, allowedPIDs: ownerPIDs) else {
            return false
        }
        if axElementsEqual(node, ancestor) { return true }
        current = axParent(node)
    }
    return false
}

private func bindingForSurface(
    axOwnerPID: pid_t,
    surface: AXUIElement,
    surfaceFrame: CGRect?,
    cancelButton: AXUIElement,
    continueButton: AXUIElement
) -> UnlockBinding? {
    bindingForSurfaceElements(
        axOwnerPID: axOwnerPID,
        surface: surface,
        surfaceFrame: surfaceFrame,
        elements: [cancelButton, continueButton]
    )
}

private func trustedSurfaceCandidates() -> [(
    surface: AXUIElement,
    nodes: [AXUIElement],
    axOwnerPID: pid_t,
    binding: UnlockBinding
)] {
    var candidates: [(surface: AXUIElement, nodes: [AXUIElement], axOwnerPID: pid_t, binding: UnlockBinding)] = []
    var seen = Set<String>()
    let allowedPIDs = Set(
        NSWorkspace.shared.runningApplications.compactMap { app -> pid_t? in
            trustedSettingsVisualOwner(app.processIdentifier) == nil
                ? nil
                : app.processIdentifier
        }
    )
    guard !allowedPIDs.isEmpty else { return [] }

    for app in NSWorkspace.shared.runningApplications {
        guard allowedPIDs.contains(app.processIdentifier) else { continue }
        let axOwnerPID = app.processIdentifier
        let appElement = AXUIElementCreateApplication(axOwnerPID)
        let windows = surfaceRoots(for: appElement, allowedPIDs: allowedPIDs)
        // ExtensionKit may expose an application AX root without a concrete
        // on-screen window. That root is not a safe recovery surface: reject
        // it instead of allowing same-process unrelated UI through hit-test.
        guard !windows.isEmpty else { continue }
        for candidateRoot in windows {
            guard isSurfaceRole(candidateRoot),
                  let surface = activeSurfaceRoot(candidateRoot, allowedPIDs: allowedPIDs),
                  let surfaceOwnerPID = elementPID(surface),
                  allowedPIDs.contains(surfaceOwnerPID),
                  let binding = bindingForSurfaceElements(
                      axOwnerPID: surfaceOwnerPID,
                      surface: surface,
                      surfaceFrame: axFrame(surface),
                      elements: []
                  ) else {
                continue
            }
            // The host and ExtensionKit can expose the same on-screen window as
            // two AX roots. Keep one candidate per visual window; its node scan
            // already admits both trusted owners.
            let key = "\(binding.visualOwnerPid):\(binding.windowId)"
            guard seen.insert(key).inserted else { continue }
            let nodes = visibleNodes(surface, allowedPIDs: allowedPIDs)
            guard !nodes.isEmpty else { continue }
            candidates.append((surface: surface, nodes: nodes, axOwnerPID: surfaceOwnerPID, binding: binding))
        }
    }
    return candidates
}

private func uniqueUnlockTarget() -> UnlockTarget? {
    let targets = trustedSurfaceCandidates().compactMap { candidate -> UnlockTarget? in
        let text = textBlob(candidate.nodes)
        // macOS 15 can omit the sheet title from AX entirely. AX narrows this
        // to one trusted Apple Account recovery surface; Vision below must
        // still prove the title and 4/6-cell geometry before input.
        guard hasUnlockSecondaryEvidence(text) else { return nil }
        let cancelButtons = candidate.nodes.filter { buttonMatches($0, labels: cancelLabels) }
        let continueButtons = candidate.nodes.filter { buttonMatches($0, labels: continueLabels) }
        guard cancelButtons.count == 1,
              continueButtons.count == 1,
              let binding = bindingForSurface(
                  axOwnerPID: candidate.axOwnerPID,
                  surface: candidate.surface,
                  surfaceFrame: axFrame(candidate.surface),
                  cancelButton: cancelButtons[0],
                  continueButton: continueButtons[0]
              ) else {
            return nil
        }
        return UnlockTarget(
            binding: binding,
            window: candidate.surface,
            cancelButton: cancelButtons[0],
            continueButton: continueButtons[0]
        )
    }
    return targets.count == 1 ? targets[0] : nil
}

private func uniqueTermsTarget() -> ModalTarget? {
    let targets = trustedSurfaceCandidates().compactMap { candidate -> ModalTarget? in
        let termsText = textBlob(candidate.nodes)
        let checkboxes = candidate.nodes.filter { element in
            axRole(element) == kAXCheckBoxRole as String &&
                isVisible(element) &&
                supportsPress(element) &&
                axFrame(element) != nil
        }
        let agreeButtons = candidate.nodes.filter {
            buttonMatches($0, labels: agreeLabels, requireEnabled: false)
        }
        guard hasTermsEvidence(termsText),
              checkboxes.count == 1,
              agreeButtons.count == 1,
              let binding = bindingForSurfaceElements(
                  axOwnerPID: candidate.axOwnerPID,
                  surface: candidate.surface,
                  surfaceFrame: axFrame(candidate.surface),
                  elements: [checkboxes[0], agreeButtons[0]]
              ) else {
            return nil
        }
        return ModalTarget(
            kind: .terms,
            binding: binding,
            surface: candidate.surface,
            primaryButton: agreeButtons[0],
            secondaryButton: nil,
            checkbox: checkboxes[0],
            passwordField: nil
        )
    }
    return targets.count == 1 ? targets[0] : nil
}

private func uniqueMacPasswordTarget() -> ModalTarget? {
    let targets = trustedSurfaceCandidates().compactMap { candidate -> ModalTarget? in
        let passwordText = textBlob(candidate.nodes)
        let fields = candidate.nodes.filter(isMacPasswordField)
        let cancelButtons = candidate.nodes.filter {
            buttonMatches($0, labels: cancelLabels, requireEnabled: false)
        }
        guard fields.count == 1,
              cancelButtons.count == 1,
              (hasMacPasswordEvidence(passwordText) || hasPasswordFieldEvidence(fields[0])),
              let continueButton = nearestButton(
                  to: fields[0],
                  in: candidate.nodes,
                  labels: continueLabels,
                  excludingIdentifiers: ["LOGIN_BUTTON"]
              ),
              let binding = bindingForSurfaceElements(
                  axOwnerPID: candidate.axOwnerPID,
                  surface: candidate.surface,
                  surfaceFrame: axFrame(candidate.surface),
                  elements: [fields[0], cancelButtons[0], continueButton]
              ) else {
            return nil
        }
        return ModalTarget(
            kind: .macPassword,
            binding: binding,
            surface: candidate.surface,
            primaryButton: continueButton,
            secondaryButton: cancelButtons[0],
            checkbox: nil,
            passwordField: fields[0]
        )
    }
    var unique: [ModalTarget] = []
    for target in targets {
        guard let fieldFrame = target.passwordField.flatMap(axFrame),
              let primaryFrame = axFrame(target.primaryButton),
              let secondaryFrame = target.secondaryButton.flatMap(axFrame) else {
            continue
        }
        let signature = [
            String(target.binding.visualOwnerPid),
            String(target.binding.windowId),
            String(format: "%.1f,%.1f,%.1f,%.1f", fieldFrame.minX, fieldFrame.minY, fieldFrame.width, fieldFrame.height),
            String(format: "%.1f,%.1f,%.1f,%.1f", primaryFrame.minX, primaryFrame.minY, primaryFrame.width, primaryFrame.height),
            String(format: "%.1f,%.1f,%.1f,%.1f", secondaryFrame.minX, secondaryFrame.minY, secondaryFrame.width, secondaryFrame.height),
        ].joined(separator: ":")
        if !unique.contains(where: { existing in
            guard let existingField = existing.passwordField.flatMap(axFrame),
                  let existingPrimary = axFrame(existing.primaryButton),
                  let existingSecondary = existing.secondaryButton.flatMap(axFrame) else {
                return false
            }
            let existingSignature = [
                String(existing.binding.visualOwnerPid),
                String(existing.binding.windowId),
                String(format: "%.1f,%.1f,%.1f,%.1f", existingField.minX, existingField.minY, existingField.width, existingField.height),
                String(format: "%.1f,%.1f,%.1f,%.1f", existingPrimary.minX, existingPrimary.minY, existingPrimary.width, existingPrimary.height),
                String(format: "%.1f,%.1f,%.1f,%.1f", existingSecondary.minX, existingSecondary.minY, existingSecondary.width, existingSecondary.height),
            ].joined(separator: ":")
            return existingSignature == signature
        }) {
            unique.append(target)
        }
    }
    return unique.count == 1 ? unique[0] : nil
}

private func uniqueLocationTarget() -> ModalTarget? {
    let targets = trustedSurfaceCandidates().compactMap { candidate -> ModalTarget? in
        let text = normalized(textBlob(candidate.nodes))
        let laterButtons = candidate.nodes.filter {
            buttonMatches(
                $0,
                labels: laterLabels,
                requireEnabled: true,
                identifier: "action-button-2"
            )
        }
        let allowButtons = candidate.nodes.filter {
            buttonMatches(
                $0,
                labels: allowLabels,
                requireEnabled: true,
                identifier: "action-button-1"
            )
        }
        let hasFindMyMacEvidence = hasLocationEvidence(text) ||
            text.contains("appleidsettings") && text.contains("\u{8B66}\u{544A}") && text.contains("mac")
        guard hasFindMyMacEvidence,
              laterButtons.count == 1,
              allowButtons.count == 1,
              let binding = bindingForSurfaceElements(
                  axOwnerPID: candidate.axOwnerPID,
                  surface: candidate.surface,
                  surfaceFrame: axFrame(candidate.surface),
                  elements: [laterButtons[0], allowButtons[0]]
              ) else {
            return nil
        }
        return ModalTarget(
            kind: .location,
            binding: binding,
            surface: candidate.surface,
            primaryButton: laterButtons[0],
            secondaryButton: allowButtons[0],
            checkbox: nil,
            passwordField: nil
        )
    }
    return targets.count == 1 ? targets[0] : nil
}

private func uniqueModalTarget(_ kind: ModalKind) -> ModalTarget? {
    switch kind {
    case .terms:
        return uniqueTermsTarget()
    case .macPassword:
        return uniqueMacPasswordTarget()
    case .location:
        return uniqueLocationTarget()
    }
}

private func modalElements(_ target: ModalTarget) -> [AXUIElement] {
    [
        target.primaryButton,
        target.secondaryButton,
        target.checkbox,
        target.passwordField,
    ].compactMap { $0 }
}

private enum ModalAnchor {
    case primary
    case checkbox
    case password
}

private func modalPoint(
    _ target: ModalTarget,
    anchor: ModalAnchor = .primary
) -> CGPoint? {
    let source: AXUIElement?
    switch anchor {
    case .primary:
        source = target.primaryButton
    case .checkbox:
        source = target.checkbox
    case .password:
        source = target.passwordField
    }
    guard let source else { return nil }
    guard let frame = axFrame(source) else { return nil }
    return CGPoint(x: frame.midX, y: frame.midY)
}

private func hitTestMatchesBoundSurface(
    _ target: ModalTarget,
    window: BoundSettingsWindow,
    point: CGPoint
) -> Bool {
    guard target.binding == window.binding,
          pointIsOnActiveDisplay(point),
          window.frame.contains(point) else {
        return false
    }
    let systemWide = AXUIElementCreateSystemWide()
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(
        systemWide,
        Float(point.x),
        Float(point.y),
        &hit
    ) == .success,
    let hit,
    let hitPID = elementPID(hit) else {
        return false
    }

    guard hitPID == target.binding.visualOwnerPID ||
          hitPID == target.binding.axOwnerPID else {
        return false
    }
    if target.binding.axOwnerPID != target.binding.visualOwnerPID {
        guard let axOwner = trustedSettingsVisualOwner(target.binding.axOwnerPID),
              isTrustedAppleIDSettingsExtension(axOwner),
              uniqueTrustedSettingsHost()?.processIdentifier == target.binding.visualOwnerPID else {
            return false
        }
    }
    // A System Settings host and its AppleIDSettings ExtensionKit process can
    // both answer the same hit-test point, but their AX trees are separate.
    // Accept either trusted owner when the hit element (or one of its trusted
    // ancestors) resolves to the exact CGWindow already bound to this modal.
    if elementOrAncestorHasWindowID(
        hit,
        target.binding.windowID,
        ownerPIDs: Set([target.binding.axOwnerPID, target.binding.visualOwnerPID])
    ) {
        return true
    }
    return isTrustedDescendant(
        hit,
        of: target.surface,
        ownerPIDs: Set([target.binding.axOwnerPID, target.binding.visualOwnerPID])
    )
}

private func elementOrAncestorHasWindowID(
    _ element: AXUIElement,
    _ windowID: CGWindowID,
    ownerPIDs: Set<pid_t>
) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<32 {
        guard let node = current,
              let nodePID = elementPID(node),
              ownerPIDs.contains(nodePID) else {
            return false
        }
        if elementWindowID(node) == windowID {
            return true
        }
        current = axParent(node)
    }
    return false
}

private func surfaceFrameMatchesBoundWindow(
    _ surfaceFrame: CGRect,
    windowFrame: CGRect,
    tolerance: CGFloat = 4
) -> Bool {
    // A broad AXWindow (for example 446) can own a separately composited
    // modal CGWindow (for example 608).  The bound controls are checked below
    // against the modal window, so accept either containment direction here.
    frame(surfaceFrame, isWithin: windowFrame, tolerance: tolerance) ||
        frame(windowFrame, isWithin: surfaceFrame, tolerance: tolerance)
}

private func modalTargetIsReady(
    _ target: ModalTarget,
    window: BoundSettingsWindow,
    point: CGPoint
) -> Bool {
    guard window.binding == target.binding,
          let surfaceFrame = axFrame(target.surface),
          surfaceFrameMatchesBoundWindow(surfaceFrame, windowFrame: window.frame),
          modalElements(target).allSatisfy({ element in
              guard let elementFrame = axFrame(element) else { return false }
              return frame(elementFrame, isWithin: window.frame, tolerance: 4)
          }),
          targetWindowIsTopmostAtPoint(window, point: point),
          hitTestMatchesBoundSurface(target, window: window, point: point) else {
        return false
    }
    return true
}

private func activateBoundModalTarget(
    _ target: ModalTarget,
    anchor: ModalAnchor = .primary
) async -> (ModalTarget, BoundSettingsWindow)? {
    guard let visualHost = visualHostForAXOwner(target.binding.axOwnerPID),
          visualHost.processIdentifier == target.binding.visualOwnerPID,
          let current = uniqueModalTarget(target.kind),
          current.binding == target.binding else {
        return nil
    }

    visualHost.activate(options: [.activateIgnoringOtherApps])
    let raisedSurface = isSurfaceRole(target.surface) &&
        AXUIElementPerformAction(target.surface, kAXRaiseAction as CFString) == .success
    if !raisedSurface,
       let visualWindow = focusedWindowForTrustedSettingsHost(target.binding.visualOwnerPID)?.element {
        _ = AXUIElementPerformAction(visualWindow, kAXRaiseAction as CFString)
    }

    for _ in 0..<20 {
        guard let refreshed = uniqueModalTarget(target.kind),
              refreshed.binding == target.binding,
              let window = boundOnScreenSettingsWindow(refreshed.binding),
              let point = modalPoint(refreshed, anchor: anchor),
              modalTargetIsReady(refreshed, window: window, point: point) else {
            try? await Task.sleep(nanoseconds: 120_000_000)
            continue
        }
        return (refreshed, window)
    }
    return nil
}

private func waitForModalToDisappear(
    _ kind: ModalKind,
    binding: UnlockBinding,
    // Apple can keep the sheet alive while the next state is fetched from the
    // network.  Three seconds was too short and turned successful clicks into
    // retryable failures; keep the bound window under observation for 24s.
    polls: Int = 200
) async -> Bool {
    for _ in 0..<polls {
        if let remaining = uniqueModalTarget(kind), remaining.binding == binding {
            try? await Task.sleep(nanoseconds: 120_000_000)
            continue
        }
        return true
    }
    return false
}

private func sameTarget(_ target: UnlockTarget, _ current: UnlockTarget?) -> Bool {
    current?.binding == target.binding
}

private func captureWindowByID(_ windowID: CGWindowID) async -> CGImage? {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            return nil
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        configuration.width = max(1, Int(filter.contentRect.width * scale))
        configuration.height = max(1, Int(filter.contentRect.height * scale))
        configuration.showsCursor = false
        return try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
    } catch {
        return nil
    }
}

private func framesAreVisuallyStable(_ first: CGRect, _ second: CGRect, tolerance: CGFloat = 0.5) -> Bool {
    abs(first.origin.x - second.origin.x) <= tolerance &&
        abs(first.origin.y - second.origin.y) <= tolerance &&
        abs(first.width - second.width) <= tolerance &&
        abs(first.height - second.height) <= tolerance
}

private func boundOnScreenSettingsWindow(_ binding: UnlockBinding) -> BoundSettingsWindow? {
    guard visualHostForAXOwner(binding.axOwnerPID)?.processIdentifier == binding.visualOwnerPID,
          binding.windowID != 0 else {
        return nil
    }
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let matches = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? [])
        .compactMap { info -> BoundSettingsWindow? in
            guard let owner = info[kCGWindowOwnerPID as String] as? NSNumber,
                  pid_t(owner.int32Value) == binding.visualOwnerPID,
                  let number = info[kCGWindowNumber as String] as? NSNumber,
                  CGWindowID(number.uint32Value) == binding.windowID,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  frame.width > 80,
                  frame.height > 60,
                  let alpha = info[kCGWindowAlpha as String] as? NSNumber,
                  alpha.doubleValue > 0 else {
                return nil
            }
            return BoundSettingsWindow(binding: binding, frame: frame)
        }
    return matches.count == 1 ? matches[0] : nil
}

private func pointIsOnActiveDisplay(_ point: CGPoint) -> Bool {
    var displayCount: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &displayCount) == .success, displayCount > 0 else {
        return false
    }
    var displayIDs = Array(repeating: CGDirectDisplayID(), count: Int(displayCount))
    let result = displayIDs.withUnsafeMutableBufferPointer {
        CGGetActiveDisplayList(displayCount, $0.baseAddress, &displayCount)
    }
    guard result == .success else { return false }
    return displayIDs.prefix(Int(displayCount)).contains { CGDisplayBounds($0).contains(point) }
}

private func targetWindowIsTopmostAtPoint(_ target: BoundSettingsWindow, point: CGPoint) -> Bool {
    guard pointIsOnActiveDisplay(point),
          let host = uniqueTrustedSettingsHost(),
          host.processIdentifier == target.binding.visualOwnerPID,
          host.isActive else {
        return false
    }
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    for info in windows {
        guard let alpha = info[kCGWindowAlpha as String] as? NSNumber,
              alpha.doubleValue > 0,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              frame.contains(point),
              let number = info[kCGWindowNumber as String] as? NSNumber,
              let owner = info[kCGWindowOwnerPID as String] as? NSNumber else {
            continue
        }
        return CGWindowID(number.uint32Value) == target.binding.windowID &&
            pid_t(owner.int32Value) == target.binding.visualOwnerPID
    }
    return false
}

private func hitTestMatchesBoundTarget(
    _ target: UnlockTarget,
    window: BoundSettingsWindow,
    point: CGPoint
) -> Bool {
    guard target.binding == window.binding else { return false }
    let systemWide = AXUIElementCreateSystemWide()
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &hit) == .success,
          let hit,
          let hitPID = elementPID(hit) else {
        return false
    }

    guard hitPID == target.binding.visualOwnerPID ||
          hitPID == target.binding.axOwnerPID else {
        return false
    }
    if target.binding.axOwnerPID != target.binding.visualOwnerPID {
        // ExtensionKit can expose the point through its own AX subtree although
        // the on-screen window is owned by the verified System Settings host.
        guard let axOwner = trustedSettingsVisualOwner(target.binding.axOwnerPID),
              isTrustedAppleIDSettingsExtension(axOwner),
              uniqueTrustedSettingsHost()?.processIdentifier == target.binding.visualOwnerPID else {
            return false
        }
    }
    if hitPID == target.binding.visualOwnerPID,
       elementWindowID(hit) == target.binding.windowID {
        return true
    }
    return isTrustedDescendant(
        hit,
        of: target.window,
        ownerPIDs: Set([target.binding.axOwnerPID, target.binding.visualOwnerPID])
    )
}

// The hidden terminal prompt necessarily takes foreground focus. Restore only
// the already-resolved trusted System Settings owner, then prove the same
// bound window is back on top before any input event is emitted.
private func activateBoundSettingsWindow(_ target: UnlockTarget) async -> Bool {
    guard let visualHost = visualHostForAXOwner(target.binding.axOwnerPID),
          visualHost.processIdentifier == target.binding.visualOwnerPID,
          let current = uniqueUnlockTarget(),
          sameTarget(target, current) else {
        return false
    }

    visualHost.activate(options: [.activateIgnoringOtherApps])
    if let visualWindow = focusedWindowForTrustedSettingsHost(target.binding.visualOwnerPID)?.element {
        _ = AXUIElementPerformAction(visualWindow, kAXRaiseAction as CFString)
    }

    for _ in 0..<16 {
        guard let refreshed = uniqueUnlockTarget(),
              sameTarget(target, refreshed),
              let window = boundOnScreenSettingsWindow(target.binding),
              let buttonFrame = axFrame(refreshed.continueButton) else {
            return false
        }
        let point = CGPoint(x: buttonFrame.midX, y: buttonFrame.midY)
        if window.frame.contains(point),
           targetWindowIsTopmostAtPoint(window, point: point),
           hitTestMatchesBoundTarget(refreshed, window: window, point: point) {
            return true
        }
        try? await Task.sleep(nanoseconds: 120_000_000)
    }
    return false
}

private struct RecognizedLine {
    let text: String
    let box: CGRect
}

private func recognizedLines(in image: CGImage) -> [RecognizedLine] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.008
    request.recognitionLanguages = ["en-US", "zh-Hans", "zh-Hant"]
    if #available(macOS 13.0, *) {
        request.revision = VNRecognizeTextRequestRevision3
        request.automaticallyDetectsLanguage = true
    }
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try? handler.perform([request])
    return ((request.results as? [VNRecognizedTextObservation]) ?? [])
        .compactMap { observation in
            guard let text = observation.topCandidates(1).first?.string else { return nil }
            return RecognizedLine(text: text, box: observation.boundingBox)
        }
}

private func looksLikeVisionUnlockTitle(_ text: String) -> Bool {
    looksLikeIPhoneUnlockSheet(text)
}

private func titleLinesAreAdjacent(_ upper: RecognizedLine, _ lower: RecognizedLine) -> Bool {
    let verticalGap = upper.box.minY - lower.box.maxY
    let horizontalDrift = abs(upper.box.midX - lower.box.midX)
    return verticalGap >= -0.01 && verticalGap <= 0.06 &&
        horizontalDrift <= max(upper.box.width, lower.box.width) * 0.65
}

private func uniqueVisionUnlockTitleBox(in image: CGImage) -> CGRect? {
    let lines = recognizedLines(in: image)
    let directMatches = lines
        .filter { looksLikeVisionUnlockTitle($0.text) }
        .map(\.box)
    if directMatches.count == 1 { return directMatches[0] }
    if !directMatches.isEmpty { return nil }

    let ordered = lines.sorted { $0.box.midY > $1.box.midY }
    var combinedMatches: [CGRect] = []
    for index in 0..<(max(0, ordered.count - 1)) {
        let upper = ordered[index]
        let lower = ordered[index + 1]
        guard titleLinesAreAdjacent(upper, lower),
              looksLikeVisionUnlockTitle("\(upper.text) \(lower.text)") else {
            continue
        }
        combinedMatches.append(upper.box.union(lower.box))
    }
    return combinedMatches.count == 1 ? combinedMatches[0] : nil
}

private func normalizedAXFrame(_ frame: CGRect, in window: BoundSettingsWindow) -> CGRect? {
    guard window.frame.contains(frame) else { return nil }
    let x = (frame.minX - window.frame.minX) / window.frame.width
    let y = 1 - ((frame.maxY - window.frame.minY) / window.frame.height)
    let width = frame.width / window.frame.width
    let height = frame.height / window.frame.height
    let normalizedFrame = CGRect(x: x, y: y, width: width, height: height)
    guard normalizedFrame.minX >= 0,
          normalizedFrame.maxX <= 1,
          normalizedFrame.minY >= 0,
          normalizedFrame.maxY <= 1 else {
        return nil
    }
    return normalizedFrame
}

private func unlockInputROI(
    titleBox: CGRect,
    target: UnlockTarget,
    window: BoundSettingsWindow
) -> CGRect? {
    guard let cancelFrame = axFrame(target.cancelButton),
          let continueFrame = axFrame(target.continueButton),
          let cancelBox = normalizedAXFrame(cancelFrame, in: window),
          let continueBox = normalizedAXFrame(continueFrame, in: window) else {
        return nil
    }
    let buttonTop = max(cancelBox.maxY, continueBox.maxY)
    let lower = buttonTop + 0.012
    let upper = titleBox.minY - 0.012
    guard lower > 0.02, upper < 0.98, upper - lower >= 0.035 else { return nil }
    return CGRect(x: 0.05, y: lower, width: 0.90, height: upper - lower)
}

private func median(_ values: [CGFloat]) -> CGFloat? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let middle = sorted.count / 2
    if sorted.count.isMultiple(of: 2) {
        return (sorted[middle - 1] + sorted[middle]) / 2
    }
    return sorted[middle]
}

private func detectUnlockCellCandidates(in image: CGImage, roi: CGRect) -> [CGRect] {
    let request = VNDetectRectanglesRequest()
    request.maximumObservations = 20
    request.minimumSize = 0.012
    request.minimumAspectRatio = 0.55
    // Vision measures this as short-side / long-side, so its valid upper
    // bound is 1.0. The stricter width/height filter stays below.
    request.maximumAspectRatio = 1.0
    request.quadratureTolerance = 18
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try? handler.perform([request])
    let insetROI = roi.insetBy(dx: 0.003, dy: 0.003)
    return ((request.results as? [VNRectangleObservation]) ?? [])
        .map(\.boundingBox)
        .filter { box in
            box.width > 0.012 &&
                box.height > 0.012 &&
                insetROI.contains(box)
        }
}

private func validatedUnlockCellGroup(_ candidates: [CGRect]) -> [CGRect]? {
    guard candidates.count == 4 || candidates.count == 6 else { return nil }
    let cells = candidates.sorted { $0.midX < $1.midX }
    let widths = cells.map(\.width)
    let heights = cells.map(\.height)
    guard let medianWidth = median(widths),
          let medianHeight = median(heights),
          medianWidth > 0,
          medianHeight > 0 else {
        return nil
    }
    guard (cells.map(\.midY).max()! - cells.map(\.midY).min()!) <= medianHeight * 0.10,
          (widths.max()! - widths.min()!) <= medianWidth * 0.15,
          (heights.max()! - heights.min()!) <= medianHeight * 0.15,
          cells.allSatisfy({ (0.55...1.35).contains($0.width / $0.height) }) else {
        return nil
    }
    var gaps: [CGFloat] = []
    for index in 1..<cells.count {
        let gap = cells[index].minX - cells[index - 1].maxX
        guard gap > 0 else { return nil }
        gaps.append(gap)
    }
    guard let medianGap = median(gaps), medianGap > 0,
          gaps.allSatisfy({ abs($0 - medianGap) <= medianGap * 0.35 }) else {
        return nil
    }
    return cells
}

// A rectangle alone is not proof of an empty passcode cell. Keep recognition
// in memory and reject any candidate whose inner area intersects recognized
// text; no OCR text leaves this helper.
private func cellInteriorHasVisibleMark(_ cell: CGRect, in image: CGImage) -> Bool? {
    guard image.bitsPerComponent == 8,
          image.bitsPerPixel >= 24,
          image.bitsPerPixel.isMultiple(of: 8),
          let data = image.dataProvider?.data,
          let bytes = CFDataGetBytePtr(data) else {
        return nil
    }
    let bytesPerPixel = image.bitsPerPixel / 8
    let inner = cell.insetBy(dx: cell.width * 0.28, dy: cell.height * 0.24)
    guard inner.width > 0, inner.height > 0 else { return nil }

    let minX = max(0, Int(floor(inner.minX * CGFloat(image.width))))
    let maxX = min(image.width, Int(ceil(inner.maxX * CGFloat(image.width))))
    // Vision rectangles use a bottom-left origin while CGImage bytes use a
    // top-left origin.
    let minY = max(0, image.height - Int(ceil(inner.maxY * CGFloat(image.height))))
    let maxY = min(image.height, image.height - Int(floor(inner.minY * CGFloat(image.height))))
    guard maxX - minX >= 4, maxY - minY >= 4 else { return nil }

    let sampleStride = max(1, min(maxX - minX, maxY - minY) / 32)
    let dataLength = CFDataGetLength(data)
    var luminances: [Int] = []
    for y in stride(from: minY, to: maxY, by: sampleStride) {
        for x in stride(from: minX, to: maxX, by: sampleStride) {
            let offset = y * image.bytesPerRow + x * bytesPerPixel
            guard offset >= 0, offset + 2 < dataLength else { return nil }
            // Averaging the first three components stays order-independent
            // for the ScreenCaptureKit 8-bit RGB/BGR surface formats.
            luminances.append((Int(bytes[offset]) + Int(bytes[offset + 1]) + Int(bytes[offset + 2])) / 3)
        }
    }
    guard luminances.count >= 16 else { return nil }
    let medianLuminance = luminances.sorted()[luminances.count / 2]
    let contrastPixels = luminances.filter { abs($0 - medianLuminance) >= 32 }.count
    return contrastPixels >= max(3, luminances.count / 400)
}

private func unlockCellsAreVisuallyEmpty(_ cells: [CGRect], in image: CGImage) -> Bool {
    let recognized = recognizedLines(in: image)
    return cells.allSatisfy { cell in
        let inner = cell.insetBy(dx: cell.width * 0.16, dy: cell.height * 0.16)
        guard inner.width > 0, inner.height > 0 else { return false }
        let hasRecognizedText = recognized.contains { line in
            let overlap = inner.intersection(line.box)
            return !overlap.isNull && !overlap.isEmpty
        }
        return !hasRecognizedText && cellInteriorHasVisibleMark(cell, in: image) == false
    }
}

private func visualUnlockCellGroup(
    image: CGImage,
    target: UnlockTarget,
    window: BoundSettingsWindow,
    expectedCount: Int? = nil
) -> [CGRect]? {
    guard let title = uniqueVisionUnlockTitleBox(in: image),
          let roi = unlockInputROI(titleBox: title, target: target, window: window),
          let cells = validatedUnlockCellGroup(detectUnlockCellCandidates(in: image, roi: roi)),
          unlockCellsAreVisuallyEmpty(cells, in: image),
          expectedCount == nil || cells.count == expectedCount else {
        return nil
    }
    return cells
}

private func cellGroupsAreStable(_ first: [CGRect], _ second: [CGRect], tolerance: CGFloat = 0.005) -> Bool {
    guard first.count == second.count, first.count == 4 || first.count == 6 else { return false }
    return zip(first, second).allSatisfy { initial, current in
        abs(initial.origin.x - current.origin.x) <= tolerance &&
            abs(initial.origin.y - current.origin.y) <= tolerance &&
            abs(initial.width - current.width) <= tolerance &&
            abs(initial.height - current.height) <= tolerance
    }
}

private func screenPointForCell(_ cell: CGRect, in window: BoundSettingsWindow) -> CGPoint? {
    guard cell.minX >= 0, cell.maxX <= 1, cell.minY >= 0, cell.maxY <= 1 else { return nil }
    let point = CGPoint(
        x: window.frame.minX + cell.midX * window.frame.width,
        y: window.frame.minY + (1 - cell.midY) * window.frame.height
    )
    return window.frame.contains(point) && pointIsOnActiveDisplay(point) ? point : nil
}

private func stableUnlockCellTarget(
    expectedCount: Int? = nil,
    expectedBinding: UnlockBinding? = nil
) async -> (UnlockTarget, BoundSettingsWindow, [CGRect])? {
    guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(),
          let firstTarget = uniqueUnlockTarget(),
          expectedBinding == nil || firstTarget.binding == expectedBinding,
          let firstWindow = boundOnScreenSettingsWindow(firstTarget.binding),
          let firstCapture = await captureWindowByID(firstWindow.binding.windowID),
          let firstCells = visualUnlockCellGroup(
              image: firstCapture,
              target: firstTarget,
              window: firstWindow,
              expectedCount: expectedCount
          ),
          let firstPoint = screenPointForCell(firstCells[0], in: firstWindow),
          targetWindowIsTopmostAtPoint(firstWindow, point: firstPoint),
          hitTestMatchesBoundTarget(firstTarget, window: firstWindow, point: firstPoint) else {
        return nil
    }
    try? await Task.sleep(nanoseconds: 180_000_000)
    guard let currentTarget = uniqueUnlockTarget(),
          sameTarget(firstTarget, currentTarget),
          let currentWindow = boundOnScreenSettingsWindow(firstTarget.binding),
          framesAreVisuallyStable(firstWindow.frame, currentWindow.frame),
          let secondCapture = await captureWindowByID(currentWindow.binding.windowID),
          let secondCells = visualUnlockCellGroup(
              image: secondCapture,
              target: currentTarget,
              window: currentWindow,
              expectedCount: expectedCount
          ),
          let currentPoint = screenPointForCell(secondCells[0], in: currentWindow),
          targetWindowIsTopmostAtPoint(currentWindow, point: currentPoint),
          hitTestMatchesBoundTarget(currentTarget, window: currentWindow, point: currentPoint),
          cellGroupsAreStable(firstCells, secondCells) else {
        return nil
    }
    return (currentTarget, currentWindow, secondCells)
}

private func postClickUnicodeDigit(_ digit: Character) -> Bool {
    guard let source = CGEventSource(stateID: .hidSystemState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
        return false
    }
    var codeUnits = Array(String(digit).utf16)
    guard codeUnits.count == 1 else { return false }
    codeUnits.withUnsafeBufferPointer { buffer in
        down.keyboardSetUnicodeString(stringLength: codeUnits.count, unicodeString: buffer.baseAddress)
        up.keyboardSetUnicodeString(stringLength: codeUnits.count, unicodeString: buffer.baseAddress)
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return true
}

private func pressCurrentContinue(for target: UnlockTarget, window: BoundSettingsWindow) -> Bool {
    guard let refreshed = uniqueUnlockTarget(),
          sameTarget(target, refreshed),
          let frame = axFrame(refreshed.continueButton) else {
        return false
    }
    let point = CGPoint(x: frame.midX, y: frame.midY)
    guard window.frame.contains(point),
          targetWindowIsTopmostAtPoint(window, point: point),
          hitTestMatchesBoundTarget(refreshed, window: window, point: point),
          isEnabled(refreshed.continueButton),
          supportsPress(refreshed.continueButton) else {
        return false
    }
    return AXUIElementPerformAction(refreshed.continueButton, kAXPressAction as CFString) == .success
}

// Apple often advances after the final digit, but the animation can outlast a
// fixed sleep. Keep observing the same bound surface before deciding whether a
// live Continue press is required.
private func waitForUnlockAdvanceOrPressContinue(
    target: UnlockTarget,
    initialWindow: BoundSettingsWindow,
    verificationPoint: CGPoint
) async -> Bool {
    // The last digit normally advances this sheet automatically. Continue can
    // already be enabled while every cell is empty, so only observe the bound
    // surface for 1.4 seconds before considering a single assisted press.
    let automaticAdvanceGracePolls = 7
    let pollIntervalNanoseconds: UInt64 = 200_000_000
    for attempt in 0..<25 {
        guard let remainingTarget = uniqueUnlockTarget() else {
            return true
        }
        guard sameTarget(target, remainingTarget) else {
            return true
        }
        guard let remainingWindow = boundOnScreenSettingsWindow(
            target.binding
        ) else {
            return false
        }
        if !framesAreVisuallyStable(initialWindow.frame, remainingWindow.frame) {
            try? await Task.sleep(nanoseconds: pollIntervalNanoseconds)
            continue
        }
        guard targetWindowIsTopmostAtPoint(remainingWindow, point: verificationPoint),
              hitTestMatchesBoundTarget(remainingTarget, window: remainingWindow, point: verificationPoint) else {
            return false
        }
        if attempt >= automaticAdvanceGracePolls && isEnabled(remainingTarget.continueButton) {
            return pressCurrentContinue(for: remainingTarget, window: remainingWindow)
        }
        try? await Task.sleep(nanoseconds: pollIntervalNanoseconds)
    }
    return false
}

private func postUnicodeText(_ text: String) -> Bool {
    let codeUnits = Array(text.utf16)
    guard !codeUnits.isEmpty,
          let source = CGEventSource(stateID: .hidSystemState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
        return false
    }
    codeUnits.withUnsafeBufferPointer { buffer in
        down.keyboardSetUnicodeString(stringLength: codeUnits.count, unicodeString: buffer.baseAddress)
        up.keyboardSetUnicodeString(stringLength: codeUnits.count, unicodeString: buffer.baseAddress)
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return true
}

private func outputForActionFailure() -> Output {
    Output(ok: false, stage: "manual_required", digits: nil)
}

private func submitTerms(expectedBinding: UnlockBinding?) async -> Output {
    guard let expectedBinding,
          let initial = uniqueTermsTarget(),
          initial.binding == expectedBinding,
          initial.checkbox != nil,
          let activated = await activateBoundModalTarget(initial, anchor: .checkbox),
          let liveCheckbox = activated.0.checkbox else {
        return outputForActionFailure()
    }
    if !checkboxIsSelected(liveCheckbox) {
        guard supportsPress(liveCheckbox),
              AXUIElementPerformAction(liveCheckbox, kAXPressAction as CFString) == .success else {
            return outputForActionFailure()
        }
    }

    var liveTarget: ModalTarget?
    var liveWindow: BoundSettingsWindow?
    for _ in 0..<20 {
        guard let refreshed = uniqueTermsTarget(),
              refreshed.binding == expectedBinding,
              let refreshedCheckbox = refreshed.checkbox,
              checkboxIsSelected(refreshedCheckbox),
              isEnabled(refreshed.primaryButton),
              supportsPress(refreshed.primaryButton),
              let window = boundOnScreenSettingsWindow(expectedBinding),
              let point = modalPoint(refreshed),
              modalTargetIsReady(refreshed, window: window, point: point) else {
            try? await Task.sleep(nanoseconds: 120_000_000)
            continue
        }
        liveTarget = refreshed
        liveWindow = window
        break
    }
    guard let liveTarget, let liveWindow,
          let point = modalPoint(liveTarget),
          liveWindow.frame.contains(point),
          hitTestMatchesBoundSurface(liveTarget, window: liveWindow, point: point),
          AXUIElementPerformAction(liveTarget.primaryButton, kAXPressAction as CFString) == .success,
          await waitForModalToDisappear(.terms, binding: expectedBinding) else {
        return outputForActionFailure()
    }
    return Output(ok: true, stage: "terms_submitted", digits: nil)
}

private func submitMacPassword(
    _ password: String,
    expectedBinding: UnlockBinding?
) async -> Output {
    guard fixedMacPasswords.contains(password),
          let expectedBinding,
          let initial = uniqueMacPasswordTarget(),
          initial.binding == expectedBinding,
          initial.passwordField != nil,
          let activated = await activateBoundModalTarget(initial, anchor: .password),
          let liveField = activated.0.passwordField,
          let fieldPoint = modalPoint(activated.0, anchor: .password),
          modalTargetIsReady(activated.0, window: activated.1, point: fieldPoint) else {
        return outputForActionFailure()
    }
    _ = AXUIElementPerformAction(liveField, kAXRaiseAction as CFString)
    guard AXUIElementSetAttributeValue(
        liveField,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    ) == .success else {
        return outputForActionFailure()
    }
    _ = AXUIElementSetAttributeValue(liveField, kAXValueAttribute as CFString, "" as CFString)
    let setResult = AXUIElementSetAttributeValue(
        liveField,
        kAXValueAttribute as CFString,
        password as CFString
    )
    if setResult != .success {
        guard postUnicodeText(password) else { return outputForActionFailure() }
    }
    try? await Task.sleep(nanoseconds: 160_000_000)

    var continueTarget: ModalTarget?
    var continueWindow: BoundSettingsWindow?
    for _ in 0..<20 {
        guard let refreshed = uniqueMacPasswordTarget(),
              refreshed.binding == expectedBinding,
              isNotExplicitlyDisabled(refreshed.primaryButton),
              supportsPress(refreshed.primaryButton),
              let refreshedWindow = boundOnScreenSettingsWindow(expectedBinding),
              let point = modalPoint(refreshed),
              modalTargetIsReady(refreshed, window: refreshedWindow, point: point) else {
            try? await Task.sleep(nanoseconds: 120_000_000)
            continue
        }
        continueTarget = refreshed
        continueWindow = refreshedWindow
        break
    }
    guard let continueTarget, let continueWindow,
          let point = modalPoint(continueTarget),
          continueWindow.frame.contains(point),
          hitTestMatchesBoundSurface(continueTarget, window: continueWindow, point: point),
          AXUIElementPerformAction(continueTarget.primaryButton, kAXPressAction as CFString) == .success,
          await waitForModalToDisappear(.macPassword, binding: expectedBinding) else {
        return outputForActionFailure()
    }
    return Output(ok: true, stage: "mac_password_submitted", digits: nil)
}

private func submitLocation(expectedBinding: UnlockBinding?) async -> Output {
    guard let expectedBinding,
          let initial = uniqueLocationTarget(),
          initial.binding == expectedBinding,
          let activated = await activateBoundModalTarget(initial),
          activated.0.binding == expectedBinding,
          let point = modalPoint(activated.0),
          isEnabled(activated.0.primaryButton),
          supportsPress(activated.0.primaryButton),
          modalTargetIsReady(activated.0, window: activated.1, point: point),
          axIdentifier(activated.0.primaryButton) == "action-button-2",
          AXUIElementPerformAction(activated.0.primaryButton, kAXPressAction as CFString) == .success,
          await waitForModalToDisappear(.location, binding: expectedBinding) else {
        return outputForActionFailure()
    }
    return Output(ok: true, stage: "location_submitted", digits: nil)
}

private func submitUnlockPasscode(
    _ passcode: String,
    expectedBinding: UnlockBinding?
) async -> Output {
    guard passcode.range(of: "^[0-9]{4}(?:[0-9]{2})?$", options: .regularExpression) != nil else {
        return Output(ok: false, stage: "manual_required", digits: nil)
    }
    let expectedCount = passcode.count
    guard let expectedBinding,
          let preActivationTarget = uniqueUnlockTarget(),
          preActivationTarget.binding == expectedBinding,
          await activateBoundSettingsWindow(preActivationTarget),
          let resolved = await stableUnlockCellTarget(
              expectedCount: expectedCount,
              expectedBinding: expectedBinding
          ),
          resolved.0.binding == expectedBinding,
          sameTarget(preActivationTarget, resolved.0) else {
        return Output(ok: false, stage: "manual_required", digits: nil)
    }
    let target = resolved.0
    let initialWindow = resolved.1
    let cells = resolved.2
    guard let point = screenPointForCell(cells[0], in: initialWindow),
          let currentTarget = uniqueUnlockTarget(),
          currentTarget.binding == expectedBinding,
          sameTarget(target, currentTarget),
          let currentWindow = boundOnScreenSettingsWindow(target.binding),
          framesAreVisuallyStable(initialWindow.frame, currentWindow.frame),
          targetWindowIsTopmostAtPoint(currentWindow, point: point),
          hitTestMatchesBoundTarget(currentTarget, window: currentWindow, point: point),
          let source = CGEventSource(stateID: .hidSystemState),
          let mouseDown = CGEvent(
              mouseEventSource: source,
              mouseType: .leftMouseDown,
              mouseCursorPosition: point,
              mouseButton: .left
          ),
          let mouseUp = CGEvent(
              mouseEventSource: source,
              mouseType: .leftMouseUp,
              mouseCursorPosition: point,
              mouseButton: .left
          ) else {
        return Output(ok: false, stage: "manual_required", digits: nil)
    }
    mouseDown.post(tap: .cghidEventTap)
    mouseUp.post(tap: .cghidEventTap)
    try? await Task.sleep(nanoseconds: 70_000_000)

    for digit in passcode {
        guard let refreshedTarget = uniqueUnlockTarget(),
              refreshedTarget.binding == expectedBinding,
              sameTarget(target, refreshedTarget),
              let refreshedWindow = boundOnScreenSettingsWindow(target.binding),
              framesAreVisuallyStable(initialWindow.frame, refreshedWindow.frame),
              targetWindowIsTopmostAtPoint(refreshedWindow, point: point),
              hitTestMatchesBoundTarget(refreshedTarget, window: refreshedWindow, point: point),
              postClickUnicodeDigit(digit) else {
            return Output(ok: false, stage: "manual_required", digits: nil)
        }
        try? await Task.sleep(nanoseconds: 45_000_000)
    }

    guard await waitForUnlockAdvanceOrPressContinue(
        target: target,
        initialWindow: initialWindow,
        verificationPoint: point
    ) else {
        return Output(ok: false, stage: "manual_required", digits: nil)
    }
    return Output(ok: true, stage: "iphone_unlock_submitted", digits: nil)
}

private struct Invocation {
    let phase: String
    let expectedBinding: UnlockBinding?
}

private func containsOnlyASCIIDecimalDigits(_ value: String) -> Bool {
    !value.isEmpty && value.unicodeScalars.allSatisfy { scalar in
        scalar.value >= 48 && scalar.value <= 57
    }
}

private func parsePositivePID(_ value: String) -> Int32? {
    guard containsOnlyASCIIDecimalDigits(value),
          let parsed = Int64(value),
          parsed > 0,
          parsed <= Int64(Int32.max) else {
        return nil
    }
    return Int32(parsed)
}

private func parsePositiveWindowID(_ value: String) -> UInt32? {
    guard containsOnlyASCIIDecimalDigits(value),
          let parsed = UInt64(value),
          parsed > 0,
          parsed <= UInt64(UInt32.max) else {
        return nil
    }
    return UInt32(parsed)
}

private func parseInvocation() -> Invocation? {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.first == "--phase" else { return nil }
    if arguments.count == 2, arguments[1] == "state" {
        return Invocation(phase: "state", expectedBinding: nil)
    }
    guard arguments.count == 8,
          ["terms", "mac-password", "unlock-code", "location"].contains(arguments[1]),
          arguments[2] == "--ax-owner-pid",
          let axOwnerPid = parsePositivePID(arguments[3]),
          arguments[4] == "--visual-owner-pid",
          let visualOwnerPid = parsePositivePID(arguments[5]),
          arguments[6] == "--window-id",
          let windowId = parsePositiveWindowID(arguments[7]) else {
        return nil
    }
    return Invocation(
        phase: arguments[1],
        expectedBinding: UnlockBinding(
            axOwnerPid: axOwnerPid,
            visualOwnerPid: visualOwnerPid,
            windowId: windowId
        )
    )
}

private let invocation = parseInvocation()

Task {
    guard let invocation else {
        emit(Output(ok: false, stage: "invalid_request", digits: nil))
    }
    switch invocation.phase {
    case "state":
        guard AXIsProcessTrusted() else {
            emit(Output(ok: false, stage: "visual_unavailable", digits: nil))
        }
        if let target = uniqueTermsTarget() {
            emit(Output(ok: true, stage: "terms", digits: nil, binding: target.binding))
        }
        if let target = uniqueMacPasswordTarget() {
            emit(Output(ok: true, stage: "mac_password", digits: nil, binding: target.binding))
        }
        if AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(),
           let target = await stableUnlockCellTarget() {
            emit(Output(
                ok: true,
                stage: "iphone_unlock",
                digits: target.2.count,
                binding: target.0.binding
            ))
        }
        if let target = uniqueLocationTarget() {
            emit(Output(ok: true, stage: "location", digits: nil, binding: target.binding))
        }
        emit(Output(ok: true, stage: "waiting", digits: nil))
    case "terms":
        emit(await submitTerms(expectedBinding: invocation.expectedBinding))
    case "mac-password":
        let raw = FileHandle.standardInput.readDataToEndOfFile()
        guard let password = String(data: raw, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) else {
            emit(outputForActionFailure())
        }
        emit(await submitMacPassword(password, expectedBinding: invocation.expectedBinding))
    case "unlock-code":
        let raw = FileHandle.standardInput.readDataToEndOfFile()
        guard let passcode = String(data: raw, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) else {
            emit(Output(ok: false, stage: "manual_required", digits: nil))
        }
        emit(await submitUnlockPasscode(passcode, expectedBinding: invocation.expectedBinding))
    case "location":
        emit(await submitLocation(expectedBinding: invocation.expectedBinding))
    default:
        emit(Output(ok: false, stage: "invalid_request", digits: nil))
    }
}

dispatchMain()
