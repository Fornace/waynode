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
                items.append(.user(.init(id: h.id, content: h.content ?? "", isGoal: h.isGoal ?? false, sentAt: h.sentAt)))
            case "assistant":
                // Server sends assistant text as `content` (NOT `text`), and
                // optional reasoning as `thinking`. This mirrors the web
                // client (sessionStore.ts loadHistory) exactly:
                //   if (m.thinking) blocks.push({ type: "thinking", text: m.thinking });
                //   blocks.push({ type: "text", text: m.content || "" });
                var blocks: [Block] = []
                if let th = h.thinking, !th.isEmpty { blocks.append(.thinking(.init(text: th))) }
                if let txt = h.content, !txt.isEmpty { blocks.append(.text(.init(text: txt))) }
                // Only add an assistant item if there's actual content.
                // Skip pure tool-call turns (no text/thinking) — they were
                // already filtered server-side, but guard defensively.
                if !blocks.isEmpty {
                    items.append(.assistant(.init(id: h.id, blocks: blocks, done: true, sentAt: h.sentAt)))
                }
            case "system":
                items.append(.system(.init(id: h.id, content: h.content ?? "", key: h.key, sentAt: h.sentAt)))
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
            return items.contains { existing in
                guard case .user(let user) = existing else { return false }
                return user.content == incoming.content && user.isGoal == incoming.isGoal
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

    public struct HistoryItem: Sendable {
        public var role: String
        public var id: String
        public var content: String?
        public var isGoal: Bool?
        public var text: String?
        public var thinking: String?
        public var key: String?
        public var sentAt: Date?
        public init(role: String, id: String, content: String? = nil, isGoal: Bool? = nil, text: String? = nil, thinking: String? = nil, key: String? = nil, sentAt: Date? = nil) {
            self.role = role; self.id = id; self.content = content; self.isGoal = isGoal
            self.text = text; self.thinking = thinking; self.key = key; self.sentAt = sentAt
        }
    }
}
