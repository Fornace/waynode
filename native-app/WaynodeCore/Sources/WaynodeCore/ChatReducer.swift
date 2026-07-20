import Foundation

// MARK: - ChatReducer
//
// A pure value type that folds SSE events into a transcript. No I/O, no
// concurrency — fully deterministic and unit-testable. This is a faithful
// port of frontend/src/lib/sessionStore.ts.
//
// Key invariants (from sessionStore.ts):
//   • msgIndex maps messageId → index of the assistant ChatItem in `items`.
//   • textDelta/thinkingDelta append to the *last* text/thinking block of the
//     message, creating one if none exists.
//   • toolStart appends a new tool block in `running` status.
//   • toolDelta appends to the matching tool block's output.
//   • toolEnd marks the tool block `done`.
//   • messageEnd marks the assistant message `done`.
//   • sync reconstructs partial text from snapshot.items.
//   • status updates a transient status label (shown in the input bar).
//   • error stores a terminal error for the turn.
//   • Duplicate message_start for the same messageId is ignored (server retry).
//   • Events for unknown messageIds (late tool_delta) are dropped silently.

public struct ChatReducer: Sendable, Equatable {
    // The transcript — user, assistant, and system rows in order.
    public internal(set) var items: [ChatItem] = []
    // messageId → items array index (only assistant items tracked here).
    public internal(set) var msgIndex: [String: Int] = [:]
    // toolCallId → location of the tool block inside items.
    public internal(set) var toolIndex: [String: ToolLocation] = [:]

    /// Monotonically increasing counter bumped on every content mutation.
    /// Used by SwiftUI views to detect streaming updates (where item count
    /// and IDs stay the same but content grows). Observing this drives
    /// auto-scroll-to-bottom during streaming.
    public internal(set) var revision: Int = 0

    /// Location of a tool block within the transcript.
    public struct ToolLocation: Hashable, Sendable {
        public var itemIdx: Int
        public var blockIdx: Int
    }

    // Transient turn state
    public private(set) var isStreaming: Bool = false
    public private(set) var statusText: String?
    public private(set) var lastError: String?
    public private(set) var turnEnded: Bool = false
    public private(set) var submissionState = ChatSubmissionState()

    // The id of the assistant message currently receiving deltas. Cleared on
    // message_end. Used to resolve text_delta events that omit messageId
    // (defensive: the server always sends it, but the web client falls back
    // to "last assistant message").
    public private(set) var currentAssistantId: String?

    public init() {}

    // MARK: - User message (optimistic, before sending)

    /// Append a user message optimistically. The server does NOT echo the
    /// user message back over SSE — the web client appends it locally too.
    public mutating func appendUser(_ content: String, isGoal: Bool = false, id: String? = nil) {
        let mid = id ?? UUID().uuidString
        items.append(.user(.init(id: mid, content: content, isGoal: isGoal)))
        revision += 1
    }

    public mutating func appendSubmission(_ draft: SubmissionDraft) {
        reconcileSubmission(.init(
            id: draft.id, prompt: draft.prompt, isGoal: draft.isGoal,
            status: .sending, error: nil
        ), kind: draft.kind)
    }

    public mutating func reconcileSubmission(
        _ submission: Submission,
        accepted: Bool = true,
        kind: SubmissionDraft.Kind = .message
    ) {
        submissionState.reconcile(items: &items, submission: submission, accepted: accepted, kind: kind)
        revision += 1
    }

    public mutating func discardFailedDraft() { submissionState.discardFailedDraft(); revision += 1 }

    // MARK: - Event folding

