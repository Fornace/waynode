import Foundation
import Security

public protocol CredentialStore: Sendable {
    func readToken(for serverOrigin: String) -> String?
    func writeToken(_ token: String, for serverOrigin: String) throws
    func deleteToken(for serverOrigin: String)
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

    public init(service: String = "com.waynode.app") {
        self.service = service
    }

    // MARK: - Read

    public func readToken(for serverOrigin: String) -> String? {
        if let token = read(account: serverOrigin) { return token }
        guard serverOrigin == Self.productionOrigin,
              let legacyToken = read(account: Self.legacyAccount) else { return nil }
        // The pre-scoping app stored one token under "default". It is safe to
        // migrate that item only to the historical production origin.
        if (try? write(legacyToken, account: serverOrigin)) != nil {
            delete(account: Self.legacyAccount)
        }
        return legacyToken
    }

    // MARK: - Write

    public func writeToken(_ token: String, for serverOrigin: String) throws {
        try write(token, account: serverOrigin)
        if serverOrigin == Self.productionOrigin { delete(account: Self.legacyAccount) }
    }

    // MARK: - Delete

    public func deleteToken(for serverOrigin: String) {
        delete(account: serverOrigin)
        if serverOrigin == Self.productionOrigin { delete(account: Self.legacyAccount) }
    }

    // MARK: - Core operations

    private static let productionOrigin = "https://waynode.fornace.net"
    private static let legacyAccount = "default"

    private func read(account: String) -> String? {
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

    private func write(_ token: String, account: String) throws {
        let data = Data(token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else {
            throw KeychainError.unhandledStatus(status)
        }

        let attributes: [String: Any] = query.merging([
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]) { _, new in new }
        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        #if DEBUG
        print("Waynode diagnostics: keychain write status \(addStatus)")
        #endif
        guard addStatus == errSecSuccess else {
            throw KeychainError.unhandledStatus(addStatus)
        }
    }

    private func delete(account: String) {
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
