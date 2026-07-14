import SwiftUI
import WaynodeCore

// MARK: - MainView
//
// The authenticated app shell. A TabView with bottom tabs (iPhone) that
// adapts to a sidebar on iPad/Mac via `.sidebarAdaptable`.
//
// Two tabs:
//   • Spaces — the main work area (NavigationStack drill-down: Spaces → Sessions → Chat)
//   • Account — tokens, server config, logout
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
    @State private var selection: TopLevelTab? = .spaces
    @State private var spacesPath = NavigationPath()

    enum TopLevelTab: String, Hashable, CaseIterable {
        case spaces, account

        var label: String {
            switch self {
            case .spaces: return "Spaces"
            case .account: return "Account"
            }
        }

        var systemImage: String {
            switch self {
            case .spaces: return "folder"
            case .account: return "person.crop.circle"
            }
        }
    }

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
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

    private var compactShell: some View {
        TabView(selection: $selection) {
            // Spaces tab: drill-down navigation (Spaces → Sessions → Chat)
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
            .tabItem {
                Label(TopLevelTab.spaces.label, systemImage: TopLevelTab.spaces.systemImage)
            }
            .tag(TopLevelTab.spaces)

            // Account tab
            NavigationStack {
                AccountScene()
            }
            .tabItem {
                Label(TopLevelTab.account.label, systemImage: TopLevelTab.account.systemImage)
            }
            .tag(TopLevelTab.account)
        }
    }

    // MARK: - Deep Link

    private func handleDeepLink() {
        guard let link = appModel.pendingDeepLink else { return }
        selection = .spaces
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
    @State private var showingAccount = false
    @State private var showingCloneSheet = false
    @State private var showingNewSession = false
    @State private var newSessionTitle = ""
    @State private var sessionError: String?

    var body: some View {
        @Bindable var model = appModel
        NavigationSplitView {
            List(selection: $model.selectedSpaceId) {
                if model.spaces.isEmpty {
                    if model.isLoadingSpaces {
                        HStack { Spacer(); ProgressView(); Spacer() }
                    } else {
                        ContentUnavailableView {
                            Label("No Workspaces", systemImage: "folder.badge.plus")
                        } description: {
                            Text("Clone a repository to create your first persistent workspace.")
                        } actions: {
                            Button("Clone Repository") { showingCloneSheet = true }
                                .buttonStyle(.glassProminent)
                        }
                        .listRowBackground(Color.clear)
                    }
                } else {
                    ForEach(model.spaces) { space in
                        SpaceRow(space: space)
                            .tag(space.id)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationTitle("Workspaces")
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        showingCloneSheet = true
                    } label: {
                        Label("Clone Repository", systemImage: "plus")
                    }
                    Button {
                        showingAccount = true
                    } label: {
                        Label("Account", systemImage: "person.crop.circle")
                    }
                    .accessibilityHint("Open server, billing, and account settings")
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
                                Text("Start a focused conversation inside this workspace.")
                            } actions: {
                                Button("New Session", action: openNewSession)
                                    .buttonStyle(.glassProminent)
                            }
                            .listRowBackground(Color.clear)
                        }
                    } else {
                        ForEach(sessions) { session in
                            SessionRow(session: session)
                                .tag(session.id)
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                        }
                    }
                } else {
                    ContentUnavailableView("Choose a workspace", systemImage: "folder")
                        .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("Sessions")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        openNewSession()
                    } label: {
                        Label("New Session", systemImage: "plus.bubble")
                    }
                    .disabled(model.selectedSpaceId == nil)
                }
            }
            .task(id: model.selectedSpaceId) {
                if let id = model.selectedSpaceId { await model.refreshSessions(spaceId: id) }
            }
        } detail: {
            if let spaceId = model.selectedSpaceId, let sessionId = model.selectedSessionId {
                SessionDetail(sessionId: sessionId, spaceId: spaceId)
            } else {
                ContentUnavailableView("Choose a session", systemImage: "rectangle.3.group", description: Text("Your worktree, conversation, and review stay together here."))
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showingAccount) {
            NavigationStack { AccountScene() }
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
            .presentationDetents([.medium])
        }
    }

    private func openNewSession() {
        newSessionTitle = ""
        sessionError = nil
        showingNewSession = true
    }

    private func createSession() {
        guard let spaceId = appModel.selectedSpaceId else { return }
        Task {
            do {
                let session = try await appModel.createSession(
                    spaceId: spaceId,
                    title: newSessionTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : newSessionTitle
                )
                appModel.selectedSessionId = session.id
                showingNewSession = false
                Haptics.success()
            } catch {
                sessionError = error.localizedDescription
                Haptics.error()
            }
        }
    }
}

#Preview {
    MainView()
        .environment(AppModel(auth: AuthStore()))
}
