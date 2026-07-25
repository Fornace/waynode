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

    /// Convenience spelling of `send(_:mode:)` — the draft discipline (retry
    /// reuse, archived gate) lives there so both surfaces behave identically.
    public func sendHammersmith(_ prompt: String) async {
        await send(prompt, mode: .hammersmith)
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
                    id: draft.id, prompt: draft.prompt, mode: .hammersmith,
                    status: .failed, error: "Server rejected the job"
                ), accepted: false)
                sendError = "Job not delegated. Server rejected the job Your draft is ready to retry."
                return
            }
            var acknowledged = response.submission ?? Submission(
                id: draft.id, prompt: draft.prompt, mode: .hammersmith, status: .completed
            )
            // Keep the row's mode on the endpoint that produced it, so a retry
            // of a later failure still routes back to /hammersmith.
            acknowledged.mode = .hammersmith
            reducer.reconcileSubmission(acknowledged)
            if let job = response.job { reducer.upsertHammersmithRun(job) }
        } catch {
            reducer.reconcileSubmission(Submission(
                id: draft.id, prompt: draft.prompt, mode: .hammersmith,
                status: .failed, error: error.localizedDescription
            ), accepted: false)
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
