import Foundation

/// One decoded SSE event plus the durable server cursor attached to its frame.
/// `eventIdField` distinguishes no `id:` field from an explicit empty `id:`.
public struct SSEFrame: Sendable, Equatable {
    public let event: SSEEvent.Kind?
    let eventIdField: EventIdField
    let malformed: Bool

    init(event: SSEEvent.Kind?, eventIdField: EventIdField, malformed: Bool = false) {
        self.event = event
        self.eventIdField = eventIdField
        self.malformed = malformed
    }

    enum EventIdField: Sendable, Equatable {
        case absent
        case value(String?)
    }
}

/// Line-level event-stream parser. Waynode writes one JSON value per `data:`
/// line, and URLSession.AsyncBytes.lines drops blank frame separators. Keep ID
/// state separate so id-less events preserve the prior reconnect cursor.
struct SSEFrameParser: Sendable {
    private var pendingId: SSEFrame.EventIdField = .absent

    mutating func consume(_ line: String) -> SSEFrame? {
        if let field = eventId(line) {
            pendingId = field
            return nil
        }
        if line.isEmpty {
            pendingId = .absent
            return nil
        }
        guard line.hasPrefix("data:") else { return nil }
        defer { pendingId = .absent }
        guard let event = decode(line) else {
            return SSEFrame(event: nil, eventIdField: pendingId, malformed: true)
        }
        return SSEFrame(event: event.kind, eventIdField: pendingId)
    }

    private func eventId(_ line: some StringProtocol) -> SSEFrame.EventIdField? {
        guard line == "id" || line.hasPrefix("id:") else { return nil }
        let raw = line == "id" ? "" : String(line.dropFirst(3))
        let value = raw.first == " " ? String(raw.dropFirst()) : raw
        guard !value.contains("\0") else { return nil }
        return .value(value.isEmpty ? nil : value)
    }

    private func decode(_ line: some StringProtocol) -> SSEEvent? {
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        guard let data = payload.data(using: .utf8) else { return nil }
        return try? JSONDecoder.api.decode(SSEEvent.self, from: data)
    }
}

/// Request construction is pure so authentication and replay headers are
/// covered without opening a live URLSession.
enum SSEWire {
    static func decode<T: Decodable>(_ line: some StringProtocol, as type: T.Type) -> T? {
        guard line.hasPrefix("data:") else { return nil }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        guard let data = payload.data(using: .utf8) else { return nil }
        return try? JSONDecoder.api.decode(T.self, from: data)
    }

    static func request(url: URL, token: String?, lastEventId: String? = nil) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let lastEventId, !lastEventId.isEmpty {
            request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
        }
        return request
    }
}
