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
        #if DEBUG
        let uiTestAuth = CommandLine.arguments.contains("-ui-test-auth")
            || ProcessInfo.processInfo.environment["WAYNODE_UI_TEST_AUTH"] == "1"
        let launchServer = Self.launchURL(named: "-server-url")
        let auth = AuthStore(serverConfig: launchServer.map(ServerConfig.init(baseURL:)))
        #else
        let auth = AuthStore()
        #endif
        let model = AppModel(auth: auth)
        #if DEBUG
        if uiTestAuth {
            auth.installUITestUser()
            model.installUITestFixture()
        }
        #endif
        _appModel = State(initialValue: model)

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
        if CommandLine.arguments.contains("-ui-test") {
            auth.logout()
            // Keep UI tests hermetic even when a previous run edited the
            // server setting. The explicit launch URL is the test fixture.
            if let launchServer { auth.setServerURL(launchServer) }
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appModel)
                .task {
                    let fixture = CommandLine.arguments.contains("-ui-test-auth")
                        || ProcessInfo.processInfo.environment["WAYNODE_UI_TEST_AUTH"] == "1"
                    #if DEBUG
                    if fixture {
                        appModel.auth.installUITestUser()
                        appModel.installUITestFixture()
                    }
                    #endif
                    if !fixture { await appModel.auth.verifyToken() }
                    if appModel.auth.isAuthenticated && !fixture {
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

    #if DEBUG
    private static func launchURL(named flag: String) -> URL? {
        guard let index = CommandLine.arguments.firstIndex(of: flag),
              index + 1 < CommandLine.arguments.count else { return nil }
        return URL(string: CommandLine.arguments[index + 1])
    }
    #endif
}
