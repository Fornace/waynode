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

    public var credentialScope: String {
        Self.canonicalOrigin(for: baseURL) ?? baseURL.absoluteString
    }

    public static func validatedBaseURL(from value: String) -> URL? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              scheme == "https" || (scheme == "http" && isLoopback(host)) else { return nil }
        components.scheme = scheme
        components.host = host
        if (scheme == "https" && components.port == 443)
            || (scheme == "http" && components.port == 80) {
            components.port = nil
        }
        if components.path == "/" { components.path = "" }
        while components.path.count > 1 && components.path.hasSuffix("/") {
            components.path.removeLast()
        }
        return components.url
    }

    public static func canonicalOrigin(for url: URL) -> String? {
        guard let source = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = source.scheme?.lowercased(),
              let host = source.host?.lowercased(),
              !host.isEmpty else { return nil }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        if !((scheme == "https" && source.port == 443) || (scheme == "http" && source.port == 80)) {
            origin.port = source.port
        }
        return origin.string
    }

    private static func isLoopback(_ host: String) -> Bool {
        host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
    }

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
    public private(set) var terminalCapability: TerminalCapabilityState = .checking
    public private(set) var isLoading: Bool = false
    public private(set) var hasRecoverableVerificationFailure = false
    public var error: String?

    /// True once the initial launch-time token verification has settled
    /// (success or failure). RootView uses this to show a launch splash
    /// instead of flashing AuthView while a returning user's token is
    /// being validated.
    public private(set) var hasCompletedLaunchCheck: Bool = false

    /// Transient token returned from ASWebAuthenticationSession. Set during
    /// the auth callback, then persisted to Keychain after verification.
    public var pendingToken: String?

    public let keychain: any CredentialStore
    private let authAPIOverride: (any NativeAuthAPI)?

    public init(
        serverConfig: ServerConfig? = nil,
        keychain: any CredentialStore = KeychainStore(),
        authAPI: (any NativeAuthAPI)? = nil
    ) {
        self.keychain = keychain
        self.authAPIOverride = authAPI
        // Load persisted config.
        if let config = serverConfig {
            self.serverConfig = config
        } else if let config = Self.loadServerConfig() {
            self.serverConfig = config
        } else {
            self.serverConfig = .default
        }
        // Load persisted token.
        self.token = keychain.readToken(for: self.serverConfig.credentialScope)
    }

    // MARK: - Properties

    public var isAuthenticated: Bool { token != nil && user != nil }
    public var apiBaseURL: URL { serverConfig.baseURL.appendingPathComponent("api") }

    /// Auth callback URL scheme for ASWebAuthenticationSession.
    public nonisolated static let callbackScheme = "waynode"

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
            hasRecoverableVerificationFailure = false
            hasCompletedLaunchCheck = true
            return
        }
        isLoading = true
        hasRecoverableVerificationFailure = false
        error = nil
        let api = makeAuthAPI(token: token)
        do {
            let resp = try await api.authMe()
            guard let user = resp.user else {
                throw APIClient.APIError(statusCode: -1, message: "Server returned no user")
            }
            self.user = user
            self.providers = resp.providers
            terminalCapability = .init(serverValue: resp.capabilities?.terminal)
        } catch let apiError as APIClient.APIError where apiError.statusCode == 401 {
            clearLocalAuthentication(message: "Session expired. Please log in again.")
        } catch {
            user = nil
            terminalCapability = .unavailable
            hasRecoverableVerificationFailure = true
            self.error = "Couldn't verify your saved session. Check the connection and retry."
        }
        isLoading = false
        hasCompletedLaunchCheck = true
    }

    // MARK: - Complete auth flow (from ASWebAuthenticationSession callback)

    /// Called when the OAuth callback redirects `waynode://auth?token=wn_...`.
    /// Persists the token and fetches the user profile.
    public func completeAuth(token: String) async {
        isLoading = true
        error = nil
        let api = makeAuthAPI(token: token)
        do {
            let resp = try await api.authMe()
            guard let user = resp.user else {
                throw APIClient.APIError(statusCode: -1, message: "Server returned no user")
            }
            // Token is valid — persist it.
            try keychain.writeToken(token, for: serverConfig.credentialScope)
            self.token = token
            self.user = user
            self.providers = resp.providers
            terminalCapability = .init(serverValue: resp.capabilities?.terminal)
            hasRecoverableVerificationFailure = false
            isLoading = false
        } catch {
            self.error = "Login failed: \(error.localizedDescription)"
            isLoading = false
        }
    }

    // MARK: - Logout

    /// Update discovered providers (used by login screen before auth).
    public func setProviders(_ newProviders: AuthMeResponse.Providers?, capabilities: AuthMeResponse.Capabilities? = nil) {
        providers = newProviders
        terminalCapability = .init(serverValue: capabilities?.terminal)
    }

    public func markServerCapabilitiesUnavailable() {
        terminalCapability = .unavailable
    }

    public func logout() {
        clearLocalAuthentication()
    }

    public func logoutRevokingCurrentToken() async {
        guard let token else {
            logout()
            return
        }
        isLoading = true
        var warning: String?
        do {
            try await makeAuthAPI(token: token, forLogout: true).revokeCurrentToken()
        } catch let apiError as APIClient.APIError where apiError.statusCode == 401 {
            // The credential is already invalid, which is equivalent to revocation.
        } catch {
            warning = "Signed out on this device. The server couldn't be reached to revoke its token."
        }
        clearLocalAuthentication(message: warning)
    }

    private func clearLocalAuthentication(message: String? = nil) {
        token = nil
        user = nil
        providers = nil
        terminalCapability = .checking
        error = message
        pendingToken = nil
        isLoading = false
        hasRecoverableVerificationFailure = false
        hasCompletedLaunchCheck = true
        keychain.deleteToken(for: serverConfig.credentialScope)
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
        self.hasRecoverableVerificationFailure = false
        self.hasCompletedLaunchCheck = true
    }

    #if DEBUG
    /// Installs an in-memory identity for deterministic native UI tests.
    public func installUITestUser() {
        token = "ui-test-token"
        user = User(id: "ui-user", name: "Waynode Tester", email: "tester@example.test", role: "owner")
        providers = .init(github: true, gitlab: true, dev: true)
        terminalCapability = .supported
        error = nil
        isLoading = false
        hasRecoverableVerificationFailure = false
        hasCompletedLaunchCheck = true
    }
    #endif

    // MARK: - Change server

    /// Changes the persisted server during launch/setup. Interactive changes
    /// must use `changeServerURL` so a live token is revoked against its old
    /// origin before any client is configured for the new one.
    public func setServerURL(_ url: URL) {
        let nextConfig = ServerConfig(baseURL: url)
        if nextConfig.credentialScope != serverConfig.credentialScope {
            token = nil
            user = nil
            providers = nil
            terminalCapability = .checking
            pendingToken = nil
            error = nil
        }
        serverConfig = nextConfig
        Self.saveServerConfig(serverConfig)
        token = keychain.readToken(for: serverConfig.credentialScope)
        hasRecoverableVerificationFailure = false
        hasCompletedLaunchCheck = token == nil
    }

    public func changeServerURL(_ url: URL) async {
        let nextConfig = ServerConfig(baseURL: url)
        guard nextConfig != serverConfig else { return }
        if token != nil {
            await logoutRevokingCurrentToken()
        } else {
            clearLocalAuthentication()
        }
        setServerURL(url)
        if token != nil { await verifyToken() }
    }

    // MARK: - Persistence (UserDefaults for config, Keychain for token)

    private static let serverConfigKey = "waynode.serverConfig"
    private static let nativeAuthAttemptKey = "waynode.nativeAuthAttempt"

    private func makeAuthAPI(token: String, forLogout: Bool = false) -> any NativeAuthAPI {
        if let authAPIOverride { return authAPIOverride }
        return APIClient(
            baseURL: serverConfig.baseURL,
            token: token,
            requestTimeout: forLogout ? 5 : 30,
            waitsForConnectivity: !forLogout
        )
    }

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
