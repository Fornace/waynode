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
        enum CodingKeys: String, CodingKey {
            case prompt
            case isGoal = "isGoal"
            case submissionId = "submissionId"
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
