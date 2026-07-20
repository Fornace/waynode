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
    public let unauthorizedStream: AsyncStream<Void>

    public init(
        baseURL: URL,
        token: String? = nil,
        requestTimeout: TimeInterval = 30,
        waitsForConnectivity: Bool = true
    ) {
        self.baseURL = baseURL
        self.token = token
        let (stream, cont) = AsyncStream.makeStream(of: Void.self)
        self.unauthorizedStream = stream
        self.onUnauthorized = cont
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = requestTimeout
        config.waitsForConnectivity = waitsForConnectivity
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
        public let operationId: String?
        public var errorDescription: String? { message }
        public init(statusCode: Int, message: String, operationId: String? = nil) {
            self.statusCode = statusCode
            self.message = message
            self.operationId = operationId
        }
    }

    func request<T: Decodable & Sendable>(
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
    func requestVoid(
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
        // Guard instead of force-unwrapping: a malformed path could otherwise
        // crash the process. URLComponents(url:resolvingAgainstBaseURL:) is
        // effectively never nil for a URL(string:)-accepted URL, but a typed
        // error is the correct defensive posture.
        guard var components = URLComponents(url: makeURL(path), resolvingAgainstBaseURL: false) else {
            throw APIError(statusCode: -1, message: "Invalid request URL")
        }
        if !query.isEmpty { components.queryItems = query }

        var req = URLRequest(url: components.url ?? makeURL(path))
        req.httpMethod = method
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        // Never attach an HTTP body to GET/HEAD requests. Since iOS 13
        // (still true on iOS 27), URLSession rejects a GET with a body
        // with the misleading NSURLErrorResourceExceedsMaximumSize (-1103)
        // "resource exceeds maximum size" error. The `let encodable` guard
        // also correctly skips the nil-default case.
        if method != "GET" && method != "HEAD", let encodable = body {
            req.httpBody = try JSONEncoder.api.encode(AnyEncodable(encodable))
        }

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(statusCode: -1, message: "Invalid response")
        }
        let operationId = http.value(forHTTPHeaderField: "X-Waynode-Operation-Id")

        if http.statusCode == 401 {
            onUnauthorized.yield()
            throw APIError(statusCode: 401, message: "Unauthorized", operationId: operationId)
        }
        if !(200...299).contains(http.statusCode) {
            let msg = (try? JSONDecoder.api.decode(ErrorBody.self, from: data))?.error
                ?? String(data: data, encoding: .utf8)
                ?? "HTTP \(http.statusCode)"
            throw APIError(statusCode: http.statusCode, message: msg, operationId: operationId)
        }
        return data
    }

    private struct ErrorBody: Decodable { let error: String }
    struct EmptyBody: Encodable, Sendable {}

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

    /// Build the URLRequest for the clone-progress SSE. The token travels in
    /// the Authorization header (NOT the query string) to keep it out of proxy
    /// access logs — matching SSEClient's documented policy. The server's
    /// `sseAuth` middleware (routes/spaces.js) accepts the header via
    /// `requireAuth` → `resolveBearerUser` → `resolveApiToken` (verified in
    /// lib/auth.mjs), so the header works on the clone-events route and the
    /// query fallback is no longer needed. Pure (nonisolated) so it is
    /// unit-testable without a live URL session.
    public nonisolated func cloneProgressRequest(url: URL, token: String?) -> URLRequest {
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
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
                let req = cloneProgressRequest(url: url, token: tok)

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
    // NOTE: Do NOT use .convertFromSnakeCase here. All Codable models in
    // this project declare explicit CodingKeys with snake_case raw values
    // (e.g. repoName = "repo_name"). Adding .convertFromSnakeCase on top
    // converts JSON keys to camelCase BEFORE matching, so "repo_name" →
    // "repoName" which no longer matches the CodingKey rawValue "repo_name",
    // and every snake_case field silently decodes as nil/empty.
    static let api: JSONDecoder = JSONDecoder()
}

/// Type-erased Encodable wrapper for sending generic bodies.
private struct AnyEncodable: Encodable {
    private let _encode: (Encoder) throws -> Void
    init(_ wrapped: some Encodable) {
        _encode = wrapped.encode
    }
    func encode(to encoder: Encoder) throws { try _encode(encoder) }
}
