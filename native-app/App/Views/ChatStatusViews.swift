import SwiftUI
import WaynodeCore

struct EmptyChatState: View {
    var onTap: (String) -> Void

    var body: some View {
        VStack(spacing: 20) {
            VStack(spacing: 10) {
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 30, weight: .medium))
                    .foregroundStyle(.tint)
                Text("What should we change?")
                    .font(.title3.bold())
                Text("Describe a task, paste code, or ask about this worktree.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            VStack(spacing: 8) {
                SuggestionChip(icon: "doc.text.magnifyingglass", text: "Explain this codebase") { onTap("Explain this codebase") }
                SuggestionChip(icon: "stethoscope", text: "Find and fix bugs") { onTap("Find and fix bugs") }
                SuggestionChip(icon: "wand.and.stars", text: "Add a feature") { onTap("Add a feature") }
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("chat.empty")
    }
}

struct HistoryFailureState: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Conversation unavailable", systemImage: "clock.arrow.trianglehead.counterclockwise.rotate.90")
        } description: {
            Text(message)
        } actions: {
            Button("Retry", action: onRetry)
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("chat.history.retry")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.history.failure")
    }
}

struct AgentWaitingRow: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 8) {
            ActivitySymbol(
                systemImage: "arrow.trianglehead.2.clockwise.rotate.90",
                reduceMotion: reduceMotion,
                size: 12,
                weight: .medium
            )
            .foregroundStyle(.tint)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityIdentifier("chat.agent.waiting")
    }
}

private struct SuggestionChip: View {
    let icon: String
    let text: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundStyle(.tint)
                    .frame(width: 20)
                Text(text).font(.subheadline)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct ConnectionBanner: View {
    let state: SSEClient.ConnectionState
    var onRecovery: (SSEClient.ConnectionFailure.Recovery) -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            icon
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption.bold())
                if let detail {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(statusLabel)
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("chat.connection.status")
            Spacer(minLength: 8)
            if case .reconnecting = state {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Waiting to reconnect")
                Button("Retry Now") { onRecovery(.retry) }
                    .font(.caption)
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("chat.connection.retry")
                    .accessibilityHint("Reconnects without clearing the transcript or message draft")
            } else if case .failed(let failure) = state {
                Button(failure.recoveryTitle) { onRecovery(failure.recovery) }
                    .font(.caption)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("chat.connection.recovery")
                    .accessibilityHint(failure.message)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(bannerColor.opacity(0.15))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.connection")
    }

    private var icon: some View {
        Image(systemName: bannerSystemImage)
            .symbolRenderingMode(.hierarchical)
            .symbolEffect(.rotate, isActive: isReconnecting)
            .symbolEffect(.wiggle, value: isFailed)
            .contentTransition(.symbolEffect(.replace))
    }

    private var bannerSystemImage: String {
        switch state {
        case .reconnecting: "arrow.triangle.2.circlepath"
        case .failed: "wifi.slash"
        default: "circle.fill"
        }
    }

    private var isReconnecting: Bool {
        if case .reconnecting = state { return true }
        return false
    }

    private var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }

    private var title: String {
        switch state {
        case .reconnecting: "Connection lost"
        case .failed: "Action needed"
        default: ""
        }
    }

    private var detail: String? {
        switch state {
        case .reconnecting(let delay):
            "Retrying in \(max(1, Int(delay))) seconds…"
        case .failed(let failure):
            failure.message
        default:
            nil
        }
    }

    private var statusLabel: String {
        [title, detail].compactMap { $0 }.joined(separator: ". ")
    }

    private var bannerColor: Color {
        switch state {
        case .reconnecting: .orange
        case .failed: .red
        default: .secondary
        }
    }
}

struct GoalBanner: View {
    let status: GoalStatus
    var onAbort: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 8) {
            goalSymbol
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(status.objective ?? "Goal running").font(.caption.bold()).lineLimit(1)
                if let budget = status.tokenBudget, let usage = status.tokenUsage {
                    HStack(spacing: 4) {
                        Text("\(Format.tokenCount(usage)) / \(Format.tokenCount(budget)) tokens")
                        if let elapsed = status.elapsedMs { Text("· \(Format.duration(ms: elapsed))") }
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                    ProgressView(value: Double(usage), total: Double(budget)).controlSize(.mini).tint(.accentColor)
                } else if let elapsed = status.elapsedMs {
                    Text(Format.duration(ms: elapsed)).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button(action: onAbort) { Image(systemName: "stop.fill").font(.caption) }
                .buttonStyle(.glass).controlSize(.small)
                .accessibilityLabel("Abort goal")
                .accessibilityIdentifier("chat.goal.stop")
        }
        .padding(.horizontal, 16).padding(.vertical, 8).background(.tint.opacity(0.08))
        .accessibilityIdentifier("chat.goal")
    }

    private var goalProgress: Double? {
        guard let usage = status.tokenUsage, let budget = status.tokenBudget, budget > 0 else { return nil }
        return min(1, max(0, Double(usage) / Double(budget)))
    }

    private var goalSymbol: some View {
        let systemImage = status.status == .active ? "target" : "pause.circle"
        return Image(systemName: systemImage, variableValue: goalProgress ?? 0)
            .symbolRenderingMode(.hierarchical)
            .symbolVariableValueMode(.draw)
            .symbolEffect(.breathe, isActive: status.status == .active && !reduceMotion)
            .contentTransition(.symbolEffect(.replace))
    }
}

struct GoalStatusSummary: View {
    let status: GoalStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let objective = status.objective { Text(objective).font(.subheadline) }
            HStack {
                if let value = status.status {
                    Label {
                        Text(value.rawValue.capitalized)
                    } icon: {
                        Image(systemName: value == .active ? "target" : "pause.circle", variableValue: goalProgress ?? 0)
                            .symbolRenderingMode(.hierarchical)
                            .symbolVariableValueMode(.draw)
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .font(.caption).foregroundStyle(.tint)
                }
                if let usage = status.tokenUsage, let budget = status.tokenBudget {
                    Text("· \(Format.tokenCount(usage))/\(Format.tokenCount(budget)) tokens")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var goalProgress: Double? {
        guard let usage = status.tokenUsage, let budget = status.tokenBudget, budget > 0 else { return nil }
        return min(1, max(0, Double(usage) / Double(budget)))
    }
}

struct ConnectionStateBadge: View {
    let state: SSEClient.ConnectionState

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(color)
            Text(label).font(.caption)
        }
    }

    private var color: Color {
        switch state {
        case .connected: .green
        case .connecting, .reconnecting: .orange
        case .disconnected: .secondary
        case .failed: .red
        }
    }

    private var systemImage: String {
        switch state {
        case .connected: "checkmark.circle.fill"
        case .connecting, .reconnecting: "arrow.triangle.2.circlepath"
        case .disconnected: "wifi.slash"
        case .failed: "exclamationmark.octagon.fill"
        }
    }

    private var label: String {
        switch state {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .reconnecting: "Reconnecting…"
        case .disconnected: "Disconnected"
        case .failed: "Action needed"
        }
    }
}
