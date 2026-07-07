import Foundation

// MARK: - SSEClient
//
// Streams Server-Sent Events from the Waynode server using URLSession's
// bytes(for:) API. Parses the text/event-stream wire format, decodes each
// `data:` payload into an SSEEvent, and yields it on an AsyncStream.
//
// Features:
//   • Automatic reconnection with exponential backoff (capped at 30s)
//   • Cooperative cancellation (task cancellation tears down the stream)
//   • Heartbeat watchdog (server sends `ping` events; if none arrive for
//     60s, the connection is considered stale and reconnected)
//   • Bearer token passed as `?t=` query param (EventSource cannot set
//     custom headers, and our native client mirrors the web transport)

public actor SSEClient {
    public nonisolated let url: URL
    private let token: String?
    private let session: URLSession
    private var task: Task<Void, Never>?
    private var continuation: AsyncStream<SSEEvent.Kind>.Continuation

    /// The AsyncStream of decoded events. The store consumes this.
    public nonisolated func events() -> AsyncStream<SSEEvent.Kind> {
        eventStream
    }
    private let eventStream: AsyncStream<SSEEvent.Kind>

    /// Connection lifecycle for UI display.
    public enum ConnectionState: Sendable, Equatable {
        case disconnected
        case connecting
        case connected
        case reconnecting(after: TimeInterval)
        case failed(reason: String)
    }
    public let onStateChange: AsyncStream<ConnectionState>.Continuation
    public nonisolated func stateChanges() -> AsyncStream<ConnectionState> { stateStream }
    private let stateStream: AsyncStream<ConnectionState>

    public init(url: URL, token: String?, session: URLSession? = nil) {
        self.url = url
        self.token = token
        let cfg = URLSessionConfiguration.ephemeral
        cfg.waitsForConnectivity = true
        cfg.timeoutIntervalForRequest = 60
        self.session = session ?? URLSession(configuration: cfg)
        let (es, ec) = AsyncStream.makeStream(of: SSEEvent.Kind.self)
        self.eventStream = es
        self.continuation = ec
        let (ss, sc) = AsyncStream.makeStream(of: ConnectionState.self)
        self.stateStream = ss
        self.onStateChange = sc
    }

    // MARK: - Start / Stop

    public func start() {
        task?.cancel()
        task = Task { [weak self] in
            await self?.run()
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        onStateChange.yield(.disconnected)
    }

    // MARK: - Reconnection loop

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                if attempt == 0 {
                    onStateChange.yield(.connecting)
                } else {
                    let delay = min(pow(2.0, Double(attempt)), 30.0)
                    onStateChange.yield(.reconnecting(after: delay))
                    try? await sleep(seconds: delay)
                    if Task.isCancelled { break }
                    onStateChange.yield(.connecting)
                }

                try await connectOnce()
                // connectOnce only returns on stream end or cancellation.
                // If the server closed cleanly (`.end` event already handled),
                // we reset the attempt counter for next time.
                attempt = 0
            } catch is CancellationError {
                break
            } catch {
                onStateChange.yield(.failed(reason: error.localizedDescription))
                attempt += 1
            }
        }
        onStateChange.yield(.disconnected)
        continuation.finish()
    }

    private func connectOnce() async throws {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        if let token {
            let existing = components.queryItems ?? []
            components.queryItems = existing + [URLQueryItem(name: "t", value: token)]
        }

        var req = URLRequest(url: components.url ?? url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")

        let (bytes, response) = try await session.bytes(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        if http.statusCode == 401 {
            onStateChange.yield(.failed(reason: "Unauthorized"))
            // Don't retry — token is invalid.
            continuation.finish()
            return
        }
        guard (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }

        onStateChange.yield(.connected)

        var buffer = ""
        var heartbeatTask = Task { [weak self] in
            // If no events for 90s, cancel the stream so it reconnects.
            try? await sleep(seconds: 90)
            if !Task.isCancelled {
                await self?.forceReconnect()
            }
        }

        defer { heartbeatTask.cancel() }

        for try await line in bytes.lines {
            if Task.isCancelled { throw CancellationError() }

            if line.isEmpty {
                // Event boundary — flush buffer if we have data.
                if !buffer.isEmpty {
                    if let event = parseEvent(buffer) {
                        // Reset heartbeat on any event.
                        heartbeatTask.cancel()
                        heartbeatTask = Task { [weak self] in
                            try? await sleep(seconds: 90)
                            if !Task.isCancelled { await self?.forceReconnect() }
                        }
                        continuation.yield(event)
                    }
                    buffer = ""
                }
                continue
            }
            buffer += line + "\n"
        }
        // Stream ended (server closed). Let the caller loop decide to reconnect.
    }

    /// Parse the buffered lines of one SSE event into an SSEEvent.Kind.
    /// Only `data:` lines matter to us; the server doesn't send `event:`
    /// or `id:` fields.
    private func parseEvent(_ buffer: String) -> SSEEvent.Kind? {
        var dataLines: [String] = []
        for line in buffer.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("data:") {
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                dataLines.append(String(payload))
            }
        }
        guard !dataLines.isEmpty else { return nil }
        let json = dataLines.joined(separator: "\n")
        guard let data = json.data(using: .utf8) else { return nil }
        return (try? JSONDecoder.api.decode(SSEEvent.self, from: data))?.kind
    }

    /// Force a reconnect by cancelling the current URLSession stream.
    /// The bytes.lines iterator will throw, triggering the reconnect loop.
    private func forceReconnect() {
        // The only way to interrupt bytes.lines is to cancel the task.
        // We create a cancellation that propagates: cancel the current task
        // and immediately restart.
        task?.cancel()
        // Restart after a brief yield.
        Task { [weak self] in
            await self?.start()
        }
    }
}

// MARK: - Sleep helper

private func sleep(seconds: TimeInterval) async throws {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
}
