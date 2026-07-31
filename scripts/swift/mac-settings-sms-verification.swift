#!/usr/bin/env swift
// Supervised System Settings SMS verification helper.
// It uses Accessibility APIs only and emits redacted, fixed JSON tokens.

import ApplicationServices
import AppKit
import Foundation

private struct Output: Codable {
    let ok: Bool
    let stage: String
}

private enum CodeEntry {
    case six([AXUIElement])
}

private struct PhoneSelection {
    let controls: [AXUIElement]
    let continueButton: AXUIElement
}

private struct SettingsSnapshot {
    let pid: pid_t
    let nodes: [AXUIElement]
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
private let axSheetsAttribute = "AXSheets"

private let continueLabels: Set<String> = [
    "continue",
    "next",
    "\u{7EE7}\u{7EED}",
    "\u{7E7C}\u{7E8C}",
]

// The supplied macOS 15 AX tree exposes the destinations as native checkboxes.
// Some builds use a button or cell wrapper instead, but groups and static text
// are never safe targets because they can contain several destination rows.
private let nativePhoneControlRoles: Set<String> = [
    kAXRadioButtonRole as String,
    kAXCheckBoxRole as String,
]
private let wrappedPhoneControlRoles: Set<String> = [
    kAXButtonRole as String,
    "AXCell",
]

private let codeMarkers = [
    "verification",
    "one-time",
    "two-factor",
    "authentication",
    "\u{9A8C}\u{8BC1}\u{7801}",
    "\u{9A57}\u{8B49}\u{78BC}",
    "\u{53CC}\u{91CD}\u{8BA4}\u{8BC1}",
    "\u{96D9}\u{91CD}\u{8A8D}\u{8B49}",
]

private let phoneMarkers = [
    "send",
    "sent",
    "text",
    "message",
    "sms",
    "phone",
    "\u{53D1}\u{9001}",
    "\u{77ED}\u{4FE1}",
    "\u{7535}\u{8BDD}",
    "\u{624B}\u{673A}",
    "\u{50B3}\u{9001}",
    "\u{8A0A}\u{606F}",
    "\u{96FB}\u{8A71}",
    "\u{624B}\u{6A5F}",
]

private func emit(_ ok: Bool, _ stage: String) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let output = Output(ok: ok, stage: stage)
    if let data = try? encoder.encode(output) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
    exit(ok ? 0 : 1)
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
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

private func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    guard let value: CFTypeRef = axCopy(element, attribute) else { return nil }
    if let boolean = value as? Bool { return boolean }
    if let number = value as? NSNumber { return number.boolValue }
    return nil
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axCopy(element, kAXChildrenAttribute as String) ?? []
}

private func axSheets(_ element: AXUIElement) -> [AXUIElement] {
    axCopy(element, axSheetsAttribute) ?? []
}

private func axRole(_ element: AXUIElement) -> String {
    axString(element, kAXRoleAttribute as String) ?? ""
}

private func axParent(_ element: AXUIElement) -> AXUIElement? {
    axCopy(element, kAXParentAttribute as String)
}

private func elementPID(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

private func belongsTo(_ element: AXUIElement, pid: pid_t) -> Bool {
    elementPID(element) == pid
}

private func isVisible(_ element: AXUIElement) -> Bool {
    axBool(element, kAXHiddenAttribute as String) != true
}

private func isEnabled(_ element: AXUIElement) -> Bool {
    axBool(element, kAXEnabledAttribute as String) == true
}

private func supportsPress(_ element: AXUIElement) -> Bool {
    var actions: CFArray?
    guard AXUIElementCopyActionNames(element, &actions) == .success,
          let names = actions as? [String] else {
        return false
    }
    return names.contains(kAXPressAction as String)
}

private func hasSettableValue(_ element: AXUIElement) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(
        element,
        kAXValueAttribute as CFString,
        &settable
    ) == .success && settable.boolValue
}

