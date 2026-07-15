#if DEBUG
import SwiftUI
import WaynodeCore

/// Exercises Keychain Services from the installed, signed app process.
/// It uses a dedicated service so a test can never overwrite the user's token.
struct SignedKeychainSmokeView: View {
    @State private var outcome: Outcome = .running

    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .opacity(outcome == .running ? 1 : 0)
            Text(outcome.message)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .accessibilityIdentifier(outcome.identifier)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("keychain.smoke.surface")
        .task { runSmokeTest() }
    }

    private func runSmokeTest() {
        let failure = SignedKeychainProbe.run()
        SignedKeychainProbe.emit(failure: failure)
        outcome = failure.map(Outcome.failed) ?? .passed
    }

    private enum Outcome: Equatable {
        case running
        case passed
        case failed(String)

        var message: String {
            switch self {
            case .running: "Checking secure storage…"
            case .passed: "Secure storage is ready"
            case .failed(let reason): "Secure storage failed: \(reason)"
            }
        }

        var identifier: String {
            switch self {
            case .running: "keychain.smoke.running"
            case .passed: "keychain.smoke.passed"
            case .failed: "keychain.smoke.failed"
            }
        }
    }
}

/// Runs before any window is created for the native-macOS smoke gate, and
/// from the visible fixture for XCTest. Keeping one probe prevents the two
/// signed-runtime paths from drifting.
enum SignedKeychainProbe {
    static func run() -> String? {
        let store = KeychainStore(
            service: "com.waynode.app.ui-test.keychain"
        )
        let scope = "https://signed-runtime-smoke.invalid"
        let probe = "wn_signed_keychain_smoke"
        let replacement = "wn_signed_keychain_replacement"
        store.deleteToken(for: scope)
        defer { store.deleteToken(for: scope) }

        do {
            try store.writeToken(probe, for: scope)
            guard store.readToken(for: scope) == probe else {
                return "The signed app wrote a keychain item but could not read it back."
            }
            try store.writeToken(replacement, for: scope)
            guard store.readToken(for: scope) == replacement else {
                return "The signed app could not update its keychain item in place."
            }
            store.deleteToken(for: scope)
            guard store.readToken(for: scope) == nil else {
                return "The signed app could not delete its keychain test item."
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    static func emit(failure: String?) {
        let marker = failure == nil
            ? "WAYNODE_KEYCHAIN_SMOKE=passed\n"
            : "WAYNODE_KEYCHAIN_SMOKE=failed\n"
        if let data = marker.data(using: .utf8) {
            FileHandle.standardOutput.write(data)
        }
        if let failure {
            print("Waynode diagnostics: keychain smoke failure: \(failure)")
        }
    }
}
#endif
