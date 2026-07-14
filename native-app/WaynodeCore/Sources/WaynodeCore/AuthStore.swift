import Foundation
import Security
#if canImport(Observation)
import Observation
#endif

// MARK: - ServerConfig
//
// Persisted server URL. Defaults to the production instance. Stored in
// UserDefaults so it survives reinstall (it is not secret).

public struct ServerConfig: Codable, Sendable, Equatable {
    public var baseURL: URL
    public init(baseURL: URL) { self.baseURL = baseURL }

    public static let `default` = ServerConfig(
        baseURL: URL(string: "https://waynode.fornace.net")!
    )
}

// MARK: - AuthStore
//
// Observable authentication state. Owns the API token (in Keychain) and the
// server URL (in UserDefaults). The SwiftUI environment reads from this to
// decide whether to present the auth flow or the main app.

@MainActor
@Observable
public final class AuthStore {
    public var serverConfig: ServerConfig
    public private(set) var token: String?
    public private(set) var user: User?
    public private(set) var providers: AuthMeResponse.Providers?
    public private(set) var isLoading: Bool = false
    public var error: String?

    /// True once the initial launch-time token verification has settled
    /// (success or failure). RootView uses this to show a launch splash
    /// instead of flashing AuthView while a returning user's token is
    /// being validated.
    public private(set) var hasCompletedLaunchCheck: Bool = false

    /// Transient token returned from ASWebAuthenticationSession. Set during
    /// the auth callback, then persisted to Keychain after verification.
    public var pendingToken: String?

    public let keychain: KeychainStore

    public init(serverConfig: ServerConfig? = nil, keychain: KeychainStore = KeychainStore()) {
        self.keychain = keychain
        // Load persisted config.
        if let config = Self.loadServerConfig() {
            self.serverConfig = config
        } else if let config = serverConfig {
            self.serverConfig = config
        } else {
            self.serverConfig = .default
        }
        // Load persisted token.
        self.token = keychain.readToken()
    }

    // MARK: - Properties

    public var isAuthenticated: Bool { token != nil && user != nil }
    public var apiBaseURL: URL { serverConfig.baseURL.appendingPathComponent("api") }

    /// Auth callback URL scheme for ASWebAuthenticationSession.
    public static let callbackScheme = "waynode"