private func normalized(_ text: String) -> String {
    text
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
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

private func textInSubtree(_ root: AXUIElement, pid: pid_t, maxNodes: Int = 120) -> [String] {
    var queue: [AXUIElement] = [root]
    var seen: [AXUIElement] = []
    var texts: [String] = []
    var visited = 0

    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        if seen.contains(where: { $0 == node }) { continue }
        seen.append(node)
        visited += 1
        guard belongsTo(node, pid: pid), isVisible(node) else { continue }
        texts.append(contentsOf: directTexts(node))
        queue.append(contentsOf: axChildren(node))
    }
    return texts
}

private func visibleNodes(in roots: [AXUIElement], pid: pid_t, maxNodes: Int = 1_500) -> [AXUIElement] {
    var queue = roots
    var seen: [AXUIElement] = []
    var nodes: [AXUIElement] = []
    var visited = 0

    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        if seen.contains(where: { $0 == node }) { continue }
        seen.append(node)
        visited += 1
        guard belongsTo(node, pid: pid), isVisible(node) else { continue }
        nodes.append(node)
        queue.append(contentsOf: axChildren(node))
    }
    return nodes
}

private func isTrustedSystemSettingsHost(_ app: NSRunningApplication) -> Bool {
    guard let bundleID = app.bundleIdentifier,
          settingsBundleIDs.contains(bundleID),
          let executable = app.executableURL?.standardizedFileURL.path else {
        return false
    }
    return executable.hasPrefix("/System/")
}

private func isTrustedAppleIDSettingsExtension(_ app: NSRunningApplication) -> Bool {
    guard let path = app.executableURL?.standardizedFileURL.path else { return false }
    return appleIDSettingsExecutablePaths.contains(path)
}

private func isTrustedSystemSettings(_ app: NSRunningApplication) -> Bool {
    if isTrustedSystemSettingsHost(app) { return true }
    guard isTrustedAppleIDSettingsExtension(app) else { return false }
    return NSWorkspace.shared.runningApplications.filter(
        isTrustedAppleIDSettingsExtension
    ).count == 1
}

private func activeSystemSettings() -> NSRunningApplication? {
    let extensions = NSWorkspace.shared.runningApplications.filter(
        isTrustedAppleIDSettingsExtension
    )
    let hosts = NSWorkspace.shared.runningApplications.filter(isTrustedSystemSettingsHost)
    let activeHosts = hosts.filter { $0.isActive }

    // The supplied AX evidence is rooted in the active System Settings host.
    // Prefer that unique window owner even when unrelated Settings extensions
    // are also running, rather than returning no surface at all.
    if activeHosts.count == 1 { return activeHosts[0] }
    if extensions.count == 1 { return extensions[0] }
    if hosts.count == 1 { return hosts[0] }
    return nil
}

private func roots(for appElement: AXUIElement, pid: pid_t) -> [AXUIElement] {
    var roots: [AXUIElement] = []
    let focused: AXUIElement? = axCopy(appElement, kAXFocusedWindowAttribute as String)
    let main: AXUIElement? = axCopy(appElement, kAXMainWindowAttribute as String)
    let windows: [AXUIElement] = axCopy(appElement, kAXWindowsAttribute as String) ?? []

    for candidate in [focused, main].compactMap({ $0 }) + windows {
        guard let surface = activeSurfaceRoot(candidate, pid: pid) else { continue }
        if !roots.contains(where: { $0 == surface }) {
            roots.append(surface)
        }
    }
    if roots.isEmpty, let surface = activeSurfaceRoot(appElement, pid: pid) {
        roots.append(surface)
    }
    return roots
}

private func activeSurfaceRoot(_ root: AXUIElement, pid: pid_t) -> AXUIElement? {
    guard belongsTo(root, pid: pid), isVisible(root) else { return nil }
    let sheets = axSheets(root).filter {
        belongsTo($0, pid: pid) && isVisible($0)
    }
    if sheets.count > 1 { return nil }
    guard let sheet = sheets.first else { return root }
    return activeSurfaceRoot(sheet, pid: pid)
}

private func asciiDigits(in text: String) -> String {
    String(text.unicodeScalars.compactMap { scalar in
        guard scalar.value >= 48 && scalar.value <= 57 else { return nil }
        return Character(String(scalar))
    })
}

