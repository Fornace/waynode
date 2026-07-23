import Testing
import Foundation
@testable import WaynodeCore

extension ChatReducerTests {
    @Test("History loads in order with correct roles")
    func historyLoad() {
        var r = ChatReducer()
        r.loadHistory([
            .init(role: "user", id: "u1", content: "Hello"),
            // Server sends assistant text as `content` (not `text`),
            // and optional reasoning as `thinking`.
            .init(role: "assistant", id: "a1", content: "Hi there"),
            .init(role: "user", id: "u2", content: "Bye"),
        ])
        #expect(r.items.count == 3)
        if case .user(let u) = r.items[0] { #expect(u.content == "Hello") }
        if case .assistant(let a) = r.items[1] {
            #expect(a.done == true)
            if case .text(let tb) = a.blocks[0] { #expect(tb.text == "Hi there") }
        }
        if case .user(let u) = r.items[2] { #expect(u.content == "Bye") }
    }

    // MARK: History loading with thinking blocks

    @Test("History assistant with thinking loads thinking before text")
    func historyLoadWithThinking() {
        var r = ChatReducer()
        r.loadHistory([
            .init(role: "user", id: "u1", content: "What is 2+2?"),
            .init(role: "assistant", id: "a1", content: "4", thinking: "2+2=4"),
        ])
        #expect(r.items.count == 2)
        if case .assistant(let a) = r.items[1] {
            #expect(a.blocks.count == 2)
            // Thinking comes first (matches web frontend)
            if case .thinking(let tb) = a.blocks[0] { #expect(tb.text == "2+2=4") }
            if case .text(let tb) = a.blocks[1] { #expect(tb.text == "4") }
        }
    }

    @Test("History assistant with only thinking and no text still loads")
    func historyLoadThinkingOnly() {
        var r = ChatReducer()
        r.loadHistory([
            .init(role: "assistant", id: "a1", thinking: "Just thinking"),
        ])
        #expect(r.items.count == 1)
        if case .assistant(let a) = r.items[0] {
            #expect(a.blocks.count == 1)
            if case .thinking(let tb) = a.blocks[0] { #expect(tb.text == "Just thinking") }
        }
    }

    @Test("History assistant with empty content and no thinking is skipped")
    func historyLoadEmptyAssistant() {
        var r = ChatReducer()
        r.loadHistory([
            .init(role: "user", id: "u1", content: "Hello"),
            .init(role: "assistant", id: "a1", content: ""),  // empty
            .init(role: "user", id: "u2", content: "World"),
        ])
        // Empty assistant message is skipped — only 2 items
        #expect(r.items.count == 2)
        if case .user(let u) = r.items[0] { #expect(u.content == "Hello") }
        if case .user(let u) = r.items[1] { #expect(u.content == "World") }
    }

    // MARK: Optimistic user append

    @Test("appendUser adds a user item")
    func appendUser() {
        var r = ChatReducer()
        r.appendUser("test message", isGoal: true)
        #expect(r.items.count == 1)
        if case .user(let u) = r.items[0] {
            #expect(u.content == "test message")
            #expect(u.isGoal == true)
        }
    }

    // MARK: Sync reconstruction (mid-turn reconnect)

    @Test("Sync reconstructs assistant items from snapshot")
    func syncReconstruction() {
        var r = ChatReducer()
        _ = r.reduce(.sync(snapshot: SyncSnapshot(items: [
            .init(role: "assistant", id: "m1", blocks: [
                .init(type: "text", text: "partial text"),
                .init(type: "tool", id: "t1", name: "bash", args: "ls", output: "file", status: "running"),
            ]),
        ])))
        #expect(r.items.count == 1)
        #expect(r.isStreaming == true)
        if case .assistant(let a) = r.items[0] {
            #expect(a.blocks.count == 2)
            #expect(a.done == false) // in-progress
            // Tool index should be rebuilt.
            #expect(r.toolIndex["t1"] != nil)
        }
    }

    @Test("Sync does not duplicate existing messages")
    func syncNoDuplicate() {
        var r = ChatReducer()
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.textDelta(messageId: "m1", delta: "first"))
        // Reconnect sync with the same message.
        _ = r.reduce(.sync(snapshot: SyncSnapshot(items: [
            .init(role: "assistant", id: "m1", text: "first"),
        ])))
        #expect(r.items.count == 1)
    }

    // MARK: Multi-turn sequence

    @Test("Two consecutive turns produce 4 items (2 user + 2 assistant)")
    func multiTurn() {
        var r = ChatReducer()
        // Turn 1
        r.appendUser("Q1")
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.textDelta(messageId: "m1", delta: "A1"))
        _ = r.reduce(.messageEnd(messageId: "m1"))
        _ = r.reduce(.turnEnd)
        // Turn 2
        r.appendUser("Q2")
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m2"))
        _ = r.reduce(.textDelta(messageId: "m2", delta: "A2"))
        _ = r.reduce(.messageEnd(messageId: "m2"))
        _ = r.reduce(.end)

        #expect(r.items.count == 4)
    }

    // MARK: Unknown event type is ignored

    @Test("Unknown event type is ignored")
    func unknownEvent() {
        var r = ChatReducer()
        // SSEEvent decodes unknown types to .unknown
        let result = r.reduce(.unknown)
        #expect(result == false)
    }

    // MARK: Empty delta does not crash

    @Test("Empty text delta creates an empty text block (web-faithful)")
    func emptyDelta() {
        var r = ChatReducer()
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.textDelta(messageId: "m1", delta: ""))
        if case .assistant(let a) = r.items[0] {
            #expect(a.blocks.count == 1) // empty block created (matches sessionStore.ts)
            if case .text(let tb) = a.blocks[0] { #expect(tb.text == "") }
        }
    }

    // MARK: tool_start without message_start (should not crash)

    @Test("Tool start without active message is dropped")
    func toolWithoutMessage() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        let result = r.reduce(.toolStart(toolName: "bash", toolCallId: "t1", toolInput: "x"))
        #expect(result == false)
        #expect(r.items.isEmpty)
    }
}

// MARK: - SSE event decoding

@Suite("SSE Decoding")
struct SSEDecodingTests {

    private func decode(_ json: String) -> SSEEvent.Kind? {
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(SSEEvent.self, from: data).kind
    }

    @Test("Decodes all event types")
    func decodeAll() {
        #expect(decode(#"{"type":"start"}"#) == .start)
        #expect(decode(#"{"type":"turn_start"}"#) == .turnStart)
        #expect(decode(#"{"type":"turn_end"}"#) == .turnEnd)
        #expect(decode(#"{"type":"end"}"#) == .end)
        #expect(decode(#"{"type":"ping"}"#) == .ping)
        #expect(decode(#"{"type":"error","message":"oops"}"#) == .error(message: "oops"))
        #expect(decode(#"{"type":"status","text":"working"}"#) == .status(text: "working"))
    }

    @Test("Decodes message_start with messageId")
    func decodeMessageStart() {
        #expect(decode(#"{"type":"message_start","messageId":"m1"}"#) == .messageStart(messageId: "m1"))
    }

    @Test("Decodes text_delta")
    func decodeTextDelta() {
        #expect(decode(#"{"type":"text_delta","messageId":"m1","delta":"hi"}"#) == .textDelta(messageId: "m1", delta: "hi"))
    }

    @Test("Decodes tool_start with toolInput")
    func decodeToolStart() {
        #expect(decode(#"{"type":"tool_start","toolName":"bash","toolCallId":"t1","toolInput":"ls"}"#) == .toolStart(toolName: "bash", toolCallId: "t1", toolInput: "ls"))
    }

    @Test("Decodes tool_start without toolInput")
    func decodeToolStartNoInput() {
        let d = decode(#"{"type":"tool_start","toolName":"bash","toolCallId":"t1"}"#)
        if case .toolStart(let name, let id, let input) = d {
            #expect(name == "bash")
            #expect(id == "t1")
            #expect(input == nil)
        } else {
            Issue.record("expected toolStart")
        }
    }

    @Test("Unknown type decodes to .unknown")
    func decodeUnknown() {
        #expect(decode(#"{"type":"future_event"}"#) == .unknown)
    }

    @Test("Missing type decodes to .unknown")
    func decodeMissingType() {
        #expect(decode(#"{"foo":"bar"}"#) == .unknown)
    }

    @Test("Missing delta defaults to empty string")
    func decodeMissingDelta() {
        #expect(decode(#"{"type":"text_delta","messageId":"m1"}"#) == .textDelta(messageId: "m1", delta: ""))
    }

    @Test("Invalid JSON returns nil")
    func decodeInvalid() {
        #expect(decode("not json") == nil)
    }

    // MARK: Live integration — real bytes captured from production server
    //
    // These bytes were captured from `GET /api/sessions/:id/stream` on
    // waynode.fornace.net for a real agent turn (prompt: "Reply with exactly:
    // NATIVE-E2E-OK"). Running them through the REAL ChatReducer proves the
    // full server → SSEEvent decode → reducer → transcript path is correct,
    // not just the hand-written unit scenarios above.

    @Test("Real production SSE bytes produce correct transcript")
    func liveProductionBytes() async throws {
        // Raw SSE frames captured from the live server (2026-07-07).
        let rawSSE = """
        data: {"type":"sync","streaming":false,"partialText":"","tools":[]}

        data: {"type":"start"}

        data: {"type":"message_start","messageId":"figen92p"}

        data: {"type":"text_delta","messageId":"figen92p","delta":"NATIVE-E2E-OK"}

        data: {"type":"message_end","messageId":"figen92p"}

        data: {"type":"end"}

        """

        // Deliver the frames through the REAL SSEClient parser, line by line
        // as URLSession's AsyncLineSequence does — which means the blank
        // event-boundary lines are dropped before consume() ever sees them.
        let lines = rawSSE.components(separatedBy: "\n").filter { !$0.isEmpty }
        let client = SSEClient(url: URL(string: "https://example.test/stream")!, token: nil)
        let collector = Task { () -> [SSEEvent.Kind] in
            var got: [SSEEvent.Kind] = []
            for await event in client.events() { got.append(event) }
            return got
        }
        try await client.consume(LineStream(lines: lines))
        await client.stop()
        let events = await collector.value
        #expect(events.count == 6)

        // Fold through the real reducer, with an optimistic user message first
        // (exactly how SessionStore drives a live send).
        var r = ChatReducer()
        r.appendUser("Reply with exactly: NATIVE-E2E-OK")
        for e in events { _ = r.reduce(e) }

        #expect(r.items.count == 2)
        #expect(r.isStreaming == false)
        if case .user(let u) = r.items[0] {
            #expect(u.content == "Reply with exactly: NATIVE-E2E-OK")
            #expect(u.isGoal == false)
        } else {
            Issue.record("item[0] should be user message")
        }
        if case .assistant(let a) = r.items[1] {
            #expect(a.done == true)
            #expect(a.blocks.count == 1)
            if case .text(let tb) = a.blocks[0] {
                #expect(tb.text == "NATIVE-E2E-OK")
            } else {
                Issue.record("expected a single text block")
            }
        } else {
            Issue.record("item[1] should be assistant message")
        }
    }
}
