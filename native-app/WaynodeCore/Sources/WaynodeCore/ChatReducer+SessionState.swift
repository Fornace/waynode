import Foundation

extension ChatReducer {
    public mutating func reconcileSessionState(active: Bool, done: Bool, submissions: [Submission]) {
        for submission in submissions {
            reconcileSubmission(submission)
        }
        guard !active, done else { return }
        submissionState.completePending(items: &items)
        isStreaming = false
        statusText = nil
        finalisePendingAssistant()
        revision += 1
    }
}
