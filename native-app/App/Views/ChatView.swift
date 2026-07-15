import SwiftUI
import UniformTypeIdentifiers
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
    @Environment(\.dismiss) private var dismiss
    @State private var composerText: String = ""
    @FocusState private var composerFocused: Bool
    @State private var autoScroll: Bool = true
    @State private var showingAccount: Bool = false
    @State private var showingAttachmentPicker = false
    @State private var isUploadingAttachments = false
    @State private var attachmentError: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(macOS)
    @State private var transcriptSearch = ""
    @State private var isTranscriptSearchPresented = false
    #endif

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
                        ConnectionBanner(
                            state: store.connectionState,
                            onRecovery: handleConnectionRecovery
                        )
                            .transition(.move(edge: .top).combined(with: .opacity))
                    }
                    if store.goalStatus.status == .active || store.goalStatus.status == .paused {
                        GoalBanner(status: store.goalStatus) {
                            Task { await store.abortTurn() }
                        }
                        .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .animation(reduceMotion ? nil : .smooth, value: store.connectionState)
                .animation(reduceMotion ? nil : .smooth, value: store.goalStatus.status)
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
                    isRunActive: store.isRunActive,
                    isAttaching: isUploadingAttachments,
                    error: attachmentError ?? store.sendError,
                    isGoalActive: store.goalStatus.status == .active,
                    isFocused: $composerFocused,
                    onAttach: { showingAttachmentPicker = true },
                    onSend: { prompt, isGoal in
                        Task {
                            await store.sendMessage(prompt, isGoal: isGoal)
                            // Keep the user's draft when delivery fails so
                            // reconnecting never destroys work they typed.
                            if store.sendError == nil {
                                composerText = ""
                                autoScroll = true
                            } else {
                                composerFocused = true
                            }
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
            if store.reducer.items.isEmpty && store.didLoadHistory {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    composerFocused = true
                }
            }
        }
        .onChange(of: store.failedDraft) { _, draft in
            guard let draft, composerText.isEmpty else { return }
            composerText = draft.prompt
            composerFocused = true
        }
        .sheet(isPresented: $showingAccount) {
            NavigationStack { AccountScene() }
        }
        .fileImporter(
            isPresented: $showingAttachmentPicker,
            allowedContentTypes: [.data],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            Task { await uploadAttachments(urls) }
        }
        #if os(macOS)
        .searchable(
            text: $transcriptSearch,
            isPresented: $isTranscriptSearchPresented,
            placement: .toolbar,
            prompt: "Search transcript"
        )
        .onReceive(NotificationCenter.default.publisher(for: .waynodeFindTranscript)) { _ in
            isTranscriptSearchPresented = true
        }
        #endif
    }

    private func uploadAttachments(_ urls: [URL]) async {
        isUploadingAttachments = true
        attachmentError = nil
        defer { isUploadingAttachments = false }

        do {
            var files: [APIClient.UploadFile] = []
            var totalBytes = 0
            for url in urls.prefix(20) {
                let hasAccess = url.startAccessingSecurityScopedResource()
                defer { if hasAccess { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                totalBytes += data.count
                guard totalBytes <= 100 * 1_024 * 1_024 else {
                    throw APIClient.APIError(
                        statusCode: 413,
                        message: "Choose files totaling less than 100 MB"
                    )
                }
                files.append(.init(filename: url.lastPathComponent, data: data))
            }
            let uploaded = try await store.uploadFiles(files)
            guard !uploaded.isEmpty else { return }
            let names = uploaded.map { "`\($0)`" }.joined(separator: ", ")
            let separator = composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "" : "\n\n"
            composerText += "\(separator)Attached workspace files: \(names)"
            composerFocused = true
        } catch {
            attachmentError = "Couldn’t attach files. \(error.localizedDescription)"
        }
    }

    // MARK: - Message list

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let historyError = store.historyError {
                        HistoryFailureState(message: historyError) {
                            Task { await store.retryHistory() }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 28)
                    } else if store.reducer.items.isEmpty && store.didLoadHistory {
                        EmptyChatState { suggestion in
                            composerText = suggestion
                            composerFocused = true
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 28)
                    }

                    if store.isLoadingHistory {
                        HStack {
                            Spacer()
                            ProgressView("Loading history…")
                            Spacer()
                        }
                        .padding(.top, 40)
                        .accessibilityLabel("Loading conversation history")
                        .accessibilityAddTraits(.updatesFrequently)
                        .accessibilityIdentifier("chat.history.loading")
                    }

                    ForEach(transcriptItems) { item in
                        ChatTranscriptRow(item: item)
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
                .padding(.top, 16)
                .padding(.bottom, 16)
            }
            // Per-session identity: forces a fresh ScrollView instance when
            // switching sessions so the scroll offset from a previous session
            // is NOT carried over (#8 — scroll position remembered bug).
            .id(ObjectIdentifier(store))
            .accessibilityIdentifier("chat.transcript")
            .accessibilityLabel("Conversation transcript")
            // Interactively dismiss the keyboard as the user scrolls down.
            .platformInteractiveKeyboardDismissal()
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
                    withAnimation(reduceMotion ? nil : .smooth) {
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
                    withAnimation(reduceMotion ? nil : .smooth) {
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

    private func handleConnectionRecovery(_ recovery: SSEClient.ConnectionFailure.Recovery) {
        switch recovery {
        case .retry:
            Task { await store.reconnect() }
        case .signIn:
            appModel.handleUnauthorized()
        case .openAccount:
            showingAccount = true
        case .returnToWorktrees:
            appModel.selectedSessionId = nil
            appModel.selectedSpaceId = nil
            dismiss()
        case .returnToSessions:
            appModel.selectedSessionId = nil
            dismiss()
        }
    }

    /// Server history may split one agent turn into several adjacent
    /// assistant records around tool calls. Present them as one turn so
    /// consecutive reasoning fragments can collapse into a single section.
    private var transcriptItems: [ChatItem] {
        store.reducer.items.reduce(into: []) { result, item in
            guard case .assistant(let next) = item,
                  let last = result.last,
                  case .assistant(var previous) = last else {
                result.append(item)
                return
            }
            previous.blocks.append(contentsOf: next.blocks)
            previous.done = next.done
            result[result.count - 1] = .assistant(previous)
        }
    }
}
