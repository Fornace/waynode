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
        #if DEBUG
        if let idx = CommandLine.arguments.firstIndex(of: "-dev-token"),
           idx + 1 < CommandLine.arguments.count {
            let token = CommandLine.arguments[idx + 1]
            try? auth.keychain.writeToken(token)
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
                }
        }
    }
}
