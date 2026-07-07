import SwiftUI
import WaynodeCore

// MARK: - MainView
//
// The authenticated app shell. Uses TabView with .sidebarAdaptable so it
// becomes a bottom tab bar on iPhone and a sidebar on iPad/Mac — one
// codebase, platform-correct navigation (per Apple's Liquid Glass guidance
// §2.8).
//
// Two top-level sections:
//   • Spaces — the main work area (NavigationSplitView: Spaces | Sessions | Chat)
//   • Account — tokens, server config, logout

struct MainView: View {
    @Environment(AppModel.self) private var appModel
    @State private var selection: TopLevelTab? = .spaces
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic

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
        TabView(selection: $selection) {
            NavigationSplitView(columnVisibility: $columnVisibility) {
                SpacesSidebar()
            } content: {
                if let spaceId = appModel.selectedSpaceId {
                    SessionsList(spaceId: spaceId)
                } else {
                    ContentUnavailableView(
                        "No Space Selected",
                        systemImage: "folder",
                        description: Text("Select a space or create a new one.")
                    )
                }
            } detail: {
                if let sessionId = appModel.selectedSessionId,
                   let spaceId = appModel.selectedSpaceId {
                    SessionDetail(sessionId: sessionId, spaceId: spaceId)
                } else {
                    ContentUnavailableView(
                        "No Session Selected",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Select a session to start chatting.")
                    )
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
        .tabViewStyle(.sidebarAdaptable)
        // sidebarAdaptable → bottom tab bar on iPhone, sidebar on iPad/Mac.
        // This is the Apple-blessed Liquid Glass navigation pattern (HIG §2.8).
    }
}

#Preview {
    MainView()
        .environment(AppModel(auth: AuthStore()))
}
