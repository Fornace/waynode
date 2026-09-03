import Foundation
import Testing
@testable import WaynodeCore

@Suite("Chat submission truth", .serialized)
struct ChatSubmissionTests {
    @Test("SSE submission and sync preserve IDs, goal mode, and streaming truth")
    func decodesWireTruth() throws {
        let submissionJSON = Data(#"{"type":"submission","submission":{"id":"s1","prompt":"ship it","mode":"goal","status":"queued"}}"#.utf8)
        let event = try JSONDecoder().decode(SSEEvent.self, from: submissionJSON)
        guard case .submission(let submission) = event.kind else {
            Issue.record("Expected submission event")
            return
        }
        #expect(submission.id == "s1")
        #expect(submission.mode == .goal)
        #expect(submission.status == .queued)

        let syncJSON = Data(#"{"type":"sync","streaming":false,"partialText":"","submissions":[{"id":"s1","prompt":"ship it","mode":"goal","status":"completed"}]}"#.utf8)
        let sync = try JSONDecoder().decode(SSEEvent.self, from: syncJSON)
        guard case .sync(let snapshot) = sync.kind else {
            Issue.record("Expected sync event")
            return
        }
        #expect(!snapshot.streaming)
        #expect(snapshot.submissions.first?.status == .completed)
    }

    @Test("Optimistic, acknowledgement, and SSE updates reconcile one row")
    func reconcilesOneRow() {
        var reducer = ChatReducer()
        let draft = SubmissionDraft(id: "s1", prompt: "Fix it", mode: .goal, queued: true)
        #expect(draft.kind == .queue)
        reducer.appendSubmission(draft)
        reducer.reconcileSubmission(.init(id: "s1", prompt: "Fix it", mode: .goal, status: .queued))
        _ = reducer.reduce(.submission(.init(id: "s1", prompt: "Fix it", mode: .goal, status: .running)))
        _ = reducer.reduce(.submission(.init(id: "s1", prompt: "Fix it", mode: .goal, status: .completed)))

        #expect(reducer.items.count == 1)
        guard case .user(let user) = reducer.items[0] else { return }
        #expect(user.id == "s1")
        #expect(user.mode == .goal)
        #expect(user.submissionStatus == .completed)
    }

    @Test("Rejected optimistic row is removed and retry cannot duplicate")
    func rejectionAndRetry() {
        var reducer = ChatReducer()
        let draft = SubmissionDraft(id: "s1", prompt: "Try this", mode: .message, queued: true)
        reducer.appendSubmission(draft)
        reducer.reconcileSubmission(
            .init(id: "s1", prompt: draft.prompt, mode: .message, status: .failed, error: "full"),
            accepted: false, queued: true
        )
        #expect(reducer.items.isEmpty)
        #expect(reducer.submissionState.failedDraft == draft)

        reducer.appendSubmission(draft)
        reducer.appendSubmission(draft)
        #expect(reducer.items.count == 1)
        reducer.reconcileSubmission(.init(id: "s1", prompt: draft.prompt, mode: .message, status: .queued), queued: true)
        #expect(reducer.items.count == 1)
        #expect(reducer.submissionState.failedDraft == nil)
    }

    @Test("Lifecycle derives queued, active, completed, failed, and cancelled truth")
    func lifecycleTruth() {
        var reducer = ChatReducer()
        let make = { (status: SubmissionStatus) in
            Submission(id: "s1", prompt: "Run", mode: .message, status: status)
        }
        reducer.reconcileSubmission(make(.queued))
        #expect(reducer.submissionState.queuedCount == 1)
        reducer.reconcileSubmission(make(.starting))
        #expect(reducer.submissionState.activeStatus == .starting)
        reducer.reconcileSubmission(make(.running))
        #expect(reducer.submissionState.activeStatus == .running)
        reducer.reconcileSubmission(make(.completed))
        #expect(reducer.submissionState.activeStatus == nil)
        reducer.reconcileSubmission(make(.cancelled))
        guard case .user(let user) = reducer.items[0] else { return }
        #expect(user.submissionStatus == .cancelled)
    }

    @Test("Native request body uses server camel-case keys")
    func requestBodyKeys() throws {
        let body = APIClient.SendMessageBody(prompt: "goal", mode: .goal, submissionId: "s1")
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(object["mode"] as? String == "goal")
        #expect(object["submissionId"] as? String == "s1")
        #expect(object["submission_id"] == nil)
    }

    @Test("Terminal accepted failure retries with a fresh id; transport loss keeps it")
    func retryIdPolicy() {
        var reducer = ChatReducer()
        reducer.appendSubmission(SubmissionDraft(id: "s1", prompt: "Run", mode: .message, queued: false))
        reducer.reconcileSubmission(
            .init(id: "s1", prompt: "Run", mode: .message, status: .failed, error: "boom"),
            accepted: true, queued: false
        )
        #expect(reducer.submissionState.failedDraft?.prompt == "Run")
        #expect(reducer.submissionState.failedDraft?.id != "s1",
                "terminal durable failure retries with a fresh submission id")

        var lost = ChatReducer()
        let draft = SubmissionDraft(id: "s2", prompt: "Run", mode: .message, queued: false)
        lost.appendSubmission(draft)
        lost.reconcileSubmission(
            .init(id: "s2", prompt: "Run", mode: .message, status: .failed, error: "network"),
            accepted: false, queued: false
        )
        #expect(lost.submissionState.failedDraft == draft,
                "response-loss retry reuses the original id for idempotent admission")
    }
}

