import Foundation

public protocol SessionTransport: Sendable {
    nonisolated func makeURL(_ path: String) -> URL
    func currentToken() async -> String?
    func getMessages(_ sessionId: String) async throws -> [APIClient.HistoryMessage]
    func getSession(_ id: String) async throws -> Session
    func getSessionState(_ sessionId: String) async throws -> APIClient.StateResponse
    func sendMessage(_ sessionId: String, prompt: String, isGoal: Bool, submissionId: String) async throws -> APIClient.OkResponse
    func queueMessage(_ sessionId: String, prompt: String, isGoal: Bool, submissionId: String) async throws -> APIClient.OkResponse
    func abortTurn(_ sessionId: String) async throws -> APIClient.AbortResponse
    func getGoalStatus(_ sessionId: String) async throws -> GoalStatus
    func uploadFiles(_ spaceId: String, files: [APIClient.UploadFile]) async throws -> APIClient.UploadResponse
}

public extension SessionTransport {
    func uploadFiles(_ spaceId: String, files: [APIClient.UploadFile]) async throws -> APIClient.UploadResponse {
        throw APIClient.APIError(statusCode: 501, message: "File attachments are unavailable")
    }
}

extension APIClient: SessionTransport {
    public struct HistoryMessage: Decodable, Sendable {
        public var role: String
        public var id: String?
        public var content: String?
        public var isGoal: Bool?
        public var text: String?
        public var thinking: String?
        public var key: String?
        public var timestamp: String?
    }

    public func getMessages(_ sessionId: String) async throws -> [HistoryMessage] {
        try await request("/api/sessions/\(sessionId)/messages")
    }

    public struct SendMessageBody: Encodable, Sendable {
        public var prompt: String
        public var isGoal: Bool
        public var submissionId: String

        public init(prompt: String, isGoal: Bool, submissionId: String) {
            self.prompt = prompt
            self.isGoal = isGoal
            self.submissionId = submissionId
        }

        /// Canonical submission mode the server prefers. The chat endpoints only ever
        /// carry `message`/`goal` (hammersmith has its own delegation endpoint).
        public var mode: String { isGoal ? "goal" : "message" }

        enum CodingKeys: String, CodingKey {
            case prompt
            case mode
            case isGoal
            case submissionId
        }

        // Send the canonical `mode` string (matching the web client and server
        // contract) and retain the legacy `isGoal` boolean so an older server that
        // predates the `mode` field still resolves goal turns instead of silently
        // downgrading them to a plain message.
        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(prompt, forKey: .prompt)
            try container.encode(mode, forKey: .mode)
            try container.encode(isGoal, forKey: .isGoal)
            try container.encode(submissionId, forKey: .submissionId)
        }
    }

    public struct OkResponse: Decodable, Sendable {
        public var ok: Bool
        public var queued: Bool?
        public var submission: Submission?
        public var duplicate: Bool?
    }

    public func sendMessage(
        _ sessionId: String, prompt: String, isGoal: Bool = false, submissionId: String
    ) async throws -> OkResponse {
        try await request(
            "/api/sessions/\(sessionId)/message", method: "POST",
            body: SendMessageBody(prompt: prompt, isGoal: isGoal, submissionId: submissionId)
        )
    }

    public func queueMessage(
        _ sessionId: String, prompt: String, isGoal: Bool = false, submissionId: String
    ) async throws -> OkResponse {
        try await request(
            "/api/sessions/\(sessionId)/queue", method: "POST",
            body: SendMessageBody(prompt: prompt, isGoal: isGoal, submissionId: submissionId)
        )
    }

    public struct AbortResponse: Decodable, Sendable {
        public var ok: Bool
        public var cancelled: Bool
        public var submissionId: String?
        public var reason: String?
    }

    public func abortTurn(_ sessionId: String) async throws -> AbortResponse {
        try await request("/api/sessions/\(sessionId)/abort", method: "POST")
    }

    public struct StateResponse: Decodable, Sendable {
        public var active: Bool
        public var done: Bool
        public var submissions: [Submission]
    }

    public func getSessionState(_ sessionId: String) async throws -> StateResponse {
        try await request("/api/sessions/\(sessionId)/state")
    }

    public func getGoalStatus(_ sessionId: String) async throws -> GoalStatus {
        struct Wrapper: Decodable { let goal: GoalStatus? }
        let wrapper: Wrapper = try await request("/api/sessions/\(sessionId)/goal")
        return wrapper.goal ?? GoalStatus()
    }
}
