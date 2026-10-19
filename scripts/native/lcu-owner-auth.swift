// lcu-owner-auth: asks macOS to authenticate the device owner (Touch ID, with the
// login password as the fallback) and reports the answer through its exit status.
// It reads and writes nothing else. `lcu apps` runs it before changing the approved-app list.
//
// Exit status: 0 the owner authenticated, 1 cancelled or failed, 2 unavailable
// (no graphical session, or no owner-authentication method), 64 usage.
import Foundation
import LocalAuthentication
import CoreGraphics

func finish(_ code: Int32, _ message: String? = nil) -> Never {
    if let message = message { FileHandle.standardError.write(Data((message + "\n").utf8)) }
    exit(code)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 2, arguments[0] == "--reason", !arguments[1].isEmpty else {
    finish(64, "usage: lcu-owner-auth --reason TEXT")
}

// Without a console graphical session (an SSH login with nobody at the screen, a
// background launch) the prompt could never be answered, so fail instead of waiting.
let session = CGSessionCopyCurrentDictionary() as? [String: Any]
guard let onConsole = session?["kCGSSessionOnConsoleKey"] as? Bool, onConsole else {
    finish(2, "no graphical login session is active for this account, so the prompt cannot be shown")
}

let context = LAContext()
var error: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
    finish(2, "owner authentication is unavailable: \(error?.localizedDescription ?? "unknown reason")")
}

let answered = DispatchSemaphore(value: 0)
var approved = false
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: arguments[1]) { ok, _ in
    approved = ok
    answered.signal()
}
answered.wait()
finish(approved ? 0 : 1)
