import Foundation
import Testing
@testable import WaynodeCore

@Suite("AuthStore credential lifecycle", .serialized)
struct AuthStoreTests {
    private var defaultScope: String { ServerConfig.default.credentialScope }

    @Test("Transient verification failure retains the stored credential")
    @MainActor
    func transientVerificationFailure() async {
        let store = MemoryCredentialStore(token: "wn_saved")
        let remote = AuthAPIStub(verification: .failure(.init(statusCode: 503, message: "Unavailable")))
        let auth = AuthStore(serverConfig: .default, keychain: store, authAPI: remote)

        await auth.verifyToken()

        #expect(auth.token == "wn_saved")
        #expect(store.readToken(for: defaultScope) == "wn_saved")
        #expect(auth.hasRecoverableVerificationFailure)
        #expect(auth.hasCompletedLaunchCheck)
        #expect(auth.user == nil)
    }

    @Test("Authoritative 401 deletes the stored credential")
    @MainActor
    func invalidCredentialIsDeleted() async {
        let store = MemoryCredentialStore(token: "wn_expired")
        let remote = AuthAPIStub(verification: .failure(.init(statusCode: 401, message: "Unauthorized")))
        let auth = AuthStore(serverConfig: .default, keychain: store, authAPI: remote)

        await auth.verifyToken()

        #expect(auth.token == nil)
        #expect(store.readToken(for: defaultScope) == nil)
        #expect(!auth.hasRecoverableVerificationFailure)
        #expect(auth.error?.contains("expired") == true)
    }

    @Test("Logout revokes remotely before deleting locally")
    @MainActor
    func logoutRevokesCurrentToken() async {
        let store = MemoryCredentialStore(token: "wn_current")
        let remote = AuthAPIStub(verification: .success(.init()))
        let auth = AuthStore(serverConfig: .default, keychain: store, authAPI: remote)

        await auth.logoutRevokingCurrentToken()

        #expect(await remote.revocationCount() == 1)
        #expect(auth.token == nil)
        #expect(store.readToken(for: defaultScope) == nil)
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
        let auth = AuthStore(serverConfig: .default, keychain: store, authAPI: remote)

        await auth.logoutRevokingCurrentToken()

        #expect(await remote.revocationCount() == 1)
        #expect(auth.token == nil)
        #expect(store.readToken(for: defaultScope) == nil)
        #expect(auth.error?.contains("couldn't be reached") == true)
    }

    @Test("Credentials are isolated by canonical server origin")
    @MainActor
    func credentialsAreServerScoped() {
        let first = ServerConfig(baseURL: URL(string: "https://one.example.test/path")!)
        let second = ServerConfig(baseURL: URL(string: "https://two.example.test")!)
        let store = MemoryCredentialStore(tokens: [
            first.credentialScope: "wn_one",
            second.credentialScope: "wn_two",
        ])

        let firstAuth = AuthStore(serverConfig: first, keychain: store)
        let secondAuth = AuthStore(serverConfig: second, keychain: store)

        #expect(firstAuth.token == "wn_one")
        #expect(secondAuth.token == "wn_two")
    }

    @Test("Server change revokes old token before verifying scoped replacement")
    @MainActor
    func serverChangeOrdersCredentialTransition() async {
        let old = ServerConfig(baseURL: URL(string: "https://old.example.test")!)
        let new = ServerConfig(baseURL: URL(string: "https://new.example.test")!)
        let store = MemoryCredentialStore(tokens: [
            old.credentialScope: "wn_old",
            new.credentialScope: "wn_new",
        ])
        let remote = AuthAPIStub(verification: .success(.init(user: testUser)))
        let auth = AuthStore(serverConfig: old, keychain: store, authAPI: remote)

        await auth.changeServerURL(new.baseURL)

        #expect(await remote.events() == ["revoke", "verify"])
        #expect(store.readToken(for: old.credentialScope) == nil)
        #expect(store.readToken(for: new.credentialScope) == "wn_new")
        #expect(auth.token == "wn_new")
        #expect(auth.isAuthenticated)
    }

