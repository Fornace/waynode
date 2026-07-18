import Foundation

// MARK: - Hammersmith delegation
//
// Mirrors sendMessage's draft discipline, but posts the prompt as a job
// description to /api/sessions/:id/hammersmith. Failures keep the draft
// retryable with kind .hammersmith so retryFailedSubmission routes back here.

@MainActor
extension SessionStore {
    /// Dynamic dispatch goes through HammersmithTransport — the bare
    /// SessionTransport extension members statically resolve to 501 defaults.
    private var hammersmithAPI: (any HammersmithTransport)? { api as? any HammersmithTransport }

    public func loadHammersmithCapability() async {
        guard let transport = hammersmithAPI else { hammersmithCapability = nil; return }
        hammersmithCapability = try? await transport.getHammersmithCapability()
    }

    public func refreshHammersmithJobs() async {
        guard let transport = hammersmithAPI,
              let jobs = try? await transport.listHammersmithJobs(sessionId) else { return }
        for job in jobs { reducer.upsertHammersmithRun(job) }
    }

    public func sendHammersmith(_ prompt: String) async {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let draft: SubmissionDraft
        if let failed = reducer.submissionState.failedDraft,
           failed.prompt == trimmed, failed.kind == .hammersmith {
            draft = SubmissionDraft(id: failed.id, prompt: trimmed, isGoal: false, kind: .hammersmith)
        } else {
            reducer.discardFailedDraft()
            draft = SubmissionDraft(id: UUID().uuidString, prompt: trimmed, isGoal: false, kind: .hammersmith)
        }
        await submitHammersmith(draft)
    }

    func submitHammersmith(_ draft: SubmissionDraft) async {
        guard !isSending else { return }
        isSending = true
        sendError = nil
        reducer.appendSubmission(draft)
        defer { isSending = false }

        do {
            guard let transport = hammersmithAPI else {
                throw APIClient.APIError(statusCode: 501, message: "Hammersmith is unavailable")
            }
            let response = try await transport.sendHammersmith(
                sessionId, prompt: draft.prompt, submissionId: draft.id
            )
            guard response.ok else {
                reducer.reconcileSubmission(Submission(
                    id: draft.id, prompt: draft.prompt, isGoal: false,
                    status: .failed, error: "Server rejected the job"
                ), accepted: false, kind: .hammersmith)
                sendError = "Job not delegated. Server rejected the job Your draft is ready to retry."
                return
            }
            let acknowledged = response.submission ?? Submission(
                id: draft.id, prompt: draft.prompt, isGoal: false, status: .completed
            )
            reducer.reconcileSubmission(acknowledged, kind: .hammersmith)
            if let job = response.job { reducer.upsertHammersmithRun(job) }
        } catch {
            reducer.reconcileSubmission(Submission(
                id: draft.id, prompt: draft.prompt, isGoal: false,
                status: .failed, error: error.localizedDescription
            ), accepted: false, kind: .hammersmith)
            sendError = "Job not delegated. \(error.localizedDescription) Your draft is ready to retry."
        }
    }

    public func stopHammersmith(_ jobId: String) async {
        do {
            guard let transport = hammersmithAPI else {
                throw APIClient.APIError(statusCode: 501, message: "Hammersmith is unavailable")
            }
            let response = try await transport.stopHammersmithJob(jobId)
            if let job = response.job { reducer.upsertHammersmithRun(job) }
        } catch {
            sendError = error.localizedDescription
        }
    }
}
