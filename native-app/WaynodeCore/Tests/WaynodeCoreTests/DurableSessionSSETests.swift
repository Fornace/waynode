import Foundation
import Testing
@testable import WaynodeCore

@Suite("Durable session SSE")
struct DurableSessionSSETests {
    private func decode(_ json: String) throws -> SSEEvent.Kind {
        try JSONDecoder.api.decode(SSEEvent.self, from: Data(json.utf8)).kind
    }

    @Test("SessionStore acknowledges only successfully applied durable frames")
    @MainActor
    func sessionStoreAcknowledgesAfterApplication() async throws {
        let transport = NativeDurableTransport()
        let store = SessionStore(sessionId: "s", spaceId: "sp", api: transport)
        let client = SSEClient(url: URL(string: "https://example.test/stream")!, token: nil)
        let collector = Task { () -> [SSEFrame] in
            var frames: [SSEFrame] = []
            for await frame in client.events() { frames.append(frame) }
            return frames
        }
        try await client.consume(DurableLineStream(lines: [
            "id: durable-good",
            #"data: {"type":"entries","entries":[{"id":"u1","role":"user","text":"hello"}]}"#,
            "id: durable-bad",
            #"data: {"type":"entries","entries":[{"id":"a1","role":"assistant","blocks":[{"type":"futureBlock"}]}]}"#,
            "id: durable-later",
            #"data: {"type":"entries","entries":[{"id":"u2","role":"user","text":"later"}]}"#,
        ]))
        await client.stop()
        let frames = await collector.value
        #expect(frames.count == 3)
        for frame in frames { await store.processFrame(frame, from: client) }

        #expect(store.reducer.items.map(\.id) == ["u1", "u2"])
        #expect(await client.lastEventId == "durable-good")
    }

