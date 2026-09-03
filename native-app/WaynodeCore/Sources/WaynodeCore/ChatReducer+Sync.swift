import Foundation

extension ChatReducer {
    /// Apply one sync event as a transaction. Durable replacement/merge,
    /// submission reconciliation, streaming state, and the optional live
    /// overlay commit together, so a rejected frame cannot leave mixed state.
    mutating func applySync(_ snapshot: SyncSnapshot) -> Bool {
        var candidate = self
        candidate.isStreaming = snapshot.streaming
        if let entries = snapshot.entries {
            let applied = snapshot.fromStart
                ? candidate.replaceDurableEntries(entries)
                : candidate.mergeDurableEntries(entries)
            guard applied else { return false }
        }
        for submission in snapshot.submissions {
            candidate.reconcileSubmission(submission)
        }
        if snapshot.entries != nil {
            candidate.dropLiveAssistant()
            if let live = snapshot.live {
                candidate.appendLiveAssistant(live)
            }
        } else {
            candidate.applyLegacySyncItems(snapshot.items)
        }
        self = candidate
        return true
    }

    private mutating func applyLegacySyncItems(_ wires: [SyncSnapshot.WireItem]) {
        for wire in wires {
            switch wire.role {
            case "assistant":
                var blocks: [Block] = []
                if let thinking = wire.thinking, !thinking.isEmpty {
                    blocks.append(.thinking(.init(text: thinking)))
                }
                if let text = wire.text, !text.isEmpty {
                    blocks.append(.text(.init(text: text)))
                }
                if let wireBlocks = wire.blocks {
                    blocks = wireBlocks.compactMap { block in
                        switch block.type {
                        case "text": return .text(.init(text: block.text ?? ""))
                        case "thinking": return .thinking(.init(text: block.text ?? ""))
                        case "tool": return .tool(.init(
                            id: block.id ?? UUID().uuidString,
                            name: block.name ?? "", args: block.args ?? "",
                            output: block.output ?? "",
                            status: .init(rawValue: block.status ?? "running") ?? .running
                        ))
                        default: return nil
                        }
                    }
                }
                let done = !isStreaming
                if let id = wire.id {
                    if msgIndex[id] == nil { appendSyncedAssistant(id: id, blocks: blocks, done: done) }
                } else if let index = inFlightAssistantIndex() {
                    if let text = wire.text, !text.isEmpty { reconcileAssistantText(at: index, with: text) }
                } else {
                    appendSyncedAssistant(id: UUID().uuidString, blocks: blocks, done: done)
                }
            case "user":
                let id = wire.id ?? UUID().uuidString
                items.append(.user(.init(id: id, content: wire.content ?? "", mode: wire.mode ?? .message)))
            case "system":
                let id = wire.id ?? UUID().uuidString
                items.append(.system(.init(id: id, content: wire.content ?? "", key: nil)))
            default:
                continue
            }
        }
    }

    private mutating func dropLiveAssistant() {
        items.removeAll { item in
            guard case .assistant(let assistant) = item else { return false }
            return !assistant.done
        }
        rebuildSyncIndexes()
    }

    private mutating func appendLiveAssistant(_ live: SyncSnapshot.LiveOverlay) {
        var blocks: [Block] = []
        if !live.thinking.isEmpty { blocks.append(.thinking(.init(text: live.thinking))) }
        for tool in live.tools {
            blocks.append(.tool(.init(
                id: tool.toolCallId, name: tool.name,
                args: tool.args.displayString, output: tool.output,
                status: .init(rawValue: tool.state) ?? .running
            )))
        }
        if !live.text.isEmpty { blocks.append(.text(.init(text: live.text))) }
        let id = "live-\(live.messageId ?? "stream")"
        appendSyncedAssistant(id: id, blocks: blocks, done: false)
        currentAssistantId = id
    }

    private func inFlightAssistantIndex() -> Int? {
        if let id = currentAssistantId, let index = msgIndex[id],
           case .assistant(let assistant) = items[index], !assistant.done { return index }
        for index in items.indices.reversed() {
            if case .assistant(let assistant) = items[index], !assistant.done { return index }
        }
        return nil
    }

    private mutating func reconcileAssistantText(at itemIndex: Int, with partial: String) {
        guard case .assistant(var assistant) = items[itemIndex] else { return }
        if let last = assistant.blocks.indices.last, case .text = assistant.blocks[last] {
            assistant.blocks[last] = .text(.init(text: partial))
        } else {
            assistant.blocks.append(.text(.init(text: partial)))
        }
        items[itemIndex] = .assistant(assistant)
    }

    private mutating func appendSyncedAssistant(id: String, blocks: [Block], done: Bool) {
        let itemIndex = items.count
        items.append(.assistant(.init(id: id, blocks: blocks, done: done)))
        msgIndex[id] = itemIndex
        for blockIndex in blocks.indices {
            if case .tool(let tool) = blocks[blockIndex] {
                toolIndex[tool.id] = ToolLocation(itemIdx: itemIndex, blockIdx: blockIndex)
            }
        }
    }

    private mutating func rebuildSyncIndexes() {
        msgIndex.removeAll(keepingCapacity: true)
        toolIndex.removeAll(keepingCapacity: true)
        for (itemIndex, item) in items.enumerated() {
            guard case .assistant(let assistant) = item else { continue }
            msgIndex[assistant.id] = itemIndex
            for (blockIndex, block) in assistant.blocks.enumerated() {
                if case .tool(let tool) = block {
                    toolIndex[tool.id] = ToolLocation(itemIdx: itemIndex, blockIdx: blockIndex)
                }
            }
        }
    }
}