    @discardableResult
    public mutating func reduce(_ event: SSEEvent.Kind) -> Bool {
        lastError = nil // reset on any new event (non-error events clear a stale error)
        revision += 1
        switch event {
        case .start:
            isStreaming = true
            turnEnded = false
            return true

        case .turnStart:
            isStreaming = true
            return true

        case .messageStart(let messageId):
            // Guard against duplicate message_start (server retries / reconnect sync).
            if msgIndex[messageId] != nil { return false }
            let idx = items.count
            items.append(.assistant(.init(id: messageId, blocks: [], done: false)))
            msgIndex[messageId] = idx
            currentAssistantId = messageId
            return true

        case .textDelta(let messageId, let delta):
            guard let mid = resolveMessageId(messageId), let idx = msgIndex[mid] else { return false }
            appendTextDelta(delta, to: idx)
            return true

        case .thinkingDelta(let messageId, let delta):
            guard let mid = resolveMessageId(messageId), let idx = msgIndex[mid] else { return false }
            appendThinkingDelta(delta, to: idx)
            return true

        case .messageEnd(let messageId):
            guard let idx = msgIndex[messageId] else { return false }
            markAssistantDone(at: idx)
            if currentAssistantId == messageId { currentAssistantId = nil }
            return true

        case .toolStart(let name, let callId, let input):
            guard let mid = currentAssistantId, let idx = msgIndex[mid] else { return false }
            appendToolBlock(name: name, callId: callId, input: input, to: idx)
            return true

        case .toolDelta(let callId, let delta):
            guard let loc = toolIndex[callId] else { return false }
            appendToolOutput(delta, itemIdx: loc.itemIdx, blockIdx: loc.blockIdx)
            return true

        case .toolEnd(let callId, let finalOutput, let isError):
            guard let loc = toolIndex[callId] else { return false }
            markToolDone(itemIdx: loc.itemIdx, blockIdx: loc.blockIdx, finalOutput: finalOutput, isError: isError)
            return true

        case .turnEnd:
            // Turn finished but stream may stay open for the next turn.
            isStreaming = false
            // Finalise any un-done assistant message (defensive: if message_end
            // was missed due to a brief disconnect).
            finalisePendingAssistant()
            return true

        case .end:
            isStreaming = submissionState.queuedCount > 0
            turnEnded = true
            finalisePendingAssistant()
            return true

        case .error(let message):
            lastError = message
            isStreaming = false
            turnEnded = true
            finalisePendingAssistant()
            return true

        case .status(let text):
            statusText = text.isEmpty ? nil : text
            return true

        case .submission(let submission):
            reconcileSubmission(submission)
            if submission.status == .starting { statusText = "Starting agent…" }
            if submission.status == .running { statusText = "Agent working"; isStreaming = true }
            if [.completed, .failed, .cancelled].contains(submission.status) { statusText = nil }
            return true

        case .hammersmithRun(let submission, let run):
            if let submission { reconcileSubmission(submission) }
            upsertHammersmithRun(run)
            return true

        case .sync(let snapshot):
            applySync(snapshot)
            return true

        case .sessionRenamed:
            // Handled by the store (title mutation on Session), not the reducer
            // body. We no-op here; the store observes this via the event stream.
            return false

        case .ping:
            return true

        case .unknown:
            return false
        }
    }

    // MARK: - Helpers

    /// If `messageId` is empty, fall back to currentAssistantId (web client
    /// behaviour for defensive decoding).
    private func resolveMessageId(_ messageId: String) -> String? {
        if !messageId.isEmpty { return messageId }
        return currentAssistantId
    }

    private mutating func appendTextDelta(_ delta: String, to itemIdx: Int) {
        guard case .assistant(var a) = items[itemIdx] else { return }
        // Find last text block; if the last block isn't text, create a new one.
        if let lastIdx = a.blocks.indices.last, case .text(var tb) = a.blocks[lastIdx] {
            tb.text += delta
            a.blocks[lastIdx] = .text(tb)
        } else {
            a.blocks.append(.text(.init(text: delta)))
        }
        items[itemIdx] = .assistant(a)
    }

