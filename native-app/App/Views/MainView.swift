import SwiftUI
import WaynodeCore

// MARK: - MainView
//
// The authenticated app shell. Compact devices use one focused drill-down;
// regular-width devices use a three-column workbench.
//
// Uses NavigationStack (NOT NavigationSplitView) for the Spaces tab so that
// taps always work and the drill-down is natural on mobile: tap a repo → see
// its sessions → tap a session → chat. This is the Mail/Messages pattern.
//
// Deep linking: waynode://space/<id> pushes the sessions list for a space;
// waynode://space/<id>/session/<sid> pushes all the way to a chat. The path
// is driven by a NavigationPath binding so we can push multiple levels.

struct MainView: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var spacesPath = NavigationPath()

    var body: some View {
        Group {
            if usesWorkbench {
                WorkbenchView()
            } else {
                compactShell
            }
        }
        // Deep-link handling: when pendingDeepLink changes, push it.
        .onChange(of: appModel.pendingDeepLink) {
            handleDeepLink()
        }
        .onAppear {
            handleDeepLink()
        }
    }

    private var usesWorkbench: Bool {
        #if targetEnvironment(macCatalyst)
        true
        #else
        horizontalSizeClass == .regular
        #endif
    }

    private var compactShell: some View {
        NavigationStack(path: $spacesPath) {
            SpacesScene()
                .navigationDestination(for: DeepLink.self) { destination in
                    switch destination {
                    case .sessionsList(let spaceId):
                        SessionsList(spaceId: spaceId)
                    case .sessionDetail(let spaceId, let sessionId):
                        SessionDetail(sessionId: sessionId, spaceId: spaceId)
                    }
                }
        }
    }

    // MARK: - Deep Link

    private func handleDeepLink() {
        guard let link = appModel.pendingDeepLink else { return }
        switch link {
        case .sessionsList(let spaceId):
            appModel.selectedSpaceId = spaceId
            appModel.selectedSessionId = nil
            spacesPath = NavigationPath([DeepLink.sessionsList(spaceId: spaceId)])
        case .sessionDetail(let spaceId, let sessionId):
            appModel.selectedSpaceId = spaceId
            appModel.selectedSessionId = sessionId
            spacesPath = NavigationPath([
                DeepLink.sessionsList(spaceId: spaceId),
                DeepLink.sessionDetail(spaceId: spaceId, sessionId: sessionId)
            ])
        }
        // Clear the pending link so it doesn't re-trigger
        appModel.pendingDeepLink = nil
    }
}