@Suite("SessionStore submission transport", .serialized)
struct SessionStoreSubmissionTests {
    @Test("Busy message queues the same goal submission ID exactly once")
    @MainActor
    func busyFallbackPreservesGoal() async {
        let transport = MockSessionTransport()
        await transport.setSendMode(.busy)
        let store = SessionStore(sessionId: "session", spaceId: "space", api: transport)
        await store.send("Finish it", mode: .goal)

        let calls = await transport.calls
        #expect(calls.count == 2)
        #expect(calls.map(\.kind) == [.message, .queue])
        #expect(calls[0].id == calls[1].id)
        #expect(calls.allSatisfy { $0.mode == .goal })
        #expect(store.reducer.items.count == 1)
    }

    @Test("Queue rejection restores one retryable draft without a ghost row")
    @MainActor
    func queueRejectionRetry() async {
        let transport = MockSessionTransport()
        await transport.setQueueMode(.failure("Queue is full"))
        let store = SessionStore(sessionId: "session", spaceId: "space", api: transport)
        _ = store.reducer.reduce(.submission(.init(
            id: "running", prompt: "First", mode: .message, status: .running
        )))

        await store.send("Follow up")
        let failed = store.failedDraft
        #expect(failed?.prompt == "Follow up")
        #expect(!store.reducer.items.contains { $0.id == failed?.id })

        await transport.setQueueMode(.success)
        await store.send("Follow up")
        #expect(store.reducer.items.filter { $0.id == failed?.id }.count == 1)
        #expect(store.failedDraft == nil)
    }

    @Test("History failure never becomes an empty conversation")
    @MainActor
    func historyFailure() async {
        let transport = MockSessionTransport()
        await transport.setHistoryFailure(true)
        let store = SessionStore(sessionId: "session", spaceId: "space", api: transport)
        await store.loadHistory()

        #expect(!store.didLoadHistory)
        #expect(store.historyError?.contains("preserved") == true)
        #expect(store.reducer.items.isEmpty)
    }

    @Test("Inactive server state completes stale running submission")
    @MainActor
    func inactiveStateCompletesStaleRun() async {
        let transport = MockSessionTransport()
        await transport.setState(.init(active: false, done: true, submissions: []))
        let store = SessionStore(sessionId: "session", spaceId: "space", api: transport)
        _ = store.reducer.reduce(.submission(.init(
            id: "running", prompt: "Work", mode: .message, status: .running
        )))
        #expect(store.isRunActive)

        await store.refreshSessionState()

        #expect(!store.isRunActive)
        guard case .user(let user) = store.reducer.items[0] else { return }
        #expect(user.submissionStatus == .completed)
    }

