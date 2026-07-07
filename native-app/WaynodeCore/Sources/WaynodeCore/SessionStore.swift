import Foundation
#if canImport(Observation)
import Observation
#endif

// MARK: - SessionStore
//
// Observable wrapper around ChatReducer + SSEClient + APIClient.
//
// Lifecycle mirrors the web client (sessionStore.ts):
//   • acquire() loads history + opens SSE
//   • release() schedules a 30s close timer (refcount)
//   • The store is never destroyed while the app is foregrounded; it
//     lives in a parent container (SpacesStore) keyed by sessionId.
//
// The reducer is the single source of truth for chat items. The store
// observes the SSE stream and applies events via the reducer, then triggers
// a UI invalidation via @Observable.
//
// Threading: MainActor-isolated. All mutations happen on the main thread.
// Network I/O is awaited off-main via Task.detached-like semantics inside
// the SSE client actor.

@MainActor
@Observable
public final class SessionStore {
    public let sessionId: String
    public let spaceId: String
    private let api: APIClient
    private var sse: SSEClient?
    private var listenerTask: Task<Void, Never>?
    private var stateTask: Task<Void, Never>?
    private var closeTimer: Task<Void, Never>?
    private var viewerCount: Int = 0

    // The reducer is the source of truth.
    public var reducer = ChatReducer()

    // Status (separate from reducer so we can show live updates).
    public var connectionState: SSEClient.ConnectionState = .disconnected
    public var isLoadingHistory: Bool = false
    public var isSending: Bool = false
    public var sendError: String?
    public var goalStatus: GoalStatus = GoalStatus()
    public var sessionMeta: Session?
    public var isPollingGoal: Bool = false

    public init(sessionId: String, spaceId: String, api: APIClient) {
        self.sessionId = sessionId
        self.spaceId = spaceId
        self.api = api
    }

    // MARK: - Lifecycle (acquire / release)

    public func acquire() async {
        viewerCount += 1
        closeTimer?.cancel()
        closeTimer = nil

        if sse == nil {
            await openStream()
        }
    }

    public func release() {
        viewerCount -= 1
        if viewerCount <= 0 {
            viewerCount = 0
            // Schedule close after 30s — mirrors sessionStore.ts.
            closeTimer?.cancel()
            closeTimer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                guard !Task.isCancelled else { return }
                await self?.closeStream()
            }
        }
    }

    // MARK: - Open / close SSE

    private func openStream() async {
        // Load history first.
        isLoadingHistory = true
        do {
            let history = try await api.getMessages(sessionId)
            reducer.loadHistory(history.map(ChatReducer.HistoryItem.init))
            if let session = try? await api.getSession(sessionId) {
                sessionMeta = session
            }
        } catch {
            // Non-fatal — we'll still connect to the stream.
            sendError = "Could not load history: \(error.localizedDescription)"
        }
        isLoadingHistory = false

        // Check live state — if the agent is mid-turn, we'll get a sync event.
        if let state = try? await api.getSessionState(sessionId), state.active {
            // Kick goal polling.
            startGoalPolling()
        }

        // Open SSE.
        let url = api.makeURL("/api/sessions/\(sessionId)/stream")
        let token = await api.currentToken()
        let client = SSEClient(url: url, token: token)
        sse = client
        await client.start()

        // Listen to events on the main actor.
        listenerTask?.cancel()
        let events = await client.events()
        let states = await client.stateChanges()
        listenerTask = Task { [weak self] in
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    for await event in events {
                        await self?.handle(event)
                    }
                }
                group.addTask {
                    for await state in states {
                        await self?.handle(state)
                    }
                }
            }
        }
    }

    private func closeStream() {
        listenerTask?.cancel()
        listenerTask = nil
        stateTask?.cancel()
        stateTask = nil
        Task { [sse] in await sse?.stop() }
        sse = nil
        connectionState = .disconnected
    }

    /// Force-close the SSE stream immediately (no 30s timer).
    /// Called by AppModel on logout, space deletion, or session deletion
    /// to avoid leaking URLSession connections and listener tasks.
    public func close() {
        closeTimer?.cancel()
        closeTimer = nil
        viewerCount = 0
        stopGoalPolling()
        closeStream()
    }

    // MARK: - Event handling

    private func handle(_ event: SSEEvent.Kind) {
        switch event {
        case .sessionRenamed(let title):
            sessionMeta?.title = title
            return
        case .status(let text):
            // Status update — also feed the reducer.
            _ = reducer.reduce(event)
            // Start goal polling if not already.
            if !isPollingGoal { startGoalPolling() }
            return
        case .end, .turnEnd:
            _ = reducer.reduce(event)
            stopGoalPolling()
            // Final fetch of goal status.
            Task { await self.refreshGoalStatus() }
            return
        default:
            _ = reducer.reduce(event)
        }
    }

    private func handle(_ state: SSEClient.ConnectionState) {
        connectionState = state
    }

    // MARK: - Send message

    public func sendMessage(_ prompt: String, isGoal: Bool = false) async {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        isSending = true
        sendError = nil

        // Optimistic append — mirrors sessionStore.ts.
        reducer.appendUser(trimmed, isGoal: isGoal)

        do {
            let resp = try await api.sendMessage(sessionId, prompt: trimmed, isGoal: isGoal)
            if !resp.ok {
                sendError = "Server rejected message"
            } else if isGoal {
                startGoalPolling()
            }
        } catch let err as APIClient.APIError where err.statusCode == 409 {
            // Busy — queue instead.
            do {
                _ = try await api.queueMessage(sessionId, prompt: trimmed)
            } catch {
                sendError = "Could not queue: \(error.localizedDescription)"
            }
        } catch {
            sendError = error.localizedDescription
        }
        isSending = false
    }

    public func abortTurn() async {
        do { try await api.abortTurn(sessionId) } catch { sendError = error.localizedDescription }
    }

    // MARK: - Goal polling

    public func startGoalPolling() {
        guard !isPollingGoal else { return }
        isPollingGoal = true
        stateTask?.cancel()
        stateTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2 * 1_000_000_000)
                guard !Task.isCancelled else { return }
                await self?.refreshGoalStatus()
                // Stop polling when goal is complete or null.
                if let self {
                    let status = await self.goalStatus.status
                    if status == nil || status == .complete {
                        await self.stopGoalPolling()
                        return
                    }
                }
            }
        }
    }

    public func stopGoalPolling() {
        isPollingGoal = false
        stateTask?.cancel()
        stateTask = nil
    }

    public func refreshGoalStatus() async {
        if let status = try? await api.getGoalStatus(sessionId) {
            goalStatus = status
        }
    }

    // MARK: - Reset (for retry / clear)

    public func reset() {
        reducer.reset()
        goalStatus = GoalStatus()
        sendError = nil
    }
}

// MARK: - HistoryItem conversion

extension ChatReducer.HistoryItem {
    init(_ msg: APIClient.HistoryMessage) {
        self.init(
            role: msg.role,
            id: msg.id ?? UUID().uuidString,
            content: msg.content,
            isGoal: msg.isGoal ?? false,
            text: msg.text,
            thinking: msg.thinking,
            key: msg.key
        )
    }
}

// MARK: - (HistoryItem conversion is defined in Chat.swift)