    @Test("SessionStore declines malformed frames before cursor commitment")
    @MainActor
    func sessionStoreRejectsMalformedFrame() async throws {
        let store = SessionStore(sessionId: "s", spaceId: "sp", api: NativeDurableTransport())
        let client = SSEClient(url: URL(string: "https://example.test/stream")!, token: nil)
        var parser = SSEFrameParser()
        #expect(parser.consume("id: safe") == nil)
        let good = parser.consume(#"data: {"type":"start"}"#)!
        let pending = parser.consume("id: unseen")
        #expect(pending == nil)
        let malformed = parser.consume("data: {broken")!
        let pendingLater = parser.consume("id: later")
        #expect(pendingLater == nil)
        let later = parser.consume(#"data: {"type":"end"}"#)!

        await store.processFrame(good, from: client)
        await store.processFrame(malformed, from: client)
        await store.processFrame(later, from: client)
        #expect(await client.lastEventId == "safe")
    }

    @Test("Release handoff preserves cursor and respects viewer ownership")
    @MainActor
    func releaseHandoffPreservesCursor() async throws {
        let store = SessionStore(sessionId: "s", spaceId: "sp", api: NativeDurableTransport())
        let old = SSEClient(url: URL(string: "https://example.test/stream")!, token: nil)
        var parser = SSEFrameParser()
        #expect(parser.consume("id: retained") == nil)
        let frame = parser.consume(#"data: {"type":"ping"}"#)!
        await old.acknowledge(frame)

        store.installStreamForTest(old, viewerCount: 0)
        store.closeStreamForTest()
        await store.connectStreamForTest()
        #expect(store.testHasStream == false)
        await store.awaitCloseForTest()
        #expect(store.testReconnectCursor == "retained")

        store.installStreamForTest(old, viewerCount: 1)
        store.closeStreamForTest()
        await store.connectStreamForTest()
        #expect(store.testHasStream)
        #expect(store.testReconnectCursor == "retained")
        store.close()
    }

    @Test("Full sync replaces history, incremental sync merges by stable entry id")
    func replacementAndMerge() throws {
        var reducer = ChatReducer()
        reducer.appendUser("obsolete", id: "old")
        let full = try decode(#"{"type":"sync","fromStart":true,"entries":[{"id":"u1","role":"user","text":"hello"},{"id":"a1","role":"assistant","blocks":[{"type":"text","text":"answer"}]}]}"#)
        let fullApplied = reducer.reduce(full)
        #expect(fullApplied)
        #expect(reducer.items.map(\.id) == ["u1", "a1"])

        let incremental = try decode(#"{"type":"sync","fromStart":false,"entries":[{"id":"a1","role":"assistant","text":"duplicate"},{"id":"u2","role":"user","text":"again"}]}"#)
        let incrementalApplied = reducer.reduce(incremental)
        #expect(incrementalApplied)
        #expect(reducer.items.map(\.id) == ["u1", "a1", "u2"])
        #expect(reducer.msgIndex.keys.sorted() == ["a1"])
        #expect(reducer.durableEntryIds == ["u1", "a1", "u2"])
    }

    @Test("Live entries preserve tool arguments and attach results")
    func toolResultLinkage() throws {
        var reducer = ChatReducer()
        let event = try decode(#"{"type":"entries","entries":[{"id":"a1","role":"assistant","blocks":[{"type":"toolCall","id":"tc1","name":"bash","args":{"command":"pwd"}}]},{"id":"tr1","role":"toolResult","toolCallId":"tc1","toolName":"bash","text":"/workspace\n","isError":false}]}"#)
        let eventApplied = reducer.reduce(event)
        #expect(eventApplied)
        #expect(reducer.items.count == 1)
        #expect(reducer.durableEntryIds == ["a1", "tr1"])
        guard case .assistant(let assistant) = reducer.items[0],
              case .tool(let tool) = assistant.blocks[0] else {
            Issue.record("Expected linked durable tool block")
            return
        }
        #expect(tool.id == "tc1")
        #expect(tool.args == #"{"command":"pwd"}"#)
        #expect(tool.output == "/workspace\n")
        #expect(tool.status == .done)
    }

    @Test("Rejected durable batches are atomic, including full replacement")
    func durableBatchAtomicity() throws {
        var reducer = ChatReducer()
        let baseline = try decode(#"{"type":"entries","entries":[{"id":"u0","role":"user","text":"keep"}]}"#)
        let baselineApplied = reducer.reduce(baseline)
        #expect(baselineApplied)
        let before = reducer

        let badMerge = try decode(#"{"type":"entries","entries":[{"id":"u1","role":"user","text":"prefix"},{"id":"a1","role":"assistant","blocks":[{"type":"futureBlock","text":"x"}]}]}"#)
        let badMergeApplied = reducer.reduce(badMerge)
        #expect(badMergeApplied == false)
        #expect(reducer == before)

        let badReplace = try decode(#"{"type":"sync","streaming":true,"fromStart":true,"entries":[{"id":"u2","role":"user","text":"prefix"},{"id":"future","role":"futureRole"}]}"#)
        let badReplaceApplied = reducer.reduce(badReplace)
        #expect(badReplaceApplied == false)
        #expect(reducer == before)

        for json in [
            #"{"type":"entries","entries":[{"id":"tr1","role":"toolResult","toolName":"bash","text":"missing call"}]}"#,
            #"{"type":"entries","entries":[{"id":"tr2","role":"toolResult","toolCallId":"","toolName":"bash","text":"empty call"}]}"#,
            #"{"type":"entries","entries":[{"id":"tr3","role":"toolResult","toolCallId":"tc","toolName":"","text":"empty name"}]}"#,
            #"{"type":"entries","entries":[{"id":"a2","role":"assistant","blocks":[{"type":"toolCall","id":"tc","name":"bash","args":{}}]},{"id":"tr4","role":"toolResult","toolCallId":"tc","toolName":"read","text":"wrong tool"}]}"#,
        ] {
            let malformedApplied = reducer.reduce(try decode(json))
            #expect(malformedApplied == false)
            #expect(reducer == before)
        }
    }

    @Test("Empty, duplicate, and unsupported durable identities are rejected")
    func invalidDurableIdentities() throws {
        for json in [
            #"{"type":"entries","entries":[{"id":"","role":"user","text":"x"}]}"#,
            #"{"type":"entries","entries":[{"id":"same","role":"user","text":"x"},{"id":"same","role":"user","text":"x"}]}"#,
            #"{"type":"entries","entries":[{"id":"future","role":"futureRole","text":"x"}]}"#,
        ] {
            var reducer = ChatReducer()
            let applied = reducer.reduce(try decode(json))
            #expect(applied == false)
            #expect(reducer.items.isEmpty)
        }
    }

    @Test("Explicit empty full projection clears transcript")
    func explicitEmptyProjection() throws {
        var reducer = ChatReducer()
        let initialApplied = reducer.reduce(try decode(#"{"type":"entries","entries":[{"id":"u1","role":"user","text":"x"}]}"#))
        #expect(initialApplied)
        let emptyApplied = reducer.reduce(try decode(#"{"type":"sync","fromStart":true,"entries":[],"items":[{"role":"user","content":"legacy"}]}"#))
        #expect(emptyApplied)
        #expect(reducer.items.isEmpty)
        #expect(reducer.durableEntryIds.isEmpty)
    }

    @Test("Notes and durable timestamps preserve server truth")
    func noteAndTimestamp() throws {
        var reducer = ChatReducer()
        let applied = reducer.reduce(try decode(#"{"type":"entries","entries":[{"id":"n1","role":"note","kind":"recovery","text":"Turn resumed","timestamp":"2026-08-29T12:34:56.123Z"}]}"#))
        #expect(applied)
        guard case .system(let note) = reducer.items.first else {
            Issue.record("Expected durable note")
            return
        }
        #expect(note.key == "recovery")
        #expect(note.content == "🔄 Turn resumed")
        #expect(note.sentAt == ISODate.parse("2026-08-29T12:34:56.123Z"))
    }

    @Test("History IDs prevent duplicate incremental replay")
    func historyReplayDeduplicates() throws {
        var reducer = ChatReducer()
        reducer.loadHistory([
            .init(role: "user", id: "u1", content: "hello"),
            .init(role: "assistant", id: "a1", content: "answer"),
        ])
        let replay = try decode(#"{"type":"entries","entries":[{"id":"u1","role":"user","text":"hello"},{"id":"a1","role":"assistant","text":"answer"}]}"#)
        let replayApplied = reducer.reduce(replay)
        #expect(replayApplied)
        #expect(reducer.items.map(\.id) == ["u1", "a1"])
    }

    @Test("Durable user keeps Pi entry id and submission lifecycle linkage")
    func durableSubmissionLinkage() throws {
        var reducer = ChatReducer()
        reducer.appendSubmission(.init(id: "submission-1", prompt: "ship", mode: .goal))
        let entry = try decode(#"{"type":"entries","entries":[{"id":"pi-entry-1","role":"user","text":"ship","submissionId":"submission-1"}]}"#)
        let entryApplied = reducer.reduce(entry)
        #expect(entryApplied)
        reducer.reconcileSubmission(.init(
            id: "submission-1", prompt: "ship", mode: .goal,
            status: .completed, error: nil
        ))
        #expect(reducer.items.count == 1)
        guard case .user(let user) = reducer.items[0] else {
            Issue.record("Expected durable user")
            return
        }
        #expect(user.id == "pi-entry-1")
        #expect(user.submissionId == "submission-1")
        #expect(user.mode == .goal)
        #expect(user.submissionStatus == .completed)
    }

    @Test("Sync composes durable transcript with one live overlay")
    func durablePlusLiveOverlay() throws {
        var reducer = ChatReducer()
        let startApplied = reducer.reduce(.messageStart(messageId: "old-live"))
        #expect(startApplied)
        let sync = try decode(#"{"type":"sync","streaming":true,"fromStart":true,"entries":[{"id":"u1","role":"user","text":"hello"}],"live":{"messageId":"new-live","text":"draft","thinking":"think","tools":[]}}"#)
        let syncApplied = reducer.reduce(sync)
        #expect(syncApplied)
        #expect(reducer.items.count == 2)
        #expect(reducer.items[0].id == "u1")
        guard case .assistant(let live) = reducer.items[1] else {
            Issue.record("Expected live assistant")
            return
        }
        #expect(live.id == "live-new-live")
        #expect(live.done == false)
        #expect(live.blocks == [.thinking(.init(text: "think")), .text(.init(text: "draft"))])
    }

    @Test("Cursor acknowledgement cannot leapfrog an unapplied frame")
    func cursorAcknowledgementBarrier() async throws {
        let client = SSEClient(url: URL(string: "https://example.test/events")!, token: nil)
        let collector = Task { () -> [SSEFrame] in
            var frames: [SSEFrame] = []
            for await frame in client.events() { frames.append(frame) }
            return frames
        }
        try await client.consume(DurableLineStream(lines: [
            "id: durable-1", #"data: {"type":"entries","entries":[]}"#,
            #"data: {"type":"ping"}"#,
            "id: future-2", #"data: {"type":"future_event"}"#,
            "id: durable-3", #"data: {"type":"ping"}"#,
            "id:\0ignored", #"data: {"type":"ping"}"#,
            "id:", #"data: {"type":"ping"}"#,
        ]))
        await client.stop()
        let frames = await collector.value
        #expect(frames.count == 6)

        await client.acknowledge(frames[0])
        await client.acknowledge(frames[1])
        #expect(await client.reconnectCursor == "durable-1")
        await client.acknowledge(frames[2], applied: false)
        await client.acknowledge(frames[3])
        await client.acknowledge(frames[4])
        await client.acknowledge(frames[5])
        #expect(await client.reconnectCursor == "durable-1")
    }
}

private actor NativeDurableTransport: SessionTransport {
    nonisolated func makeURL(_ path: String) -> URL { URL(string: "https://example.test\(path)")! }
    func currentToken() -> String? { "token" }
    func getMessages(_ sessionId: String) async throws -> [APIClient.HistoryMessage] { [] }
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

private struct DurableLineStream: AsyncSequence {
    typealias Element = String
    let lines: [String]
    func makeAsyncIterator() -> Iterator { Iterator(lines: lines) }
    struct Iterator: AsyncIteratorProtocol {
        var lines: [String]
        mutating func next() async -> String? { lines.isEmpty ? nil : lines.removeFirst() }
    }
}
