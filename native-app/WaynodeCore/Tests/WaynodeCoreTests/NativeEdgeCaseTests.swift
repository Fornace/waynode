import Foundation
import Testing
@testable import WaynodeCore

// MARK: - Native edge-case regression tests (failing-first)
//
// Each test pins one confirmed edge-case bug from the QA scout. Bugs 1, 2, 4,
// 7 exercise existing code paths and fail behaviourally against the current
// implementation. Bugs 3, 5, 6 require a small testability seam that the fix
// introduces (consume/heartbeatResets on SSEClient; SSEWire.request for SSE
// endpoints; terminalRequest on WSClient), so they fail until those seams —
// which are part of the fix — exist.

@Suite("Native edge-case fixes", .serialized)
struct NativeEdgeCaseTests {

    // MARK: Bug 1 — SSE reconnect `sync` duplicates the in-flight assistant
    // message when the partial-text WireItem carries no id. The reducer must
    // reconcile the partial into the current in-flight assistant item instead
    // of appending a second row. (reducer-level)

    @Test("sync with no id reconciles into the in-flight assistant item (no duplicate)")
    func syncReconcilesInFlightAssistant() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.textDelta(messageId: "m1", delta: "partial"))

        // The server's partial-text sync WireItem omits id (Chat.swift decoder
        // hardcodes id:nil). Before the fix the reducer minted a random UUID,
        // never matched msgIndex, and appended a second assistant row.
        let snapshot = SyncSnapshot(items: [
            .init(role: "assistant", id: nil, text: "partial reconciled")
        ], streaming: true)
        _ = r.reduce(.sync(snapshot: snapshot))

        // Exactly ONE assistant item, with the reconciled partial text.
        #expect(r.items.count == 1)
        if case .assistant(let a) = r.items[0] {
            if case .text(let tb) = a.blocks.last {
                #expect(tb.text == "partial reconciled")
            } else {
                Issue.record("expected a reconciled text block")
            }
            #expect(a.done == false)
        } else {
            Issue.record("expected a single assistant item")
        }

        // A repeat sync must still not duplicate.
        _ = r.reduce(.sync(snapshot: snapshot))
        #expect(r.items.count == 1)
    }

    // MARK: Bug 2 — History load silently skipped when an optimistic
    // submission lands first. loadHistory gated on reducer.items.isEmpty, so a
    // send that beat GET /messages skipped the whole transcript while still
    // setting didLoadHistory=true. (store-level with a test double)

    @Test("History loads and precedes an optimistic send that landed first")
    @MainActor
    func historyLoadsDespiteOptimisticSend() async throws {
        let transport = NativeEdgeTransport()
        let history = try JSONDecoder.api.decode([APIClient.HistoryMessage].self, from: Data(#"""
        [{"role":"user","id":"h1","content":"old question"},
         {"role":"assistant","id":"h2","content":"old answer"}]
        """#.utf8))
        await transport.setHistory(history)

        let store = SessionStore(sessionId: "s", spaceId: "sp", api: transport)

        // Optimistic send appends a user row BEFORE GET /messages returns.
        _ = store.reducer.reduce(.submission(.init(
            id: "optimistic", prompt: "new message", isGoal: false, status: .sending
        )))
        #expect(!store.reducer.items.isEmpty)

        await store.loadHistory()

        #expect(store.didLoadHistory)
        // History rows must be present AND ordered before the optimistic row.
        let ids = store.reducer.items.map(\.id)
        #expect(ids == ["h1", "h2", "optimistic"])
    }

    // MARK: Bug 3 — Heartbeat watchdog ignores unparseable keep-alive lines.
    // SSE comment keep-alives (": ka") parse to nil, so the old code only reset
    // the 90s watchdog inside `if let event = parseEvent(...)`. An idle-but-
    // healthy connection force-reconnected every 90s (compounding bug 1).
    // (SSEClient line-level)

    @Test("Heartbeat watchdog resets on SSE comment keep-alive lines")
    func heartbeatResetsOnKeepAliveLines() async throws {
        let client = SSEClient(url: URL(string: "https://example.test/stream")!, token: nil)
        let before = await client.heartbeatResets

        // Comment keep-alive lines carry no `data:` payload, so parseEvent
        // returns nil for them. Before the fix these never reset the watchdog.
        try await client.consume(LineStream(lines: [
            ": keep-alive", "",
            ": keep-alive", "",
            ": keep-alive", ""
        ]))

        let after = await client.heartbeatResets
        // Every received line — including comment keep-alives — must reset the
        // watchdog. Before the fix, keep-alive-only streams left the count
        // unchanged (reset happened only on a parsed event).
        #expect(after > before)
    }

    // MARK: SSE parsing under real AsyncLineSequence behaviour.
    // URLSession's bytes.lines NEVER yields the blank lines that separate SSE
    // events, so a parser that waits for `line.isEmpty` as an event boundary
    // buffers forever and decodes nothing — no streamed deltas ever reached
    // the reducer. consume() must decode each `data:` line as one event.

    @Test("consume decodes events without blank boundary lines")
    func consumeDecodesWithoutBlankLines() async throws {
        let client = SSEClient(url: URL(string: "https://example.test/stream")!, token: nil)

        let collector = Task { () -> [SSEEvent.Kind] in
            var got: [SSEEvent.Kind] = []
            for await event in client.events() { got.append(event) }
            return got
        }

        // Exactly what AsyncLineSequence delivers for a live turn: data lines
        // and comment keep-alives, never an empty boundary line.
        try await client.consume(LineStream(lines: [
            #"data: {"type":"start"}"#,
            #"data: {"type":"message_start","messageId":"m1"}"#,
            #"data: {"type":"thinking_delta","messageId":"m1","delta":"pondering"}"#,
            ": ka",
            #"data: {"type":"text_delta","messageId":"m1","delta":"answer"}"#,
            #"data: {"type":"message_end","messageId":"m1"}"#,
            #"data: {"type":"end"}"#,
        ]))
        await client.stop()  // finish the continuation so the collector ends

        let events = await collector.value
        #expect(events.count == 6)
        #expect(events[2] == .thinkingDelta(messageId: "m1", delta: "pondering"))
        #expect(events[3] == .textDelta(messageId: "m1", delta: "answer"))
    }

    // MARK: Bug 6

    // MARK: Bug 4 — Concurrent submit silently drops the draft. The old
    // `guard !isSending else { return }` returned with sendError==nil, and the
    // caller cleared the composer whenever sendError was nil — the message
    // vanished. The fix routes the busy rejection through failedDraft.
    // (store-level with a test double)

    @Test("Concurrent submit keeps the draft retryable instead of dropping it")
    @MainActor
    func concurrentSubmitKeepsDraft() async {
        let transport = NativeEdgeTransport()
        let store = SessionStore(sessionId: "s", spaceId: "sp", api: transport)
        store.isSending = true  // simulate an in-flight submit

        await store.sendMessage("concurrent draft")

        // Before the fix: silent return, sendError nil, draft dropped.
        #expect(store.sendError != nil)
        // The busy rejection must surface a readable reason (reject() formats
        // it as "Message not sent. <reason>. Your draft is ready to retry.").
        #expect(store.sendError?.lowercased().contains("already") == true)
        #expect(store.failedDraft?.prompt == "concurrent draft")

        // No network attempt should have been made for the rejected draft.
        let calls = await transport.sendCalls
        #expect(calls.isEmpty)
    }

    // MARK: Bug 6 — Clone-progress SSE put the bearer token in the URL query
    // (?t=...), contradicting SSEClient's header policy. The fix sends it via
    // the Authorization header. Every SSE endpoint (chat, clone-progress, git
    // inspector) now builds its request through SSEWire.request, so one test
    // pins the policy for all of them.

    @Test("SSE requests authenticate via Authorization header, not query token")
    func sseRequestsUseHeaderAuth() {
        let client = APIClient(baseURL: URL(string: "https://example.test")!, token: nil)
        let url = client.makeURL("/api/spaces/s1/clone-events")
        let req = SSEWire.request(url: url, token: "wn_secret")

        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer wn_secret")
        // Token must NOT leak into the URL query (proxy-log policy).
        #expect(req.url?.query == nil)
        #expect(req.url?.absoluteString.contains("t=wn_secret") == false)
        #expect(req.value(forHTTPHeaderField: "Accept") == "text/event-stream")
    }

    // MARK: Bug 5 — Force-unwrapped URLComponents can crash. WSClient.connect() — Force-unwrapped URLComponents can crash. WSClient.connect()
    // and APIClient rawData/streamCloneProgress used `URLComponents(...)!`. The
    // fix guard-lets with a typed failure. (URL-level guard test for WSClient;
    // the rawData guard is defense-in-depth since URLComponents never returns
    // nil for a URL(string:)-accepted URL, and the clone-progress force-unwrap
    // is removed entirely by SSEWire.request above.)

    @Test("WSClient terminal request rewrites scheme, carries bearer header, and never force-unwraps")
    func wsClientTerminalRequestIsGuarded() throws {
        let req = try #require(WSClient.terminalRequest(
            for: URL(string: "https://example.test/ws/terminal")!, token: "wn_secret"
        ))
        // https → wss scheme rewrite preserved.
        #expect(req.url?.scheme == "wss")
        // Bearer header preserved.
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer wn_secret")
    }

    // MARK: Bug 7 — Archived sessions remain fully interactive. The fix gates
    // sendMessage on sessionMeta.archived, rejecting through the existing
    // failedDraft path. (store-level with a test double)

    @Test("Archived session rejects new messages and keeps the draft")
    @MainActor
    func archivedSessionRejectsSend() async {
        let transport = NativeEdgeTransport()
        let store = SessionStore(sessionId: "s", spaceId: "sp", api: transport)
        store.sessionMeta = Session(
            id: "s", spaceId: "sp", ownerId: "o", title: "Archived",
            piSessionDir: "", archived: true, createdAt: "", updatedAt: ""
        )

        await store.sendMessage("hello archived")

        #expect(store.sendError?.lowercased().contains("archived") == true)
        #expect(store.failedDraft?.prompt == "hello archived")

        // No network attempt should have been made for an archived session.
        let calls = await transport.sendCalls
        #expect(calls.isEmpty)
    }
}

// MARK: - Test doubles

/// Minimal SessionTransport double for the store-level edge cases. Configurable
/// history + call tracking. Mirrors MockSessionTransport in
/// ChatSubmissionTests but returns a non-empty transcript.
private actor NativeEdgeTransport: SessionTransport {
    private var history: [APIClient.HistoryMessage] = []
    private(set) var sendCalls: [String] = []

    nonisolated func makeURL(_ path: String) -> URL { URL(string: "https://example.test\(path)")! }
    func currentToken() -> String? { "token" }
    func setHistory(_ h: [APIClient.HistoryMessage]) { history = h }

    func getMessages(_ sessionId: String) async throws -> [APIClient.HistoryMessage] { history }

    func getSession(_ id: String) async throws -> Session {
        Session(id: id, spaceId: "space", ownerId: "owner", title: "Session",
                piSessionDir: "", createdAt: "", updatedAt: "")
    }

    func getSessionState(_ sessionId: String) async throws -> APIClient.StateResponse {
        .init(active: false, done: true, submissions: [])
    }

    func sendMessage(_ sessionId: String, prompt: String, isGoal: Bool, submissionId: String) async throws -> APIClient.OkResponse {
        sendCalls.append(prompt)
        return .init(ok: true, queued: false,
                     submission: .init(id: submissionId, prompt: prompt, isGoal: isGoal, status: .starting),
                     duplicate: false)
    }

    func queueMessage(_ sessionId: String, prompt: String, isGoal: Bool, submissionId: String) async throws -> APIClient.OkResponse {
        .init(ok: true, queued: true,
              submission: .init(id: submissionId, prompt: prompt, isGoal: isGoal, status: .queued),
              duplicate: false)
    }

    func abortTurn(_ sessionId: String) async throws -> APIClient.AbortResponse {
        .init(ok: true, cancelled: true, submissionId: nil, reason: nil)
    }

    func getGoalStatus(_ sessionId: String) async throws -> GoalStatus { GoalStatus() }
}

/// A trivial synchronous AsyncSequence over a [String], used to feed SSE wire
/// lines into SSEClient.consume() without a live URL session.
struct LineStream: AsyncSequence {
    let lines: [String]
    struct Iterator: AsyncIteratorProtocol {
        var lines: [String]
        mutating func next() async -> String? { lines.isEmpty ? nil : lines.removeFirst() }
    }
    func makeAsyncIterator() -> Iterator { Iterator(lines: lines) }
}
