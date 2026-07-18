import Foundation

// MARK: - Hammersmith transport
//
// Protocol-extension defaults throw 501 (exactly like uploadFiles) so every
// existing SessionTransport test double keeps compiling unchanged. Dynamic
// dispatch goes through the HammersmithTransport sub-protocol: SessionStore
// holds `any SessionTransport`, so extension members alone would statically
// resolve to these defaults and never reach a concrete implementation.

public protocol HammersmithTransport: SessionTransport {
    func getHammersmithCapability() async throws -> HammersmithCapability
    func sendHammersmith(_ sessionId: String, prompt: String, submissionId: String) async throws -> HammersmithSendResponse
    func listHammersmithJobs(_ sessionId: String) async throws -> [HammersmithRun]
    func stopHammersmithJob(_ jobId: String) async throws -> HammersmithStopResponse
}

public extension HammersmithTransport {
    func getHammersmithCapability() async throws -> HammersmithCapability {
        throw APIClient.APIError(statusCode: 501, message: "Hammersmith is unavailable")
    }

    func sendHammersmith(
        _ sessionId: String, prompt: String, submissionId: String
    ) async throws -> HammersmithSendResponse {
        throw APIClient.APIError(statusCode: 501, message: "Hammersmith is unavailable")
    }

    func listHammersmithJobs(_ sessionId: String) async throws -> [HammersmithRun] {
        throw APIClient.APIError(statusCode: 501, message: "Hammersmith is unavailable")
    }

    func stopHammersmithJob(_ jobId: String) async throws -> HammersmithStopResponse {
        throw APIClient.APIError(statusCode: 501, message: "Hammersmith is unavailable")
    }
}

public extension SessionTransport {
    func getHammersmithCapability() async throws -> HammersmithCapability {
        throw APIClient.APIError(statusCode: 501, message: "Hammersmith is unavailable")
    }

    func sendHammersmith(
        _ sessionId: String, prompt: String, submissionId: String
    ) async throws -> HammersmithSendResponse {
        throw APIClient.APIError(statusCode: 501, message: "Hammersmith is unavailable")
    }

    func listHammersmithJobs(_ sessionId: String) async throws -> [HammersmithRun] {
        throw APIClient.APIError(statusCode: 501, message: "Hammersmith is unavailable")
    }

    func stopHammersmithJob(_ jobId: String) async throws -> HammersmithStopResponse {
        throw APIClient.APIError(statusCode: 501, message: "Hammersmith is unavailable")
    }
}

public struct HammersmithSendResponse: Decodable, Sendable {
    public var ok: Bool
    public var duplicate: Bool?
    public var submission: Submission?
    public var job: HammersmithRun?

    enum CodingKeys: String, CodingKey {
        case ok, duplicate, submission, job
    }

    public init(ok: Bool, duplicate: Bool? = nil, submission: Submission? = nil, job: HammersmithRun? = nil) {
        self.ok = ok
        self.duplicate = duplicate
        self.submission = submission
        self.job = job
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        duplicate = try c.decodeIfPresent(Bool.self, forKey: .duplicate)
        submission = try c.decodeIfPresent(Submission.self, forKey: .submission)
        job = try c.decodeIfPresent(HammersmithRun.self, forKey: .job)
    }
}

public struct HammersmithStopResponse: Decodable, Sendable {
    public var ok: Bool
    public var stopped: Bool?
    public var job: HammersmithRun?

    enum CodingKeys: String, CodingKey {
        case ok, stopped, job
    }

    public init(ok: Bool, stopped: Bool? = nil, job: HammersmithRun? = nil) {
        self.ok = ok
        self.stopped = stopped
        self.job = job
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        stopped = try c.decodeIfPresent(Bool.self, forKey: .stopped)
        job = try c.decodeIfPresent(HammersmithRun.self, forKey: .job)
    }
}

extension APIClient: HammersmithTransport {
    public func getHammersmithCapability() async throws -> HammersmithCapability {
        try await request("/api/hammersmith/capability")
    }

    public struct HammersmithSendBody: Encodable, Sendable {
        public var mode: String
        public var prompt: String
        public var submissionId: String
        enum CodingKeys: String, CodingKey {
            case mode, prompt
            case submissionId = "submissionId"
        }
    }

    public func sendHammersmith(
        _ sessionId: String, prompt: String, submissionId: String
    ) async throws -> HammersmithSendResponse {
        try await request(
            "/api/sessions/\(sessionId)/hammersmith", method: "POST",
            body: HammersmithSendBody(mode: "hammersmith", prompt: prompt, submissionId: submissionId)
        )
    }

    public func listHammersmithJobs(_ sessionId: String) async throws -> [HammersmithRun] {
        try await request("/api/sessions/\(sessionId)/hammersmith/jobs")
    }

    public func stopHammersmithJob(_ jobId: String) async throws -> HammersmithStopResponse {
        try await request("/api/hammersmith/jobs/\(jobId)/stop", method: "POST")
    }
}
