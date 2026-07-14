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
        let store = KeychainStore(
            service: "com.waynode.app.ui-test.keychain",
            account: "signed-runtime-smoke"
        )
        let probe = "wn_signed_keychain_smoke"
        store.deleteToken()
        defer { store.deleteToken() }

        do {
            try store.writeToken(probe)
            guard store.readToken() == probe else {
                outcome = .failed("The signed app wrote a keychain item but could not read it back.")
                return
            }
            store.deleteToken()
            guard store.readToken() == nil else {
                outcome = .failed("The signed app could not delete its keychain test item.")
                return
            }
            outcome = .passed
        } catch {
            outcome = .failed(error.localizedDescription)
        }
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
#endif
