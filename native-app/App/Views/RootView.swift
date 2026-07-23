import SwiftUI
import WaynodeCore

// MARK: - RootView
//
// Auth gate: shows AuthView when unauthenticated, MainView when logged in.
// Uses a transition so the switch feels native (not a jarring flip).

struct RootView: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            routedContent
        }
        #if DEBUG
        .modifier(UITestDynamicTypeModifier())
        #endif
        // Respect the system appearance. A workbench must remain legible with
        // the user's contrast, transparency, and light/dark preferences.
        .animation(reduceMotion ? nil : .smooth(duration: 0.4), value: appModel.auth.isAuthenticated)
        .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: appModel.auth.hasCompletedLaunchCheck)
        .onOpenURL { url in
            handleDeepLink(url)
        }
    }

    @ViewBuilder private var routedContent: some View {
        #if DEBUG
        if showKeychainFixture {
            SignedKeychainSmokeView().transition(.opacity)
        } else {
            standardContent
        }
        #else
        standardContent
        #endif
    }

    @ViewBuilder private var standardContent: some View {
        #if DEBUG
        if showAccountFixture {
            AccountSheetContainer().transition(.opacity)
        } else if showChatFixture {
            ChatUITestFixtureView(
                historyFailure: CommandLine.arguments.contains("-ui-test-chat-history-failure")
            ).transition(.opacity)
        } else if showGitFixture {
            GitInspector(spaceId: "ui-space", fixtureSnapshot: GitUITestFixtures.snapshot).transition(.opacity)
        } else if showSettingsFixture {
            SessionUITestFixtureView(settings: true).transition(.opacity)
        } else if showNewSessionFixture {
            SessionUITestFixtureView(settings: false).transition(.opacity)
        } else if showTerminalFixture {
            TerminalView(sessionId: "ui-session", spaceId: "ui-space").transition(.opacity)
        } else {
            authenticatedContent
        }
        #else
        authenticatedContent
        #endif
    }

    @ViewBuilder private var authenticatedContent: some View {
        if showMainView {
            MainView().transition(.opacity.combined(with: .move(edge: .trailing)))
        } else if appModel.auth.token != nil && !appModel.auth.hasCompletedLaunchCheck {
            LaunchView().transition(.opacity)
        } else {
            AuthView().transition(.opacity.combined(with: .move(edge: .leading)))
        }
    }

    private var showMainView: Bool {
        #if DEBUG
        return (appModel.isUITestFixture && appModel.auth.isAuthenticated)
            || (appModel.auth.isAuthenticated && appModel.auth.user != nil)
        #else
        return appModel.auth.isAuthenticated && appModel.auth.user != nil
        #endif
    }

    private var showKeychainFixture: Bool {
        #if DEBUG
        return CommandLine.arguments.contains("-ui-test-keychain")
        #else
        return false
        #endif
    }

    private var showTerminalFixture: Bool {
        #if DEBUG
        return fixtureIsAuthenticated && CommandLine.arguments.contains("-ui-test-terminal")
        #else
        return false
        #endif
    }

    private var showGitFixture: Bool {
        #if DEBUG
        return fixtureIsAuthenticated && CommandLine.arguments.contains("-ui-test-git")
        #else
        return false
        #endif
    }

    private var showChatFixture: Bool {
        #if DEBUG
        return fixtureIsAuthenticated && (
            CommandLine.arguments.contains("-ui-test-chat-active")
                || CommandLine.arguments.contains("-ui-test-chat-history-failure")
        )
        #else
        return false
        #endif
    }

    private var showAccountFixture: Bool {
        #if DEBUG
        return fixtureIsAuthenticated && CommandLine.arguments.contains("-ui-test-account")
        #else
        return false
        #endif
    }

    private var showSettingsFixture: Bool {
        #if DEBUG
        return fixtureIsAuthenticated && CommandLine.arguments.contains("-ui-test-settings")
        #else
        return false
        #endif
    }

    private var showNewSessionFixture: Bool {
        #if DEBUG
        return fixtureIsAuthenticated && CommandLine.arguments.contains("-ui-test-new-session")
        #else
        return false
        #endif
    }

    private var fixtureIsAuthenticated: Bool {
        #if DEBUG
        return appModel.isUITestFixture && appModel.auth.isAuthenticated
        #else
        return false
        #endif
    }

    // MARK: - Deep Link Handling
    //
    // URL schemes:
    //   waynode://auth?token=wn_...     — OAuth callback (handled by AuthView)
    //   waynode://space/<id>             — open a space's sessions list
    //   waynode://space/<id>/session/<id> — open a specific chat session

    private func handleDeepLink(_ url: URL) {
        if url.scheme == "waynode", url.host == "auth" {
            Task {
                if await appModel.auth.completeNativeAuthCallback(url) {
                    await appModel.bootstrap()
                }
            }
            return
        }

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

#if DEBUG
private struct UITestDynamicTypeModifier: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if ProcessInfo.processInfo.environment["WAYNODE_UI_TEST_DYNAMIC_TYPE"] == "accessibility3" {
            content.dynamicTypeSize(.accessibility3)
        } else {
            content
        }
    }
}
#endif

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
        .background {
            Color("LaunchScreenBackground")
                .ignoresSafeArea()
        }
    }
}

#Preview {
    RootView()
        .environment(AppModel(auth: AuthStore()))
}
