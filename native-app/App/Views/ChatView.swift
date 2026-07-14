import SwiftUI
import WaynodeCore

// MARK: - Edit-message environment (#9)
//
// Lets a user message pre-fill the composer with its text so the user can
// tweak and resend. True conversation forking (server-side pi checkpoint /
// resume with a parent pointer) is not yet supported by the server, so this
// is the achievable client-side slice: edit-and-resend as a new message.

private struct EditMessageKey: EnvironmentKey {
    nonisolated(unsafe) static let defaultValue: ((String) -> Void)? = nil
}

extension EnvironmentValues {
    /// Set by ChatView; consumed by UserMessageView's context menu.
    var onEditMessage: ((String) -> Void)? {
        get { self[EditMessageKey.self] }
        set { self[EditMessageKey.self] = newValue }
    }
}

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
//   • Keyboard: auto-focuses on appear, tap message area to focus,
//     interactively dismisses on scroll.

struct ChatView: View {
    @Bindable var store: SessionStore
    @Environment(AppModel.self) private var appModel
    @State private var composerText: String = ""
    @FocusState private var composerFocused: Bool
    @State private var autoScroll: Bool = true

    // Auto-scroll anchor: track the last item id for scroll-to-bottom.
    private let bottomID = "chat-bottom"

    var body: some View {
        // Top banners (conditional) sit in a safeAreaInset so the message
        // list fills the full screen and banners slide in from the top when
        // needed.
        messageList
            .safeAreaInset(edge: .top, spacing: 0) {
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
            }
            // Provide an edit handler so user messages can pre-fill the
            // composer via their context menu (#9).
            .environment(\.onEditMessage) { text in
                composerText = text
                composerFocused = true
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
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
        // Only auto-focus when the chat is empty (new conversation).
        // When opening a session with history, don't steal focus — let the
        // user read first, tap to type when ready.
        .onAppear {
            if store.reducer.items.isEmpty && !store.isLoadingHistory {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    composerFocused = true
                }
            }
        }
    }

    // MARK: - Message list

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if store.reducer.items.isEmpty && !store.isLoadingHistory {
                        EmptyChatState { suggestion in
                            composerText = suggestion
                            composerFocused = true
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 80)
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

                    // Bottom anchor for auto-scroll — generous bottom padding
                    // so the last message doesn't hide behind the composer
                    // when the keyboard is visible.
                    Color.clear
                        .frame(height: 1)
                        .id(bottomID)
                }
                // Tighter horizontal padding so content uses more of the
                // screen width on iPhone (was 16 → 10). Bubbles and markdown
                // blocks already carry their own internal padding.
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .padding(.bottom, 16)
            }
            // Per-session identity: forces a fresh ScrollView instance when
            // switching sessions so the scroll offset from a previous session
            // is NOT carried over (#8 — scroll position remembered bug).
            .id(ObjectIdentifier(store))
            // Interactively dismiss the keyboard as the user scrolls down.
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            // Tap anywhere on the message list (that isn't a link/button)
            // to bring the keyboard back.
            .onTapGesture {
                composerFocused = true
            }
            // Track whether user is near the bottom — drives autoScroll.
            .onScrollGeometryChange(for: Bool.self) { geo in
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
            // When history finishes loading, jump to the bottom so the user
            // lands on the latest message rather than a stale offset (#8).
            .onChange(of: store.isLoadingHistory) { _, loading in
                if !loading, !store.reducer.items.isEmpty {
                    autoScroll = true
                    proxy.scrollTo(bottomID, anchor: .bottom)
                }
            }
            .onAppear {
                // Ensure we start at the bottom for this session.
                if !store.reducer.items.isEmpty {
                    autoScroll = true
                    DispatchQueue.main.async {
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
