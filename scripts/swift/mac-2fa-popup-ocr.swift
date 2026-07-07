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
    if blob.contains("正用于登录") && blob.contains("新设备") && blob.contains("完成") { return true }
    return false
}

func windowsForApp(_ appEl: AXUIElement) -> [AXUIElement] {
    var list: [AXUIElement] = axCopy(appEl, kAXWindowsAttribute as String) ?? []
    if let focused: AXUIElement = axCopy(appEl, kAXFocusedWindowAttribute as String) {
        if !list.contains(where: { $0 == focused }) { list.append(focused) }
    }
    return list
}

func captureRect(_ rect: CGRect) -> CGImage? {
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

func ocrText(from cgImage: CGImage) -> String {
    var lines: [String] = []
    let sem = DispatchSemaphore(value: 0)
    let request = VNRecognizeTextRequest { req, _ in
        defer { sem.signal() }
        guard let obs = req.results as? [VNRecognizedTextObservation] else { return }
        for o in obs {
            if let t = o.topCandidates(1).first?.string {
                lines.append(t)
            }
        }
    }
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    if #available(macOS 13.0, *) {
        request.revision = VNRecognizeTextRequestRevision3
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try? handler.perform([request])
    sem.wait()
    return lines.joined(separator: " ")
}

func findFormattedCode(_ text: String) -> (String, String)? {
    let pattern = #"\d{3}\s\d{3}"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
    let ns = text as NSString
    let range = NSRange(location: 0, length: ns.length)
    guard let m = regex.firstMatch(in: text, range: range) else { return nil }
    let raw = ns.substring(with: m.range)
    let digits = raw.filter(\.isNumber)
    guard digits.count == 6 else { return nil }
    return (String(digits), raw)
}

func findCodeDialogFrame() -> CGRect? {
    for app in NSWorkspace.shared.runningApplications {
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        for win in windowsForApp(appEl) {
            let blob = blobOf(win)
            if looksLikeCodeDialog(blob), let frame = frameOf(win), frame.width > 120, frame.height > 80 {
                return frame
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
var i = 1
while i < CommandLine.arguments.count {
    if CommandLine.arguments[i] == "--timeout", i + 1 < CommandLine.arguments.count {
        timeoutSec = Int(CommandLine.arguments[i + 1]) ?? timeoutSec
        i += 2
        continue
    }
    i += 1
}

let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))
while Date() < deadline {
    if let frame = findCodeDialogFrame() {
        logStep("dialog frame \(Int(frame.origin.x)),\(Int(frame.origin.y)) \(Int(frame.width))x\(Int(frame.height))")
        if let cg = captureRect(frame) {
            let text = ocrText(from: cg)
            logStep("ocr text: \(text.prefix(120))")
            if let (code, raw) = findFormattedCode(text) {
                emit(Output(ok: true, code: code, raw: raw, source: "vision", message: "ok"))
            }
        }
    }
    usleep(400_000)
}

emit(Output(ok: false, code: nil, raw: nil, source: nil, message: "timeout"))
