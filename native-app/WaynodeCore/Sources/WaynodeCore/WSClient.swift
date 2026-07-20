import Foundation

// MARK: - Terminal WebSocket transport

enum WebSocketTransportEvent: Sendable, Equatable {
    case opened
    case text(String)
    case failed(String)
    case closed
}

protocol WebSocketTransport: Sendable {
    var events: AsyncStream<WebSocketTransportEvent> { get }
    func start()
    func send(_ text: String) async throws
    func cancel()
}

private final class URLSessionSocketTransport: NSObject, WebSocketTransport, @unchecked Sendable {
    let events: AsyncStream<WebSocketTransportEvent>
    private let continuation: AsyncStream<WebSocketTransportEvent>.Continuation
    private let request: URLRequest
    private let lock = NSLock()
    private var didFinish = false
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?

    init(request: URLRequest) {
        self.request = request
        (events, continuation) = AsyncStream.makeStream(of: WebSocketTransportEvent.self)
        super.init()
    }

    func start() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = true
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let socket = session.webSocketTask(with: request)
        self.session = session
        self.socket = socket
        socket.resume()
        receiveTask = Task { [weak self] in await self?.receiveLoop(socket) }
    }

    func send(_ text: String) async throws {
        guard let socket else { throw URLError(.notConnectedToInternet) }
        try await socket.send(.string(text))
    }

    func cancel() {
        receiveTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        finish(with: .closed)
    }

    private func receiveLoop(_ socket: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await socket.receive()
                switch message {
                case .string(let text): continuation.yield(.text(text))
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) { continuation.yield(.text(text)) }
                @unknown default: break
                }
            } catch {
                guard !Task.isCancelled else { return }
                finish(with: .failed("Connection lost"))
                return
            }
        }
    }

    private func finish(with event: WebSocketTransportEvent) {
        lock.lock()
        guard !didFinish else { lock.unlock(); return }
        didFinish = true
        lock.unlock()
        continuation.yield(event)
        continuation.finish()
    }
}

extension URLSessionSocketTransport: URLSessionWebSocketDelegate {
    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        continuation.yield(.opened)
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        finish(with: .closed)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard error != nil else { return }
        finish(with: .failed("Could not connect"))
    }
}

// MARK: - WSClient

public actor WSClient {
    public nonisolated let url: URL
    private let token: String?
    private let transportFactory: @Sendable (URLRequest) -> any WebSocketTransport
    private var transport: (any WebSocketTransport)?
    private var listenTask: Task<Void, Never>?
    private var state: TransportState = .disconnected
    private let outputStream: AsyncStream<TerminalMessage>
    private let outputContinuation: AsyncStream<TerminalMessage>.Continuation

    public enum TransportState: Sendable, Equatable {
        case disconnected
        case connecting
        case connected
        case failed(String)
    }

    public enum TerminalMessage: Sendable, Equatable {
        case transport(TransportState)
        case output(String)
        case exited(Int)
        case error(String)
    }

    public nonisolated func output() -> AsyncStream<TerminalMessage> { outputStream }
    public func connectionState() -> TransportState { state }

    public init(url: URL, token: String?) {
        self.url = url
        self.token = token
        self.transportFactory = { URLSessionSocketTransport(request: $0) }
        (outputStream, outputContinuation) = AsyncStream.makeStream(of: TerminalMessage.self)
    }

    init(
        url: URL,
        token: String?,
        transportFactory: @escaping @Sendable (URLRequest) -> any WebSocketTransport
    ) {
        self.url = url
        self.token = token
        self.transportFactory = transportFactory
        (outputStream, outputContinuation) = AsyncStream.makeStream(of: TerminalMessage.self)
    }

    /// Build the WebSocket transport request for `url`: rewrite the scheme
    /// (https→wss, http→ws) and attach the bearer header. Returns nil instead
    /// of force-unwrapping when URLComponents cannot decompose the URL, so a
    /// malformed terminal URL becomes a clean connect failure rather than a
    /// crash. Static + nonisolated so it is unit-testable without an instance.
    public static func terminalRequest(for url: URL, token: String?) -> URLRequest? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        if components.scheme == "https" { components.scheme = "wss" }
        else if components.scheme == "http" { components.scheme = "ws" }
        var request = URLRequest(url: components.url ?? url)
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    public func connect() {
        guard state == .disconnected || isFailure else { return }
        transition(to: .connecting)
        // Guard-let the request build instead of the old
        // `URLComponents(url: url, resolvingAgainstBaseURL: false)!` so a
        // non-decomposable terminal URL surfaces as a clean failure state.
        guard let request = Self.terminalRequest(for: url, token: token) else {
            transition(to: .failed("Invalid terminal URL"))
            return
        }

        let transport = transportFactory(request)
        self.transport = transport
        listenTask = Task { [weak self] in
            for await event in transport.events {
                guard !Task.isCancelled else { return }
                await self?.handle(event)
            }
        }
        transport.start()
    }

    public func disconnect() {
        transition(to: .disconnected)
        listenTask?.cancel()
        listenTask = nil
        transport?.cancel()
        transport = nil
        outputContinuation.finish()
    }

    public func sendInput(_ data: String) async {
        await send(WireMessage(type: "input", data: data, cols: nil, rows: nil, exitCode: nil, message: nil))
    }

    public func sendResize(cols: Int, rows: Int) async {
        await send(WireMessage(type: "resize", data: nil, cols: cols, rows: rows, exitCode: nil, message: nil))
    }

    private var isFailure: Bool {
        if case .failed = state { return true }
        return false
    }

    private func transition(to next: TransportState) {
        guard next != state else { return }
        state = next
        outputContinuation.yield(.transport(next))
    }

    private func handle(_ event: WebSocketTransportEvent) {
        switch event {
        case .opened: transition(to: .connected)
        case .text(let text): decode(text)
        case .failed(let message):
            transition(to: .failed(state == .connecting ? "Could not connect" : message))
        case .closed: transition(to: .disconnected)
        }
    }

    private func decode(_ text: String) {
        guard let data = text.data(using: .utf8),
              let decoded = try? JSONDecoder.api.decode(WireMessage.self, from: data) else { return }
        switch decoded.type {
        case "output": outputContinuation.yield(.output(decoded.data ?? ""))
        case "exit", "exited": outputContinuation.yield(.exited(decoded.exitCode ?? 0))
        case "error": outputContinuation.yield(.error(decoded.message ?? "Unknown error"))
        default: break
        }
    }

    private func send(_ message: WireMessage) async {
        guard state == .connected,
              let data = try? JSONEncoder.api.encode(message),
              let string = String(data: data, encoding: .utf8) else { return }
        do { try await transport?.send(string) }
        catch { transition(to: .failed("Connection lost")) }
    }

    private struct WireMessage: Codable, Sendable {
        let type: String
        let data: String?
        let cols: Int?
        let rows: Int?
        let exitCode: Int?
        let message: String?
    }
}
