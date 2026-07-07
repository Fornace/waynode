import Foundation

// MARK: - APIClient
//
// Thin async/await wrapper over URLSession for the Waynode REST API.
// All requests carry the Bearer token (when present) in the Authorization
// header. A 401 response triggers a delegate callback so the UI can return
// to the auth flow.

public actor APIClient {
    public nonisolated let baseURL: URL
    private let session: URLSession
    private var token: String?

    /// Called when a request receives 401 Unauthorized. The UI observes this
    /// to present the auth flow and clear the stored token.
    public let onUnauthorized: AsyncStream<Void>.Continuation
    private let onUnauthorizedStream: AsyncStream<Void>

    public init(baseURL: URL, token: String? = nil) {
        self.baseURL = baseURL
        self.token = token
        var (stream, cont) = AsyncStream.makeStream(of: Void.self)
        self.onUnauthorizedStream = stream
        self.onUnauthorized = cont
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config)
    }

    public func setToken(_ newToken: String?) {
        token = newToken
    }

    /// Read-only access to the current bearer token (for SSE/WS URLs).
    public func currentToken() -> String? { token }

    public nonisolated func makeURL(_ path: String) -> URL {
        baseURL.appendingPathComponent(path)
    }

    // MARK: - Core request

    public struct APIError: Error, LocalizedError, Sendable {
        public let statusCode: Int
        public let message: String
        public var errorDescription: String? { message }
        public init(statusCode: Int, message: String) {
            self.statusCode = statusCode; self.message = message
        }
    }

    private func request<T: Decodable & Sendable>(
        _ path: String,
        method: String = "GET",
        body: (some Encodable & Sendable)? = nil as EmptyBody?,
        query: [URLQueryItem] = []
    ) async throws -> T {
        let data = try await rawData(path, method: method, body: body, query: query)
        do {
            return try JSONDecoder.api.decode(T.self, from: data)
        } catch {
            throw APIError(statusCode: -1, message: "Decoding failed: \(error)")
        }
    }

    /// Fire-and-forget request returning void (checks for errors only).
    private func requestVoid(
        _ path: String,
        method: String,
        body: (some Encodable & Sendable)? = nil as EmptyBody?,
        query: [URLQueryItem] = []
    ) async throws {
        _ = try await rawData(path, method: method, body: body, query: query)
    }

    private func rawData(
        _ path: String,
        method: String,
        body: (some Encodable & Sendable)? = nil as EmptyBody?,
        query: [URLQueryItem]
    ) async throws -> Data {
        var components = URLComponents(url: makeURL(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }

        var req = URLRequest(url: components.url ?? makeURL(path))
        req.httpMethod = method
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        if !(body is EmptyBody) {
            req.httpBody = try JSONEncoder.api.encode(AnyEncodable(body))
        }

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(statusCode: -1, message: "Invalid response")
        }

        if http.statusCode == 401 {
            onUnauthorized.yield()
            throw APIError(statusCode: 401, message: "Unauthorized")
        }
        if !(200...299).contains(http.statusCode) {
            let msg = (try? JSONDecoder.api.decode(ErrorBody.self, from: data))?.error
                ?? String(data: data, encoding: .utf8)
                ?? "HTTP \(http.statusCode)"
            throw APIError(statusCode: http.statusCode, message: msg)
        }
        return data
    }

    private struct ErrorBody: Decodable { let error: String }
    private struct EmptyBody: Encodable, Sendable {}

    // MARK: - Auth

    public func authMe() async throws -> AuthMeResponse {
        try await request("/api/auth/me")
    }

    // MARK: - Orgs

    public func listOrgs() async throws -> [Org] {
        try await request("/api/orgs")
    }

    // MARK: - Spaces

    public func listSpaces() async throws -> [Space] {
        try await request("/api/spaces")
    }

    public func getSpace(_ id: String) async throws -> Space {
        try await request("/api/spaces/\(id)")
    }

    public struct CreateSpaceBody: Encodable, Sendable {
        public var repoUrl: String
        public var branch: String?
        public var orgId: String?
        public init(repoUrl: String, branch: String? = nil, orgId: String? = nil) {
            self.repoUrl = repoUrl; self.branch = branch; self.orgId = orgId
        }
    }

    public func createSpace(_ body: CreateSpaceBody) async throws -> Space {
        try await request("/api/spaces", method: "POST", body: body)
    }

    // MARK: - Clone progress streaming

    /// A single clone progress event from the server's clone-events SSE.
    public enum CloneEvent: Sendable, Equatable {
        /// A git clone --progress line (e.g. "remote: Counting objects: 100% ...").
        case progress(String)
        /// Clone finished successfully.
        case done
        /// Clone failed.
        case error(String)
    }

    /// Stream live clone progress for a space. The server's clone-events SSE
    /// replays buffered lines + terminal state (done/error), then streams live
    /// until the clone settles. If the clone already finished and the in-memory
    /// registry entry was cleaned up, the stream simply finishes with no events.
    public func streamCloneProgress(spaceId: String) -> AsyncThrowingStream<CloneEvent, Error> {
        let tok = self.token
        let url = baseURL.appendingPathComponent("/api/spaces/\(spaceId)/clone-events")

        return AsyncThrowingStream { continuation in
            let task = Task {
                var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
                if let tok {
                    components.queryItems = [URLQueryItem(name: "t", value: tok)]
                }
                var req = URLRequest(url: components.url ?? url)
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")

                do {
                    let cfg = URLSessionConfiguration.ephemeral
                    cfg.timeoutIntervalForRequest = 120
                    cfg.waitsForConnectivity = true
                    let session = URLSession(configuration: cfg)

                    let (bytes, response) = try await session.bytes(for: req)
                    guard let http = response as? HTTPURLResponse else {
                        throw URLError(.badServerResponse)
                    }
                    guard (200...299).contains(http.statusCode) else {
                        throw URLError(.badServerResponse)
                    }

                    var buffer = ""
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        if line.isEmpty {
                            if !buffer.isEmpty {
                                if let event = Self.parseCloneEvent(buffer) {
                                    continuation.yield(event)
                                }
                                buffer = ""
                            }
                            continue
                        }
                        buffer += line + "\n"
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Parse one SSE event buffer into a CloneEvent (or nil for pings/unknown).
    private static func parseCloneEvent(_ buffer: String) -> CloneEvent? {
        var dataLines: [String] = []
        for line in buffer.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("data:") {
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                dataLines.append(String(payload))
            }
        }
        guard !dataLines.isEmpty else { return nil }
        let json = dataLines.joined(separator: "\n")
        guard let data = json.data(using: .utf8) else { return nil }

        struct Payload: Decodable {
            let type: String
            let line: String?
            let error: String?
        }
        guard let payload = try? JSONDecoder().decode(Payload.self, from: data) else { return nil }
        switch payload.type {
        case "progress": return .progress(payload.line ?? "")
        case "done": return .done
        case "error": return .error(payload.error ?? "Clone failed")
        default: return nil  // ping, unknown
        }
    }

    public func deleteSpace(_ id: String) async throws {
        try await requestVoid("/api/spaces/\(id)", method: "DELETE")
    }

    public func pullSpace(_ id: String) async throws {
        try await requestVoid("/api/spaces/\(id)/pull", method: "POST")
    }

    // MARK: - Sessions

    public func listSessions(spaceId: String) async throws -> [Session] {
        try await request("/api/spaces/\(spaceId)/sessions")
    }

    public struct CreateSessionBody: Encodable, Sendable {
        public var title: String?
        public init(title: String? = nil) { self.title = title }
    }

    public func createSession(spaceId: String, title: String? = nil) async throws -> Session {
        try await request("/api/spaces/\(spaceId)/sessions", method: "POST",
                          body: CreateSessionBody(title: title))
    }

    public func getSession(_ id: String) async throws -> Session {
        try await request("/api/sessions/\(id)")
    }

    public func patchSession(_ id: String, title: String? = nil, archived: Bool? = nil) async throws -> Session {
        struct Body: Encodable {
            let title: String?
            let archived: Bool?
        }
        return try await request("/api/sessions/\(id)", method: "PATCH",
                                 body: Body(title: title, archived: archived))
    }

    public func deleteSession(_ id: String) async throws {
        try await requestVoid("/api/sessions/\(id)", method: "DELETE")
    }

    public func archiveSession(_ id: String) async throws {
        try await requestVoid("/api/sessions/\(id)/archive", method: "POST")
    }

    public func setSessionModel(_ id: String, model: String) async throws {
        struct Body: Encodable { let model: String }
        try await requestVoid("/api/sessions/\(id)/model", method: "POST", body: Body(model: model))
    }

    // MARK: - Messages (history + send)

    /// History response — the server returns a JSON array of message objects.
    public struct HistoryMessage: Decodable, Sendable {
        public var role: String
        public var id: String?
        public var content: String?
        public var isGoal: Bool?
        public var text: String?
        public var thinking: String?
        public var key: String?
    }

    public func getMessages(_ sessionId: String) async throws -> [HistoryMessage] {
        try await request("/api/sessions/\(sessionId)/messages")
    }

    public struct SendMessageBody: Encodable, Sendable {
        public var prompt: String
        public var isGoal: Bool
        public init(prompt: String, isGoal: Bool = false) {
            self.prompt = prompt; self.isGoal = isGoal
        }
    }

    public struct OkResponse: Decodable, Sendable {
        public var ok: Bool
        public var queued: Bool?
    }

    public func sendMessage(_ sessionId: String, prompt: String, isGoal: Bool = false) async throws -> OkResponse {
        try await request("/api/sessions/\(sessionId)/message", method: "POST",
                          body: SendMessageBody(prompt: prompt, isGoal: isGoal))
    }

    /// Queue a follow-up while a turn is running (409 → queue).
    public func queueMessage(_ sessionId: String, prompt: String) async throws -> OkResponse {
        try await request("/api/sessions/\(sessionId)/queue", method: "POST",
                          body: SendMessageBody(prompt: prompt, isGoal: false))
    }

    public func abortTurn(_ sessionId: String) async throws {
        try await requestVoid("/api/sessions/\(sessionId)/abort", method: "POST")
    }

    public struct StateResponse: Decodable, Sendable {
        public var active: Bool
        public var done: Bool
    }

    public func getSessionState(_ sessionId: String) async throws -> StateResponse {
        try await request("/api/sessions/\(sessionId)/state")
    }

    public func getGoalStatus(_ sessionId: String) async throws -> GoalStatus {
        struct Wrapper: Decodable { let goal: GoalStatus? }
        let w: Wrapper = try await request("/api/sessions/\(sessionId)/goal")
        return w.goal ?? GoalStatus()
    }

    // MARK: - Git

    public func getGitSnapshot(_ spaceId: String) async throws -> GitSnapshot {
        try await request("/api/spaces/\(spaceId)/git")
    }

    public func getGitDiff(_ spaceId: String, file: String? = nil) async throws -> GitDiffResponse {
        var query: [URLQueryItem] = []
        if let file { query.append(.init(name: "file", value: file)) }
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

    public func pushBranch(_ spaceId: String) async throws {
        struct Resp: Decodable { let ok: Bool; let error: String? }
        let r: Resp = try await request("/api/spaces/\(spaceId)/git/push", method: "POST")
        if !r.ok { throw APIError(statusCode: 409, message: r.error ?? "Push failed") }
    }

    // MARK: - Tokens

    public struct TokenInfo: Codable, Identifiable, Sendable, Hashable {
        public var id: String
        public var label: String
        public var lastUsedAt: String?
        public var createdAt: String
    }

    public struct CreateTokenResponse: Decodable, Sendable {
        public var id: String
        public var token: String // raw token — shown once
        public var label: String
    }

    public func listTokens() async throws -> [TokenInfo] {
        try await request("/api/tokens")
    }

    public func createToken(label: String) async throws -> CreateTokenResponse {
        struct Body: Encodable { let label: String }
        return try await request("/api/tokens", method: "POST", body: Body(label: label))
    }

    public func revokeToken(id: String) async throws {
        try await requestVoid("/api/tokens/\(id)", method: "DELETE")
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

// MARK: - Git types (from getSnapshot)

public struct GitSnapshot: Decodable, Hashable, Sendable {
    public var currentBranch: String
    public var detached: Bool
    public var upstream: String?
    public var ahead: Int
    public var behind: Int
    public var hasUncommittedChanges: Bool
    public var files: [GitFile]
    public var commits: [GitCommit]
    public var branches: [GitBranch]
    public var defaultBranch: String

    enum CodingKeys: String, CodingKey {
        case currentBranch, detached, upstream, ahead, behind
        case hasUncommittedChanges, files, commits, branches, defaultBranch
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        currentBranch = try c.decodeIfPresent(String.self, forKey: .currentBranch) ?? ""
        detached = try c.decodeIfPresent(Bool.self, forKey: .detached) ?? false
        upstream = try c.decodeIfPresent(String.self, forKey: .upstream)
        ahead = try c.decodeIfPresent(Int.self, forKey: .ahead) ?? 0
        behind = try c.decodeIfPresent(Int.self, forKey: .behind) ?? 0
        hasUncommittedChanges = try c.decodeIfPresent(Bool.self, forKey: .hasUncommittedChanges) ?? false
        files = try c.decodeIfPresent([GitFile].self, forKey: .files) ?? []
        commits = try c.decodeIfPresent([GitCommit].self, forKey: .commits) ?? []
        branches = try c.decodeIfPresent([GitBranch].self, forKey: .branches) ?? []
        defaultBranch = try c.decodeIfPresent(String.self, forKey: .defaultBranch) ?? "main"
    }
}

public struct GitFile: Decodable, Hashable, Identifiable, Sendable {
    public var id: String { path }
    public var path: String
    public var status: String // M, A, D, untracked, modified, ...
    public var staged: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decodeIfPresent(String.self, forKey: .path) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        // Server sends `staged` as a String (e.g. "M", " ", "untracked",
        // "conflict") — the X field of `git status --porcelain`. Convert to
        // Bool: non-empty and non-space means staged.
        if let s = try? c.decodeIfPresent(String.self, forKey: .staged) {
            staged = !s.isEmpty && s != " "
        } else {
            staged = (try? c.decodeIfPresent(Bool.self, forKey: .staged)) ?? false
        }
    }

    enum CodingKeys: String, CodingKey { case path, status, staged }
}

public struct GitCommit: Decodable, Hashable, Identifiable, Sendable {
    public var id: String { hash }
    public var hash: String
    public var message: String
    public var author: String
    public var date: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hash = try c.decodeIfPresent(String.self, forKey: .hash) ?? ""
        // Server sends `subject` (the git log %s field), not `message`.
        message = try c.decodeIfPresent(String.self, forKey: .message)
            ?? c.decodeIfPresent(String.self, forKey: .subject) ?? ""
        author = try c.decodeIfPresent(String.self, forKey: .author) ?? ""
        date = try c.decodeIfPresent(String.self, forKey: .date) ?? ""
    }

    enum CodingKeys: String, CodingKey { case hash, message, subject, author, date }
}

public struct GitBranch: Decodable, Hashable, Identifiable, Sendable {
    public var id: String { name }
    public var name: String
    public var current: Bool
    public var isDefault: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        // Server doesn't send `current`; it's derived by the caller by
        // comparing branch.name to snapshot.currentBranch. Default false.
        current = (try? c.decodeIfPresent(Bool.self, forKey: .current)) ?? false
        isDefault = (try? c.decodeIfPresent(Bool.self, forKey: .isDefault)) ?? false
    }

    enum CodingKeys: String, CodingKey { case name, current, isDefault }
}

public struct GitDiffResponse: Decodable, Sendable {
    public var diff: String
    public var error: String?
}

// MARK: - JSON helpers

extension JSONEncoder {
    static let api: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()
}

extension JSONDecoder {
    static let api: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()
}

/// Type-erased Encodable wrapper for sending generic bodies.
private struct AnyEncodable: Encodable {
    private let _encode: (Encoder) throws -> Void
    init(_ wrapped: some Encodable) {
        _encode = wrapped.encode
    }
    func encode(to encoder: Encoder) throws { try _encode(encoder) }
}
