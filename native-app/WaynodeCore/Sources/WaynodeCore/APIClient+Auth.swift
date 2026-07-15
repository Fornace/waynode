import Foundation

public struct AccountDeletionReauthResponse: Decodable, Sendable {
    public let authorizationURL: URL

    enum CodingKeys: String, CodingKey {
        case authorizationURL = "authorization_url"
    }
}

private struct AccountDeletionReauthRequest: Encodable, Sendable {
    let provider: String
    let nonce: String
}

private struct AccountDeletionRequest: Encodable, Sendable {
    let confirmation: String
    let deletionGrant: String
    let nativeNonce: String

    enum CodingKeys: String, CodingKey {
        case confirmation
        case deletionGrant = "deletion_grant"
        case nativeNonce = "native_nonce"
    }
}

public protocol NativeAuthAPI: Sendable {
    func authMe() async throws -> AuthMeResponse
    func revokeCurrentToken() async throws
}

extension APIClient: NativeAuthAPI {
    public func revokeCurrentToken() async throws {
        try await requestVoid("/api/auth/native-token", method: "DELETE")
    }

    public func beginAccountDeletionReauth(provider: String, nonce: String) async throws -> URL {
        let response: AccountDeletionReauthResponse = try await request(
            "/api/auth/account/deletion-reauth",
            method: "POST",
            body: AccountDeletionReauthRequest(provider: provider, nonce: nonce)
        )
        return response.authorizationURL
    }

    public func deleteAccount(grant: String, nonce: String) async throws {
        try await requestVoid(
            "/api/auth/account",
            method: "DELETE",
            body: AccountDeletionRequest(confirmation: "DELETE", deletionGrant: grant, nativeNonce: nonce)
        )
    }
}
