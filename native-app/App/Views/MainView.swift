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

    var body: some View {
        @Bindable var model = appModel
        NavigationSplitView {
            List(selection: $model.selectedSpaceId) {
                ForEach(model.spaces) { space in
                    Label(space.repoName, systemImage: "arrow.triangle.branch")
                        .tag(space.id)
                }
            }
            .navigationTitle("Spaces")
        } content: {
            List(selection: $model.selectedSessionId) {
                if let spaceId = model.selectedSpaceId {
                    ForEach(model.sessions(forSpace: spaceId)) { session in
                        Text(session.title).tag(session.id)
                    }
                }
            }
            .navigationTitle("Sessions")
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
    }
}

#Preview {
    MainView()
        .environment(AppModel(auth: AuthStore()))
}
