import Foundation

/// Full-fidelity durable transcript entry from the session wire protocol.
/// Unknown roles decode but are ignored, which keeps forward compatibility
/// without acknowledging entries the current client cannot represent.
public struct DurableEntry: Decodable, Equatable, Sendable {
    public struct AssistantBlock: Decodable, Equatable, Sendable {
        public var type: String
        public var text: String?
        public var id: String?
        public var name: String?
        public var args: JSONValue?
    }

    public var id: String
    public var parentId: String?
    public var timestamp: String?
    public var role: String
    public var text: String?
    public var blocks: [AssistantBlock]?
    public var submissionId: String?
    public var toolCallId: String?
    public var toolName: String?
    public var isError: Bool?
    public var command: String?
    public var exitCode: Int?
    public var cancelled: Bool?
    public var kind: String?
}

/// JSON value used for tool arguments. It preserves object/array structure and
/// produces a stable string for the existing native ToolBlock model.
public enum JSONValue: Decodable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    var displayString: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return value.rounded() == value ? String(Int(value)) : String(value)
        case .bool(let value): return value ? "true" : "false"
        case .null: return "null"
        case .array(let values): return "[\(values.map(\.displayString).joined(separator: ","))]"
        case .object(let values):
            let body = values.keys.sorted().map { key in
                "\(Self.quote(key)):\(values[key]!.jsonString)"
            }.joined(separator: ",")
            return "{\(body)}"
        }
    }

    private var jsonString: String {
        if case .string(let value) = self { return Self.quote(value) }
        return displayString
    }

    private static func quote(_ value: String) -> String {
        var escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")
        escaped = escaped.unicodeScalars.reduce(into: "") { result, scalar in
            if scalar.value < 0x20 {
                result += String(format: "\\u%04x", scalar.value)
            } else {
                result.unicodeScalars.append(scalar)
            }
        }
        return "\"\(escaped)\""
    }
}
