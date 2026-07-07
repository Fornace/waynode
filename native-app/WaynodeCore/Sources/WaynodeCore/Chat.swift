import Foundation

// MARK: - Chat domain (exact mirror of frontend/src/types.ts)
//
// The server streams a turn as Server-Sent Events. Each SSE event is a JSON
// object with a `type` discriminator. The reducer (ChatReducer.swift) folds
// these into a list of ChatItem values, maintaining a msgIndex so deltas
// append to the correct message even when they arrive out of order.

// MARK: Block (assistant content unit)

public enum Block: Hashable, Identifiable, Sendable {
    case text(TextBlock)
    case thinking(ThinkingBlock)
    case tool(ToolBlock)

    public struct TextBlock: Hashable, Sendable {
        public var text: String
        public init(text: String = "") { self.text = text }
    }
    public struct ThinkingBlock: Hashable, Sendable {
        public var text: String
        public init(text: String = "") { self.text = text }
    }
    public struct ToolBlock: Hashable, Sendable, Identifiable {
        public enum Status: String, Codable, Sendable {
            case running, done, error
        }
        public var id: String
        public var name: String
        public var args: String
        public var output: String
        public var status: Status
        public init(id: String, name: String, args: String = "", output: String = "", status: Status = .running) {
            self.id = id; self.name = name; self.args = args; self.output = output; self.status = status
        }
    }

    // Identifiable — tool blocks use their own id; text/thinking synthesise a
    // hash so SwiftUI's ForEach stays stable.
    public var id: String {
        switch self {
        case .text(let b): return "text:" + b.text.hashValue.description
        case .thinking(let b): return "thinking:" + b.text.hashValue.description
        case .tool(let b): return "tool:" + b.id
        }
    }
}

// MARK: ChatItem (one row in the transcript)

public enum ChatItem: Hashable, Identifiable, Sendable {
    case user(UserItem)
    case assistant(AssistantItem)
    case system(SystemItem)

    public struct UserItem: Hashable, Sendable, Identifiable {
        public var id: String
        public var content: String
        public var isGoal: Bool
        public init(id: String, content: String, isGoal: Bool = false) {
            self.id = id; self.content = content; self.isGoal = isGoal
        }
    }
    public struct AssistantItem: Hashable, Sendable, Identifiable {
        public var id: String
        public var blocks: [Block]
        public var done: Bool
        public init(id: String, blocks: [Block] = [], done: Bool = false) {
            self.id = id; self.blocks = blocks; self.done = done
        }
    }
    public struct SystemItem: Hashable, Sendable, Identifiable {
        public var id: String
        public var content: String
        public var key: String?
        public init(id: String, content: String, key: String? = nil) {
            self.id = id; self.content = content; self.key = key
        }
    }

    public var id: String {
        switch self {
        case .user(let i): return i.id
        case .assistant(let i): return i.id
        case .system(let i): return i.id
        }
    }

    /// Is the assistant item still receiving events this turn?
    public var isStreaming: Bool {
        if case .assistant(let a) = self { return !a.done }
        return false
    }
}

// MARK: SSE event wire format

/// Raw SSE event envelope decoded from the JSON `data:` payload.
///
/// Decoding is deliberately lenient: an event with a missing `type` or a type
/// we don't recognise becomes `.unknown` and is ignored by the reducer. This
/// keeps the client robust against server-side additions.
public struct SSEEvent: Decodable, Sendable, Equatable {
    public let kind: Kind

    public enum Kind: Equatable, Sendable {
        case start
        case turnStart
        case messageStart(messageId: String)
        case textDelta(messageId: String, delta: String)
        case thinkingDelta(messageId: String, delta: String)
        case messageEnd(messageId: String)
        case toolStart(toolName: String, toolCallId: String, toolInput: String?)
        case toolDelta(toolCallId: String, delta: String)
        case toolEnd(toolCallId: String, finalOutput: String?, isError: Bool)
        case turnEnd
        case end
        case error(message: String)
        case status(text: String)
        case sync(snapshot: SyncSnapshot)
        case sessionRenamed(title: String)
        case ping
        case unknown
    }

