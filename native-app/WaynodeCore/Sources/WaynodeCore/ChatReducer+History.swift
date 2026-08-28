import Foundation

// MARK: - History loading (before SSE starts)
//
// Same module, behaviour identical to the original in-file members — moved
// here to keep ChatReducer.swift under the repo's 400-line file gate.

extension ChatReducer {
    /// Load persisted history from `/api/sessions/:id/messages`. Called once
    /// before the SSE stream opens. History items are marked done/stable.
    public mutating func loadHistory(_ history: [HistoryItem]) {
        revision += 1
        for h in history {
            switch h.role {
            case "user":
                // The persisted transcript carries no submission mode — the
                // server stores the prompt the agent saw, not how it was
                // submitted — so replayed rows are plain messages.
                items.append(.user(.init(id: h.id, content: h.content ?? "", sentAt: h.sentAt)))
            case "assistant":
                var blocks = Self.historyBlocks(h)
                if blocks.isEmpty {
                    if let th = h.thinking, !th.isEmpty { blocks.append(.thinking(.init(text: th))) }
                    if let txt = h.content, !txt.isEmpty { blocks.append(.text(.init(text: txt))) }
                }
                if !blocks.isEmpty {
                    items.append(.assistant(.init(id: h.id, blocks: blocks, done: true, sentAt: h.sentAt)))
                }
            case "toolResult":
                // Full-fidelity replay: attach durable output to the earlier
                // assistant tool block (same toolCallId as pi's JSONL).
                if let callId = h.toolCallId { applyHistoryToolResult(callId: callId, output: h.text ?? h.content ?? "", isError: h.isError ?? false) }
            case "system", "note":
                items.append(.system(.init(id: h.id, content: h.content ?? h.text ?? "", key: h.key, sentAt: h.sentAt)))
            default:
                break
            }
        }
    }

    public mutating func mergeHistory(_ history: [HistoryItem]) {
        var staged = ChatReducer()
        staged.loadHistory(history)

        for item in staged.items {
            if containsEquivalentHistoryItem(item) { continue }
            items.append(item)
            if case .assistant(let assistant) = item {
                msgIndex[assistant.id] = items.count - 1
            }
        }
        revision += 1
    }

    private func containsEquivalentHistoryItem(_ item: ChatItem) -> Bool {
        if items.contains(where: { $0.id == item.id }) { return true }

        switch item {
        case .user(let incoming):
            // Content only: history rows never carry a mode, so comparing modes
            // would make every goal/swarm row look new and duplicate it.
            return items.contains { existing in
                guard case .user(let user) = existing else { return false }
                return user.content == incoming.content
            }
        case .assistant(let incoming):
            return items.contains { existing in
                guard case .assistant(let assistant) = existing else { return false }
                return assistant.blocks == incoming.blocks
            }
        case .system(let incoming):
            return items.contains { existing in
                guard case .system(let system) = existing else { return false }
                return system.content == incoming.content && system.key == incoming.key
            }
        case .hammersmithRun:
            return false
        }
    }

    private static func historyBlocks(_ item: HistoryItem) -> [Block] {
        (item.blocks ?? []).compactMap { wire in
            switch wire.type {
            case "text": return wire.text.map { .text(.init(text: $0)) }
            case "thinking": return wire.text.map { .thinking(.init(text: $0)) }
            case "tool": return .tool(.init(
                id: wire.id ?? UUID().uuidString,
                name: wire.name ?? "Tool",
                args: wire.args ?? "",
                output: wire.output ?? "",
                status: .init(rawValue: wire.status ?? "running") ?? .running
            ))
            default: return nil
            }
        }
    }

    private mutating func applyHistoryToolResult(callId: String, output: String, isError: Bool) {
        for index in items.indices.reversed() {
            guard case .assistant(var assistant) = items[index] else { continue }
            guard let blockIndex = assistant.blocks.firstIndex(where: {
                if case .tool(let tool) = $0 { return tool.id == callId }
                return false
            }) else { continue }
            guard case .tool(var tool) = assistant.blocks[blockIndex] else { return }
            tool.output = output
            tool.status = isError ? .error : .done
            assistant.blocks[blockIndex] = .tool(tool)
            items[index] = .assistant(assistant)
            return
        }
    }

    public struct HistoryItem: Sendable {
        public var role: String
        public var id: String
        public var content: String?
        public var text: String?
        public var thinking: String?
        public var key: String?
        public var sentAt: Date?
        public var blocks: [SyncSnapshot.WireBlock]?
        public var toolCallId: String?
        public var toolName: String?
        public var isError: Bool?
        public init(
            role: String, id: String, content: String? = nil, text: String? = nil,
            thinking: String? = nil, key: String? = nil, sentAt: Date? = nil,
            blocks: [SyncSnapshot.WireBlock]? = nil, toolCallId: String? = nil,
            toolName: String? = nil, isError: Bool? = nil
        ) {
            self.role = role; self.id = id; self.content = content
            self.text = text; self.thinking = thinking; self.key = key; self.sentAt = sentAt
            self.blocks = blocks; self.toolCallId = toolCallId
            self.toolName = toolName; self.isError = isError
        }
    }
}
