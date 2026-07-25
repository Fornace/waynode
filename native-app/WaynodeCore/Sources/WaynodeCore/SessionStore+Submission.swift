import Foundation

@MainActor
extension SessionStore {
    public func uploadFiles(_ files: [APIClient.UploadFile]) async throws -> [String] {
        guard !files.isEmpty else { return [] }
        return try await api.uploadFiles(spaceId, files: files).files
    }

    public func loadHistory() async {
        isLoadingHistory = true
        historyError = nil
        defer { isLoadingHistory = false }

        do {
            let history = try await api.getMessages(sessionId)
            // Load history exactly once, INDEPENDENT of whether an optimistic
            // submission has already appended a user row. Previously the gate
            // `reducer.items.isEmpty` meant a send that beat GET /messages
            // would skip the load while still marking didLoadHistory=true,
            // hiding the entire prior transcript until re-open. We stage the
            // persisted transcript in a throwaway reducer (reusing loadHistory)
            // then splice it in FRONT of any in-flight optimistic items so the
            // transcript order is preserved.
            if !didLoadHistory {
                var staged = ChatReducer()
                staged.loadHistory(history.map(ChatReducer.HistoryItem.init))
                if !staged.items.isEmpty {
                    let offset = staged.items.count
                    // Shift any streaming-item indices (msgIndex/toolIndex) by
                    // the number of prepended rows so deltas keep landing on
                    // the right item. During openStream these are typically
                    // empty (SSE not connected yet), so this is usually a no-op.
                    reducer.msgIndex = reducer.msgIndex.mapValues { $0 + offset }
                    reducer.toolIndex = reducer.toolIndex.mapValues {
                        ChatReducer.ToolLocation(itemIdx: $0.itemIdx + offset, blockIdx: $0.blockIdx)
                    }
                    reducer.items.insert(contentsOf: staged.items, at: 0)
                    reducer.revision += 1
                }
                didLoadHistory = true
            }
            if let session = try? await api.getSession(sessionId) { sessionMeta = session }
        } catch {
            didLoadHistory = false
            historyError = "Conversation couldn’t be loaded. Your conversation is preserved on the server."
        }
    }

    public func retryHistory() async {
        await loadHistory()
    }

    public func refreshCompletedHistory() async {
        do {
            let history = try await api.getMessages(sessionId)
            reducer.mergeHistory(history.map(ChatReducer.HistoryItem.init))
            historyError = nil
            didLoadHistory = true
        } catch {
            historyError = "Latest assistant response couldn’t be loaded. Pull to refresh or reopen this session."
        }
    }

    /// The one entry point for composer submissions. `mode` alone decides the
    /// endpoint (via SubmissionDraft.kind), so the UI cannot route a goal to the
    /// swarm — or a swarm job to the chat stream — by getting a second flag wrong.
    public func send(_ prompt: String, mode: SubmissionMode = .message) async {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let draft: SubmissionDraft
        if let failed = reducer.submissionState.failedDraft,
           failed.prompt == trimmed, failed.mode == mode {
            draft = SubmissionDraft(id: failed.id, prompt: trimmed, mode: mode, queued: shouldQueueSubmission)
        } else {
            reducer.discardFailedDraft()
            draft = SubmissionDraft(
                id: UUID().uuidString, prompt: trimmed, mode: mode, queued: shouldQueueSubmission
            )
        }
        // Archived sessions are read-only. Reject before any network attempt
        // and route through the existing failedDraft path so the text is
        // preserved for the composer. The server is being hardened to return
        // 409 separately; this gate is defense-in-depth plus good UX.
        if sessionMeta?.archived == true {
            reject(draft, message: "This session is archived and can’t accept new messages")
            return
        }
        await submit(draft)
    }

    public func retryFailedSubmission() async {
        guard var draft = reducer.submissionState.failedDraft else { return }
        // Re-derive the routing bit: the run state may have changed while the
        // draft sat in the composer. A hammersmith draft ignores it.
        draft.queued = shouldQueueSubmission
        await submit(draft)
    }

    public func abortTurn() async {
        sendError = nil
        do {
            let response = try await api.abortTurn(sessionId)
            if !response.cancelled {
                sendError = response.reason ?? "This hosted run can’t be stopped yet. It is still running."
            }
        } catch {
            sendError = error.localizedDescription
        }
    }

    private var shouldQueueSubmission: Bool {
        isRunActive || reducer.submissionState.queuedCount > 0
    }

    /// Endpoint dispatch — the single place a draft's kind becomes a request.
    /// Being total over Kind is what keeps mode and endpoint in lockstep.
    func submit(_ draft: SubmissionDraft) async {
        switch draft.kind {
        case .hammersmith: await submitHammersmith(draft)
        case .message, .queue: await submitChat(draft)
        }
    }

    private func submitChat(_ draft: SubmissionDraft) async {
        guard !isSending else {
            // A previous submission is still in flight. Surface a busy
            // rejection through the existing failedDraft path so the composer
            // keeps the text instead of silently dropping it — the old
            // `guard !isSending else { return }` left sendError==nil, and the
            // caller clears the composer whenever sendError is nil, so the
            // message vanished from composer, transcript, and failedDraft.
            reject(draft, message: "A message is already being sent")
            return
        }
        isSending = true
        sendError = nil
        reducer.appendSubmission(draft)
        defer { isSending = false }

        do {
            let response: APIClient.OkResponse
            if draft.kind == .queue {
                response = try await api.queueMessage(
                    sessionId, prompt: draft.prompt,
                    mode: draft.mode, submissionId: draft.id
                )
            } else {
                response = try await sendOrQueueWhenBusy(draft)
            }
            guard response.ok else {
                reject(draft, message: "Server rejected the message")
                return
            }
            let fallbackStatus: SubmissionStatus = response.queued == true ? .queued : .starting
            var acknowledged = response.submission ?? Submission(
                id: draft.id, prompt: draft.prompt, mode: draft.mode,
                status: fallbackStatus
            )
            // The client chose the endpoint, so its mode is authoritative for the
            // row already on screen: a mode-less acknowledgement must never
            // downgrade a goal turn to a plain message.
            acknowledged.mode = draft.mode
            reducer.reconcileSubmission(acknowledged, queued: draft.queued)
            if ![.completed, .failed, .cancelled].contains(acknowledged.status) {
                startRunStatePolling()
                if draft.mode == .goal { startGoalPolling() }
            }
        } catch {
            reject(draft, message: error.localizedDescription)
        }
    }

    private func sendOrQueueWhenBusy(_ draft: SubmissionDraft) async throws -> APIClient.OkResponse {
        do {
            return try await api.sendMessage(
                sessionId, prompt: draft.prompt,
                mode: draft.mode, submissionId: draft.id
            )
        } catch let error as APIClient.APIError where error.statusCode == 409 {
            return try await api.queueMessage(
                sessionId, prompt: draft.prompt,
                mode: draft.mode, submissionId: draft.id
            )
        }
    }

    func reject(_ draft: SubmissionDraft, message: String) {
        reducer.reconcileSubmission(Submission(
            id: draft.id, prompt: draft.prompt, mode: draft.mode,
            status: .failed, error: message
        ), accepted: false, queued: draft.queued)
        sendError = "Message not sent. \(message) Your draft is ready to retry."
    }
}
