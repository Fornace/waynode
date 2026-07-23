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

    /// Number of times the heartbeat watchdog has been reset. Observability
    /// hook bumped on every received line, so a healthy-but-idle stream (SSE
    /// comment keep-alives) cannot trip the 90s watchdog. Internal for tests.
    private(set) var heartbeatResets: Int = 0

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
        let req = SSEWire.request(url: url, token: token)

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

        try await consume(bytes.lines)
        // Stream ended (server closed). Let the caller loop decide to reconnect.
    }

    /// Fold an async sequence of SSE wire lines into decoded events on the
    /// continuation, resetting the heartbeat watchdog on EVERY received line.
    /// Extracted from connectOnce() so the line-level behaviour — including
    /// the handling of comment keep-alive lines (`: ka`) that carry no `data:`
    /// payload — is unit-testable without a live URL session.
    ///
    /// Every `data:` line is parsed as one complete event. The server writes
    /// each event as a single `data: ${JSON.stringify(ev)}\n\n` frame, so a
    /// payload can never span lines — and `AsyncLineSequence` (bytes.lines)
    /// NEVER yields the blank separator lines, so any parser that waits for
    /// `line.isEmpty` as an event boundary waits forever and decodes nothing.
    ///
    /// Any received line (event data or a comment keep-alive) proves the
    /// connection is alive, so the watchdog is reset here rather than only
    /// on a successfully parsed event.
    func consume<S: AsyncSequence>(_ lines: S) async throws where S.Element == String {
        var heartbeatTask = Task { [weak self] in
            // If no events for 90s, force-reconnect by invalidating the session.
            try? await sleep(seconds: 90)
            if !Task.isCancelled {
                await self?.forceReconnect()
            }
        }
        defer { heartbeatTask.cancel() }

        for try await line in lines {
            if Task.isCancelled { throw CancellationError() }

            // Reset the watchdog on ANY received line — not only on a parsed
            // event. Comment keep-alives parse to nil but still prove liveness.
            heartbeatTask.cancel()
            heartbeatTask = Task { [weak self] in
                try? await sleep(seconds: 90)
                if !Task.isCancelled { await self?.forceReconnect() }
            }
            heartbeatResets += 1

            if let event = SSEWire.decode(line, as: SSEEvent.self)?.kind {
                continuation.yield(event)
            }
        }
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

// MARK: - SSE wire decoding

/// Decodes one SSE wire line into a payload. The Waynode server writes every
/// event as a single `data: <one-line JSON>` frame (JSON.stringify never emits
/// raw newlines), so each `data:` line is one complete event. Non-data lines —
/// comment keep-alives (`: ka`) and blank boundaries — decode to nil.
///
/// This exists because `URLSession.AsyncBytes.lines` silently drops empty
/// lines, so the classic "accumulate until blank line" SSE parser never fires.
/// Parse per line; never wait for a boundary.
enum SSEWire {
    static func decode<T: Decodable>(_ line: some StringProtocol, as type: T.Type) -> T? {
        guard line.hasPrefix("data:") else { return nil }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        guard let data = payload.data(using: .utf8) else { return nil }
        return try? JSONDecoder.api.decode(T.self, from: data)
    }

    /// Build the URLRequest for any Waynode SSE endpoint. The token travels in
    /// the Authorization header (NOT the query string) to keep it out of proxy
    /// access logs; the server's `sseAuth` middleware accepts the header on
    /// every SSE route. Pure so it is unit-testable without a live URL session.
    static func request(url: URL, token: String?) -> URLRequest {
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
    }
}

// MARK: - Sleep helper

private func sleep(seconds: TimeInterval) async throws {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
}
