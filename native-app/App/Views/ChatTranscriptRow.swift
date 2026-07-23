import SwiftUI
import WaynodeCore

struct ChatTranscriptRow: View {
    let item: ChatItem
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            ChatItemView(item: item)
            metadata
        }
    }

    @ViewBuilder
    private var metadata: some View {
        HStack(spacing: 6) {
            if case .assistant = item { timestamp }
            Spacer(minLength: 8)
            if case .user(let user) = item,
               let status = user.submissionStatus,
               status != .completed {
                submissionStatus(status, error: status == .failed)
                Text("·").foregroundStyle(.tertiary)
            }
            if case .user = item { timestamp }
            if case .system = item {
                timestamp
                Spacer(minLength: 8)
            }
        }
        .padding(.horizontal, 8)
    }

    @ViewBuilder
    private var timestamp: some View {
        if let sentAt = item.sentAt {
            HStack(spacing: 3) {
                Image(systemName: "clock")
                    .accessibilityHidden(true)
                Text(sentAt.formatted(date: .omitted, time: .shortened))
                    .monospacedDigit()
            }
            .accessibilityLabel(sentAt.formatted(date: .abbreviated, time: .shortened))
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .accessibilityIdentifier("chat.message.\(item.id).time")
        }
    }

    private func submissionStatus(_ status: SubmissionStatus, error: Bool) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon(for: status))
                .symbolRenderingMode(.hierarchical)
                .symbolEffect(.rotate, isActive: status.isActive && !reduceMotion)
                .symbolEffect(.wiggle, value: status == .failed)
                .contentTransition(.symbolEffect(.replace))
            Text(label(for: status))
        }
        .font(.caption2.weight(.medium))
        .foregroundStyle(error ? Color.red : Color.secondary)
        .accessibilityIdentifier("chat.submission.\(status.rawValue)")
    }

    private func label(for status: SubmissionStatus) -> String {
        switch status {
        case .sending: "Sending"
        case .queued: "Queued"
        case .starting: "Starting"
        case .running: "Running"
        case .completed: "Sent"
        case .failed: "Failed: draft restored"
        case .cancelled: "Cancelled"
        }
    }

    private func icon(for status: SubmissionStatus) -> String {
        switch status {
        case .sending, .starting, .running: "arrow.trianglehead.2.clockwise.rotate.90"
        case .queued: "clock"
        case .completed: "checkmark"
        case .failed: "exclamationmark.circle"
        case .cancelled: "stop.circle"
        }
    }
}

private extension SubmissionStatus {
    var isActive: Bool {
        switch self {
        case .sending, .starting, .running:
            true
        case .queued, .completed, .failed, .cancelled:
            false
        }
    }
}
