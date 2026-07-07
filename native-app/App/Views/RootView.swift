import SwiftUI
import WaynodeCore

// MARK: - RootView
//
// Auth gate: shows AuthView when unauthenticated, MainView when logged in.
// Uses a transition so the switch feels native (not a jarring flip).

struct RootView: View {
    @Environment(AppModel.self) private var appModel

    var body: some View {
        ZStack {
            if appModel.auth.isAuthenticated && appModel.auth.user != nil {
                MainView()
                    .transition(.opacity.combined(with: .move(edge: .trailing)))
            } else {
                AuthView()
                    .transition(.opacity.combined(with: .move(edge: .leading)))
            }
        }
        .animation(.smooth(duration: 0.4), value: appModel.auth.isAuthenticated)
    }
}

#Preview {
    RootView()
        .environment(AppModel(auth: AuthStore()))
}
