import Foundation
import Testing
@testable import WaynodeCore

@Suite("Native account deletion callback")
struct NativeAccountDeletionTests {
    private let nonce = Data(repeating: 7, count: 32).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")

    @Test("Grant callback is bound to the native nonce")
    func callbackNonceBinding() throws {
        let url = URL(string: "waynode://delete-account?grant=wnd_one-time&nonce=\(nonce)")!
        #expect(try NativeAccountDeletion.grant(from: url, expectedNonce: nonce) == "wnd_one-time")

        do {
            _ = try NativeAccountDeletion.grant(from: url, expectedNonce: String(repeating: "x", count: 43))
            Issue.record("A callback with the wrong nonce was accepted")
        } catch {
            #expect(error as? NativeAccountDeletion.CallbackError == .invalidOrExpired)
        }
    }

    @Test("Identity mismatch is recoverable and does not expose a grant")
    func identityMismatch() {
        let url = URL(string: "waynode://delete-account?error=identity_mismatch&nonce=\(nonce)")!
        do {
            _ = try NativeAccountDeletion.grant(from: url, expectedNonce: nonce)
            Issue.record("An error callback was accepted as a grant")
        } catch let error as NativeAccountDeletion.CallbackError {
            #expect(error == .server("identity_mismatch"))
            #expect(error.localizedDescription.contains("different Waynode account"))
        } catch {
            Issue.record("Unexpected callback error: \(error)")
        }
    }

    @Test("Malformed schemes and grant prefixes are rejected")
    func malformedCallback() {
        let wrongScheme = URL(string: "https://delete-account?grant=wnd_valid&nonce=\(nonce)")!
        let wrongGrant = URL(string: "waynode://delete-account?grant=not-a-grant&nonce=\(nonce)")!
        #expect(throws: NativeAccountDeletion.CallbackError.self) {
            try NativeAccountDeletion.grant(from: wrongScheme, expectedNonce: nonce)
        }
        #expect(throws: NativeAccountDeletion.CallbackError.self) {
            try NativeAccountDeletion.grant(from: wrongGrant, expectedNonce: nonce)
        }
    }
}
