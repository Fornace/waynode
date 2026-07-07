import Testing
import Foundation
@testable import WaynodeCore

// MARK: - ChatReducer adversarial tests
//
// Every test covers a specific failure mode of the state machine. These are
// NOT "happy path" tests — they target the exact edges where a naive reducer
// would crash, duplicate, or desync.
//
// NOTE: We cannot write `#expect(r.reduce(...))` because the Testing macro
// captures `r` by immutable value, blocking the mutating call. Instead we
// store the result in a `let` and assert on that.

@Suite("ChatReducer")
struct ChatReducerTests {

    // Helper to fold an event and assert it was accepted.
    @discardableResult
    private mutating func ok(_ r: inout ChatReducer, _ event: SSEEvent.Kind) -> Bool {
        let b = r.reduce(event)
        return b
    }

    // MARK: Happy path — a full assistant turn

    @Test("Full turn: start → text deltas → message_end → turn_end")
    func fullTurn() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.textDelta(messageId: "m1", delta: "Hello"))
        _ = r.reduce(.textDelta(messageId: "m1", delta: " world"))
        _ = r.reduce(.messageEnd(messageId: "m1"))
        _ = r.reduce(.turnEnd)

        #expect(r.items.count == 1)
        if case .assistant(let a) = r.items[0] {
            #expect(a.done == true)
            if case .text(let tb) = a.blocks[0] {
                #expect(tb.text == "Hello world")
            }
        }
        #expect(r.isStreaming == false)
    }

    // MARK: Duplicate message_start (server retry / reconnect)

    @Test("Duplicate message_start is ignored, not duplicated")
    func duplicateMessageStart() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.textDelta(messageId: "m1", delta: "A"))
        // Server sends message_start again (reconnect or retry).
        let result = r.reduce(.messageStart(messageId: "m1"))
        #expect(result == false)
        #expect(r.items.count == 1)
    }

    // MARK: Text deltas append to last text block

    @Test("Multiple text deltas concatenate into one text block")
    func textConcatenation() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        for ch in "abcdefghij" {
            _ = r.reduce(.textDelta(messageId: "m1", delta: String(ch)))
        }
        if case .assistant(let a) = r.items[0] {
            #expect(a.blocks.count == 1)
            if case .text(let tb) = a.blocks[0] {
                #expect(tb.text == "abcdefghij")
            }
        }
    }

    // MARK: Text after thinking creates a NEW text block

    @Test("Text after thinking creates a new text block")
    func textAfterThinking() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.textDelta(messageId: "m1", delta: "First "))
        _ = r.reduce(.thinkingDelta(messageId: "m1", delta: "thinking..."))
        _ = r.reduce(.textDelta(messageId: "m1", delta: "Second"))
        if case .assistant(let a) = r.items[0] {
            #expect(a.blocks.count == 3) // text, thinking, text
        }
    }

    // MARK: Tool lifecycle

    @Test("Tool start → delta → end produces a complete tool block")
    func toolLifecycle() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.toolStart(toolName: "bash", toolCallId: "t1", toolInput: "ls"))
        _ = r.reduce(.toolDelta(toolCallId: "t1", delta: "file1\n"))
        _ = r.reduce(.toolDelta(toolCallId: "t1", delta: "file2\n"))
        _ = r.reduce(.toolEnd(toolCallId: "t1", finalOutput: nil, isError: false))
        if case .assistant(let a) = r.items[0] {
            #expect(a.blocks.count == 1)
            if case .tool(let tb) = a.blocks[0] {
                #expect(tb.name == "bash")
                #expect(tb.args == "ls")
                #expect(tb.output == "file1\nfile2\n")
                #expect(tb.status == .done)
            }
        }
    }

    @Test("Multiple tools in one message")
    func multipleTools() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.toolStart(toolName: "bash", toolCallId: "t1", toolInput: "echo a"))
        _ = r.reduce(.toolStart(toolName: "bash", toolCallId: "t2", toolInput: "echo b"))
        _ = r.reduce(.toolDelta(toolCallId: "t1", delta: "a"))
        _ = r.reduce(.toolDelta(toolCallId: "t2", delta: "b"))
        _ = r.reduce(.toolEnd(toolCallId: "t1", finalOutput: nil, isError: false))
        _ = r.reduce(.toolEnd(toolCallId: "t2", finalOutput: nil, isError: false))
        if case .assistant(let a) = r.items[0] {
            #expect(a.blocks.count == 2)
        }
    }

    // MARK: Bug #26 — tool_end with finalOutput (fast tools, no delta)

    @Test("tool_end finalOutput populates output when no delta was emitted")
    func toolEndFinalOutput() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.toolStart(toolName: "read", toolCallId: "t1", toolInput: "file.txt"))
        // NO tool_delta — fast tool completes instantly
        _ = r.reduce(.toolEnd(toolCallId: "t1", finalOutput: "hello world", isError: false))
        if case .assistant(let a) = r.items[0] {
            if case .tool(let tb) = a.blocks[0] {
                #expect(tb.output == "hello world")
                #expect(tb.status == .done)
            }
        }
    }

    @Test("tool_end with isError sets error status")
    func toolEndError() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.toolStart(toolName: "bash", toolCallId: "t1", toolInput: "false"))
        _ = r.reduce(.toolEnd(toolCallId: "t1", finalOutput: "exit code 1", isError: true))
        if case .assistant(let a) = r.items[0] {
            if case .tool(let tb) = a.blocks[0] {
                #expect(tb.output == "exit code 1")
                #expect(tb.status == .error)
            }
        }
    }

    // MARK: Late tool_delta for unknown toolCallId

    @Test("Tool delta for unknown toolCallId is dropped")
    func lateToolDelta() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        // tool_delta without preceding tool_start
        let result = r.reduce(.toolDelta(toolCallId: "ghost", delta: "x"))
        #expect(result == false)
        #expect(r.items.count == 1)
        if case .assistant(let a) = r.items[0] {
            #expect(a.blocks.count == 0)
        }
    }

    // MARK: Text delta for unknown messageId

    @Test("Text delta for unknown messageId is dropped")
    func unknownMessageDelta() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        let result = r.reduce(.textDelta(messageId: "unknown", delta: "x"))
        #expect(result == false)
    }

    // MARK: Error event sets lastError and stops streaming

    @Test("Error event stops streaming and stores message")
    func errorEvent() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.textDelta(messageId: "m1", delta: "partial"))
        _ = r.reduce(.error(message: "Connection lost"))
        #expect(r.lastError == "Connection lost")
        #expect(r.isStreaming == false)
        // The assistant message should be finalised (done=true).
        if case .assistant(let a) = r.items[0] {
            #expect(a.done == true)
        }
    }

    // MARK: turn_end finalises un-done assistant messages

    @Test("turn_end finalises a message that never got message_end")
    func turnEndFinalises() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.textDelta(messageId: "m1", delta: "incomplete"))
        // No message_end — turn_end should finalise.
        _ = r.reduce(.turnEnd)
        if case .assistant(let a) = r.items[0] {
            #expect(a.done == true)
        }
    }

    // MARK: turn_end finalises running tool blocks

    @Test("turn_end marks running tools as done")
    func turnEndMarksToolsDone() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.toolStart(toolName: "bash", toolCallId: "t1", toolInput: "x"))
        // No tool_end — turn_end should finalise.
        _ = r.reduce(.turnEnd)
        if case .assistant(let a) = r.items[0], case .tool(let tb) = a.blocks[0] {
            #expect(tb.status == .done)
        }
    }

    // MARK: Status event updates statusText

    @Test("Status event sets and clears statusText")
    func statusEvent() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.status(text: "Running bash"))
        #expect(r.statusText == "Running bash")
        _ = r.reduce(.status(text: ""))
        #expect(r.statusText == nil)
    }

    // MARK: Ping is a no-op

    @Test("Ping events are accepted but do nothing")
    func pingEvent() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        let result = r.reduce(.ping)
        #expect(result)
        #expect(r.items.isEmpty)
    }

    // MARK: session_renamed is handled by store, not reducer

    @Test("session_renamed returns false (handled by store)")
    func sessionRenamed() {
        var r = ChatReducer()
        let result = r.reduce(.sessionRenamed(title: "New Title"))
        #expect(result == false)
    }

    // MARK: Reset

    @Test("reset() clears everything")
    func reset() {
        var r = ChatReducer()
        _ = r.reduce(.start)
        _ = r.reduce(.messageStart(messageId: "m1"))
        _ = r.reduce(.textDelta(messageId: "m1", delta: "x"))
        r.reset()
        #expect(r.items.isEmpty)
        #expect(r.msgIndex.isEmpty)
        #expect(r.toolIndex.isEmpty)
        #expect(r.isStreaming == false)
    }

    // MARK: History loading preserves order

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
    func liveProductionBytes() {
        // Raw SSE frames captured from the live server (2026-07-07).
        let rawSSE = """
        data: {"type":"sync","streaming":false,"partialText":"","tools":[]}

        data: {"type":"start"}

        data: {"type":"message_start","messageId":"figen92p"}

        data: {"type":"text_delta","messageId":"figen92p","delta":"NATIVE-E2E-OK"}

        data: {"type":"message_end","messageId":"figen92p"}

        data: {"type":"end"}

        """

        // Parse SSE frames exactly as SSEClient does.
        var events: [SSEEvent] = []
        for block in rawSSE.components(separatedBy: "\n\n") {
            var dataLines: [String] = []
            for line in block.split(separator: "\n", omittingEmptySubsequences: false) {
                if line.hasPrefix("data:") {
                    dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                }
            }
            guard !dataLines.isEmpty,
                  let d = dataLines.joined(separator: "\n").data(using: .utf8),
                  let ev = try? JSONDecoder().decode(SSEEvent.self, from: d) else { continue }
            events.append(ev)
        }
        #expect(events.count == 6)

        // Fold through the real reducer, with an optimistic user message first
        // (exactly how SessionStore drives a live send).
        var r = ChatReducer()
        r.appendUser("Reply with exactly: NATIVE-E2E-OK")
        for e in events { _ = r.reduce(e.kind) }

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
