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
    let api: any SessionTransport
    private let offlineFixture: Bool
    private var sse: SSEClient?
    private var listenerTask: Task<Void, Never>?
    private var stateTask: Task<Void, Never>?
    private var runStateTask: Task<Void, Never>?
    private var closeTimer: Task<Void, Never>?
    private var viewerCount: Int = 0
    private var isRestartingStream: Bool = false
    private var reconnectCursor: String?
    private var streamCloseTask: Task<Void, Never>?
    #if DEBUG
    var testViewerCount: Int { viewerCount }
    var testHasStream: Bool { sse != nil }
    var testReconnectCursor: String? { reconnectCursor }
    var testStreamCursor: String? { get async { await sse?.reconnectCursor } }
    #endif

    // The reducer is the source of truth.
    public var reducer = ChatReducer()

    // Status (separate from reducer so we can show live updates).
    public var connectionState: SSEClient.ConnectionState = .disconnected
    public var isLoadingHistory: Bool = false
    public var didLoadHistory: Bool = false
    public var historyError: String?
    public var isSending: Bool = false
    public var sendError: String?
    public var goalStatus: GoalStatus = GoalStatus()
    public var sessionMeta: Session?
    public var isPollingGoal: Bool = false
    public var hammersmithCapability: HammersmithCapability?

    public var failedDraft: SubmissionDraft? { reducer.submissionState.failedDraft }
    public var isRunActive: Bool {
        reducer.isStreaming || reducer.submissionState.activeStatus == .starting
            || reducer.submissionState.activeStatus == .running
    }

    public init(
        sessionId: String, spaceId: String,
        api: any SessionTransport, offlineFixture: Bool = false
    ) {
        self.sessionId = sessionId
        self.spaceId = spaceId
        self.api = api
        self.offlineFixture = offlineFixture
    }

    // MARK: - Lifecycle (acquire / release)

    public func acquire() async {
        viewerCount += 1
        closeTimer?.cancel()
        closeTimer = nil

        if offlineFixture {
            connectionState = .connected
            return
        }
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
                self?.closeStream()
            }
        }
    }

    // MARK: - Open / close SSE

    private func openStream() async {
        await loadHistory()

        // Check live state — if the agent is mid-turn, we'll get a sync event.
        if let state = await refreshSessionState(), state.active || isRunActive {
            startRunStatePolling()
        }

        await refreshHammersmithJobs()
        Task { await self.loadHammersmithCapability() }

        await connectStream()
    }

    /// Reopen only the live stream. History and reducer state deliberately stay
    /// intact, so retrying cannot erase the transcript or disturb a draft held
    /// by the composing view.
    public func reconnect() async {
        guard viewerCount > 0, !isRestartingStream else { return }
        isRestartingStream = true
        defer { isRestartingStream = false }

        listenerTask?.cancel()
        listenerTask = nil
        let previous = sse
        sse = nil
        if let previous { reconnectCursor = await previous.reconnectCursor }
        await previous?.stop()

        guard viewerCount > 0 else {
            connectionState = .disconnected
            return
        }
        await connectStream()
    }

    private func connectStream() async {
        // A release/reacquire can overlap the asynchronous actor hop needed to
        // capture the previous client's cursor. Wait for that handoff before
        // constructing the replacement request, or replay can start at nil.
        if let closing = streamCloseTask { await closing.value }
        guard sse == nil, viewerCount > 0 else { return }
        connectionState = .connecting
        let url = api.makeURL("/api/sessions/\(sessionId)/stream")
        let token = await api.currentToken()
        let client = SSEClient(url: url, token: token, lastEventId: reconnectCursor)
        sse = client
        await client.start()

        // Listen to events on the main actor.
        listenerTask?.cancel()
        let events = client.events()
        let states = client.stateChanges()
        listenerTask = Task { [weak self] in
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    for await frame in events {
                        guard let self else { return }
                        await self.processFrame(frame, from: client)
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
        runStateTask?.cancel()
        runStateTask = nil
        let client = sse
        sse = nil
        connectionState = .disconnected
        guard let client else { return }
        // Keep one awaitable handoff barrier. connectStream() waits for this
        // task, so immediate reacquisition cannot race ahead with a nil cursor.
        guard streamCloseTask == nil else { return }
        streamCloseTask = Task { [weak self] in
            let cursor = await client.reconnectCursor
            await client.stop()
            guard let self else { return }
            self.reconnectCursor = cursor
            self.streamCloseTask = nil
        }
    }

    #if DEBUG
    func installStreamForTest(_ client: SSEClient, viewerCount: Int) {
        sse = client
        self.viewerCount = viewerCount
    }

    func closeStreamForTest() { closeStream() }
    func connectStreamForTest() async { await connectStream() }
    func awaitCloseForTest() async { await streamCloseTask?.value }
    #endif

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

    /// Application-level SSE acknowledgement. Durable cursor movement happens
    /// only after the reducer/store has represented the decoded event.
    func processFrame(_ frame: SSEFrame, from client: SSEClient) async {
        guard let event = frame.event else {
            await client.acknowledge(frame, applied: false)
            return
        }
        let applied = handle(event)
        await client.acknowledge(frame, applied: applied)
    }

    @discardableResult
    private func handle(_ event: SSEEvent.Kind) -> Bool {
        switch event {
        case .sessionRenamed(let title):
            sessionMeta?.title = title
            return true
        case .status:
            // Status update, also feed the reducer.
            _ = reducer.reduce(event)
            // Start goal polling if not already.
            if !isPollingGoal { startGoalPolling() }
            return true
        case .submission(let submission):
            _ = reducer.reduce(event)
            if ![.completed, .failed, .cancelled].contains(submission.status) {
                startRunStatePolling()
                if submission.mode == .goal { startGoalPolling() }
            } else if !isRunActive {
                stopRunStatePolling()
                Task { await self.refreshCompletedHistory() }
            }
            return true
        case .end, .turnEnd:
            _ = reducer.reduce(event)
            if !isRunActive {
                stopRunStatePolling()
                stopGoalPolling()
                Task { await self.refreshCompletedHistory() }
            }
            // Final fetch of goal status.
            Task { await self.refreshGoalStatus() }
            return true
        default:
            return reducer.reduce(event)
        }
    }

    private func handle(_ state: SSEClient.ConnectionState) {
        connectionState = state
    }

    // MARK: - Run state polling

    public func startRunStatePolling() {
        guard !isPollingRunState else { return }
        runStateTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2 * 1_000_000_000)
                guard !Task.isCancelled, let self else { return }
                let state = await self.refreshSessionState()
                let runActive = self.isRunActive
                if state?.active == false, !runActive {
                    self.stopRunStatePolling()
                    return
                }
            }
        }
    }

    public func stopRunStatePolling() {
        runStateTask?.cancel()
        runStateTask = nil
    }

    public var isPollingRunState: Bool {
        runStateTask != nil
    }

    @discardableResult
    public func refreshSessionState() async -> APIClient.StateResponse? {
        guard let state = try? await api.getSessionState(sessionId) else { return nil }
        reducer.reconcileSessionState(
            active: state.active,
            done: state.done,
            submissions: state.submissions
        )
        if !state.active, state.done {
            stopRunStatePolling()
            if !isRunActive {
                Task { await self.refreshCompletedHistory() }
            }
        }
        return state
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
                    let status = self.goalStatus.status
                    if status == nil || status == .complete {
                        self.stopGoalPolling()
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
        historyError = nil
        didLoadHistory = false
    }
}

// MARK: - HistoryItem conversion

extension ChatReducer.HistoryItem {
    init(_ msg: APIClient.HistoryMessage) {
        self.init(
            role: msg.role,
            id: msg.id ?? UUID().uuidString,
            content: msg.content,
            text: msg.text,
            thinking: msg.thinking,
            key: msg.key,
            sentAt: ISODate.parse(msg.timestamp),
            blocks: msg.blocks,
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            isError: msg.isError
        )
    }
}

// MARK: - (HistoryItem conversion is defined in Chat.swift)
