import Foundation

extension ChatReducer {
    /// Replace the durable transcript atomically on a full projection. The
    /// receiver changes only after every entry and assistant block is known.
    @discardableResult
    mutating func replaceDurableEntries(_ entries: [DurableEntry]) -> Bool {
        var candidate = ChatReducer()
        guard candidate.applyDurableEntries(entries) else { return false }
        commitDurableTranscript(from: candidate)
        return true
    }

    /// Merge stable entry IDs atomically. A rejected batch leaves the complete
    /// transcript and its indexes unchanged, so replaying the frame is safe.
    @discardableResult
    mutating func mergeDurableEntries(_ entries: [DurableEntry]) -> Bool {
        var candidate = self
        guard candidate.applyDurableEntries(entries) else { return false }
        self = candidate
        return true
    }

    private mutating func applyDurableEntries(_ entries: [DurableEntry]) -> Bool {
        var incomingIds = Set<String>()
        for entry in entries {
            guard !entry.id.isEmpty, incomingIds.insert(entry.id).inserted else { return false }
            if durableEntryIds.contains(entry.id) { continue }
            switch entry.role {
            case "user":
                appendDurableUser(entry)
            case "assistant":
                guard appendDurableAssistant(entry) else { return false }
            case "toolResult":
                guard attachDurableToolResult(entry) else { return false }
            case "bashExecution":
                appendDurableBash(entry)
            case "note":
                appendDurableNote(entry)
            case "system":
                // Kept for older session projections. Current v2 uses `note`.
                appendDurableSystem(entry)
            default:
                return false
            }
            durableEntryIds.insert(entry.id)
        }
        return true
    }

    private mutating func commitDurableTranscript(from candidate: ChatReducer) {
        items = candidate.items
        msgIndex = candidate.msgIndex
        durableEntryIds = candidate.durableEntryIds
        toolIndex = candidate.toolIndex
        currentAssistantId = candidate.currentAssistantId
    }

    private mutating func appendDurableUser(_ entry: DurableEntry) {
        let sentAt = ISODate.parse(entry.timestamp)
        if let submissionId = entry.submissionId,
           let index = items.firstIndex(where: { item in
               if case .user(let user) = item { return user.id == submissionId }
               return false
           }), case .user(let optimistic) = items[index] {
            items[index] = .user(.init(
                id: entry.id, submissionId: submissionId,
                content: optimistic.content, mode: optimistic.mode,
                submissionStatus: optimistic.submissionStatus,
                sentAt: sentAt ?? optimistic.sentAt
            ))
            rebuildIndexes()
            return
        }
        items.append(.user(.init(
            id: entry.id, submissionId: entry.submissionId,
            content: entry.text ?? "", sentAt: sentAt
        )))
    }

    private mutating func appendDurableAssistant(_ entry: DurableEntry) -> Bool {
        let itemIdx = items.count
        var blocks: [Block] = []
        if let source = entry.blocks {
            for block in source {
                switch block.type {
                case "text":
                    blocks.append(.text(.init(text: block.text ?? "")))
                case "thinking":
                    blocks.append(.thinking(.init(text: block.text ?? "")))
                case "toolCall":
                    guard let id = block.id, !id.isEmpty,
                          let name = block.name, !name.isEmpty else { return false }
                    let tool = Block.ToolBlock(
                        id: id, name: name,
                        args: block.args?.displayString ?? "{}",
                        output: "", status: .running
                    )
                    blocks.append(.tool(tool))
                    toolIndex[id] = ToolLocation(itemIdx: itemIdx, blockIdx: blocks.count - 1)
                default:
                    return false
                }
            }
        } else if let text = entry.text, !text.isEmpty {
            blocks.append(.text(.init(text: text)))
        }
        items.append(.assistant(.init(
            id: entry.id, blocks: blocks, done: true,
            sentAt: ISODate.parse(entry.timestamp)
        )))
        msgIndex[entry.id] = itemIdx
        return true
    }

    private mutating func attachDurableToolResult(_ entry: DurableEntry) -> Bool {
        guard let callId = entry.toolCallId, !callId.isEmpty,
              let toolName = entry.toolName, !toolName.isEmpty else { return false }
        guard let location = toolIndex[callId],
              items.indices.contains(location.itemIdx),
              case .assistant(var assistant) = items[location.itemIdx],
              assistant.blocks.indices.contains(location.blockIdx) else {
            items.append(.system(.init(
                id: entry.id, content: entry.text ?? "", key: "toolResult",
                sentAt: ISODate.parse(entry.timestamp)
            )))
            return true
        }
        guard case .tool(let existingTool) = assistant.blocks[location.blockIdx],
              existingTool.name == toolName else { return false }
        var tool = existingTool
        tool.output = entry.text ?? ""
        tool.status = entry.isError == true ? .error : .done
        assistant.blocks[location.blockIdx] = .tool(tool)
        items[location.itemIdx] = .assistant(assistant)
        return true
    }

    private mutating func appendDurableNote(_ entry: DurableEntry) {
        let text: String
        switch entry.kind {
        case "compaction":
            text = "📝 Context compacted. Earlier work was summarized to keep the session fast."
        case "recovery":
            text = "🔄 \(entry.text ?? "")"
        default:
            text = "📝 \(entry.text ?? "")"
        }
        items.append(.system(.init(
            id: entry.id, content: text, key: entry.kind,
            sentAt: ISODate.parse(entry.timestamp)
        )))
    }

    private mutating func appendDurableSystem(_ entry: DurableEntry) {
        items.append(.system(.init(
            id: entry.id, content: entry.text ?? "", key: entry.kind,
            sentAt: ISODate.parse(entry.timestamp)
        )))
    }

    private mutating func appendDurableBash(_ entry: DurableEntry) {
        let status = entry.cancelled == true ? "cancelled"
            : entry.exitCode == nil ? ""
            : entry.exitCode == 0 ? "✓" : "⚠"
        let prefix = status.isEmpty ? "📝" : status
        items.append(.system(.init(
            id: entry.id,
            content: "\(prefix) Terminal: \(entry.command ?? "")",
            key: "bashExecution", sentAt: ISODate.parse(entry.timestamp)
        )))
    }

    private mutating func rebuildIndexes() {
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