private struct WorkbenchView: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showingAccount = false
    @State private var showingCloneSheet = false
    @State private var showingNewSession = false
    @State private var newSessionTitle = ""
    @State private var sessionError: String?
    @State private var spaceToDelete: Space?
    @State private var sessionToDelete: Session?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @FocusState private var focusedColumn: FocusColumn?
    private enum FocusColumn: Hashable { case worktrees, sessions }

    var body: some View {
        @Bindable var model = appModel
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(selection: $model.selectedSpaceId) {
                if model.spaces.isEmpty {
                    if model.isLoadingSpaces {
                        HStack { Spacer(); ProgressView(); Spacer() }
                    } else {
                        ContentUnavailableView {
                            Label("No Worktrees", systemImage: "folder.badge.plus")
                        } description: {
                            Text("Clone a repository to create your first worktree.")
                        } actions: {
                            Button("Clone Repository") { showingCloneSheet = true }
                                .buttonStyle(.glassProminent)
                                .accessibilityIdentifier("worktree.clone")
                        }
                        .listRowBackground(Color.clear)
                    }
                } else {
                    ForEach(model.spaces) { space in
                        SpaceRow(space: space, isSelected: model.selectedSpaceId == space.id)
                            .tag(space.id)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                            .contextMenu {
                                Button("Delete Worktree", role: .destructive) { spaceToDelete = space }
                                    .accessibilityIdentifier("worktree.\(space.id).delete")
                            }
                            .accessibilityAction(named: "Delete Worktree") { spaceToDelete = space }
                    }
                }
            }
            .listStyle(.sidebar)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("worktrees.list")
            .focused($focusedColumn, equals: .worktrees)
            .navigationTitle("Worktrees")
            .navigationSplitViewColumnWidth(min: 250, ideal: 300, max: 360)
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        showingCloneSheet = true
                    } label: {
                        Label("Clone Repository", systemImage: "plus")
                    }
                    .help("Clone a repository into a new worktree")
                    .accessibilityIdentifier("worktree.clone")
                    .keyboardShortcut("o", modifiers: [.command, .shift])
                    Button {
                        showingAccount = true
                    } label: {
                        Label("Account", systemImage: "person.crop.circle")
                    }
                    .accessibilityHint("Open server, billing, and account settings")
                    .accessibilityIdentifier("account.open")
                    .help("Account, billing, and server settings")
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let error = model.spacesError {
                    Label(error, systemImage: "wifi.exclamationmark")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.thinMaterial)
                }
            }
        } content: {
            List(selection: $model.selectedSessionId) {
                if let spaceId = model.selectedSpaceId {
                    let sessions = model.sessions(forSpace: spaceId)
                    if sessions.isEmpty {
                        if model.isLoadingSessions {
                            HStack { Spacer(); ProgressView(); Spacer() }
                        } else if let error = model.sessionsError {
                            ContentUnavailableView {
                                Label("Couldn’t Load Sessions", systemImage: "wifi.exclamationmark")
                            } description: {
                                Text(error)
                            } actions: {
                                Button("Retry") { Task { await model.refreshSessions(spaceId: spaceId) } }
                            }
                            .listRowBackground(Color.clear)
                        } else {
                            ContentUnavailableView {
                                Label("No Sessions", systemImage: "plus.bubble")
                            } description: {
                                Text("Start a focused conversation inside this worktree.")
                            } actions: {
                                Button("New Session", action: openNewSession)
                                    .buttonStyle(.glassProminent)
                                    .accessibilityIdentifier("session.new")
                            }
                            .listRowBackground(Color.clear)
                        }
                    } else {
                        ForEach(sessions) { session in
                            SessionRow(session: session, isSelected: model.selectedSessionId == session.id)
                                .tag(session.id)
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                                .contextMenu {
                                    Button("Delete Session", role: .destructive) { sessionToDelete = session }
                                        .accessibilityIdentifier("session.\(session.id).delete")
                                }
                                .accessibilityAction(named: "Delete Session") { sessionToDelete = session }
                        }
                    }
                } else {
                    ContentUnavailableView("Choose a worktree", systemImage: "folder")
                        .listRowBackground(Color.clear)
                }
            }
            .navigationTitle(selectedSpaceTitle)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("sessions.list")
            .focused($focusedColumn, equals: .sessions)
            .navigationSplitViewColumnWidth(min: 250, ideal: 310, max: 380)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        openNewSession()
                    } label: {
                        Label("New Session", systemImage: "plus.bubble")
                    }
                    .disabled(model.selectedSpaceId == nil)
                    .help("Start a session in the selected worktree")
                    .accessibilityIdentifier("session.new")
                    .keyboardShortcut("n", modifiers: .command)
                }
            }
            .task(id: model.selectedSpaceId) {
                guard let id = model.selectedSpaceId else { return }
                await model.refreshSessions(spaceId: id)
                selectFirstSessionIfNeeded(in: id)
            }
        } detail: {
            if let spaceId = model.selectedSpaceId, let sessionId = model.selectedSessionId {
                SessionDetail(sessionId: sessionId, spaceId: spaceId)
            } else {
                ContentUnavailableView("Choose a session", systemImage: "rectangle.3.group", description: Text("Your worktree, conversation, and review stay together here."))
            }
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            #if targetEnvironment(macCatalyst)
            ToolbarItemGroup(placement: .navigation) {
                Button(action: toggleNavigation) {
                    Label("Toggle Navigation", systemImage: "sidebar.left")
                }
                .help(columnVisibility == .detailOnly ? "Show worktrees and sessions" : "Hide navigation columns")
                .accessibilityIdentifier("navigation.toggle")
                .keyboardShortcut("s", modifiers: [.command, .control])
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await refreshSelection() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .help("Refresh worktrees and the selected session list")
                .accessibilityIdentifier("workbench.refresh")
                .keyboardShortcut("r", modifiers: .command)
            }
            #endif
        }
        .sheet(isPresented: $showingAccount) {
            AccountSheetContainer()
        }
        .sheet(isPresented: $showingCloneSheet) {
            CloneSheet()
        }
        .sheet(isPresented: $showingNewSession) {
            NewSessionSheet(
                title: $newSessionTitle,
                error: $sessionError,
                onCreate: createSession,
                onCancel: { showingNewSession = false }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .workbenchDeletionAlerts(space: $spaceToDelete, session: $sessionToDelete)
        .task {
            if model.spaces.isEmpty { await model.refreshSpaces() }
            selectFirstSpaceIfNeeded()
            focusedColumn = .worktrees
        }
        .onChange(of: model.spaces.map(\.id)) {
            selectFirstSpaceIfNeeded()
        }
        .onChange(of: model.selectedSpaceId) { oldValue, newValue in
            guard oldValue != newValue else { return }
            let validIds = Set(newValue.map { model.sessions(forSpace: $0).map(\.id) } ?? [])
            if let sessionId = model.selectedSessionId, !validIds.contains(sessionId) {
                model.selectedSessionId = nil
            }
        }
    }

    private func openNewSession() {
        newSessionTitle = ""
        sessionError = nil
        showingNewSession = true
    }

    private func createSession() async throws {
        guard let spaceId = appModel.selectedSpaceId else { return }
        let trimmedTitle = newSessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let session = try await appModel.createSession(
            spaceId: spaceId,
            title: trimmedTitle.isEmpty ? nil : trimmedTitle
        )
        try Task.checkCancellation()
        appModel.selectedSessionId = session.id
        showingNewSession = false
        Haptics.success()
    }

    private var selectedSpaceTitle: String {
        guard let id = appModel.selectedSpaceId,
              let space = appModel.spaces.first(where: { $0.id == id }) else { return "Sessions" }
        return space.repoName.isEmpty ? "Sessions" : space.repoName
    }

    private func selectFirstSpaceIfNeeded() {
        guard appModel.selectedSpaceId == nil else { return }
        appModel.selectedSpaceId = appModel.spaces.first?.id
    }

    private func selectFirstSessionIfNeeded(in spaceId: String) {
        let sessions = appModel.sessions(forSpace: spaceId)
        if let selected = appModel.selectedSessionId, sessions.contains(where: { $0.id == selected }) { return }
        appModel.selectedSessionId = sessions.first?.id
    }

    private func refreshSelection() async {
        await appModel.refreshSpaces()
        if let spaceId = appModel.selectedSpaceId {
            await appModel.refreshSessions(spaceId: spaceId)
            selectFirstSessionIfNeeded(in: spaceId)
        } else {
            selectFirstSpaceIfNeeded()
        }
    }

    private func toggleNavigation() {
        withAnimation(reduceMotion ? nil : .snappy) {
            columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
        }
    }
}

struct AccountSheetContainer: View {
    var body: some View {
        NavigationStack {
            AccountScene()
        }
        #if targetEnvironment(macCatalyst)
        .frame(minWidth: 560, minHeight: 620)
        #endif
    }
}

#Preview {
    MainView()
        .environment(AppModel(auth: AuthStore()))
}
