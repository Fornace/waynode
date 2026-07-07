import Foundation

// MARK: - WSClient (terminal WebSocket)
//
// Connects to the terminal WebSocket endpoint and provides a simple
// send/receive interface. The server protocol (routes/terminal.js) expects:
//
//   Client → Server:
//     {"type":"input","data":"ls\n"}
//     {"type":"resize","cols":80,"rows":24}
//
//   Server → Client:
//     {"type":"output","data":"..."}
//     {"type":"exited","exitCode":0}
//
// Auth: token passed as ?t= query param.

public actor WSClient {
    public nonisolated let url: URL
    private let token: String?
    private var task: URLSessionWebSocketTask?
    private var session: URLSession
    private var listenTask: Task<Void, Never>?
    private var outputContinuation: AsyncStream<TerminalMessage>.Continuation
    public nonisolated func output() -> AsyncStream<TerminalMessage> { outputStream }
    private let outputStream: AsyncStream<TerminalMessage>

    public enum TerminalMessage: Sendable, Equatable {
        case output(String)
        case exited(Int)
    }

    public init(url: URL, token: String?) {
        self.url = url
        self.token = token
        let (stream, cont) = AsyncStream.makeStream(of: TerminalMessage.self)
        self.outputStream = stream
        self.outputContinuation = cont
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config)
    }

    public func connect() {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        if let token {
            let existing = components.queryItems ?? []
            components.queryItems = existing + [URLQueryItem(name: "t", value: token)]
        }
        let wsURL = components.url ?? url
        task = session.webSocketTask(with: wsURL)
        task?.resume()
        startListening()
    }

    public func disconnect() {
        listenTask?.cancel()
        listenTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        outputContinuation.finish()
    }

    private func startListening() {
        listenTask?.cancel()
        listenTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                guard let task = await self.task else { break }
                do {
                    let msg = try await task.receive()
                    switch msg {
                    case .string(let text):
                        self.handleIncoming(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.handleIncoming(text)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    // Connection lost — yield exited so the UI updates.
                    await self.outputContinuation.yield(.exited(-1))
                    break
                }
            }
        }
    }

    private nonisolated func handleIncoming(_ text: String) {
        guard let data = text.data(using: .utf8),
              let decoded = try? JSONDecoder.api.decode(WireMessage.self, from: data) else { return }
        Task { [weak self] in
            switch decoded.type {
            case "output":
                await self?.outputContinuation.yield(.output(decoded.data ?? ""))
            case "exited":
                await self?.outputContinuation.yield(.exited(decoded.exitCode ?? 0))
            default:
                break
            }
        }
    }

    // MARK: - Sending

    public func sendInput(_ data: String) async {
        let msg = WireMessage(type: "input", data: data, cols: nil, rows: nil, exitCode: nil)
        await send(msg)
    }

    public func sendResize(cols: Int, rows: Int) async {
        let msg = WireMessage(type: "resize", data: nil, cols: cols, rows: rows, exitCode: nil)
        await send(msg)
    }

    private func send(_ msg: WireMessage) async {
        guard let data = try? JSONEncoder.api.encode(msg),
              let string = String(data: data, encoding: .utf8) else { return }
        try? await task?.send(.string(string))
    }

    private struct WireMessage: Codable, Sendable {
        let type: String
        let data: String?
        let cols: Int?
        let rows: Int?
        let exitCode: Int?
    }
}