    private mutating func appendThinkingDelta(_ delta: String, to itemIdx: Int) {
        guard case .assistant(var a) = items[itemIdx] else { return }
        if let lastIdx = a.blocks.indices.last, case .thinking(var tb) = a.blocks[lastIdx] {
            tb.text += delta
            a.blocks[lastIdx] = .thinking(tb)
        } else {
            a.blocks.append(.thinking(.init(text: delta)))
        }
        items[itemIdx] = .assistant(a)
    }

    private mutating func appendToolBlock(name: String, callId: String, input: String?, to itemIdx: Int) {
        guard case .assistant(var a) = items[itemIdx] else { return }
        let blockIdx = a.blocks.count
        a.blocks.append(.tool(.init(id: callId, name: name, args: input ?? "", output: "", status: .running)))
        items[itemIdx] = .assistant(a)
        toolIndex[callId] = ToolLocation(itemIdx: itemIdx, blockIdx: blockIdx)
    }

    private mutating func appendToolOutput(_ delta: String, itemIdx: Int, blockIdx: Int) {
        guard case .assistant(var a) = items[itemIdx], blockIdx < a.blocks.count else { return }
        guard case .tool(var tb) = a.blocks[blockIdx] else { return }
        tb.output += delta
        a.blocks[blockIdx] = .tool(tb)
        items[itemIdx] = .assistant(a)
    }

    private mutating func markToolDone(itemIdx: Int, blockIdx: Int, finalOutput: String?, isError: Bool) {
        guard case .assistant(var a) = items[itemIdx], blockIdx < a.blocks.count else { return }
        guard case .tool(var tb) = a.blocks[blockIdx] else { return }
        // If finalOutput is provided and the tool emitted no delta events,
        // use it as the output (handles fast tools that complete instantly).
        if let final = finalOutput, !final.isEmpty, tb.output.isEmpty {
            tb.output = final
        }
        tb.status = isError ? .error : .done
        a.blocks[blockIdx] = .tool(tb)
        items[itemIdx] = .assistant(a)
    }

    private mutating func markAssistantDone(at itemIdx: Int) {
        guard case .assistant(var a) = items[itemIdx] else { return }
        a.done = true
        // Mark any still-running tool blocks as done (defensive).
        for i in a.blocks.indices {
            if case .tool(var tb) = a.blocks[i], tb.status == .running {
                tb.status = .done
                a.blocks[i] = .tool(tb)
            }
        }
        items[itemIdx] = .assistant(a)
    }

    /// On turn_end / end / error: if the current assistant message was never
    /// marked done, mark it done now so the UI shows a complete turn.
    private mutating func finalisePendingAssistant() {
        for i in items.indices {
            if case .assistant(let a) = items[i], !a.done {
                markAssistantDone(at: i)
            }
        }
        currentAssistantId = nil
    }

    // MARK: - Sync reconstruction

