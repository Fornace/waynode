import Foundation
import Testing
@testable import WaynodeCore

@Suite("Hammersmith models + wire", .serialized)
struct HammersmithWireTests {
    @Test("Capability decodes full JSON and empty object leniently")
    func capabilityDecoding() throws {
        let full = Data(#"{"available":true,"installed":true,"dashboardUrl":"http://127.0.0.1:8700","version":"1.2.3","state":"ready","hosted":{"billingRequired":true,"entitled":false}}"#.utf8)
        let capability = try JSONDecoder().decode(HammersmithCapability.self, from: full)
        #expect(capability.available)
        #expect(capability.installed == true)
        #expect(capability.dashboardUrl == "http://127.0.0.1:8700")
        #expect(capability.version == "1.2.3")
        #expect(capability.state == "ready")
        #expect(capability.hosted?.billingRequired == true)
        #expect(capability.hosted?.entitled == false)

        let empty = try JSONDecoder().decode(HammersmithCapability.self, from: Data(#"{}"#.utf8))
        #expect(!empty.available)
        #expect(empty.installed == nil)
        #expect(empty.hosted == nil)
    }

    @Test("hammersmith_run SSE decodes run from the submission job key")
    func hammersmithRunEventDecoding() throws {
        let json = Data(#"{"type":"hammersmith_run","submission":{"id":"s1","prompt":"do the job","mode":"hammersmith","isGoal":false,"status":"completed","createdAt":"2026-07-18T00:00:00Z","job":{"id":"j1","submissionId":"s1","sessionId":"sess","spaceId":"sp","description":"do the job","lifecycle":"running","totalTasks":3,"checkedTasks":1,"passedTasks":1,"failedTasks":0,"updatedAt":"2026-07-18T00:00:01Z","createdAt":"2026-07-18T00:00:00Z"}}}"#.utf8)
        let event = try JSONDecoder().decode(SSEEvent.self, from: json)
        guard case .hammersmithRun(let submission, let run) = event.kind else {
            Issue.record("Expected hammersmithRun event")
            return
        }
        #expect(submission?.id == "s1")
        #expect(run.id == "j1")
        #expect(run.lifecycle == .running)
        #expect(run.totalTasks == 3)
        #expect(run.checkedTasks == 1)
    }

    @Test("hammersmith_run without a job decodes to unknown")
    func hammersmithRunMissingJob() throws {
        let json = Data(#"{"type":"hammersmith_run","submission":{"id":"s1","prompt":"do the job","isGoal":false,"status":"completed"}}"#.utf8)
        let event = try JSONDecoder().decode(SSEEvent.self, from: json)
        #expect(event.kind == .unknown)
    }

    @Test("Run decodes leniently and unknown lifecycle falls back to running")
    func runLenientDecoding() throws {
        let run = try JSONDecoder().decode(HammersmithRun.self, from: Data(#"{"id":"j1"}"#.utf8))
        #expect(run.id == "j1")
        #expect(run.lifecycle == .running)
        #expect(run.totalTasks == 0)

        let weird = try JSONDecoder().decode(HammersmithRun.self, from: Data(#"{"id":"j2","lifecycle":"exploded"}"#.utf8))
        #expect(weird.lifecycle == .running)
    }
}

@Suite("Hammersmith reducer folding", .serialized)
struct HammersmithReducerTests {
    private func run(_ id: String, lifecycle: HammersmithRunLifecycle = .running,
                     checked: Int = 1, passed: Int = 1, failed: Int = 0, total: Int = 3) -> HammersmithRun {
        HammersmithRun(
            id: id, submissionId: "s1", sessionId: "sess", spaceId: "sp",
            description: "do the job", lifecycle: lifecycle,
            totalTasks: total, checkedTasks: checked, passedTasks: passed, failedTasks: failed
        )
    }

    @Test("First event appends run item and reconciles the submission")
    func firstEventAppends() {
        var reducer = ChatReducer()
        let changed = reducer.reduce(.hammersmithRun(
            submission: Submission(id: "s1", prompt: "do the job", isGoal: false, status: .completed),
            run: run("j1")
        ))
        #expect(changed)
        #expect(reducer.items.count == 2)
        guard case .user(let user) = reducer.items[0] else {
            Issue.record("Expected the submission as a user item")
            return
        }
        #expect(user.id == "s1")
        guard case .hammersmithRun(let item) = reducer.items[1] else {
            Issue.record("Expected a hammersmith run item")
            return
        }
        #expect(item.run.id == "j1")
        #expect(item.id == "j1")
    }

    @Test("Same run id updates in place; a different id appends")
    func upsertInPlace() {
        var reducer = ChatReducer()
        _ = reducer.reduce(.hammersmithRun(submission: nil, run: run("j1", checked: 1)))
        let revisionAfterFirst = reducer.revision
        _ = reducer.reduce(.hammersmithRun(submission: nil, run: run("j1", checked: 2, passed: 2)))
        #expect(reducer.items.count == 1)
        #expect(reducer.revision > revisionAfterFirst)
        guard case .hammersmithRun(let updated) = reducer.items[0] else { return }
        #expect(updated.run.checkedTasks == 2)
        #expect(updated.run.passedTasks == 2)

        _ = reducer.reduce(.hammersmithRun(submission: nil, run: run("j2")))
        #expect(reducer.items.count == 2)
        #expect(reducer.hammersmithRuns.map(\.id) == ["j1", "j2"])
    }

    @Test("activeHammersmithRun tracks the latest running run and nils on finish")
    func activeRunLifecycle() {
        var reducer = ChatReducer()
        #expect(reducer.activeHammersmithRun == nil)
        _ = reducer.reduce(.hammersmithRun(submission: nil, run: run("j1")))
        #expect(reducer.activeHammersmithRun?.id == "j1")
        _ = reducer.reduce(.hammersmithRun(submission: nil, run: run("j1", lifecycle: .finished, checked: 3, passed: 3)))
        #expect(reducer.activeHammersmithRun == nil)
        _ = reducer.reduce(.hammersmithRun(submission: nil, run: run("j2")))
        #expect(reducer.activeHammersmithRun?.id == "j2")
    }
}

@Suite("SessionStore hammersmith transport", .serialized)
struct SessionStoreHammersmithTests {
    @Test("Successful delegation adds the user row and the run row")
    @MainActor
    func sendSuccess() async {
        let transport = MockHammersmithTransport()
        let store = SessionStore(sessionId: "session", spaceId: "space", api: transport)
        await store.sendHammersmith("do the job")

        #expect(store.sendError == nil)
        #expect(store.reducer.items.count == 2)
        #expect(store.reducer.hammersmithRuns.map(\.id) == ["j1"])
        #expect(store.reducer.items.contains { $0.id == "j1" && $0.id != "s1" })
        let calls = await transport.hammersmithCalls
        #expect(calls.count == 1)
        #expect(calls.first?.prompt == "do the job")
    }

    @Test("Transport failure keeps a hammersmith draft retryable through retryFailedSubmission")
    @MainActor
    func sendFailureAndRetry() async {
        let transport = MockHammersmithTransport()
        await transport.setFailure(APIClient.APIError(statusCode: 402, message: "Hosted Hammersmith requires an entitlement"))
        let store = SessionStore(sessionId: "session", spaceId: "space", api: transport)
        await store.sendHammersmith("do the job")

        #expect(store.sendError?.contains("Job not delegated") == true)
        #expect(store.failedDraft?.kind == .hammersmith)
        #expect(store.failedDraft?.prompt == "do the job")

        await transport.setFailure(nil)
        await store.retryFailedSubmission()
        #expect(store.sendError == nil)
        #expect(store.failedDraft == nil)
        #expect(store.reducer.hammersmithRuns.map(\.id) == ["j1"])
        let calls = await transport.hammersmithCalls
        #expect(calls.count == 2)
        #expect(calls.first?.submissionId == calls.last?.submissionId)
    }

    @Test("refreshHammersmithJobs seeds run items without SSE")
    @MainActor
    func refreshSeedsRuns() async {
        let transport = MockHammersmithTransport()
        let store = SessionStore(sessionId: "session", spaceId: "space", api: transport)
        await store.refreshHammersmithJobs()
        #expect(store.reducer.hammersmithRuns.map(\.id) == ["j1"])
        guard case .hammersmithRun(let item) = store.reducer.items.first else {
            Issue.record("Expected a hammersmith run item")
            return
        }
        #expect(item.run.lifecycle == .running)
    }

    @Test("Capability success stores it; failure leaves nil so the mode stays hidden")
    @MainActor
    func capabilityGating() async {
        let transport = MockHammersmithTransport()
        let store = SessionStore(sessionId: "session", spaceId: "space", api: transport)
        await store.loadHammersmithCapability()
        #expect(store.hammersmithCapability?.available == true)

        let offline = MockHammersmithTransport()
        await offline.setCapabilityFailure(true)
        let offlineStore = SessionStore(sessionId: "session", spaceId: "space", api: offline)
        await offlineStore.loadHammersmithCapability()
        #expect(offlineStore.hammersmithCapability == nil)
    }
}

private actor MockHammersmithTransport: HammersmithTransport {
    struct HammersmithCall: Sendable {
        let prompt: String
        let submissionId: String
    }

    private(set) var hammersmithCalls: [HammersmithCall] = []
    private var failure: Error?
    private var capabilityFails = false

    nonisolated func makeURL(_ path: String) -> URL { URL(string: "https://example.test\(path)")! }
    func currentToken() -> String? { "token" }
    func setFailure(_ error: Error?) { failure = error }
    func setCapabilityFailure(_ value: Bool) { capabilityFails = value }

    func getMessages(_ sessionId: String) async throws -> [APIClient.HistoryMessage] { [] }

    func getSession(_ id: String) async throws -> Session {
        Session(id: id, spaceId: "space", ownerId: "owner", title: "Session", piSessionDir: "", createdAt: "", updatedAt: "")
    }

    func getSessionState(_ sessionId: String) async throws -> APIClient.StateResponse {
        .init(active: false, done: true, submissions: [])
    }

    func sendMessage(_ sessionId: String, prompt: String, isGoal: Bool, submissionId: String) async throws -> APIClient.OkResponse {
        .init(ok: true, queued: false, submission: .init(id: submissionId, prompt: prompt, isGoal: isGoal, status: .starting), duplicate: false)
    }

    func queueMessage(_ sessionId: String, prompt: String, isGoal: Bool, submissionId: String) async throws -> APIClient.OkResponse {
        .init(ok: true, queued: true, submission: .init(id: submissionId, prompt: prompt, isGoal: isGoal, status: .queued), duplicate: false)
    }

    func abortTurn(_ sessionId: String) async throws -> APIClient.AbortResponse {
        .init(ok: true, cancelled: true, submissionId: nil, reason: nil)
    }

    func getGoalStatus(_ sessionId: String) async throws -> GoalStatus { GoalStatus() }

    func getHammersmithCapability() async throws -> HammersmithCapability {
        if capabilityFails { throw APIClient.APIError(statusCode: 503, message: "offline") }
        return HammersmithCapability(available: true, installed: true, dashboardUrl: "http://127.0.0.1:8700")
    }

    func sendHammersmith(_ sessionId: String, prompt: String, submissionId: String) async throws -> HammersmithSendResponse {
        hammersmithCalls.append(.init(prompt: prompt, submissionId: submissionId))
        if let failure { throw failure }
        return HammersmithSendResponse(
            ok: true,
            submission: Submission(id: submissionId, prompt: prompt, isGoal: false, status: .completed),
            job: Self.job(id: "j1", submissionId: submissionId)
        )
    }

    func listHammersmithJobs(_ sessionId: String) async throws -> [HammersmithRun] {
        [Self.job(id: "j1", submissionId: "s1")]
    }

    func stopHammersmithJob(_ jobId: String) async throws -> HammersmithStopResponse {
        HammersmithStopResponse(ok: true, stopped: true, job: Self.job(id: jobId, submissionId: "s1", lifecycle: .stopped))
    }

    private static func job(
        id: String, submissionId: String, lifecycle: HammersmithRunLifecycle = .running
    ) -> HammersmithRun {
        HammersmithRun(
            id: id, submissionId: submissionId, sessionId: "session", spaceId: "space",
            description: "do the job", lifecycle: lifecycle,
            totalTasks: 3, checkedTasks: 1, passedTasks: 1, failedTasks: 0,
            monitorUrl: "http://127.0.0.1:8700"
        )
    }
}
