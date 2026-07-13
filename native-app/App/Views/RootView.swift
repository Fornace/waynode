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
        // Respect the system appearance. A workbench must remain legible with
        // the user's contrast, transparency, and light/dark preferences.
        .animation(.smooth(duration: 0.4), value: appModel.auth.isAuthenticated)
        .animation(.smooth(duration: 0.3), value: appModel.auth.hasCompletedLaunchCheck)
        .onOpenURL { url in
            handleDeepLink(url)
        }
    }

    // MARK: - Deep Link Handling
    //
    // URL schemes:
    //   waynode://auth?token=wn_...     — OAuth callback (handled by AuthView)
    //   waynode://space/<id>             — open a space's sessions list
    //   waynode://space/<id>/session/<id> — open a specific chat session

    private func handleDeepLink(_ url: URL) {
        // OAuth callbacks are handled by AuthView's ASWebAuthenticationSession
        if url.host == "auth" { return }

        guard url.host == "space" else { return }
        let segments = url.pathComponents.filter { !$0.isEmpty }

        if segments.count >= 3 && segments[1] == "session" {
            // /space/<spaceId>/session/<sessionId>
            appModel.pendingDeepLink = .sessionDetail(
                spaceId: segments[0],
                sessionId: segments[2]
            )
        } else if segments.count >= 1 {
            // /space/<spaceId>
            appModel.pendingDeepLink = .sessionsList(spaceId: segments[0])
        }
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
