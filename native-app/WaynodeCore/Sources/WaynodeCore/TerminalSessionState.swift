import Foundation

public struct TerminalSessionState: Sendable, Equatable {
    public enum Connection: Sendable, Equatable {
        case disconnected
        case connecting
        case reconnecting
        case connected
        case exited(Int)
        case failed(String)
    }

    public private(set) var connection: Connection = .disconnected
    public private(set) var output = ""

    public init() {}

    public mutating func beginConnection(reconnecting: Bool = false) {
        connection = reconnecting ? .reconnecting : .connecting
    }

    public mutating func beginRestart() {
        if !output.isEmpty { output += "\r\n\u{1B}[2m— Terminal restarted —\u{1B}[0m\r\n" }
        connection = .connecting
    }

    public mutating func clearScrollback() {
        output = "\u{1B}[2J\u{1B}[H"
    }

    @discardableResult
    public mutating func apply(_ message: WSClient.TerminalMessage) -> Bool {
        switch message {
        case .transport(let state): applyTransport(state)
        case .output(let data):
            output.append(data)
            if output.utf8.count > 2_000_000 {
                output = "\u{1B}[2J\u{1B}[H" + String(output.suffix(1_500_000))
                return true
            }
        case .exited(let code): connection = .exited(code)
        case .error(let message): connection = .failed(message)
        }
        return false
    }

    private mutating func applyTransport(_ state: WSClient.TransportState) {
        if case .exited = connection { return }
        switch state {
        case .disconnected:
            if case .failed = connection { return }
            connection = .disconnected
        case .connecting:
            if connection != .reconnecting { connection = .connecting }
        case .connected: connection = .connected
        case .failed(let message): connection = .failed(message)
        }
    }
}