private func isPhoneControlRole(_ role: String) -> Bool {
    nativePhoneControlRoles.contains(role) || wrappedPhoneControlRoles.contains(role)
}

private func hasNestedPhoneControl(_ element: AXUIElement, pid: pid_t) -> Bool {
    var queue = axChildren(element)
    var seen: [AXUIElement] = []
    while !queue.isEmpty {
        let node = queue.removeFirst()
        if seen.contains(where: { $0 == node }) { continue }
        seen.append(node)
        guard belongsTo(node, pid: pid), isVisible(node) else { continue }
        if isPhoneControlRole(axRole(node)) { return true }
        queue.append(contentsOf: axChildren(node))
    }
    return false
}

private func phoneControlTexts(_ element: AXUIElement, pid: pid_t) -> [String] {
    var texts = directTexts(element)
    guard wrappedPhoneControlRoles.contains(axRole(element)) else {
        return texts
    }
    // A wrapper can borrow text from a single direct static label. Do not
    // inspect deeper descendants; that would re-match a nested checkbox row.
    for child in axChildren(element) {
        guard belongsTo(child, pid: pid),
              isVisible(child),
              axRole(child) == kAXStaticTextRole as String else {
            continue
        }
        texts.append(contentsOf: directTexts(child))
    }
    return texts
}

private func isSelectablePhoneControl(_ element: AXUIElement, pid: pid_t) -> Bool {
    let role = axRole(element)
    guard isPhoneControlRole(role),
          isEnabled(element),
          supportsPress(element) || hasSettableValue(element) else {
        return false
    }
    if wrappedPhoneControlRoles.contains(role), hasNestedPhoneControl(element, pid: pid) {
        return false
    }
    let texts = phoneControlTexts(element, pid: pid)
    guard asciiDigits(in: texts.joined(separator: " ")).count >= 2 else { return false }
    return texts.contains { text in
        let value = normalized(text)
        return phoneMarkers.contains(where: value.contains)
    }
}

private func continueButton(in nodes: [AXUIElement]) -> AXUIElement? {
    let matches = nodes.filter { element in
        guard axRole(element) == kAXButtonRole as String,
              isEnabled(element),
              supportsPress(element) else {
            return false
        }
        return directTexts(element).contains { continueLabels.contains(normalized($0)) }
    }
    return matches.count == 1 ? matches[0] : nil
}

private func phoneSelection(in nodes: [AXUIElement], pid: pid_t) -> PhoneSelection? {
    let controls = nodes.filter { isSelectablePhoneControl($0, pid: pid) }
    guard !controls.isEmpty, let button = continueButton(in: nodes) else { return nil }
    return PhoneSelection(controls: controls, continueButton: button)
}

private func isTextInput(_ element: AXUIElement) -> Bool {
    let role = axRole(element)
    return role == kAXTextFieldRole as String || role == "AXSecureTextField"
}

private func isSearchField(_ element: AXUIElement) -> Bool {
    directTexts(element).contains { text in
        let value = normalized(text)
        return value.contains("search") || value.contains("\u{641C}\u{7D22}") || value.contains("\u{641C}\u{5C0B}")
    }
}

private func isSemanticCodeField(_ field: AXUIElement) -> Bool {
    var candidate: AXUIElement? = field
    for _ in 0..<5 {
        guard let current = candidate else { break }
        if directTexts(current).contains(where: { text in
            let value = normalized(text)
            return codeMarkers.contains(where: { value.contains($0) })
        }) {
            return true
        }
        candidate = axParent(current)
    }
    return false
}

