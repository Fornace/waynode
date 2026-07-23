import SwiftUI

// MARK: - Edit-message environment (#9)
//
// Lets a user message pre-fill the composer with its text so the user can
// tweak and resend. True conversation forking (server-side pi checkpoint /
// resume with a parent pointer) is not yet supported by the server, so this
// is the achievable client-side slice: edit-and-resend as a new message.

/// An Equatable wrapper for environment action handlers. Raw closures can
/// never be proven equal, so putting them in the environment directly makes
/// SwiftUI treat the key as changed on EVERY ChatView body eval — which
/// re-rendered every transcript row on every keystroke and focus change
/// (the multi-second keyboard delay on long transcripts). Identity is the
/// owning store: same store, same handler.
struct ChatHandler: Equatable {
    let id: ObjectIdentifier
    let call: (String) -> Void
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
}

private struct EditMessageKey: EnvironmentKey {
    nonisolated(unsafe) static let defaultValue: ChatHandler? = nil
}

private struct StopHammersmithKey: EnvironmentKey {
    nonisolated(unsafe) static let defaultValue: ChatHandler? = nil
}

extension EnvironmentValues {
    /// Set by ChatView; consumed by UserMessageView's context menu.
    var onEditMessage: ChatHandler? {
        get { self[EditMessageKey.self] }
        set { self[EditMessageKey.self] = newValue }
    }
    /// Set by ChatView; consumed by HammersmithRunView's stop button.
    var onStopHammersmith: ChatHandler? {
        get { self[StopHammersmithKey.self] }
        set { self[StopHammersmithKey.self] = newValue }
    }
}