    /// Starts a one-shot native OAuth attempt. The nonce is persisted briefly
    /// so a signed callback can still finish after scene reconstruction.
    public func beginNativeAuth() -> String? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            error = "Couldn't create a secure sign-in request. Please try again."
            return nil
        }
        let nonce = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let attempt = NativeAuthAttempt(nonce: nonce, expiresAt: Date().addingTimeInterval(10 * 60))
        if let data = try? JSONEncoder().encode(attempt) {
            UserDefaults.standard.set(data, forKey: Self.nativeAuthAttemptKey)
            return nonce
        }
        error = "Couldn't prepare sign in. Please try again."
        return nil
    }

    public func cancelNativeAuth() {
        UserDefaults.standard.removeObject(forKey: Self.nativeAuthAttemptKey)
    }

    /// Validates and consumes the signed server callback before storing a token.
    @discardableResult
    public func completeNativeAuthCallback(_ url: URL) async -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == Self.callbackScheme,
              components.host == "auth",
              let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
              token.hasPrefix("wn_"),
              let nonce = components.queryItems?.first(where: { $0.name == "nonce" })?.value,
              consumeNativeAuthNonce(nonce) else {
            cancelNativeAuth()
            error = "This sign-in callback is invalid or expired. Please start again."
            return false
        }
        await completeAuth(token: token)
        return isAuthenticated
    }

    // MARK: - Verify token (called on launch)

    public func verifyToken() async {
        guard let token else {
            hasCompletedLaunchCheck = true
            return
        }
        isLoading = true
        error = nil
        let api = APIClient(baseURL: serverConfig.baseURL, token: token)
        do {
            let resp = try await api.authMe()
            self.user = resp.user
            self.providers = resp.providers
            await api.setToken(nil) // clear the transient token on the client
            isLoading = false
        } catch {
            // Token is invalid — clear it.
            self.token = nil
            self.user = nil
            keychain.deleteToken()
            self.error = "Session expired. Please log in again."
            isLoading = false
        }
        hasCompletedLaunchCheck = true
    }

    // MARK: - Complete auth flow (from ASWebAuthenticationSession callback)

    /// Called when the OAuth callback redirects `waynode://auth?token=wn_...`.
    /// Persists the token and fetches the user profile.
    public func completeAuth(token: String) async {
        isLoading = true
        error = nil
        let api = APIClient(baseURL: serverConfig.baseURL, token: token)
        do {
            let resp = try await api.authMe()
            // Token is valid — persist it.
            try keychain.writeToken(token)
            self.token = token
            self.user = resp.user
            self.providers = resp.providers
            isLoading = false
        } catch {
            self.error = "Login failed: \(error.localizedDescription)"
            isLoading = false
        }
    }

    // MARK: - Logout

    /// Update discovered providers (used by login screen before auth).
    public func setProviders(_ newProviders: AuthMeResponse.Providers?) {
        providers = newProviders
    }

    public func logout() {
        token = nil
        user = nil
        providers = nil
        error = nil
        pendingToken = nil
        keychain.deleteToken()
    }

    /// DEBUG: synchronously mark as authenticated with a pre-validated token.
    /// Used by the launch-argument debug hook for testing post-login flows.
    public func markAuthenticated(token: String) {
        self.token = token
        // Set a minimal user so isAuthenticated returns true immediately.
        if self.user == nil {
            self.user = User(id: "dev-user", name: "Francesco", role: "admin")
        }
        self.error = nil
        self.isLoading = false
        self.hasCompletedLaunchCheck = true
    }

    #if DEBUG
    /// Installs an in-memory identity for deterministic native UI tests.
    public func installUITestUser() {
        token = "ui-test-token"
        user = User(id: "ui-user", name: "Waynode Tester", email: "tester@example.test", role: "owner")
        providers = .init(github: true, gitlab: true, dev: true)
        error = nil
        isLoading = false
        hasCompletedLaunchCheck = true
    }
    #endif

    // MARK: - Change server

    public func setServerURL(_ url: URL) {
        serverConfig = ServerConfig(baseURL: url)
        Self.saveServerConfig(serverConfig)
    }

    // MARK: - Persistence (UserDefaults for config, Keychain for token)

    private static let serverConfigKey = "waynode.serverConfig"
    private static let nativeAuthAttemptKey = "waynode.nativeAuthAttempt"

    private struct NativeAuthAttempt: Codable {
        let nonce: String
        let expiresAt: Date
    }

    private func consumeNativeAuthNonce(_ candidate: String) -> Bool {
        defer { cancelNativeAuth() }
        guard let data = UserDefaults.standard.data(forKey: Self.nativeAuthAttemptKey),
              let attempt = try? JSONDecoder().decode(NativeAuthAttempt.self, from: data),
              attempt.expiresAt > Date() else { return false }
        let expected = Data(attempt.nonce.utf8)
        let provided = Data(candidate.utf8)
        guard expected.count == provided.count, !expected.isEmpty else { return false }
        return expected.withUnsafeBytes { expectedBytes in
            provided.withUnsafeBytes { providedBytes in
                var difference: UInt8 = 0
                for index in 0..<expected.count {
                    difference |= expectedBytes[index] ^ providedBytes[index]
                }
                return difference == 0
            }
        }
    }

    private static func loadServerConfig() -> ServerConfig? {
        guard let data = UserDefaults.standard.data(forKey: serverConfigKey) else { return nil }
        return try? JSONDecoder().decode(ServerConfig.self, from: data)
    }

    private static func saveServerConfig(_ config: ServerConfig) {
        if let data = try? JSONEncoder().encode(config) {
            UserDefaults.standard.set(data, forKey: serverConfigKey)
        }
    }
}

// MARK: - (AuthProviders removed — use AuthMeResponse.Providers)