    /// When reconnecting mid-turn, the server sends a `sync` event with the
    /// partial transcript of the current turn. We reconstruct assistant items
    /// from the snapshot. Existing history items are preserved.
    private mutating func applySync(_ snapshot: SyncSnapshot) {
        isStreaming = snapshot.streaming
        for submission in snapshot.submissions { reconcileSubmission(submission) }
        for wire in snapshot.items {
            switch wire.role {
            case "assistant":
                // Build the block list for this wire item once.
                var blocks: [Block] = []
                if let txt = wire.text, !txt.isEmpty { blocks.append(.text(.init(text: txt))) }
                if let th = wire.thinking, !th.isEmpty { blocks.append(.thinking(.init(text: th))) }
                for wb in wire.blocks ?? [] {
                    switch wb.type {
                    case "text": if let t = wb.text { blocks.append(.text(.init(text: t))) }
                    case "thinking": if let t = wb.text { blocks.append(.thinking(.init(text: t))) }
                    case "tool":
                        blocks.append(.tool(.init(
                            id: wb.id ?? UUID().uuidString,
                            name: wb.name ?? "",
                            args: wb.args ?? "",
                            output: wb.output ?? "",
                            status: .init(rawValue: wb.status ?? "running") ?? .running
                        )))
                    default: break
                    }
                }
                let done = !snapshot.streaming
                if let mid = wire.id {
                    // Known id: dedup against existing messages on reconnect.
                    if msgIndex[mid] != nil { continue }
                    appendSyncedAssistant(id: mid, blocks: blocks, done: done)
                } else if let idx = inFlightAssistantIndex() {
                    // No id but an assistant item is still streaming: reconcile
                    // the sync partial text into it instead of appending a
                    // duplicate row. The server's partial-text WireItem omits
                    // id (Chat.swift decoder hardcodes id:nil), so the old code
                    // minted a random UUID that could never match msgIndex —
                    // the dedup guard never fired and a second assistant row
                    // appeared on every reconnect alongside the original.
                    if let txt = wire.text, !txt.isEmpty {
                        reconcileAssistantText(at: idx, with: txt)
                    }
                } else {
                    // No id and no in-flight assistant item: mint one (legacy
                    // reconnect path where the client has nothing locally).
                    appendSyncedAssistant(id: UUID().uuidString, blocks: blocks, done: done)
                }
            case "user":
                let mid = wire.id ?? UUID().uuidString
                items.append(.user(.init(id: mid, content: wire.content ?? "", isGoal: wire.isGoal ?? false)))
            case "system":
                let mid = wire.id ?? UUID().uuidString
                items.append(.system(.init(id: mid, content: wire.content ?? "", key: nil)))
            default:
                break
            }
        }
    }

    /// Index of the assistant item currently receiving a stream (the message
    /// that is not yet done). Prefers currentAssistantId; falls back to the
    /// last non-done assistant item.
    private func inFlightAssistantIndex() -> Int? {
        if let mid = currentAssistantId, let idx = msgIndex[mid],
           case .assistant(let a) = items[idx], !a.done {
            return idx
        }
        for i in stride(from: items.count - 1, through: 0, by: -1) {
            if case .assistant(let a) = items[i], !a.done { return i }
        }
        return nil
    }

    /// Replace the streaming assistant item's text content with the sync
    /// partial. The sync event carries the authoritative accumulated partial
    /// for the current turn, so we overwrite (not append) the text block.
    private mutating func reconcileAssistantText(at itemIdx: Int, with partial: String) {
        guard case .assistant(var a) = items[itemIdx] else { return }
        if let lastIdx = a.blocks.indices.last, case .text = a.blocks[lastIdx] {
            a.blocks[lastIdx] = .text(.init(text: partial))
        } else {
            a.blocks.append(.text(.init(text: partial)))
        }
        items[itemIdx] = .assistant(a)
    }

    /// Append a reconstructed assistant item (from history/sync) and rebuild
    /// the tool index for any tool blocks it carries.
    private mutating func appendSyncedAssistant(id: String, blocks: [Block], done: Bool) {
        let idx = items.count
        items.append(.assistant(.init(id: id, blocks: blocks, done: done)))
        msgIndex[id] = idx
        if case .assistant(let a) = items[idx] {
            for bi in a.blocks.indices {
                if case .tool(let tb) = a.blocks[bi] {
                    toolIndex[tb.id] = ToolLocation(itemIdx: idx, blockIdx: bi)
                }
            }
        }
    }

    // MARK: - Reset

    /// Reset transient turn state for a new session view (keeps loaded history).
    public mutating func resetTurn() {
        isStreaming = false
        statusText = nil
        lastError = nil
        turnEnded = false
        currentAssistantId = nil
    }

    /// Full reset — clear everything (used when switching sessions).
    public mutating func reset() {
        revision += 1
        items.removeAll()
        msgIndex.removeAll()
        toolIndex.removeAll()
        submissionState.reset()
        resetTurn()
    }
}
