import SwiftUI
import WaynodeCore

struct EmptyChatState: View {
    var onTap: (String) -> Void

    var body: some View {
        VStack(spacing: 20) {
            VStack(spacing: 12) {
                Image(systemName: "sparkles")
                    .font(.system(size: 40, weight: .light))
                    .foregroundStyle(.tint)
                Text("How can I help?")
                    .font(.title3.bold())
                Text("Describe a task, paste code, or ask a question.\nThe agent works directly in your repository.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            VStack(spacing: 8) {
                SuggestionChip(icon: "doc.text.magnifyingglass", text: "Explain this codebase") { onTap("Explain this codebase") }
                SuggestionChip(icon: "bug", text: "Find and fix bugs") { onTap("Find and fix bugs") }
                SuggestionChip(icon: "wand.and.stars", text: "Add a feature") { onTap("Add a feature") }
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct SuggestionChip: View {
    let icon: String
    let text: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.caption).foregroundStyle(.tint)
                Text(text).font(.subheadline)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct ConnectionBanner: View {
    let state: SSEClient.ConnectionState

    var body: some View {
        HStack(spacing: 8) {
            icon
            Text(text).font(.caption.bold())
            Spacer()
            if case .reconnecting = state { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(bannerColor.opacity(0.15))
    }

    private var icon: some View {
        switch state {
        case .reconnecting: Image(systemName: "arrow.triangle.2.circlepath")
        case .failed: Image(systemName: "wifi.slash")
        default: Image(systemName: "circle.fill")
        }
    }

    private var text: String {
        switch state {
        case .reconnecting: "Reconnecting…"
        case .failed: "Connection failed — will retry"
        default: ""
        }
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

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: status.status == .active ? "target" : "pause.circle").foregroundStyle(.tint)
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
        }
        .padding(.horizontal, 16).padding(.vertical, 8).background(.tint.opacity(0.08))
    }
}

struct GoalStatusSummary: View {
    let status: GoalStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let objective = status.objective { Text(objective).font(.subheadline) }
            HStack {
                if let value = status.status {
                    Label(value.rawValue.capitalized, systemImage: value == .active ? "target" : "pause.circle")
                        .font(.caption).foregroundStyle(.tint)
                }
                if let usage = status.tokenUsage, let budget = status.tokenBudget {
                    Text("· \(Format.tokenCount(usage))/\(Format.tokenCount(budget)) tokens")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct ConnectionStateBadge: View {
    let state: SSEClient.ConnectionState

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 8, height: 8)
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

    private var label: String {
        switch state {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .reconnecting: "Reconnecting…"
        case .disconnected: "Disconnected"
        case .failed: "Failed"
        }
    }
}
