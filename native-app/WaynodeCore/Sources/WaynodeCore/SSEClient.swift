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
//   • Heartbeat watchdog (if no events arrive for 90s, the connection is
//     considered stale and force-reconnected via session invalidation)
//   • Bearer token sent in an Authorization header. Unlike browser
//     EventSource, URLSession can set headers; keeping it out of the URL
//     prevents a credential from being recorded in proxy access logs.

public actor SSEClient {
    public nonisolated let url: URL
    private let token: String?
    /// Session for the active connection. Created fresh in connectOnce()
    /// and stored so forceReconnect() can invalidate it without cancelling
    /// the task (which would kill the continuation permanently).
    private var currentSession: URLSession?
    private var task: Task<Void, Never>?
    private var continuation: AsyncStream<SSEEvent.Kind>.Continuation

    /// The AsyncStream of decoded events. The store consumes this.
    public nonisolated func events() -> AsyncStream<SSEEvent.Kind> {
        eventStream
    }
    private let eventStream: AsyncStream<SSEEvent.Kind>

    /// A server decision that retrying the same request cannot repair.
    public struct ConnectionFailure: Sendable, Equatable {
        public enum Kind: Sendable, Equatable {
            case sessionExpired
            case billingRequired
            case accessRevoked
            case sessionMissing
            case serverRejected(statusCode: Int)
        }

        public enum Recovery: Sendable, Equatable {
            case signIn
            case openAccount
            case returnToWorktrees
            case returnToSessions
            case retry
        }

        public let kind: Kind

        public init(kind: Kind) {
            self.kind = kind
        }

        public var message: String {
            switch kind {
            case .sessionExpired: "Session expired. Sign in again."
            case .billingRequired: "Hosted plan inactive. Open Account to continue."
            case .accessRevoked: "You no longer have access to this worktree."
            case .sessionMissing: "This session no longer exists."
            case .serverRejected(let statusCode):
                "The server rejected the live connection (HTTP \(statusCode))."
            }
        }

        public var recovery: Recovery {
            switch kind {
            case .sessionExpired: .signIn
            case .billingRequired: .openAccount
            case .accessRevoked: .returnToWorktrees
            case .sessionMissing: .returnToSessions
            case .serverRejected: .retry
            }
        }

        public var recoveryTitle: String {
            switch recovery {
            case .signIn: "Sign In"
            case .openAccount: "Open Account"
            case .returnToWorktrees: "Back to Worktrees"
            case .returnToSessions: "Back to Sessions"
            case .retry: "Retry"
            }
        }
    }

    /// Connection lifecycle for UI display. `reconnecting` is transient;
    /// `failed` is reserved for a typed server decision that needs a person.
    public enum ConnectionState: Sendable, Equatable {
        case disconnected
        case connecting
        case connected
        case reconnecting(after: TimeInterval)
        case failed(ConnectionFailure)
    }
    public let onStateChange: AsyncStream<ConnectionState>.Continuation
    public nonisolated func stateChanges() -> AsyncStream<ConnectionState> { stateStream }
    private let stateStream: AsyncStream<ConnectionState>

    public init(url: URL, token: String?) {
        self.url = url
        self.token = token
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
        currentSession?.invalidateAndCancel()
        currentSession = nil
        onStateChange.yield(.disconnected)
        continuation.finish()
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
                // A stream ending without cancellation is a dropped live
                // connection. Back off before reconnecting instead of spinning.
                attempt += 1
            } catch is CancellationError {
                break
            } catch let error as StreamHTTPError {
                if let failure = error.permanentFailure {
                    // Authentication, authorization, billing, and a missing
                    // session cannot be repaired by retrying the same request.
                    onStateChange.yield(.failed(failure))
                    return
                }
                // Timeouts, throttling, and server outages remain transient.
                attempt += 1
            } catch {
                // Transport failures are transient. The next loop iteration
                // publishes the retry delay; never present them as a terminal
                // failure that asks the person to repair server state.
                attempt += 1
            }
        }
        if Task.isCancelled {
            onStateChange.yield(.disconnected)
        }
        // NOTE: do NOT call continuation.finish() here — only stop() finishes
        // the continuation. This allows forceReconnect() to invalidate the
        // session (causing connectOnce to throw) without permanently killing
        // the event stream. The run loop simply reconnects.
    }

    private func connectOnce() async throws {
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        // Create a fresh session per connection so forceReconnect() can
        // invalidate it without affecting the task.
        let cfg = URLSessionConfiguration.ephemeral
        cfg.waitsForConnectivity = true
        cfg.timeoutIntervalForRequest = 60
        let session = URLSession(configuration: cfg)
        currentSession = session

        defer { currentSession = nil }

        let (bytes, response) = try await session.bytes(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200...299).contains(http.statusCode) else {
            throw StreamHTTPError(statusCode: http.statusCode)
        }

        onStateChange.yield(.connected)

        var buffer = ""
        var heartbeatTask = Task { [weak self] in
            // If no events for 90s, force-reconnect by invalidating the session.
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

    /// Force a reconnect by invalidating the current URLSession.
    /// The bytes.lines iterator will throw immediately, and the run loop
    /// will reconnect on its own with exponential backoff. We do NOT cancel
    /// the task — that would exit run() and we'd lose the continuation.
    private func forceReconnect() {
        currentSession?.invalidateAndCancel()
    }
}

/// An HTTP response is a server decision, not a transient transport error.
/// Keeping it typed lets the reconnect loop distinguish a real outage from a
/// condition the person must resolve (for example an expired subscription).
private struct StreamHTTPError: LocalizedError, Sendable {
    let statusCode: Int

    var permanentFailure: SSEClient.ConnectionFailure? {
        let kind: SSEClient.ConnectionFailure.Kind
        switch statusCode {
        case 401: kind = .sessionExpired
        case 402: kind = .billingRequired
        case 403: kind = .accessRevoked
        case 404: kind = .sessionMissing
        case 400..<500 where statusCode != 408 && statusCode != 429:
            kind = .serverRejected(statusCode: statusCode)
        default:
            return nil
        }
        return SSEClient.ConnectionFailure(kind: kind)
    }

    var errorDescription: String? {
        permanentFailure?.message ?? "Live connection failed (HTTP \(statusCode))."
    }
}

// MARK: - Sleep helper

private func sleep(seconds: TimeInterval) async throws {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
}
