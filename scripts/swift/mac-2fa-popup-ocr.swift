#!/usr/bin/env swift
// 弹窗验证码 OCR（Vision）— AX 读不到大字号 NNN NNN 时的回退
// JSON includes only the minimal internal IPC payload and fixed status fields.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

struct Output: Codable {
    let ok: Bool
    let code: String?
    let source: String?
    let message: String
    let capability: String?

    init(ok: Bool, code: String?, source: String?, message: String, capability: String? = nil) {
        self.ok = ok
        self.code = code
        self.source = source
        self.message = message
        self.capability = capability
    }
}

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ wid: UnsafeMutablePointer<CGWindowID>) -> AXError

func logStep(_ msg: String) {
    FileHandle.standardError.write("[2FA-ocr] \(msg)\n".data(using: .utf8)!)
}

func screenCaptureCapability(requestPermission: Bool = false) -> String {
    if CGPreflightScreenCaptureAccess() { return "available" }
    if requestPermission {
        _ = CGRequestScreenCaptureAccess()
    }
    return CGPreflightScreenCaptureAccess() ? "available" : "permission_missing"
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

func axTexts(_ element: AXUIElement) -> [String] {
    [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXRoleDescriptionAttribute]
        .compactMap { axString(element, $0 as String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
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

func blobOf(_ root: AXUIElement, depth: Int = 0, maxDepth: Int = 14) -> String {
    if depth > maxDepth { return "" }
    var b = axTexts(root).joined(separator: " ")
    for child in axChildren(root) {
        b += " " + blobOf(child, depth: depth + 1, maxDepth: maxDepth)
    }
    return b
}

func looksLikeCodeDialog(_ blob: String) -> Bool {
    if blob.contains("在网页上输入此验证码") { return true }
    if blob.contains("在网页上输入") && blob.contains("验证码") { return true }
    if blob.contains("验证码以登录") { return true }
    if blob.contains("在網頁上輸入此驗證碼") { return true }
    if blob.contains("在網頁上輸入") && blob.contains("驗證碼") { return true }
    if blob.contains("驗證碼以登入") { return true }
    if blob.contains("Enter this verification code") { return true }
    if blob.contains("正用于登录") && blob.contains("新设备") && (blob.contains("完成") || blob.contains("Done")) { return true }
    return false
}

let dedicatedAuthExecutables: Set<String> = [
    "FollowUpUI",
    "CoreAuthUI",
    "CoreAuthentication",
    "AuthenticationServicesAgent",
]
let sharedHostExecutables: Set<String> = [
    "UserNotificationCenter",
    "loginwindow",
    "SecurityAgent",
    "akd",
]
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

enum CandidateKind: Equatable {
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
    if dedicatedAuthExecutables.contains(executableName) ||
        dedicatedAuthBundleIDs.contains(bundleIdentifier) {
        return .dedicated
    }
    if sharedHostExecutables.contains(executableName) ||
        sharedHostBundleIDs.contains(bundleIdentifier) {
        return .sharedHost
    }
    return nil
}

func hasExplicitAppleAccountEvidence(_ blob: String) -> Bool {
    let lower = blob.lowercased()
    let markers = [
        "apple id",
        "apple account",
        "apple账户",
        "apple 账户",
        "apple帐户",
        "apple 帐户",
        "apple帐号",
        "apple 帐号",
        "apple帳戶",
        "apple 帳戶",
        "apple帳號",
        "apple 帳號",
    ]
    return markers.contains { lower.contains($0) }
}

func isEligibleCodeWindow(
    kind: CandidateKind,
    blob: String,
    hasCodePrompt: Bool,
    hasCodeDisplay: Bool = false
) -> Bool {
    switch kind {
    case .dedicated:
        return hasCodePrompt || hasCodeDisplay
    case .sharedHost:
        return hasCodePrompt && hasExplicitAppleAccountEvidence(blob)
    }
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

struct DialogTarget {
    let windowID: CGWindowID?
}

enum OcrCandidateSource: Equatable {
    case fullWindow
    case centerCrop
}

struct OcrCandidate {
    let code: String
    let source: OcrCandidateSource

    var requiresStability: Bool {
        source == .centerCrop
    }
}

struct CenterCandidateState {
    let code: String
    let capturePass: Int
}

struct CenterCandidateTracker {
    private var states: [CGWindowID: CenterCandidateState] = [:]

    mutating func observeCenterCandidate(
        windowID: CGWindowID,
        code: String,
        capturePass: Int
    ) -> Bool {
        let previous = states[windowID]
        if previous?.code == code && previous?.capturePass == capturePass - 1 {
            states[windowID] = CenterCandidateState(code: code, capturePass: capturePass)
            return true
        }
        states[windowID] = CenterCandidateState(code: code, capturePass: capturePass)
        return false
    }

    mutating func reset(windowID: CGWindowID) {
        states.removeValue(forKey: windowID)
    }

    mutating func retainOnly(_ windowIDs: Set<CGWindowID>) {
        states = states.filter { windowIDs.contains($0.key) }
    }
}

func windowIDFor(_ element: AXUIElement) -> CGWindowID? {
    var wid: CGWindowID = 0
    if _AXUIElementGetWindow(element, &wid) == .success, wid != 0 { return wid }
    return nil
}

// Some system authentication sheets expose a complete AX tree but do not
// bridge their AX window to a CGWindowID. Keep the OCR fallback window-bound:
// resolve only an on-screen window from the same already-verified process
// whose frame intersects the verified AX dialog frame.
func resolveOnScreenWindowID(pid: pid_t, near axFrame: CGRect) -> CGWindowID? {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windowInfo = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    let axArea = max(1, axFrame.width * axFrame.height)
    let axCenter = CGPoint(x: axFrame.midX, y: axFrame.midY)
    var candidates: [(id: CGWindowID, score: CGFloat)] = []

    for info in windowInfo {
        guard
            let ownerPIDNumber = info[kCGWindowOwnerPID as String] as? NSNumber,
            pid_t(ownerPIDNumber.int32Value) == pid,
            let windowNumber = info[kCGWindowNumber as String] as? NSNumber,
            let bounds = info[kCGWindowBounds as String] as? NSDictionary,
            let candidateFrame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
            candidateFrame.width > 80,
            candidateFrame.height > 60
        else { continue }

        let intersection = axFrame.intersection(candidateFrame)
        let intersects = !intersection.isNull && !intersection.isEmpty
        let candidateCenter = CGPoint(x: candidateFrame.midX, y: candidateFrame.midY)
        let centerIsContained = candidateFrame.contains(axCenter) || axFrame.contains(candidateCenter)
        guard intersects || centerIsContained else { continue }

        let overlapPenalty = intersects ? 1 - (intersection.width * intersection.height / axArea) : 1
        let sizePenalty = abs(candidateFrame.width - axFrame.width) / max(1, axFrame.width) +
            abs(candidateFrame.height - axFrame.height) / max(1, axFrame.height)
        let centerPenalty = hypot(candidateCenter.x - axCenter.x, candidateCenter.y - axCenter.y) /
            max(1, max(axFrame.width, axFrame.height))
        let windowID = CGWindowID(windowNumber.uint32Value)
        guard windowID != 0 else { continue }
        candidates.append((id: windowID, score: overlapPenalty + sizePenalty + centerPenalty))
    }

    candidates.sort { $0.score < $1.score }
    guard let best = candidates.first else { return nil }
    // If two windows are geometrically indistinguishable, do not guess which
    // one to capture. The next polling pass can resolve a stable target.
    if candidates.count > 1, abs(candidates[1].score - best.score) < 0.01 {
        return nil
    }
    return best.id
}

func findCodeDialogs() -> [DialogTarget] {
    var out: [DialogTarget] = []
    for app in NSWorkspace.shared.runningApplications {
        guard let kind = candidateKind(for: app) else { continue }
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        for win in windowsForApp(appEl) {
            let blob = blobOf(win)
            let hasCodePrompt = looksLikeCodeDialog(blob)
            guard isEligibleCodeWindow(
                kind: kind,
                blob: blob,
                hasCodePrompt: hasCodePrompt
            ), let frame = frameOf(win), frame.width > 80, frame.height > 60 else { continue }
            let windowID = resolveOnScreenWindowID(
                pid: app.processIdentifier,
                near: frame
            ) ?? windowIDFor(win)
            guard let windowID else { continue }
            out.append(DialogTarget(windowID: windowID))
        }
    }
    return out
}

func captureWindowByID(_ wid: CGWindowID) async -> CGImage? {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let window = content.windows.first(where: { $0.windowID == wid }) else {
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

// Screen Recording can still inspect a window when Accessibility is denied to
// this helper. Limit that route to dedicated Apple authentication processes,
// enumerate only on-screen window IDs, and keep all pixels in memory.
func findScreenOnlyCodeDialogs() -> [DialogTarget] {
    let trustedPIDs = Set(NSWorkspace.shared.runningApplications.compactMap { app -> pid_t? in
        guard candidateKind(for: app) == .dedicated else { return nil }
        return app.processIdentifier
    })
    guard !trustedPIDs.isEmpty else { return [] }

    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windowInfo = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    var windowIDs = Set<CGWindowID>()
    var out: [DialogTarget] = []
    for info in windowInfo {
        guard
            let ownerPIDNumber = info[kCGWindowOwnerPID as String] as? NSNumber,
            trustedPIDs.contains(pid_t(ownerPIDNumber.int32Value)),
            let windowNumber = info[kCGWindowNumber as String] as? NSNumber,
            let bounds = info[kCGWindowBounds as String] as? NSDictionary,
            let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
            frame.width > 80,
            frame.height > 60
        else { continue }
        let windowID = CGWindowID(windowNumber.uint32Value)
        guard windowID != 0, windowIDs.insert(windowID).inserted else { continue }
        out.append(DialogTarget(windowID: windowID))
    }
    return out
}

func captureDialog(_ target: DialogTarget) async -> CGImage? {
    guard let wid = target.windowID else { return nil }
    return await captureWindowByID(wid)
}

func ocrLines(from cgImage: CGImage, level: VNRequestTextRecognitionLevel) -> [String] {
    var lines: [String] = []
    let sem = DispatchSemaphore(value: 0)
    let request = VNRecognizeTextRequest { req, _ in
        defer { sem.signal() }
        guard let obs = req.results as? [VNRecognizedTextObservation] else { return }
        for o in obs.sorted(by: { $0.boundingBox.minY > $1.boundingBox.minY }) {
            if let t = o.topCandidates(1).first?.string {
                lines.append(t)
            }
        }
    }
    request.recognitionLevel = level
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.02
    if #available(macOS 13.0, *) {
        request.revision = VNRecognizeTextRequestRevision3
        request.automaticallyDetectsLanguage = true
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try? handler.perform([request])
    sem.wait()
    return lines
}

let formattedCodePattern = #"(?<![0-9])[0-9]{3}[\s\u00a0\u2009]+[0-9]{3}(?![0-9])"#
let contiguousCodePattern = #"(?<![0-9])[0-9]{6}(?![0-9])"#

func findFormattedCode(_ text: String, allowContiguous: Bool = false) -> String? {
    var patterns = [formattedCodePattern]
    if allowContiguous {
        patterns.append(contiguousCodePattern)
    }
    for pattern in patterns {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
        let ns = text as NSString
        let range = NSRange(location: 0, length: ns.length)
        if let m = regex.firstMatch(in: text, range: range) {
            let raw = ns.substring(with: m.range)
            let digits = raw.filter(\.isNumber)
            if digits.count == 6 { return String(digits) }
        }
    }
    return nil
}

func firstCode(in lines: [String], allowContiguous: Bool) -> String? {
    for line in lines {
        if let hit = findFormattedCode(line, allowContiguous: allowContiguous) {
            return hit
        }
    }
    return nil
}

func tryOcrOnImage(_ cg: CGImage) -> OcrCandidate? {
    let fullLines = ocrLines(from: cg, level: .accurate)
    if let hit = firstCode(in: fullLines, allowContiguous: false) {
        return OcrCandidate(code: hit, source: .fullWindow)
    }
    if fullLines.isEmpty {
        let fastLines = ocrLines(from: cg, level: .fast)
        if let hit = firstCode(in: fastLines, allowContiguous: false) {
            return OcrCandidate(code: hit, source: .fullWindow)
        }
    }
    // 中心裁剪再试（大字号验证码常在中间）
    let w = CGFloat(cg.width)
    let h = CGFloat(cg.height)
    let cropRect = CGRect(x: w * 0.1, y: h * 0.2, width: w * 0.8, height: h * 0.55)
    if let cropped = cg.cropping(to: cropRect) {
        let cropLines = ocrLines(from: cropped, level: .accurate)
        if let hit = firstCode(in: cropLines, allowContiguous: true) {
            return OcrCandidate(code: hit, source: .centerCrop)
        }
        if cropLines.isEmpty {
            let fastCropLines = ocrLines(from: cropped, level: .fast)
            if let hit = firstCode(in: fastCropLines, allowContiguous: true) {
                return OcrCandidate(code: hit, source: .centerCrop)
            }
        }
    }
    return nil
}

func emit(_ output: Output) -> Never {
    let enc = JSONEncoder()
    if let data = try? enc.encode(output) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
    exit(output.ok ? 0 : 1)
}

var timeoutSec = 8
var preflightScreenCapture = false
var promptScreenCapture = false
var i = 1
while i < CommandLine.arguments.count {
    if CommandLine.arguments[i] == "--preflight-screen-capture" {
        preflightScreenCapture = true
        i += 1
        continue
    }
    if CommandLine.arguments[i] == "--prompt-screen-capture" {
        promptScreenCapture = true
        i += 1
        continue
    }
    if CommandLine.arguments[i] == "--timeout", i + 1 < CommandLine.arguments.count {
        timeoutSec = Int(CommandLine.arguments[i + 1]) ?? timeoutSec
        i += 2
        continue
    }
    i += 1
}

if preflightScreenCapture {
    emit(Output(
        ok: true,
        code: nil,
        source: nil,
        message: "preflight",
        capability: screenCaptureCapability(requestPermission: promptScreenCapture)
    ))
}

let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))
var capturePass = 0
var centerCandidateTracker = CenterCandidateTracker()
while Date() < deadline {
    capturePass += 1
    let dialogs: [DialogTarget]
    if AXIsProcessTrusted() {
        let axDialogs = findCodeDialogs()
        dialogs = axDialogs.isEmpty ? findScreenOnlyCodeDialogs() : axDialogs
    } else {
        dialogs = findScreenOnlyCodeDialogs()
    }
    var capturedWindowIDs = Set<CGWindowID>()
    if dialogs.isEmpty {
        logStep("no code dialog found")
    }
    for target in dialogs {
        guard let wid = target.windowID else { continue }
        guard capturedWindowIDs.insert(wid).inserted else { continue }
        logStep("code dialog found")
        guard let cg = await captureDialog(target) else {
            centerCandidateTracker.reset(windowID: wid)
            logStep("window capture failed")
            continue
        }
        guard let candidate = tryOcrOnImage(cg) else {
            centerCandidateTracker.reset(windowID: wid)
            continue
        }
        if candidate.requiresStability {
            guard centerCandidateTracker.observeCenterCandidate(
                windowID: wid,
                code: candidate.code,
                capturePass: capturePass
            ) else { continue }
        } else {
            centerCandidateTracker.reset(windowID: wid)
        }
        logStep("verification code acquired")
        emit(Output(ok: true, code: candidate.code, source: "vision", message: "ok"))
    }
    centerCandidateTracker.retainOnly(capturedWindowIDs)
    usleep(350_000)
}

emit(Output(ok: false, code: nil, source: nil, message: "timeout"))
