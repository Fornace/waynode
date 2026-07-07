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

struct MainView: View {
    @Environment(AppModel.self) private var appModel
    @State private var selection: TopLevelTab? = .spaces

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
            // Spaces tab: drill-down navigation (Spaces → Sessions → Chat)
            NavigationStack {
                SpacesScene()
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
}

#Preview {
    MainView()
        .environment(AppModel(auth: AuthStore()))
}
