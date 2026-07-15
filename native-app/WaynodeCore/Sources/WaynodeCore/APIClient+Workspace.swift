import Foundation

extension APIClient {
    // MARK: - Git

    public func getGitSnapshot(_ spaceId: String) async throws -> GitSnapshot {
        try await request("/api/spaces/\(spaceId)/git")
    }

    public func getGitDiff(_ spaceId: String, file: String? = nil) async throws -> GitDiffResponse {
        var query: [URLQueryItem] = []
        if let file { query.append(.init(name: "path", value: file)) }
        return try await request("/api/spaces/\(spaceId)/git/diff", query: query)
    }

    public struct CommitBody: Encodable, Sendable {
        public var summary: String
        public var description: String?
        public var files: [String]
        public init(summary: String, description: String? = nil, files: [String]) {
            self.summary = summary; self.description = description; self.files = files
        }
    }

    public struct CommitResponse: Decodable, Sendable {
        public var ok: Bool
        public var error: String?
        public var commit: String?
    }

    public func commitFiles(_ spaceId: String, message: String, files: [String]) async throws -> CommitResponse {
        try await request("/api/spaces/\(spaceId)/git/commit", method: "POST",
                          body: CommitBody(summary: message, description: nil, files: files))
    }

    private struct DiscardFileBody: Encodable, Sendable {
        var path: String
        var confirmation = "DISCARD TRACKED FILE"
    }

    private struct GitMutationResponse: Decodable, Sendable {
        var ok: Bool
        var data: GitSnapshot
    }

    public func discardTrackedFile(_ spaceId: String, path: String) async throws -> GitSnapshot {
        let response: GitMutationResponse = try await request(
            "/api/spaces/\(spaceId)/git/discard-file", method: "POST",
            body: DiscardFileBody(path: path)
        )
        return response.data
    }

    public struct SwitchBranchBody: Encodable, Sendable {
        public var branchName: String
        public var mode: String // "stash" | "carry" | "clean"
        public init(branchName: String, mode: String) { self.branchName = branchName; self.mode = mode }
    }

    public func switchBranch(_ spaceId: String, branch: String, mode: String = "stash") async throws {
        struct Resp: Decodable { let ok: Bool; let error: String? }
        let r: Resp = try await request("/api/spaces/\(spaceId)/git/switch-branch", method: "POST",
                                        body: SwitchBranchBody(branchName: branch, mode: mode))
        if !r.ok { throw APIError(statusCode: 409, message: r.error ?? "Failed to switch branch") }
    }

    public func createBranch(_ spaceId: String, name: String) async throws {
        struct Body: Encodable { let branchName: String }
        struct Resp: Decodable { let ok: Bool; let error: String? }
        let r: Resp = try await request("/api/spaces/\(spaceId)/git/create-branch", method: "POST",
                                        body: Body(branchName: name))
        if !r.ok { throw APIError(statusCode: 409, message: r.error ?? "Failed to create branch") }
    }

    public func pullBranch(_ spaceId: String) async throws {
        struct Resp: Decodable { let ok: Bool; let error: String? }
        let r: Resp = try await request("/api/spaces/\(spaceId)/git/pull", method: "POST")
        if !r.ok { throw APIError(statusCode: 409, message: r.error ?? "Pull failed") }
    }

    public func pushBranch(_ spaceId: String, setUpstream: Bool = true) async throws {
        struct Body: Encodable { let setUpstream: Bool }
        struct Resp: Decodable { let ok: Bool; let error: String? }
        let r: Resp = try await request("/api/spaces/\(spaceId)/git/push", method: "POST",
                                        body: Body(setUpstream: setUpstream))
        if !r.ok { throw APIError(statusCode: 409, message: r.error ?? "Push failed") }
    }

    // MARK: - Tokens

    public struct TokenInfo: Codable, Identifiable, Sendable, Hashable {
        public var id: String
        public var label: String
        public var lastUsedAt: String?
        public var createdAt: String

        // Server returns DB rows with snake_case columns (last_used_at,
        // created_at). Explicit CodingKeys handle the mapping since we
        // can't use .convertFromSnakeCase (it conflicts with other models
        // that declare snake_case CodingKey rawValues).
        enum CodingKeys: String, CodingKey {
            case id, label
            case lastUsedAt = "last_used_at"
            case createdAt = "created_at"
        }
    }

    public struct CreateTokenResponse: Decodable, Sendable {
        public var id: String
        public var token: String // raw token — shown once
        public var label: String
    }

    private struct TokenListResponse: Decodable, Sendable {
        let tokens: [TokenInfo]
    }

    public func listTokens() async throws -> [TokenInfo] {
        let resp: TokenListResponse = try await request("/api/tokens")
        return resp.tokens
    }

    public func createToken(label: String) async throws -> CreateTokenResponse {
        struct Body: Encodable { let label: String }
        return try await request("/api/tokens", method: "POST", body: Body(label: label))
    }

    public func revokeToken(id: String) async throws {
        try await requestVoid("/api/tokens/\(id)", method: "DELETE")
    }

    // MARK: - Hosted billing

    public struct BillingEnabledResponse: Decodable, Sendable {
        public let enabled: Bool
        public let deployment: String?
    }

    public struct BillingInfo: Decodable, Sendable {
        public let plan: String
        public let status: String
        public let currentPeriodEnd: String?

        enum CodingKeys: String, CodingKey {
            case plan, status
            case currentPeriodEnd = "current_period_end"
        }
    }

    private struct CheckoutResponse: Decodable, Sendable { let url: URL }

    public func billingCapability() async throws -> BillingCapabilityState {
        let response: BillingEnabledResponse = try await request("/api/billing/enabled")
        return BillingCapabilityState(deployment: response.deployment)
    }

    public func billing(orgId: String) async throws -> BillingInfo {
        try await request("/api/orgs/\(orgId)/billing")
    }

    public func startCheckout(orgId: String, plan: String) async throws -> URL {
        struct Body: Encodable, Sendable { let plan: String }
        let response: CheckoutResponse = try await request(
            "/api/orgs/\(orgId)/billing/checkout", method: "POST", body: Body(plan: plan)
        )
        return response.url
    }

    public func openBillingPortal(orgId: String) async throws -> URL {
        let response: CheckoutResponse = try await request(
            "/api/orgs/\(orgId)/billing/portal", method: "POST"
        )
        return response.url
    }

    // MARK: - Models

    public func listModels() async throws -> ModelsResponse {
        try await request("/api/models")
    }

    // MARK: - Repos (GitHub / GitLab browse)

    public func listGithubRepos() async throws -> [RepoGroup] {
        try await request("/api/repos/github")
    }

    public func listGitlabRepos() async throws -> [RepoGroup] {
        try await request("/api/repos/gitlab")
    }
}
