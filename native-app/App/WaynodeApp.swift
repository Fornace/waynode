import SwiftUI
import WaynodeCore

// MARK: - WaynodeApp
//
// The root app. Owns the AppModel (which owns AuthStore, API clients,
// session stores). The entire state graph is observable and flows from
// here through the environment.

@main
struct WaynodeApp: App {
    @State private var appModel: AppModel

    init() {
        let auth = AuthStore()
        _appModel = State(initialValue: AppModel(auth: auth))

        // DEBUG: allow injecting a token via launch arguments for testing.
        // Usage: simctl launch ... com.waynode.app -dev-token wn_xxx
        //        -space <id> [-session <id>]  (deep-link navigation)
        #if DEBUG
        if let idx = CommandLine.arguments.firstIndex(of: "-dev-token"),
           idx + 1 < CommandLine.arguments.count {
            let token = CommandLine.arguments[idx + 1]
            do {
                try auth.keychain.writeToken(token)
                print("Waynode diagnostics: test credential persisted")
            } catch {
                print("Waynode diagnostics: test credential persistence failed: \(error.localizedDescription)")
            }
            auth.markAuthenticated(token: token)
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appModel)
                .task {
                    await appModel.auth.verifyToken()
                    if appModel.auth.isAuthenticated {
                        await appModel.bootstrap()
                    }
                    #if DEBUG
                    // Deep-link navigation via launch args (for testing)
                    let args = CommandLine.arguments
                    if let spaceIdx = args.firstIndex(of: "-space"),
                       spaceIdx + 1 < args.count {
                        let spaceId = args[spaceIdx + 1]
                        if let sessionIdx = args.firstIndex(of: "-session"),
                           sessionIdx + 1 < args.count {
                            let sessionId = args[sessionIdx + 1]
                            appModel.pendingDeepLink = .sessionDetail(spaceId: spaceId, sessionId: sessionId)
                        } else {
                            appModel.pendingDeepLink = .sessionsList(spaceId: spaceId)
                        }
                    }
                    #endif
                }
        }
    }
}
