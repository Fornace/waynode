import Foundation
import Testing
@testable import WaynodeCore

@Suite("AuthStore credential lifecycle", .serialized)
struct AuthStoreTests {
    @Test("Transient verification failure retains the stored credential")
    @MainActor
    func transientVerificationFailure() async {
        let store = MemoryCredentialStore(token: "wn_saved")
        let remote = AuthAPIStub(verification: .failure(.init(statusCode: 503, message: "Unavailable")))
        let auth = AuthStore(keychain: store, authAPI: remote)

        await auth.verifyToken()

        #expect(auth.token == "wn_saved")
        #expect(store.readToken() == "wn_saved")
        #expect(auth.hasRecoverableVerificationFailure)
        #expect(auth.hasCompletedLaunchCheck)
        #expect(auth.user == nil)
    }

    @Test("Authoritative 401 deletes the stored credential")
    @MainActor
    func invalidCredentialIsDeleted() async {
        let store = MemoryCredentialStore(token: "wn_expired")
        let remote = AuthAPIStub(verification: .failure(.init(statusCode: 401, message: "Unauthorized")))
        let auth = AuthStore(keychain: store, authAPI: remote)

        await auth.verifyToken()

        #expect(auth.token == nil)
        #expect(store.readToken() == nil)
        #expect(!auth.hasRecoverableVerificationFailure)
        #expect(auth.error?.contains("expired") == true)
    }

    @Test("Logout revokes remotely before deleting locally")
    @MainActor
    func logoutRevokesCurrentToken() async {
        let store = MemoryCredentialStore(token: "wn_current")
        let remote = AuthAPIStub(verification: .success(.init()))
        let auth = AuthStore(keychain: store, authAPI: remote)

        await auth.logoutRevokingCurrentToken()

        #expect(await remote.revocationCount() == 1)
        #expect(auth.token == nil)
        #expect(store.readToken() == nil)
        #expect(auth.error == nil)
    }

    @Test("Unreachable logout still clears locally and reports residual risk")
    @MainActor
    func unreachableLogoutStillCompletes() async {
        let store = MemoryCredentialStore(token: "wn_offline")
        let remote = AuthAPIStub(
            verification: .success(.init()),
            revocationError: .init(statusCode: 503, message: "Unavailable")
        )
        let auth = AuthStore(keychain: store, authAPI: remote)

        await auth.logoutRevokingCurrentToken()

        #expect(await remote.revocationCount() == 1)
        #expect(auth.token == nil)
        #expect(store.readToken() == nil)
        #expect(auth.error?.contains("couldn't be reached") == true)
    }
}

private final class MemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?

    init(token: String?) { self.token = token }

    func readToken() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return token
    }

    func writeToken(_ token: String) throws {
        lock.lock()
        defer { lock.unlock() }
        self.token = token
    }

    func deleteToken() {
        lock.lock()
        defer { lock.unlock() }
        token = nil
    }
}

private actor AuthAPIStub: NativeAuthAPI {
    enum Verification: Sendable {
        case success(AuthMeResponse)
        case failure(APIClient.APIError)
    }

    private let verification: Verification
    private let revocationError: APIClient.APIError?
    private var revocations = 0

    init(verification: Verification, revocationError: APIClient.APIError? = nil) {
        self.verification = verification
        self.revocationError = revocationError
    }

    func authMe() async throws -> AuthMeResponse {
        switch verification {
        case .success(let response): response
        case .failure(let error): throw error
        }
    }

    func revokeCurrentToken() async throws {
        revocations += 1
        if let revocationError { throw revocationError }
    }

    func revocationCount() -> Int { revocations }
}
