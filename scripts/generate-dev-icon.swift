// Run from the repository root: swift scripts/generate-dev-icon.swift
// Runtime Dock images do not receive the installed app's automatic inset/mask.
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let output = root.appendingPathComponent("src-tauri/icons/dev")
let source = NSImage(contentsOf: root.appendingPathComponent("src-tauri/icons/icon.png"))!
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("taizhou-dev-\(UUID().uuidString).iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func render(_ pixels: Int) throws -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    let cg = context.cgContext
    cg.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
    cg.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
    context.imageInterpolation = .high

    // 824 / 1024 matches the normal macOS icon body, with 100 px safe margins.
    let body = NSRect(x: 100, y: 100, width: 824, height: 824)
    cg.saveGState()
    NSBezierPath(roundedRect: body, xRadius: 184, yRadius: 184).addClip()
    source.draw(in: body, from: .zero, operation: .copy, fraction: 1)
    cg.restoreGState()

    // Draw the badge after the body mask so the lower-right corner remains intact.
    let badge = NSRect(x: 700, y: 64, width: 276, height: 276)
    NSColor.white.setFill()
    NSBezierPath(roundedRect: badge, xRadius: 68, yRadius: 68).fill()
    NSColor(srgbRed: 37 / 255, green: 99 / 255, blue: 235 / 255, alpha: 1).setFill()
    NSBezierPath(roundedRect: badge.insetBy(dx: 22, dy: 22), xRadius: 46, yRadius: 46).fill()
    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 186, weight: .bold), .foregroundColor: NSColor.white,
    ]
    let text = "D" as NSString
    let textSize = text.size(withAttributes: attributes)
    text.draw(at: NSPoint(x: badge.midX - textSize.width / 2,
                         y: badge.midY - textSize.height / 2), withAttributes: attributes)
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    try render(size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try render(size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
try render(512).write(to: output.appendingPathComponent("icon.png"))
let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
task.arguments = ["-c", "icns", iconset.path, "-o", output.appendingPathComponent("icon.icns").path]
try task.run()
task.waitUntilExit()
guard task.terminationStatus == 0 else { fatalError("iconutil failed") }
try FileManager.default.removeItem(at: iconset)
print("Generated dev icons: 824/1024 body, transparent margins, unclipped D badge")
