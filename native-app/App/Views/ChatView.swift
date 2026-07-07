import SwiftUI
import WaynodeCore

// MARK: - ChatView
//
// The main conversation surface. Shows:
//   • A connection status banner (only when degraded)
//   • A goal status banner (when active)
//   • The scrollable message list (lazy)
//   • The composer (text editor + send button + goal toggle)
//
// Design:
//   • Content layer (messages, diffs, tool results) — matte, no glass.
//   • Functional layer (composer bar, buttons) — Liquid Glass.
//   • Primary action (Send) — .glassProminent.
//   • Auto-scroll to bottom on new content, but respects manual scroll-up.
//   • Streaming text appears character-by-character (from SSE deltas).

struct ChatView: View {
    @Bindable var store: SessionStore
    @Environment(AppModel.self) private var appModel
    @State private var composerText: String = ""
    @FocusState private var composerFocused: Bool
    @State private var autoScroll: Bool = true

    // Auto-scroll anchor: track the last item id for scroll-to-bottom.
    private let bottomID = "chat-bottom"

    var body: some View {
        VStack(spacing: 0) {
            // Top banners (conditional)
            VStack(spacing: 0) {
                if showConnectionBanner {
                    ConnectionBanner(state: store.connectionState)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                if store.goalStatus.status == .active || store.goalStatus.status == .paused {
                    GoalBanner(status: store.goalStatus) {
                        Task { await store.abortTurn() }
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.smooth, value: store.connectionState)
            .animation(.smooth, value: store.goalStatus.status)

            // Message list
            messageList

            // Composer
            ComposerBar(
                text: $composerText,
                isSending: store.isSending,
                error: store.sendError,
                isGoalActive: store.goalStatus.status == .active,
                isFocused: $composerFocused,
                onSend: { prompt, isGoal in
                    Task {
                        await store.sendMessage(prompt, isGoal: isGoal)
                        composerText = ""
                        autoScroll = true
                    }
                },
                onAbort: {
                    Task { await store.abortTurn() }
                }
            )
        }
    }

    // MARK: - Message list

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if store.reducer.items.isEmpty && !store.isLoadingHistory {
                        EmptyChatState()
                            .padding(.top, 60)
                    }

                    if store.isLoadingHistory {
                        HStack {
                            Spacer()
                            ProgressView("Loading history…")
                            Spacer()
                        }
                        .padding(.top, 40)
                    }

                    ForEach(store.reducer.items) { item in
                        ChatItemView(item: item)
                            .id(item.id)
                    }

                    // Bottom anchor for auto-scroll
                    Color.clear
                        .frame(height: 1)
                        .id(bottomID)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            // Track whether user is near the bottom — drives autoScroll.
            // When the user scrolls up, autoScroll becomes false; when they
            // scroll back to the bottom, it becomes true again.
            .onScrollGeometryChange(for: Bool.self) { geo in
                // "Near bottom" = the visible area reaches within 80pt of the end.
                let maxOffset = geo.contentSize.height - geo.bounds.height
                let currentOffset = geo.contentOffset.y + geo.bounds.height
                return maxOffset <= 0 || currentOffset >= geo.contentSize.height - 80
            } action: { oldValue, isNearBottom in
                autoScroll = isNearBottom
            }
            .onChange(of: store.reducer.items.last?.id) {
                if autoScroll {
                    withAnimation(.smooth) {
                        proxy.scrollTo(bottomID, anchor: .bottom)
                    }
                }
            }
            .onChange(of: store.reducer.items.count) {
                if autoScroll {
                    withAnimation(.smooth) {
                        proxy.scrollTo(bottomID, anchor: .bottom)
                    }
                }
            }
            // Follow streaming content growth — revision bumps on every
            // text_delta so we scroll as the assistant's reply grows.
            .onChange(of: store.reducer.revision) {
                if autoScroll {
                    proxy.scrollTo(bottomID, anchor: .bottom)
                }
            }
        }
    }

    private var showConnectionBanner: Bool {
        switch store.connectionState {
        case .reconnecting, .failed:
            return true
        default:
            return false
        }
    }
}

// MARK: - Empty Chat State

struct EmptyChatState: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "sparkles")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            Text("Start a conversation")
                .font(.title2.bold())
            Text("Describe a task, paste code, or ask a question.\nThe agent works in your repository on the server.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Connection Banner

struct ConnectionBanner: View {
    let state: SSEClient.ConnectionState

    var body: some View {
        HStack(spacing: 8) {
            icon
            Text(text)
                .font(.caption.bold())
            Spacer()
            if case .reconnecting = state {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(bannerColor.opacity(0.15))
    }

    private var icon: some View {
        switch state {
        case .reconnecting:
            return Image(systemName: "arrow.triangle.2.circlepath")
        case .failed:
            return Image(systemName: "wifi.slash")
        default:
            return Image(systemName: "circle.fill")
        }
    }

    private var text: String {
        switch state {
        case .reconnecting: return "Reconnecting…"
        case .failed: return "Connection failed — will retry"
        default: return ""
        }
    }

    private var bannerColor: Color {
        switch state {
        case .reconnecting: return .orange
        case .failed: return .red
        default: return .secondary
        }
    }
}

// MARK: - Goal Banner

struct GoalBanner: View {
    let status: GoalStatus
    var onAbort: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: status.status == .active ? "target" : "pause.circle")
                .foregroundStyle(.tint)

            VStack(alignment: .leading, spacing: 2) {
                if let objective = status.objective {
                    Text(objective)
                        .font(.caption.bold())
                        .lineLimit(1)
                } else {
                    Text("Goal running")
                        .font(.caption.bold())
                }

                if let budget = status.tokenBudget, let usage = status.tokenUsage {
                    HStack(spacing: 4) {
                        Text("\(Format.tokenCount(usage)) / \(Format.tokenCount(budget)) tokens")
                        if let elapsed = status.elapsedMs {
                            Text("· \(Format.duration(ms: elapsed))")
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                    // Progress bar
                    ProgressView(value: Double(usage), total: Double(budget))
                        .controlSize(.mini)
                        .tint(Color.accentColor)
                } else if let elapsed = status.elapsedMs {
                    Text(Format.duration(ms: elapsed))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            Button(action: onAbort) {
                Image(systemName: "stop.fill")
                    .font(.caption)
            }
            .buttonStyle(.glass)
            .controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.tint.opacity(0.08))
    }
}

// MARK: - Goal Status Summary (for settings sheet)

struct GoalStatusSummary: View {
    let status: GoalStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let objective = status.objective {
                Text(objective)
                    .font(.subheadline)
            }
            HStack {
                if let s = status.status {
                    Label(s.rawValue.capitalized, systemImage: s == .active ? "target" : "pause.circle")
                        .font(.caption)
                        .foregroundStyle(.tint)
                }
                if let usage = status.tokenUsage, let budget = status.tokenBudget {
                    Text("· \(Format.tokenCount(usage))/\(Format.tokenCount(budget)) tokens")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - Connection State Badge

struct ConnectionStateBadge: View {
    let state: SSEClient.ConnectionState

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.caption)
        }
    }

    private var color: Color {
        switch state {
        case .connected: return .green
        case .connecting, .reconnecting: return .orange
        case .disconnected: return .secondary
        case .failed: return .red
        }
    }

    private var label: String {
        switch state {
        case .connected: return "Connected"
        case .connecting: return "Connecting…"
        case .reconnecting: return "Reconnecting…"
        case .disconnected: return "Disconnected"
        case .failed: return "Failed"
        }
    }
}