    @Test("Hosted cancelled false keeps active Stop truth and explains why")
    @MainActor
    func hostedAbortTruth() async {
        let transport = MockSessionTransport()
        await transport.setAbortCancelled(false)
        let store = SessionStore(sessionId: "session", spaceId: "space", api: transport)
        _ = store.reducer.reduce(.submission(.init(
            id: "running", prompt: "Work", mode: .message, status: .running
        )))
        #expect(store.isRunActive)

        await store.abortTurn()
        #expect(store.isRunActive)
        #expect(store.sendError?.contains("still running") == true)
    }
}

private actor MockSessionTransport: SessionTransport {
    enum Outcome: Sendable { case success, busy, failure(String) }
    struct Call: Sendable {
        let kind: SubmissionDraft.Kind
        let id: String
        let mode: SubmissionMode
    }

    private(set) var calls: [Call] = []
    private var sendOutcome: Outcome = .success
    private var queueOutcome: Outcome = .success
    private var historyFails = false
    private var abortCancelled = false
    private var stateResponse = APIClient.StateResponse(active: false, done: true, submissions: [])

    nonisolated func makeURL(_ path: String) -> URL { URL(string: "https://example.test\(path)")! }
    func currentToken() -> String? { "token" }
    func setSendMode(_ outcome: Outcome) { sendOutcome = outcome }
    func setQueueMode(_ outcome: Outcome) { queueOutcome = outcome }
    func setHistoryFailure(_ value: Bool) { historyFails = value }
    func setAbortCancelled(_ value: Bool) { abortCancelled = value }
    func setState(_ response: APIClient.StateResponse) { stateResponse = response }

    func getMessages(_ sessionId: String) async throws -> [APIClient.HistoryMessage] {
        if historyFails { throw APIClient.APIError(statusCode: 503, message: "offline") }
        return []
    }

    func getSession(_ id: String) async throws -> Session {
        Session(id: id, spaceId: "space", ownerId: "owner", title: "Session", piSessionDir: "", createdAt: "", updatedAt: "")
    }

    func getSessionState(_ sessionId: String) async throws -> APIClient.StateResponse {
        stateResponse
    }

    func sendMessage(_ sessionId: String, prompt: String, mode: SubmissionMode, submissionId: String) async throws -> APIClient.OkResponse {
        calls.append(.init(kind: .message, id: submissionId, mode: mode))
        return try response(for: sendOutcome, id: submissionId, prompt: prompt, mode: mode, queued: false)
    }

    func queueMessage(_ sessionId: String, prompt: String, mode: SubmissionMode, submissionId: String) async throws -> APIClient.OkResponse {
        calls.append(.init(kind: .queue, id: submissionId, mode: mode))
        return try response(for: queueOutcome, id: submissionId, prompt: prompt, mode: mode, queued: true)
    }

    func abortTurn(_ sessionId: String) async throws -> APIClient.AbortResponse {
        .init(ok: true, cancelled: abortCancelled, submissionId: "running", reason: abortCancelled ? nil : "Run is still running")
    }

    func getGoalStatus(_ sessionId: String) async throws -> GoalStatus { GoalStatus() }

    private func response(
        for outcome: Outcome, id: String, prompt: String, mode: SubmissionMode, queued: Bool
    ) throws -> APIClient.OkResponse {
        switch outcome {
        case .success:
            return .init(ok: true, queued: queued, submission: .init(
                id: id, prompt: prompt, mode: mode, status: queued ? .queued : .starting
            ), duplicate: false)
        case .busy:
            throw APIClient.APIError(statusCode: 409, message: "busy")
        case .failure(let message):
            throw APIClient.APIError(statusCode: 409, message: message)
        }
    }
}
