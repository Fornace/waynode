import Foundation
import Security

public enum NativeAccountDeletion {
    public static func makeNonce() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw CallbackError.randomnessUnavailable
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func grant(from callbackURL: URL, expectedNonce: String) throws -> String {
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              components.scheme == AuthStore.callbackScheme,
              components.host == "delete-account",
              value(named: "nonce", in: components) == expectedNonce else {
            throw CallbackError.invalidOrExpired
        }
        if let serverError = value(named: "error", in: components) {
            throw CallbackError.server(serverError)
        }
        guard let grant = value(named: "grant", in: components), grant.hasPrefix("wnd_") else {
            throw CallbackError.invalidOrExpired
        }
        return grant
    }

    private static func value(named name: String, in components: URLComponents) -> String? {
        components.queryItems?.first { $0.name == name }?.value
    }

    public enum CallbackError: LocalizedError, Equatable {
        case randomnessUnavailable
        case invalidOrExpired
        case server(String)

        public var errorDescription: String? {
            switch self {
            case .randomnessUnavailable:
                return "Waynode couldn't create a secure reauthentication request. Try again."
            case .invalidOrExpired:
                return "The account verification callback was invalid or expired. Start again."
            case .server(let code) where code == "identity_mismatch":
                return "That provider signed in to a different Waynode account. Your account was not deleted."
            case .server:
                return "Account verification did not complete. Your account was not deleted."
            }
        }
    }
}
