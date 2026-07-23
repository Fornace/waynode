import Foundation

public struct ChatSubmissionState: Sendable, Equatable {
    public private(set) var failedDraft: SubmissionDraft?
    public private(set) var queuedCount = 0
    public private(set) var activeStatus: SubmissionStatus?

    public init() {}

    public mutating func reconcile(
        items: inout [ChatItem],
        submission: Submission,
        accepted: Bool = true,
        kind: SubmissionDraft.Kind = .message
    ) {
        let draft = SubmissionDraft(
            id: submission.id, prompt: submission.prompt,
            isGoal: submission.isGoal, kind: kind
        )
        let index = items.firstIndex { item in
            if case .user(let user) = item { return user.id == submission.id }
            return false
        } ?? items.lastIndex { item in
            guard case .user(let user) = item else { return false }
            return user.content == submission.prompt
                && user.isGoal == submission.isGoal
                && user.submissionStatus?.isPending == true
        }
        if !accepted && submission.status == .failed {
            if let index { items.remove(at: index) }
        } else {
            let sentAt: Date?
            if let index, case .user(let existing) = items[index] {
                sentAt = existing.sentAt
            } else {
                sentAt = Date()
            }
            let user = ChatItem.user(.init(
                id: submission.id, content: submission.prompt,
                isGoal: submission.isGoal, submissionStatus: submission.status,
                sentAt: sentAt
            ))
            if let index { items[index] = user } else { items.append(user) }
        }

        if submission.status == .failed {
            failedDraft = SubmissionDraft(
                id: accepted ? UUID().uuidString : draft.id,
                prompt: draft.prompt, isGoal: draft.isGoal, kind: draft.kind
            )
        } else if failedDraft?.id == submission.id {
            failedDraft = nil
        }
        derive(from: items)
    }

    public mutating func reset() {
        failedDraft = nil; queuedCount = 0; activeStatus = nil
    }

    mutating func completePending(items: inout [ChatItem]) {
        for index in items.indices {
            guard case .user(let user) = items[index],
                  user.submissionStatus?.isPending == true else {
                continue
            }
            items[index] = .user(.init(
                id: user.id,
                content: user.content,
                isGoal: user.isGoal,
                submissionStatus: .completed,
                sentAt: user.sentAt
            ))
        }
        derive(from: items)
    }

    public mutating func discardFailedDraft() {
        failedDraft = nil
    }

    private mutating func derive(from items: [ChatItem]) {
        let statuses = items.compactMap { item -> SubmissionStatus? in
            if case .user(let user) = item { return user.submissionStatus }
            return nil
        }
        queuedCount = statuses.filter { $0 == .queued }.count
        activeStatus = [.running, .starting, .queued, .sending].first { statuses.contains($0) }
    }
}

private extension SubmissionStatus {
    var isPending: Bool {
        switch self {
        case .sending, .queued, .starting, .running:
            true
        case .completed, .failed, .cancelled:
            false
        }
    }
}