private func axFrame(_ element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
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

private func isEmptyCodeField(_ field: AXUIElement) -> Bool {
    guard let value = axString(field, kAXValueAttribute as String) else {
        return false
    }
    return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

private func hasSharedDirectParent(_ fields: [AXUIElement]) -> Bool {
    guard let first = fields.first,
          let parent = axParent(first) else {
        return false
    }
    return fields.dropFirst().allSatisfy { axParent($0) == parent }
}

private func isValidSixCellLayout(
    _ fields: [AXUIElement],
    requireEmpty: Bool = true
) -> Bool {
    guard fields.count == 6,
          hasSharedDirectParent(fields) else {
        return false
    }
    if requireEmpty && fields.contains(where: { !isEmptyCodeField($0) }) {
        return false
    }
    let framed = fields.compactMap { field -> (AXUIElement, CGRect)? in
        guard let frame = axFrame(field) else { return nil }
        return (field, frame)
    }
    guard framed.count == 6 else { return false }
    let sorted = framed.sorted { $0.1.minX < $1.1.minX }
    let widths = sorted.map { $0.1.width }
    let heights = sorted.map { $0.1.height }
    let midYs = sorted.map { $0.1.midY }
    guard let maxWidth = widths.max(),
          let minWidth = widths.min(),
          let maxHeight = heights.max(),
          let minHeight = heights.min(),
          let maxMidY = midYs.max(),
          let minMidY = midYs.min(),
          maxWidth > 0,
          maxHeight > 0,
          maxWidth - minWidth <= max(CGFloat(2), maxWidth * 0.15),
          maxHeight - minHeight <= max(CGFloat(2), maxHeight * 0.15),
          maxMidY - minMidY <= max(CGFloat(4), maxHeight * 0.2) else {
        return false
    }

    var gaps: [CGFloat] = []
    for index in 1..<sorted.count {
        let gap = sorted[index].1.minX - sorted[index - 1].1.maxX
        guard gap >= 0 else { return false }
        gaps.append(gap)
    }
    guard let maxGap = gaps.max(),
          let minGap = gaps.min() else {
        return false
    }
    let averageGap = gaps.reduce(CGFloat.zero, +) / CGFloat(gaps.count)
    return maxGap - minGap <= max(CGFloat(8), averageGap * 0.8)
}

private func sixCellFieldGroups(
    _ fields: [AXUIElement],
    requireEmpty: Bool
) -> [[AXUIElement]] {
    var groups: [[AXUIElement]] = []
    for field in fields {
        guard let parent = axParent(field) else { continue }
        if let existing = groups.firstIndex(where: { group in
            guard let first = group.first,
                  let firstParent = axParent(first) else {
                return false
            }
            return firstParent == parent
        }) {
            groups[existing].append(field)
        } else {
            groups.append([field])
        }
    }
    return groups.filter {
        $0.count == 6 && isValidSixCellLayout($0, requireEmpty: requireEmpty)
    }
}

private func codeEntry(
    in nodes: [AXUIElement],
    requireEmpty: Bool = true
) -> CodeEntry? {
    let fields = nodes.filter {
        isTextInput($0) &&
            isEnabled($0) &&
            !isSearchField($0) &&
            axChildren($0).isEmpty
    }
    guard !fields.isEmpty else { return nil }

    let semanticGroups = sixCellFieldGroups(
        fields.filter(isSemanticCodeField),
        requireEmpty: requireEmpty
    )
    let groups = semanticGroups.isEmpty
        ? sixCellFieldGroups(fields, requireEmpty: requireEmpty)
        : semanticGroups
    guard groups.count == 1,
          let codeFields = groups.first else {
        return nil
    }
    let framed = codeFields.compactMap { field -> (AXUIElement, CGRect)? in
        guard let frame = axFrame(field) else { return nil }
        return (field, frame)
    }
    guard framed.count == 6 else { return nil }
    return .six(framed.sorted { $0.1.minX < $1.1.minX }.map { $0.0 })
}

private func codeEntries(
    in snapshots: [SettingsSnapshot],
    requireEmpty: Bool = true
) -> [(SettingsSnapshot, CodeEntry)] {
    snapshots.compactMap { snapshot -> (SettingsSnapshot, CodeEntry)? in
        guard let entry = codeEntry(
            in: snapshot.nodes,
            requireEmpty: requireEmpty
        ) else { return nil }
        return (snapshot, entry)
    }
}

private func isSixCellCodeEntry(_ entry: CodeEntry) -> Bool {
    if case .six = entry { return true }
    return false
}

private func hasCodeDeliverySuffix(in nodes: [AXUIElement], pid: pid_t, suffix: String) -> Bool {
    let texts = nodes
        .filter { belongsTo($0, pid: pid) && isVisible($0) }
        .flatMap(directTexts)
    guard texts.contains(where: { text in
        let value = normalized(text)
        return codeMarkers.contains(where: value.contains)
    }) else {
        return false
    }
    let deliverySuffixes = Set(texts.compactMap { text -> String? in
        let value = normalized(text)
        guard phoneMarkers.contains(where: value.contains) else {
            return nil
        }
        let digits = asciiDigits(in: text)
        guard digits.count >= 2 else { return nil }
        return String(digits.suffix(2))
    })
    return deliverySuffixes.count == 1 && deliverySuffixes.contains(suffix)
}

private func setFocusedValue(
    _ element: AXUIElement,
    value: String,
    transitionSuffix: String? = nil
) -> Bool {
    _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success else {
        return false
    }
    usleep(transitionSuffix == nil ? 80_000 : 180_000)
    guard let suffix = transitionSuffix else {
        return axString(element, kAXValueAttribute as String) == value
    }

    // A confirmed final digit is enough to hand control back to the outer
    // dynamic state machine. Apple can keep the six-cell surface visible
    // while it validates remotely, so this helper must not turn a slow but
    // successful submission into a premature write failure.
    if axString(element, kAXValueAttribute as String) == value {
        return true
    }

    // If the element retired before its value could be read back, accept only
    // when the same verified OTP target is gone. A still-live six-cell group
    // means the final write was not observable and must remain a failure.
    return matchingCodeEntries(suffix: suffix, requireEmpty: false).isEmpty
}

private func selected(_ element: AXUIElement) -> Bool {
    axBool(element, kAXValueAttribute as String) == true
}

private func selectPhone(_ control: AXUIElement) -> Bool {
    if selected(control) { return true }
    _ = AXUIElementPerformAction(control, kAXPressAction as CFString)
    for _ in 0..<5 {
        usleep(100_000)
        if selected(control) { return true }
    }
    // SwiftUI occasionally exposes the checkbox state but routes AXPress to
    // its container. A settable AXValue is the bounded fallback for that one
    // already suffix-matched control.
    guard AXUIElementSetAttributeValue(
        control,
        kAXValueAttribute as CFString,
        kCFBooleanTrue
    ) == .success else {
        return false
    }
    for _ in 0..<5 {
        usleep(100_000)
        if selected(control) { return true }
    }
    return false
}

private func readManualCodeFromStandardInput() -> String? {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 64,
          let input = String(data: data, encoding: .utf8) else {
        return nil
    }
    let code = input.trimmingCharacters(in: .whitespacesAndNewlines)
    return code.range(of: #"^[0-9]{6}$"#, options: .regularExpression) != nil ? code : nil
}

private func sameCodeEntryShape(_ lhs: CodeEntry, _ rhs: CodeEntry) -> Bool {
    switch (lhs, rhs) {
    case let (.six(leftFields), .six(rightFields)):
        guard leftFields.count == rightFields.count else { return false }
        let leftFrames = leftFields.compactMap(axFrame)
        let rightFrames = rightFields.compactMap(axFrame)
        guard leftFrames.count == rightFrames.count else { return false }
        return zip(leftFrames, rightFrames).allSatisfy { left, right in
            abs(left.minX - right.minX) <= 2 &&
                abs(left.minY - right.minY) <= 2 &&
                abs(left.width - right.width) <= 2 &&
                abs(left.height - right.height) <= 2
        }
    default:
        return false
    }
}

private func resolvedCodeEntries(
    in snapshots: [SettingsSnapshot],
    suffix: String,
    requireEmpty: Bool = true
) -> [(SettingsSnapshot, CodeEntry)] {
    // Never write into a code field while any visible Settings surface still
    // exposes the phone-choice controls. This covers focused/main/window
    // snapshot races during the sheet transition.
    let phoneSelectionPresent = snapshots.contains {
        phoneSelection(in: $0.nodes, pid: $0.pid) != nil
    }
    guard !phoneSelectionPresent else { return [] }
    let candidates = codeEntries(in: snapshots, requireEmpty: requireEmpty)
    let suffixMatched = candidates.filter { snapshot, _ in
        hasCodeDeliverySuffix(in: snapshot.nodes, pid: snapshot.pid, suffix: suffix)
    }
    if suffixMatched.count == 1 { return suffixMatched }

    // The macOS 15 AX tree sometimes exposes the six editable cells but not
    // the delivery-label sibling. codeEntry() only accepts one shared-parent,
    // empty, geometrically aligned six-cell group for this fallback.
    let fallbackCandidates = candidates.filter { isSixCellCodeEntry($0.1) }
    guard suffixMatched.isEmpty, fallbackCandidates.count == 1 else {
        return []
    }
    return fallbackCandidates
}

private func matchingCodeEntries(
    suffix: String,
    requireEmpty: Bool = true
) -> [(SettingsSnapshot, CodeEntry)] {
    let initial = resolvedCodeEntries(
        in: currentSnapshots(),
        suffix: suffix,
        requireEmpty: requireEmpty
    )
    guard initial.count == 1 else { return [] }

    // Require the same target to survive one short re-read. This catches the
    // transient AX tree where the phone sheet or a retiring surface is still
    // present and prevents writing a code into a stale six-field group.
    usleep(140_000)
    let revalidated = resolvedCodeEntries(
        in: currentSnapshots(),
        suffix: suffix,
        requireEmpty: requireEmpty
    )
    guard revalidated.count == 1,
          sameCodeEntryShape(initial[0].1, revalidated[0].1) else {
        return []
    }
    return revalidated
}

private func parseArguments() -> (phase: String?, suffix: String?) {
    var phase: String?
    var suffix: String?
    var index = 1
    let arguments = CommandLine.arguments

    while index < arguments.count {
        if arguments[index] == "--phase", index + 1 < arguments.count {
            phase = arguments[index + 1]
            index += 2
            continue
        }
        if arguments[index] == "--suffix", index + 1 < arguments.count {
            suffix = arguments[index + 1]
            index += 2
            continue
        }
        index += 1
    }
    return (phase, suffix)
}

private func currentSnapshots() -> [SettingsSnapshot] {
    guard let app = activeSystemSettings() else { return [] }
    let pid = app.processIdentifier
    let appElement = AXUIElementCreateApplication(pid)
    let roots = roots(for: appElement, pid: pid)
    return roots.map { root in
        SettingsSnapshot(pid: pid, nodes: visibleNodes(in: [root], pid: pid))
    }.filter { !$0.nodes.isEmpty }
}

let arguments = parseArguments()
guard let phase = arguments.phase else {
    emit(false, "unknown_phase")
}
guard AXIsProcessTrusted() else {
    emit(false, "accessibility_unavailable")
}

switch phase {
case "sms-state":
    guard let suffix = arguments.suffix,
          suffix.range(of: #"^[0-9]{2}$"#, options: .regularExpression) != nil else {
        emit(false, "suffix_invalid")
    }
    let snapshots = currentSnapshots()
    guard !snapshots.isEmpty else {
        emit(true, "waiting")
    }
    // A six-cell group that survives the same-parent/geometry re-read is the
    // only accepted code surface.  Single semantic inputs are intentionally
    // ignored: this page is guaranteed to expose six digits in the supported
    // macOS flow, and accepting one field risks filling the wrong surface.
    let stableCodeCandidates = matchingCodeEntries(suffix: suffix)
    let populatedCodeCandidates = matchingCodeEntries(suffix: suffix, requireEmpty: false)
    let sixCellCandidates = codeEntries(in: snapshots).filter { isSixCellCodeEntry($0.1) }
    let phoneSnapshots = snapshots.filter {
        phoneSelection(in: $0.nodes, pid: $0.pid) != nil
    }
    if stableCodeCandidates.count == 1, phoneSnapshots.isEmpty {
        emit(true, "code_entry")
    }
    // Once the six cells are populated, retain a distinct state while Apple
    // validates the code. Treating this as generic waiting would let the Node
    // coordinator advance before the code page has actually disappeared.
    if stableCodeCandidates.isEmpty,
       populatedCodeCandidates.count == 1,
       phoneSnapshots.isEmpty {
        emit(true, "code_pending")
    }
    if phoneSnapshots.count == 1,
       populatedCodeCandidates.isEmpty,
       sixCellCandidates.isEmpty {
        emit(true, "phone_selection")
    }
    emit(true, "waiting")

case "sms-select":
    guard let suffix = arguments.suffix,
          suffix.range(of: #"^[0-9]{2}$"#, options: .regularExpression) != nil else {
        emit(false, "suffix_invalid")
    }
    let selections = currentSnapshots().compactMap { snapshot -> (SettingsSnapshot, PhoneSelection)? in
        guard let selection = phoneSelection(in: snapshot.nodes, pid: snapshot.pid) else {
            return nil
        }
        return (snapshot, selection)
    }
    guard selections.count == 1 else {
        emit(false, "phone_selection_unavailable")
    }
    let selectionSnapshot = selections[0].0
    let selection = selections[0].1
    let matches = selection.controls.filter { control in
        phoneControlTexts(control, pid: selectionSnapshot.pid).contains { text in
            asciiDigits(in: text).hasSuffix(suffix)
        }
    }
    guard matches.count == 1 else {
        emit(false, matches.isEmpty ? "phone_not_matched" : "phone_not_unique")
    }
    guard selectPhone(matches[0]) else {
        emit(false, "selection_not_confirmed")
    }
    emit(true, "selected")

case "sms-continue":
    guard let suffix = arguments.suffix,
          suffix.range(of: #"^[0-9]{2}$"#, options: .regularExpression) != nil else {
        emit(false, "phone_selection_unavailable")
    }
    let selections = currentSnapshots().compactMap { snapshot -> (SettingsSnapshot, PhoneSelection)? in
        guard let selection = phoneSelection(in: snapshot.nodes, pid: snapshot.pid) else {
            return nil
        }
        return (snapshot, selection)
    }
    guard selections.count == 1 else {
        emit(false, "selection_not_confirmed")
    }
    let selectionSnapshot = selections[0].0
    let selection = selections[0].1
    let selectedMatches = selection.controls.filter { control in
        selected(control) && phoneControlTexts(control, pid: selectionSnapshot.pid).contains { text in
            asciiDigits(in: text).hasSuffix(suffix)
        }
    }
    guard selectedMatches.count == 1,
          selection.controls.filter(selected).count == 1 else {
        emit(false, "selection_not_confirmed")
    }
    guard AXUIElementPerformAction(selection.continueButton, kAXPressAction as CFString) == .success else {
        emit(false, "continue_failed")
    }
    emit(true, "continued")

case "sms-code":
    guard let suffix = arguments.suffix,
          suffix.range(of: #"^[0-9]{2}$"#, options: .regularExpression) != nil else {
        emit(false, "suffix_invalid")
    }
    guard let code = readManualCodeFromStandardInput() else {
      emit(false, "manual_code_invalid")
    }
    let entries = matchingCodeEntries(suffix: suffix)
    guard entries.count == 1 else {
        emit(false, "code_entry_unavailable")
    }
    let filled: Bool
    switch entries[0].1 {
    case .six(let fields):
        var wroteAllDigits = true
        for (index, field) in fields.enumerated() {
            let digitIndex = code.index(code.startIndex, offsetBy: index)
            let transitionSuffix = index == fields.count - 1 ? suffix : nil
            if !setFocusedValue(
                field,
                value: String(code[digitIndex]),
                transitionSuffix: transitionSuffix
            ) {
                wroteAllDigits = false
                break
            }
        }
        filled = wroteAllDigits
    }
    guard filled else {
        emit(false, "code_write_failed")
    }
    emit(true, "code_submitted")

default:
    emit(false, "unknown_phase")
}
