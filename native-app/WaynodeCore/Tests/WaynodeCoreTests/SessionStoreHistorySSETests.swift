import Foundation
import Testing
@testable import WaynodeCore

/// End-to-end store cycle: persisted history, canonical full sync with a
/// live overlay, tool-result linkage, durable supersession, and release /
/// reacquire handoff, all against in-memory frames.
@Suite("SessionStore history and durable replay")
struct SessionStoreHistorySSETests {
    private func decode(_ json: String) throws -> SSEEvent.Kind {
        try JSONDecoder.api.decode(SSEEvent.self, from: Data(json.utf8)).kind
    }

    @Test("History, full sync, and release/reacquire keep one transcript and one cursor")
    @MainActor
    func historySyncReacquire() async throws {
        let transport = HistorySSETransport(history: [
            .init(role: "user", id: "u1", content: "hello"),
            .init(role: "assistant", id: "a1", content: "answer"),
        ])
        let store = SessionStore(sessionId: "s", spaceId: "sp", api: transport)
        await store.loadHistory()
        #expect(store.didLoadHistory)
        #expect(store.reducer.items.map(\.id) == ["u1", "a1"])

        let client = SSEClient(url: URL(string: "https://example.test/stream")!, token: nil)
        let collector = Task { () -> [SSEFrame] in
            var frames: [SSEFrame] = []
            for await frame in client.events() { frames.append(frame) }
            return frames
        }
        try await client.consume(HistoryLineStream(lines: [
            "id: leaf-1",
            #"data: {"type":"sync","streaming":true,"fromStart":true,"entries":[{"id":"u1","role":"user","text":"hello"},{"id":"a1","role":"assistant","blocks":[{"type":"toolCall","id":"tc1","name":"bash","args":{"command":"pwd"}}]},{"id":"tr1","role":"toolResult","toolCallId":"tc1","toolName":"bash","text":"/workspace\n","isError":false}],"live":{"messageId":"m-live","text":"draft","thinking":"","tools":[]}}"#,
            "id: leaf-2",
            #"data: {"type":"sync","streaming":false,"fromStart":true,"entries":[{"id":"u1","role":"user","text":"hello"},{"id":"a1","role":"assistant","blocks":[{"type":"toolCall","id":"tc1","name":"bash","args":{"command":"pwd"}}]},{"id":"tr1","role":"toolResult","toolCallId":"tc1","toolName":"bash","text":"/workspace\n","isError":false},{"id":"u2","role":"user","text":"again"}]}"#,
        ]))
        await client.stop()
        let frames = await collector.value
        #expect(frames.count == 2)
        for frame in frames { await store.processFrame(frame, from: client) }

        // The durable projection owns the transcript: the tool result is
        // attached to its call, and the finished projection supersedes the
        // earlier live overlay.
        #expect(store.reducer.items.map(\.id) == ["u1", "a1", "u2"])
        guard case .assistant(let assistant) = store.reducer.items[1],
              case .tool(let tool) = assistant.blocks[0] else {
            Issue.record("Expected linked durable tool block")
            return
        }
        #expect(tool.output == "/workspace\n")
        #expect(store.reducer.isStreaming == false)
        #expect(await client.reconnectCursor == "leaf-2")

        // Release/reacquire retains the cursor and seeds the replacement
        // stream with it, so replay starts after leaf-2.
        store.installStreamForTest(client, viewerCount: 1)
        store.closeStreamForTest()
        await store.connectStreamForTest()
        #expect(store.testHasStream)
        #expect(store.testReconnectCursor == "leaf-2")
        #expect(await store.testStreamCursor == "leaf-2")

        // Re-fetching history after reacquire must deduplicate by durable id.
        await transport.setHistory([
            .init(role: "user", id: "u1", content: "hello"),
            .init(role: "assistant", id: "a1", content: "answer"),
            .init(role: "user", id: "u2", content: "again"),
        ])
        await store.refreshCompletedHistory()
        for id in ["u1", "a1", "u2"] {
            #expect(store.reducer.items.filter { $0.id == id }.count == 1, "\(id) duplicated after refresh")
        }
        store.close()
    }

    @Test("Reacquire keeps the loaded transcript and never reloads history twice")
    @MainActor
    func reacquireKeepsHistoryLoaded() async throws {
        let transport = HistorySSETransport(history: [
            .init(role: "user", id: "u1", content: "hello"),
        ])
        let store = SessionStore(sessionId: "s", spaceId: "sp", api: transport)
        await store.loadHistory()
        #expect(await transport.messagesCalls == 1)

        // Simulate release and reacquire of just the stream.
        let client = SSEClient(url: URL(string: "https://example.test/stream")!, token: nil)
        store.installStreamForTest(client, viewerCount: 1)
        store.closeStreamForTest()
        await store.connectStreamForTest()
        #expect(store.testHasStream)
        #expect(store.reducer.items.map(\.id) == ["u1"])
        #expect(store.didLoadHistory)
        #expect(await transport.messagesCalls == 1, "reacquire must not refetch history")
        store.close()
    }
}

private actor HistorySSETransport: SessionTransport {
    private var history: [APIClient.HistoryMessage]
    private(set) var messagesCalls = 0

    init(history: [APIClient.HistoryMessage]) {
        self.history = history
    }

    func setHistory(_ history: [APIClient.HistoryMessage]) {
        self.history = history
    }

    nonisolated func makeURL(_ path: String) -> URL { URL(string: "https://example.test\(path)")! }
    func currentToken() -> String? { "token" }
    func getMessages(_ sessionId: String) async throws -> [APIClient.HistoryMessage] {
        messagesCalls += 1
        return history
    }
    func getSession(_ id: String) async throws -> Session {
        Session(id: id, spaceId: "space", ownerId: "owner", title: "Session",
                piSessionDir: "", createdAt: "", updatedAt: "")
    }
    func getSessionState(_ sessionId: String) async throws -> APIClient.StateResponse {
        .init(active: false, done: true, submissions: [])
    }
    func sendMessage(_ sessionId: String, prompt: String, mode: SubmissionMode,
                     submissionId: String) async throws -> APIClient.OkResponse {
        .init(ok: true, queued: false,
              submission: .init(id: submissionId, prompt: prompt, mode: mode, status: .starting),
              duplicate: false)
    }
    func queueMessage(_ sessionId: String, prompt: String, mode: SubmissionMode,
                      submissionId: String) async throws -> APIClient.OkResponse {
        .init(ok: true, queued: true,
              submission: .init(id: submissionId, prompt: prompt, mode: mode, status: .queued),
              duplicate: false)
    }
    func abortTurn(_ sessionId: String) async throws -> APIClient.AbortResponse {
        .init(ok: true, cancelled: true, submissionId: nil, reason: nil)
    }
    func getGoalStatus(_ sessionId: String) async throws -> GoalStatus { GoalStatus() }
}

private struct HistoryLineStream: AsyncSequence {
    typealias Element = String
    let lines: [String]
    func makeAsyncIterator() -> Iterator { Iterator(lines: lines) }
    struct Iterator: AsyncIteratorProtocol {
        var lines: [String]
        mutating func next() async -> String? { lines.isEmpty ? nil : lines.removeFirst() }
    }
}
