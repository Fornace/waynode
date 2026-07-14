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

}
