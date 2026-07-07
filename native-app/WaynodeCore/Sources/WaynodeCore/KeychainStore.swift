import Foundation
import Security

// MARK: - KeychainStore
//
// Thin wrapper over the iOS/macOS Keychain Services API for persisting the
// Waynode API token and server URL. The token is the single credential the
// app needs (Bearer `wn_...`). We store it in a generic password item
// scoped to the app's access group (when present) so it survives reinstall
// only when explicitly backed up.

public struct KeychainStore: Sendable {
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
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let accessGroup = Self.accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
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

        var attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if let accessGroup = Self.accessGroup {
            attributes[kSecAttrAccessGroup as String] = accessGroup
        }

        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.unhandledStatus(status)
        }
    }

    private func delete() {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup = Self.accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        SecItemDelete(query as CFDictionary)
    }

    /// Access group is set via Info.plist key-chain-sharing when present.
    /// On simulator without a group, this is nil.
    private static let accessGroup: String? = {
        // Apps without keychain sharing leave this nil; we read it from
        // the bundle at runtime if available.
        Bundle.main.object(forInfoDictionaryKey: "WaynodeKeychainAccessGroup") as? String
    }()

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