    @Test("Failed replacement preserves the working credential")
    @MainActor
    func failedReplacementPreservesCredential() async {
        let store = MemoryCredentialStore(token: "wn_working", failWrites: true)
        let remote = AuthAPIStub(verification: .success(.init(user: testUser)))
        let auth = AuthStore(serverConfig: .default, keychain: store, authAPI: remote)

        await auth.completeAuth(token: "wn_replacement")

        #expect(store.readToken(for: defaultScope) == "wn_working")
        #expect(auth.token == "wn_working")
        #expect(auth.error?.contains("Login failed") == true)
    }

    @Test("Server URL policy requires HTTPS except exact loopback hosts")
    func serverURLPolicy() {
        #expect(ServerConfig.validatedBaseURL(from: "https://Example.COM:443/")?.absoluteString == "https://example.com")
        #expect(ServerConfig.validatedBaseURL(from: "http://localhost:3000") != nil)
        #expect(ServerConfig.validatedBaseURL(from: "http://127.0.0.1:3000") != nil)
        #expect(ServerConfig.validatedBaseURL(from: "http://[::1]:3000") != nil)
        #expect(ServerConfig.validatedBaseURL(from: "http://192.168.1.10:3000") == nil)
        #expect(ServerConfig.validatedBaseURL(from: "http://example.com") == nil)
        #expect(ServerConfig.validatedBaseURL(from: "https://user:pass@example.com") == nil)
    }

    @Test("Terminal capability preserves unsupported and unavailable truth")
    @MainActor
    func terminalCapabilityTruth() {
        let auth = AuthStore(serverConfig: .default, keychain: MemoryCredentialStore(token: nil))
        #expect(auth.terminalCapability == .checking)

        auth.setProviders(nil, capabilities: .init(terminal: true))
        #expect(auth.terminalCapability == .supported)
        auth.setProviders(nil, capabilities: .init(terminal: false))
        #expect(auth.terminalCapability == .unsupported)
        auth.setProviders(nil, capabilities: nil)
        #expect(auth.terminalCapability == .unavailable)
        auth.markServerCapabilitiesUnavailable()
        #expect(auth.terminalCapability == .unavailable)
    }

    private var testUser: User {
        User(id: "user-1", name: "Waynode Tester")
    }
}

private final class MemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String: String]
    private let failWrites: Bool

    init(token: String?, failWrites: Bool = false) {
        tokens = token.map { [ServerConfig.default.credentialScope: $0] } ?? [:]
        self.failWrites = failWrites
    }

    init(tokens: [String: String], failWrites: Bool = false) {
        self.tokens = tokens
        self.failWrites = failWrites
    }

    func readToken(for serverOrigin: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return tokens[serverOrigin]
    }

    func writeToken(_ token: String, for serverOrigin: String) throws {
        lock.lock()
        defer { lock.unlock() }
        if failWrites { throw TestCredentialError.writeFailed }
        tokens[serverOrigin] = token
    }

    func deleteToken(for serverOrigin: String) {
        lock.lock()
        defer { lock.unlock() }
        tokens.removeValue(forKey: serverOrigin)
    }

    private enum TestCredentialError: Error { case writeFailed }
}

private actor AuthAPIStub: NativeAuthAPI {
    enum Verification: Sendable {
        case success(AuthMeResponse)
        case failure(APIClient.APIError)
    }

    private let verification: Verification
    private let revocationError: APIClient.APIError?
    private var revocations = 0
    private var recordedEvents: [String] = []

    init(verification: Verification, revocationError: APIClient.APIError? = nil) {
        self.verification = verification
        self.revocationError = revocationError
    }

    func authMe() async throws -> AuthMeResponse {
        recordedEvents.append("verify")
        switch verification {
        case .success(let response): return response
        case .failure(let error): throw error
        }
    }

    func revokeCurrentToken() async throws {
        recordedEvents.append("revoke")
        revocations += 1
        if let revocationError { throw revocationError }
    }

    func revocationCount() -> Int { revocations }
    func events() -> [String] { recordedEvents }
}
