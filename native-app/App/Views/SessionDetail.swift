import SwiftUI
import WaynodeCore
private enum GitContextState {
    case loading
    case loaded(GitSnapshot)
    case unavailable
}
struct SessionDetail: View {
    @Environment(AppModel.self) private var appModel
    let sessionId: String
    let spaceId: String

    @State private var detailTab: DetailTab = .chat
    @State private var showingGitInspector = false
    @State private var showingSessionSettings = false
    @State private var gitContext: GitContextState = .loading
    enum DetailTab: String, CaseIterable, Hashable {
        case chat, terminal

        var label: String { self == .chat ? "Chat" : "Terminal" }
        var systemImage: String { self == .chat ? "bubble.left.and.bubble.right" : "terminal" }
    }
    var body: some View {
        @Bindable var store = appModel.store(for: sessionId, spaceId: spaceId)

        VStack(spacing: 0) {
            SessionContextBar(
                worktree: appModel.spaces.first { $0.id == spaceId },
                state: gitContext,
                connectionState: store.connectionState,
                selectedTab: $detailTab,
                onOpenGit: { showingGitInspector = true }
            )
            switch detailTab {
            case .chat:
                ChatView(store: store)
            case .terminal:
                TerminalView(sessionId: sessionId, spaceId: spaceId)
            }
        }
        .accessibilityIdentifier("session.detail")
        .navigationTitle(store.sessionMeta?.title ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            #if targetEnvironment(macCatalyst)
            ToolbarItem(placement: .principal) {
                Text(store.sessionMeta?.title ?? "Session")
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(store.sessionMeta?.title ?? "Session")
                    .accessibilityIdentifier("session.title")
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    showingGitInspector = true
                } label: {
                    Label("Git Worktree", systemImage: "arrow.triangle.branch")
                }
                .help("Review changes, commits, branches, and sync status")
                .accessibilityIdentifier("git.open")
                .keyboardShortcut("g", modifiers: [.command, .shift])
                Button {
                    showingSessionSettings = true
                } label: {
                    Label("Session Settings", systemImage: "slider.horizontal.3")
                }
                .help("Model, connection, and session settings")
                .accessibilityIdentifier("session.settings.open")
                .keyboardShortcut(",", modifiers: .command)
                Button(role: .destructive) {
                    Task { await store.abortTurn() }
                } label: {
                    Label("Stop Agent", systemImage: "stop.fill")
                }
                .help("Stop the current agent turn")
                .accessibilityIdentifier("agent.stop")
                .keyboardShortcut(".", modifiers: .command)
                .disabled(store.goalStatus.status != .active && !store.isSending)
            }
            #else
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                        Section("Session view") {
                            Button {
                                detailTab = .chat
                            } label: {
                                Label("Chat", systemImage: DetailTab.chat.systemImage)
                            }
                            .accessibilityIdentifier("session.mode.chat")
                            Button {
                                detailTab = .terminal
                            } label: {
                                Label("Terminal", systemImage: DetailTab.terminal.systemImage)
                            }
                            .accessibilityIdentifier("session.mode.terminal")
                        }
                        Divider()
                        Button {
                            showingGitInspector = true
                        } label: {
                            Label("Git Worktree", systemImage: "arrow.triangle.branch")
                        }
                        .accessibilityIdentifier("git.open")
                        Button {
                            showingSessionSettings = true
                        } label: {
                            Label("Session Settings", systemImage: "slider.horizontal.3")
                        }
                        .accessibilityIdentifier("session.settings.open")
                        Divider()
                        Button(role: .destructive) {
                            Task { await store.abortTurn() }
                        } label: {
                            Label("Abort Agent", systemImage: "stop.fill")
                        }
                        .disabled(store.goalStatus.status != .active)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Session actions")
                .accessibilityIdentifier("session.more")
            }
            #endif
        }
        .sheet(isPresented: $showingGitInspector) {
            #if DEBUG
            GitInspector(
                spaceId: spaceId,
                fixtureSnapshot: appModel.isUITestFixture ? GitUITestFixtures.snapshot : nil
            )
            #else
            GitInspector(spaceId: spaceId)
            #endif
        }
        .onChange(of: showingGitInspector) { _, isShowing in
            if !isShowing { Task { await refreshGitContext() } }
        }
        .onChange(of: store.isSending) { _, isSending in
            if !isSending { Task { await refreshGitContext() } }
        }
        .sheet(isPresented: $showingSessionSettings) {
            SessionSettingsSheet(store: store)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .task {
            #if DEBUG
            if CommandLine.arguments.contains("-ui-test-terminal") { detailTab = .terminal }
            #endif
            await store.acquire()
            await refreshGitContext()
        }
        .onDisappear {
            store.release()
        }
    }
    private func refreshGitContext() async {
        #if DEBUG
        if appModel.isUITestFixture {
            gitContext = .unavailable
            return
        }
        #endif
        guard let api = appModel.currentAPI() else {
            gitContext = .unavailable
            return
        }
        gitContext = .loading
        do {
            gitContext = .loaded(try await api.getGitSnapshot(spaceId))
        } catch {
            gitContext = .unavailable
        }
    }
}
private struct SessionContextBar: View {
    let worktree: Space?
    let state: GitContextState
    let connectionState: SSEClient.ConnectionState
    @Binding var selectedTab: SessionDetail.DetailTab
    let onOpenGit: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            Button(action: onOpenGit) {
                HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.branch")
                    .foregroundStyle(.tint)
                Text(worktree?.repoName ?? "Worktree")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(branch)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                switch state {
                case .loaded(let snapshot):
                    Text(snapshot.files.isEmpty ? "Clean" : "\(snapshot.files.count) changed")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(snapshot.files.isEmpty ? Color.secondary : Color.orange)
                case .loading:
                    ProgressView()
                        .controlSize(.mini)
                case .unavailable:
                    Label("Unavailable", systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Open Git worktree, \(worktree?.repoName ?? "Worktree"), branch \(branch)")
            .accessibilityIdentifier("git.context.open")
            .accessibilityHint("Review changed files, commits, branches, and sync status")
            .help(gitHelp)
            #if targetEnvironment(macCatalyst)
            Divider().frame(height: 20)
            ConnectionStateBadge(state: connectionState)
                .accessibilityIdentifier("session.connection")
                .help(connectionHelp)
            Picker("Session view", selection: $selectedTab) {
                ForEach(SessionDetail.DetailTab.allCases, id: \.self) { tab in
                    Label(tab.label, systemImage: tab.systemImage).tag(tab)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .accessibilityIdentifier("session.mode")
            .frame(width: 190)
            #endif
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
    private var branch: String {
        if case .loaded(let snapshot) = state { return snapshot.currentBranch }
        return worktree?.branch ?? ""
    }
    private var gitHelp: String {
        [worktree?.repoName, branch.isEmpty ? nil : "Branch: \(branch)", "Open Git worktree"]
            .compactMap { $0 }
            .joined(separator: "\n")
    }
    private var connectionHelp: String {
        if case .failed(let failure) = connectionState { return failure.message }
        if case .reconnecting(let delay) = connectionState { return "Trying again in \(Int(delay)) seconds" }
        return "Live session connection"
    }
}
