import Foundation

public protocol NativeAuthAPI: Sendable {
    func authMe() async throws -> AuthMeResponse
    func revokeCurrentToken() async throws
}

extension APIClient: NativeAuthAPI {
    public func revokeCurrentToken() async throws {
        try await requestVoid("/api/auth/native-token", method: "DELETE")
    }
}
