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
