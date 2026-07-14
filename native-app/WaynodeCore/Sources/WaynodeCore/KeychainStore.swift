import Foundation
import Security

public protocol CredentialStore: Sendable {
    func readToken() -> String?
    func writeToken(_ token: String) throws
    func deleteToken()
}

// MARK: - KeychainStore
//
// Thin wrapper over the iOS/macOS Keychain Services API for persisting the
// Waynode API token and server URL. The token is the single credential the
// app needs (Bearer `wn_...`). We store it in a generic password item
// in the app's default, code-signing-derived keychain namespace. Waynode does
// not share credentials with another app or extension.

public struct KeychainStore: CredentialStore {
    public let service: String
    public let account: String

    public init(service: String = "com.waynode.app", account: String = "default") {
        self.service = service
        self.account = account
    }

    // MARK: - Read

    public func readToken() -> String? {
        read()
    }

    // MARK: - Write

    public func writeToken(_ token: String) throws {
        try write(token)
    }

    // MARK: - Delete

    public func deleteToken() {
        delete()
    }

    // MARK: - Core operations

    private func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        #if DEBUG
        print("Waynode diagnostics: keychain read status \(status)")
        #endif
        guard status == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8) else {
            return nil
        }
        return token
    }

    private func write(_ token: String) throws {
        let data = Data(token.utf8)
        delete() // Always overwrite

        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(attributes as CFDictionary, nil)
        #if DEBUG
        print("Waynode diagnostics: keychain write status \(status)")
        #endif
        guard status == errSecSuccess else {
            throw KeychainError.unhandledStatus(status)
        }
    }

    private func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    public enum KeychainError: Error, LocalizedError {
        case unhandledStatus(OSStatus)
        case invalidData

        public var errorDescription: String? {
            switch self {
            case .unhandledStatus(let s): return "Keychain error: \(s)"
            case .invalidData: return "Invalid keychain data"
            }
        }
    }
}