    // We decode manually so we can map server field names and tolerate missing keys.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: WireKeys.self)
        let type = try c.decodeIfPresent(String.self, forKey: .type) ?? ""
        switch type {
        case "start": kind = .start
        case "turn_start": kind = .turnStart
        case "message_start":
            kind = .messageStart(messageId: try Self.msg(c))
        case "text_delta":
            let mid = try c.decodeIfPresent(String.self, forKey: .messageId) ?? ""
            let delta = try c.decodeIfPresent(String.self, forKey: .delta) ?? ""
            kind = .textDelta(messageId: mid, delta: delta)
        case "thinking_delta":
            let mid = try c.decodeIfPresent(String.self, forKey: .messageId) ?? ""
            let delta = try c.decodeIfPresent(String.self, forKey: .delta) ?? ""
            kind = .thinkingDelta(messageId: mid, delta: delta)
        case "message_end":
            kind = .messageEnd(messageId: try Self.msg(c))
        case "tool_start":
            let name = try c.decodeIfPresent(String.self, forKey: .toolName) ?? ""
            let id = try c.decodeIfPresent(String.self, forKey: .toolCallId) ?? ""
            // Server sends `args` for the tool input; fall back to `toolInput`.
            let input = try c.decodeIfPresent(String.self, forKey: .args) ?? c.decodeIfPresent(String.self, forKey: .toolInput)
            kind = .toolStart(toolName: name, toolCallId: id, toolInput: input)
        case "tool_delta":
            let id = try c.decodeIfPresent(String.self, forKey: .toolCallId) ?? ""
            // Server sends `text` for tool delta (partial result); fall back to `delta`.
            let delta = try c.decodeIfPresent(String.self, forKey: .text) ?? c.decodeIfPresent(String.self, forKey: .delta) ?? ""
            kind = .toolDelta(toolCallId: id, delta: delta)
        case "tool_end":
            let id = try c.decodeIfPresent(String.self, forKey: .toolCallId) ?? ""
            let output = try c.decodeIfPresent(String.self, forKey: .text)
            let isErr = try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false
            kind = .toolEnd(toolCallId: id, finalOutput: output, isError: isErr)
        case "turn_end": kind = .turnEnd
        case "end": kind = .end
        case "error":
            let msg = try c.decodeIfPresent(String.self, forKey: .message) ?? "Unknown error"
            kind = .error(message: msg)
        case "status":
            let text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
            kind = .status(text: text)
        case "sync":
            // Server wire format: { type: "sync", streaming: Bool, partialText: String, tools: [...] }
            // We build a SyncSnapshot from the flat fields. partialText becomes an assistant item.
            let streaming = try c.decodeIfPresent(Bool.self, forKey: .streaming) ?? false
            var items: [SyncSnapshot.WireItem] = []
            if let partial = try c.decodeIfPresent(String.self, forKey: .partialText), !partial.isEmpty {
                items.append(SyncSnapshot.WireItem(role: "assistant", content: nil, id: nil, isGoal: nil, text: partial, thinking: nil, blocks: nil))
            }
            // tools are currently never populated server-side (liveTools is always []),
            // but decode defensively if present.
            if let tools = try c.decodeIfPresent([SyncSnapshot.WireItem].self, forKey: .tools) {
                items.append(contentsOf: tools)
            }
            kind = .sync(snapshot: SyncSnapshot(items: items))
        case "session_renamed":
            let title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            kind = .sessionRenamed(title: title)
        case "ping": kind = .ping
        default: kind = .unknown
        }
    }

    enum WireKeys: String, CodingKey {
        case type, messageId = "messageId", delta, toolName = "toolName"
        case toolCallId = "toolCallId", toolInput = "toolInput"
        case message, text, snapshot, title
        case streaming, partialText, tools
        case args
        case isError = "isError"
    }

    static func msg(_ c: KeyedDecodingContainer<WireKeys>) throws -> String {
        try c.decodeIfPresent(String.self, forKey: .messageId) ?? ""
    }
}

/// The `sync` event carries the full transcript of the *current* turn so far.
/// Used when the client connects mid-turn (reconnect, late subscribe).
public struct SyncSnapshot: Codable, Equatable, Sendable {
    public struct WireItem: Codable, Equatable, Sendable {
        public var role: String
        public var content: String?
        public var id: String?
        public var isGoal: Bool?
        public var text: String?
        public var thinking: String?
        public var blocks: [WireBlock]?
    }
    public struct WireBlock: Codable, Equatable, Sendable {
        public var type: String
        public var text: String?
        public var id: String?
        public var name: String?
        public var args: String?
        public var output: String?
        public var status: String?
    }
    public var items: [WireItem]
}
