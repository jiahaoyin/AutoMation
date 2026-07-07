#!/usr/bin/env swift
// 弹窗验证码 OCR（Vision）— AX 读不到大字号 NNN NNN 时的回退
// JSON: { "ok": true, "code": "757464", "raw": "757 464", "source": "vision" }

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Vision

struct Output: Codable {
    let ok: Bool
    let code: String?
    let raw: String?
    let source: String?
    let message: String
}

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ wid: UnsafeMutablePointer<CGWindowID>) -> AXError

func logStep(_ msg: String) {
    FileHandle.standardError.write("[2FA-ocr] \(msg)\n".data(using: .utf8)!)
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
    if blob.contains("Enter this verification code") { return true }
    if blob.contains("正用于登录") && blob.contains("新设备") && (blob.contains("完成") || blob.contains("Done")) { return true }
    return false
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
    let appName: String
    let window: AXUIElement
    let frame: CGRect
    let windowID: CGWindowID?
}

func windowIDFor(_ element: AXUIElement) -> CGWindowID? {
    var wid: CGWindowID = 0
    if _AXUIElementGetWindow(element, &wid) == .success, wid != 0 { return wid }
    return nil
}

func findCodeDialogs() -> [DialogTarget] {
    var out: [DialogTarget] = []
    for app in NSWorkspace.shared.runningApplications {
        let appName = app.localizedName ?? ""
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        for win in windowsForApp(appEl) {
            let blob = blobOf(win)
            guard looksLikeCodeDialog(blob), let frame = frameOf(win), frame.width > 80, frame.height > 60 else { continue }
            out.append(DialogTarget(appName: appName, window: win, frame: frame, windowID: windowIDFor(win)))
        }
    }
    return out
}

func captureWindowByID(_ wid: CGWindowID) -> CGImage? {
    let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("2fa-ocr-w-\(UUID().uuidString).png")
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-x", "-l", String(wid), path]
    do {
        try task.run()
        task.waitUntilExit()
        guard task.terminationStatus == 0, let img = NSImage(contentsOfFile: path) else { return nil }
        defer { try? FileManager.default.removeItem(atPath: path) }
        var proposed = CGRect(origin: .zero, size: img.size)
        return img.cgImage(forProposedRect: &proposed, context: nil, hints: nil)
    } catch {
        return nil
    }
}

func paddedFrame(_ frame: CGRect, pad: CGFloat = 8) -> CGRect {
    CGRect(
        x: max(0, frame.origin.x - pad),
        y: max(0, frame.origin.y - pad),
        width: frame.width + pad * 2,
        height: frame.height + pad * 2
    )
}

func captureRectScreencapture(_ rect: CGRect) -> CGImage? {
    let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("2fa-ocr-\(UUID().uuidString).png")
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = [
        "-x", "-R",
        "\(Int(rect.origin.x)),\(Int(rect.origin.y)),\(Int(rect.width)),\(Int(rect.height))",
        path,
    ]
    do {
        try task.run()
        task.waitUntilExit()
        guard task.terminationStatus == 0, let img = NSImage(contentsOfFile: path) else { return nil }
        defer { try? FileManager.default.removeItem(atPath: path) }
        var proposed = CGRect(origin: .zero, size: img.size)
        guard let cg = img.cgImage(forProposedRect: &proposed, context: nil, hints: nil) else { return nil }
        return cg
    } catch {
        return nil
    }
}

func captureDialog(_ target: DialogTarget) -> (CGImage, String)? {
    if let wid = target.windowID, let img = captureWindowByID(wid) {
        return (img, "screencapture_window")
    }
    let padded = paddedFrame(target.frame)
    if let img = captureRectScreencapture(padded) {
        return (img, "screencapture")
    }
    if let img = captureRectScreencapture(target.frame) {
        return (img, "screencapture_exact")
    }
    return nil
}

