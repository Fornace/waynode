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
            } else if appModel.auth.token != nil
                        && !appModel.auth.hasCompletedLaunchCheck {
                // Returning user whose token is still being validated at
                // launch. Show the brand splash rather than flashing the
                // login screen for ~1s.
                LaunchView()
                    .transition(.opacity)
            } else {
                AuthView()
                    .transition(.opacity.combined(with: .move(edge: .leading)))
            }
        }
        // Force dark mode — Waynode is a developer tool, dark is the right default.
        .preferredColorScheme(.dark)
        .animation(.smooth(duration: 0.4), value: appModel.auth.isAuthenticated)
        .animation(.smooth(duration: 0.3), value: appModel.auth.hasCompletedLaunchCheck)
    }
}

// MARK: - Launch splash
//
// Brand-centered splash shown only while a stored token is being verified
// at cold launch. Keeps the first impression seamless for returning users.

struct LaunchView: View {
    var body: some View {
        VStack(spacing: 16) {
            BrandLogo()
                .frame(width: 72, height: 72)
            ProgressView()
                .controlSize(.small)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
    }
}

#Preview {
    RootView()
        .environment(AppModel(auth: AuthStore()))
}
