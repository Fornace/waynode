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
            if reducer.items.isEmpty {
                reducer.loadHistory(history.map(ChatReducer.HistoryItem.init))
            }
            didLoadHistory = true
            if let session = try? await api.getSession(sessionId) { sessionMeta = session }
        } catch {
            didLoadHistory = false
            historyError = "Conversation couldn’t be loaded. Your conversation is preserved on the server."
        }
    }

    public func retryHistory() async {
        await loadHistory()
    }

    public func sendMessage(_ prompt: String, isGoal: Bool = false) async {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let kind: SubmissionDraft.Kind = shouldQueueSubmission ? .queue : .message
        let draft: SubmissionDraft
        if let failed = reducer.submissionState.failedDraft,
           failed.prompt == trimmed, failed.isGoal == isGoal {
            draft = SubmissionDraft(id: failed.id, prompt: trimmed, isGoal: isGoal, kind: kind)
        } else {
            reducer.discardFailedDraft()
            draft = SubmissionDraft(id: UUID().uuidString, prompt: trimmed, isGoal: isGoal, kind: kind)
        }
        await submit(draft)
    }

    public func retryFailedSubmission() async {
        guard var draft = reducer.submissionState.failedDraft else { return }
        if draft.kind == .hammersmith { await submitHammersmith(draft); return }
        if shouldQueueSubmission { draft.kind = .queue }
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

    private func submit(_ draft: SubmissionDraft) async {
        guard !isSending else { return }
        isSending = true
        sendError = nil
        reducer.appendSubmission(draft)
        defer { isSending = false }

        do {
            let response: APIClient.OkResponse
            if draft.kind == .queue {
                response = try await api.queueMessage(
                    sessionId, prompt: draft.prompt,
                    isGoal: draft.isGoal, submissionId: draft.id
                )
            } else {
                response = try await sendOrQueueWhenBusy(draft)
            }
            guard response.ok else {
                reject(draft, message: "Server rejected the message")
                return
            }
            let fallbackStatus: SubmissionStatus = response.queued == true ? .queued : .starting
            let acknowledged = response.submission ?? Submission(
                id: draft.id, prompt: draft.prompt, isGoal: draft.isGoal,
                status: fallbackStatus
            )
            reducer.reconcileSubmission(acknowledged, kind: draft.kind)
            if draft.isGoal { startGoalPolling() }
        } catch {
            reject(draft, message: error.localizedDescription)
        }
    }

    private func sendOrQueueWhenBusy(_ draft: SubmissionDraft) async throws -> APIClient.OkResponse {
        do {
            return try await api.sendMessage(
                sessionId, prompt: draft.prompt,
                isGoal: draft.isGoal, submissionId: draft.id
            )
        } catch let error as APIClient.APIError where error.statusCode == 409 {
            return try await api.queueMessage(
                sessionId, prompt: draft.prompt,
                isGoal: draft.isGoal, submissionId: draft.id
            )
        }
    }

    private func reject(_ draft: SubmissionDraft, message: String) {
        reducer.reconcileSubmission(Submission(
            id: draft.id, prompt: draft.prompt, isGoal: draft.isGoal,
            status: .failed, error: message
        ), accepted: false, kind: draft.kind)
        sendError = "Message not sent. \(message) Your draft is ready to retry."
    }
}