func saveDebugImage(_ cg: CGImage, dir: String, label: String) {
    let url = URL(fileURLWithPath: dir).appendingPathComponent("2fa-ocr-\(label)-\(Int(Date().timeIntervalSince1970)).png")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let rep = NSBitmapImageRep(cgImage: cg)
    if let data = rep.representation(using: .png, properties: [:]) {
        try? data.write(to: url)
        logStep("debug screenshot: \(url.path)")
    }
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

func ocrText(from cgImage: CGImage) -> String {
    let accurate = ocrLines(from: cgImage, level: .accurate).joined(separator: " ")
    if !accurate.isEmpty { return accurate }
    return ocrLines(from: cgImage, level: .fast).joined(separator: " ")
}

func findFormattedCode(_ text: String) -> (String, String)? {
    let patterns = [
        #"\d{3}[\s\u00a0\u2009]+\d{3}"#,
        #"\d{3}\s*\d{3}"#,
        #"(?<!\d)\d{6}(?!\d)"#,
    ]
    for pattern in patterns {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
        let ns = text as NSString
        let range = NSRange(location: 0, length: ns.length)
        if let m = regex.firstMatch(in: text, range: range) {
            let raw = ns.substring(with: m.range)
            let digits = raw.filter(\.isNumber)
            if digits.count == 6 { return (String(digits), raw) }
        }
    }
    // 分行合并：Vision 有时把 "350" 与 "566" 拆成两行
    let onlyDigits = text.filter { $0.isNumber || $0.isWhitespace }
    let chunks = onlyDigits.split(whereSeparator: { $0.isWhitespace })
    for chunk in chunks {
        let d = String(chunk).filter(\.isNumber)
        if d.count == 6 { return (d, d) }
    }
    let allDigits = text.filter(\.isNumber)
    if allDigits.count >= 6 {
        let code = String(allDigits.prefix(6))
        return (code, code)
    }
    return nil
}

func tryOcrOnImage(_ cg: CGImage, label: String) -> (String, String)? {
    let fullText = ocrText(from: cg)
    logStep("\(label) ocr: \(fullText.prefix(160))")
    if let hit = findFormattedCode(fullText) { return hit }
    // 中心裁剪再试（大字号验证码常在中间）
    let w = CGFloat(cg.width)
    let h = CGFloat(cg.height)
    let cropRect = CGRect(x: w * 0.1, y: h * 0.2, width: w * 0.8, height: h * 0.55)
    if let cropped = cg.cropping(to: cropRect) {
        let cropText = ocrText(from: cropped)
        logStep("\(label) center-crop ocr: \(cropText.prefix(120))")
        if let hit = findFormattedCode(cropText) { return hit }
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
var debugDir: String?
var i = 1
while i < CommandLine.arguments.count {
    if CommandLine.arguments[i] == "--timeout", i + 1 < CommandLine.arguments.count {
        timeoutSec = Int(CommandLine.arguments[i + 1]) ?? timeoutSec
        i += 2
        continue
    }
    if CommandLine.arguments[i] == "--debug-dir", i + 1 < CommandLine.arguments.count {
        debugDir = CommandLine.arguments[i + 1]
        i += 2
        continue
    }
    i += 1
}

let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))
var attempt = 0
while Date() < deadline {
    attempt += 1
    let dialogs = findCodeDialogs()
    if dialogs.isEmpty {
        logStep("no code dialog found (attempt \(attempt))")
    }
    for target in dialogs {
        logStep("dialog \(target.appName) frame \(Int(target.frame.origin.x)),\(Int(target.frame.origin.y)) \(Int(target.frame.width))x\(Int(target.frame.height)) wid=\(target.windowID.map(String.init) ?? "nil")")
        guard let (cg, method) = captureDialog(target) else {
            logStep("capture failed for \(target.appName)")
            continue
        }
        if let dir = debugDir {
            saveDebugImage(cg, dir: dir, label: "capture-\(method)")
        }
        if let (code, raw) = tryOcrOnImage(cg, label: method) {
            emit(Output(ok: true, code: code, raw: raw, source: "vision", message: "ok"))
        }
        if let dir = debugDir {
            saveDebugImage(cg, dir: dir, label: "failed-\(method)")
        }
    }
    // 全屏回退：弹窗坐标不准时仍可能读到中间大字
    if attempt % 3 == 0 {
        for screen in NSScreen.screens {
            let f = screen.frame
            if let cg = captureRectScreencapture(f), let (code, raw) = tryOcrOnImage(cg, label: "fullscreen") {
                emit(Output(ok: true, code: code, raw: raw, source: "vision_fullscreen", message: "ok"))
            }
        }
    }
    usleep(350_000)
}

emit(Output(ok: false, code: nil, raw: nil, source: nil, message: "timeout"))
