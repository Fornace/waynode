import SwiftUI
import WaynodeCore

struct ChatTranscriptRow: View {
    let item: ChatItem

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

    private var timestamp: some View {
        Group {
            if let sentAt = item.sentAt {
                Text(sentAt.formatted(date: .omitted, time: .shortened))
                    .monospacedDigit()
                    .accessibilityLabel(sentAt.formatted(date: .abbreviated, time: .shortened))
            } else {
                Text("Time unavailable")
                    .accessibilityLabel("Sent time unavailable")
            }
        }
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .accessibilityIdentifier("chat.message.\(item.id).time")
    }

    private func submissionStatus(_ status: SubmissionStatus, error: Bool) -> some View {
        Label(label(for: status), systemImage: icon(for: status))
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
        case .failed: "Failed — draft restored"
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
