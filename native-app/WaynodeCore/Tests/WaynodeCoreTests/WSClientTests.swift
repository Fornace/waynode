import Foundation
import Testing
@testable import WaynodeCore

@Suite("Terminal transport truth and recovery", .serialized)
struct WSClientTests {
    @Test("Resume remains connecting until the WebSocket handshake opens")
    func delayedHandshakeDoesNotPrematurelyConnect() async {
        let transport = MockWebSocketTransport()
        let client = makeClient(transport)
        var messages = client.output().makeAsyncIterator()

        await client.connect()

        #expect(await client.connectionState() == .connecting)
        #expect(transport.started)
        #expect(await messages.next() == .transport(.connecting))

        transport.emit(.opened)
        #expect(await messages.next() == .transport(.connected))
        #expect(await client.connectionState() == .connected)
        await client.disconnect()
    }

    @Test("A failed handshake is never reported as connected")
    func connectFailure() async {
        let transport = MockWebSocketTransport()
        let client = makeClient(transport)
        var messages = client.output().makeAsyncIterator()

        await client.connect()
        #expect(await messages.next() == .transport(.connecting))
        transport.emit(.failed("TLS failed"), finish: true)

        #expect(await messages.next() == .transport(.failed("Could not connect")))
        #expect(await client.connectionState() == .failed("Could not connect"))
        await client.disconnect()
    }

    @Test("Connected transport keeps raw input and resize protocol messages")
    func inputAndResizeRemainAvailable() async {
        let transport = MockWebSocketTransport()
        let client = makeClient(transport)
        var messages = client.output().makeAsyncIterator()
        await client.connect()
        _ = await messages.next()
        transport.emit(.opened)
        _ = await messages.next()

        await client.sendInput("\u{3}")
        await client.sendResize(cols: 132, rows: 44)

        let sent = transport.sentMessages
        #expect(sent.count == 2)
        #expect(sent[0].contains("\"type\":\"input\""))
        #expect(sent[0].contains("\\u0003"))
        #expect(sent[1].contains("\"cols\":132"))
        #expect(sent[1].contains("\"rows\":44"))
        await client.disconnect()
    }

    @Test("Drop and retry preserve scrollback and expose reconnecting")
    func reconnectPreservesOutput() {
        var state = TerminalSessionState()
        state.beginConnection()
        state.apply(.transport(.connecting))
        state.apply(.transport(.connected))
        state.apply(.output("before drop\r\n"))
        state.apply(.transport(.failed("Connection lost")))

        #expect(state.connection == .failed("Connection lost"))
        #expect(state.output.contains("before drop"))

        state.beginConnection(reconnecting: true)
        state.apply(.transport(.connecting))
        #expect(state.connection == .reconnecting)
        state.apply(.transport(.connected))
        state.apply(.output("after retry\r\n"))

        #expect(state.connection == .connected)
        #expect(state.output.contains("before drop"))
        #expect(state.output.contains("after retry"))
    }

    @Test("Exit and restart are distinct and retain the prior transcript")
    func exitAndRestart() {
        var state = TerminalSessionState()
        state.apply(.output("old process output"))
        state.apply(.exited(7))
        #expect(state.connection == .exited(7))

        state.beginRestart()
        #expect(state.connection == .connecting)
        #expect(state.output.contains("old process output"))
        #expect(state.output.contains("Terminal restarted"))
        state.apply(.transport(.connected))
        state.apply(.output("new process output"))
        #expect(state.output.contains("old process output"))
        #expect(state.output.contains("new process output"))
    }

    @Test("Only explicit clear removes retained scrollback")
    func explicitClear() {
        var state = TerminalSessionState()
        state.apply(.output("retain me"))
        state.beginConnection(reconnecting: true)
        #expect(state.output.contains("retain me"))
        state.clearScrollback()
        #expect(!state.output.contains("retain me"))
        #expect(state.output.contains("\u{1B}[2J"))
    }

    private func makeClient(_ transport: MockWebSocketTransport) -> WSClient {
        WSClient(url: URL(string: "https://example.test/ws/terminal")!, token: "secret") { _ in transport }
    }
}

private final class MockWebSocketTransport: WebSocketTransport, @unchecked Sendable {
    let events: AsyncStream<WebSocketTransportEvent>
    private let continuation: AsyncStream<WebSocketTransportEvent>.Continuation
    private let lock = NSLock()
    private var didStart = false
    private var sent: [String] = []

    var started: Bool { lock.withLock { didStart } }
    var sentMessages: [String] { lock.withLock { sent } }

    init() {
        (events, continuation) = AsyncStream.makeStream(of: WebSocketTransportEvent.self)
    }

    func start() { lock.withLock { didStart = true } }
    func send(_ text: String) async throws { lock.withLock { sent.append(text) } }
    func cancel() { continuation.finish() }

    func emit(_ event: WebSocketTransportEvent, finish: Bool = false) {
        continuation.yield(event)
        if finish { continuation.finish() }
    }
}
