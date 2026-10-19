import AppKit
import Foundation

final class Fixture: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var field: NSTextField!
    private let output: URL

    init(output: URL) {
        self.output = output
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 500, height: 180))
        let label = NSTextField(labelWithString: "LCU fixture draft")
        label.frame = NSRect(x: 20, y: 125, width: 460, height: 22)
        field = NSTextField(frame: NSRect(x: 20, y: 80, width: 460, height: 28))
        field.identifier = NSUserInterfaceItemIdentifier("fixtureDraft")
        field.stringValue = "before"
        let button = NSButton(title: "Save draft", target: self, action: #selector(saveDraft))
        button.frame = NSRect(x: 20, y: 24, width: 130, height: 32)
        button.identifier = NSUserInterfaceItemIdentifier("saveDraft")
        content.addSubview(label)
        content.addSubview(field)
        content.addSubview(button)
        window = NSWindow(contentRect: content.frame,
                          styleMask: [.titled, .closable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "LCU Mac Native Fixture 20260925"
        window.contentView = content
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    @objc private func saveDraft() {
        do {
            try field.stringValue.write(to: output, atomically: true, encoding: .utf8)
        } catch {
            fputs("Fixture save failed: \(error)\n", stderr)
        }
    }
}

guard CommandLine.arguments.count == 2 || CommandLine.arguments.count == 3 else {
    fputs("Usage: LCUMacFixture OUTPUT_PATH [PID_PATH]\n", stderr)
    exit(2)
}
if CommandLine.arguments.count == 3 {
    try? "\(ProcessInfo.processInfo.processIdentifier)\n".write(
        to: URL(fileURLWithPath: CommandLine.arguments[2]), atomically: true, encoding: .utf8)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Fixture(output: URL(fileURLWithPath: CommandLine.arguments[1]))
app.delegate = delegate
app.run()
