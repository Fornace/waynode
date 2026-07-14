import SwiftUI
import WaynodeCore
import AuthenticationServices

// MARK: - AuthView
//
// The login screen. Presents two buttons: "Continue with GitHub" and
// "Continue with GitLab" (shown only if enabled on the server).
//
// Uses ASWebAuthenticationSession to perform the OAuth flow in Safari.
// The server redirects to waynode://auth?token=wn_...&nonce=... which
// ASWebAuthenticationSession captures.
//
// Design: centered logo + buttons on a matte background. No glass here —
// this is the content layer before the app shell exists. The primary
// button uses .glassProminent per the Liquid Glass reference.

struct AuthView: View {
    @Environment(AppModel.self) private var appModel
    @State private var session: ASWebAuthenticationSession?
    @State private var presentationProvider: AuthPresentationProvider?
    @State private var error: String?
    @State private var customServerURL: String = ""
    @State private var showingServerSheet = false
    @State private var isFetchingProviders = false
    @State private var providersFetchFailed = false

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                authContent
                    .frame(maxWidth: 460)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("auth.surface")
        .sheet(isPresented: $showingServerSheet) {
            ServerConfigSheet(
                url: Binding(
                    get: { customServerURL.isEmpty ? appModel.auth.serverConfig.baseURL.absoluteString : customServerURL },
                    set: { customServerURL = $0 }
                )
            ) { newURL in
                if let url = URL(string: newURL) {
                    appModel.auth.setServerURL(url)
                    appModel.reconfigureAPI()
                    Task { await fetchProviders() }
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .macSheetFrame(minWidth: 480, idealWidth: 540, maxWidth: 620, minHeight: 360, idealHeight: 420, maxHeight: 560)
        }
        .task { await fetchProviders() }
    }

    private var authContent: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 32)
                .frame(maxHeight: 240)

            // Logo
            BrandLogo()
                .frame(width: 96, height: 96)
                .padding(.bottom, 16)

            Text("Waynode")
                .font(.largeTitle.bold())
                .padding(.bottom, 4)

            if let user = appModel.auth.user {
                Text("Welcome back, \(user.name)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Text("Your coding agent workspace")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            // Auth buttons
            VStack(spacing: 12) {
                if let providers = appModel.auth.providers, providers.github == true {
                    Button {
                        Task { await startAuth(provider: "github") }
                    } label: {
                        Label("Continue with GitHub", systemImage: "person.crop.circle.badge.checkmark")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large).accessibilityIdentifier("auth.github")
                    .disabled(session != nil)
                }

                if let providers = appModel.auth.providers, providers.gitlab == true {
                    Button {
                        Task { await startAuth(provider: "gitlab") }
                    } label: {
                        Label("Continue with GitLab", systemImage: "person.crop.circle.badge.checkmark")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large).accessibilityIdentifier("auth.gitlab")
                    .disabled(session != nil)
                }

                // If we don't know providers yet, show loading or retry.
                if appModel.auth.providers == nil {
                    if isFetchingProviders {
                        ProgressView()
                            .controlSize(.large)
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .accessibilityIdentifier("auth.providers.loading")
                    } else if providersFetchFailed {
                        VStack(spacing: 12) {
                            Text("Couldn't reach server")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Button {
                                Task { await fetchProviders() }
                            } label: {
                                Label("Retry", systemImage: "arrow.clockwise")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.glass)
                            .controlSize(.large).accessibilityIdentifier("auth.providers.retry")
                        }
                    } else {
                        // Fallback: generic login (should rarely show since
                        // fetchProviders runs immediately on appear).
                        Button {
                            Task { await startAuth(provider: "github") }
                        } label: {
                            Label("Log In", systemImage: "arrow.right.square")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.glassProminent)
                        .controlSize(.large).accessibilityIdentifier("auth.login")
                        .disabled(session != nil)
                    }
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 8)

            // Server URL config (for self-hosters)
            Button {
                customServerURL = appModel.auth.serverConfig.baseURL.absoluteString
                showingServerSheet = true
            } label: {
                Label {
                    Text(serverHost)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } icon: {
                    Image(systemName: "server.rack")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Change server. Current server: \(serverHost)")
            .accessibilityHint("Opens server address settings")
            .accessibilityIdentifier("auth.server.change")
            .frame(minHeight: 44)
            .padding(.vertical, 8)
            .padding(.bottom, 16)

            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal)
                    .padding(.bottom, 8)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                    .accessibilityLabel("Login error: \(error)")
                    .accessibilitySortPriority(2)
            } else if let authError = appModel.auth.error {
                Text(authError)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .padding(.horizontal)
                    .padding(.bottom, 8)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                    .accessibilityLabel("Login error: \(authError)")
                    .accessibilitySortPriority(2)
            }
        }
    }

    private var serverHost: String {
        appModel.auth.serverConfig.baseURL.host ?? "waynode.fornace.net"
    }

    private func fetchProviders() async {
        // Hit /api/auth/me without a token to discover available providers.
        // Retries up to 3 times with backoff to survive transient network
        // errors (VPN, DNS hiccup, etc.).
        isFetchingProviders = true
        providersFetchFailed = false
        let api = APIClient(baseURL: appModel.auth.serverConfig.baseURL)
        let maxAttempts = 3
        for attempt in 1...maxAttempts {
            do {
                let resp = try await api.authMe()
                appModel.auth.setProviders(resp.providers)
                isFetchingProviders = false
                providersFetchFailed = false
                return
            } catch {
                if attempt < maxAttempts {
                    // Exponential backoff: 1s, 2s, 4s
                    let delay = UInt64(attempt) * 1_000_000_000
                    try? await Task.sleep(nanoseconds: delay)
                } else {
                    // All retries exhausted — show error state with retry button.
                    isFetchingProviders = false
                    providersFetchFailed = true
                }
            }
        }
    }
    private func startAuth(provider: String) async {
        guard session == nil else { return }
        error = nil
        appModel.auth.error = nil // Clear stale "session expired" msg
        let baseURL = appModel.auth.serverConfig.baseURL
        var authURL = URLComponents(url: baseURL.appendingPathComponent("/auth/\(provider)"), resolvingAgainstBaseURL: false)!
        let scheme = AuthStore.callbackScheme
        guard let presentationProvider = AuthPresentationProvider.active() else {
            error = "Waynode needs an active window before it can open sign in."
            return
        }
        guard let nonce = appModel.auth.beginNativeAuth() else { return }
        authURL.queryItems = [
            URLQueryItem(name: "native", value: "1"),
            URLQueryItem(name: "native_nonce", value: nonce),
        ]
        let url = authURL.url!

        let completion: @Sendable (URL?, Error?) -> Void = { callbackURL, err in
            // Safari completes on an XPC queue on Catalyst. Hop to main before
            // touching SwiftUI state to satisfy Swift 6 actor isolation.
            DispatchQueue.main.async {
                Task { @MainActor in
                    self.session = nil
                    self.presentationProvider = nil
                    guard let callbackURL else {
                        appModel.auth.cancelNativeAuth()
                        if let err = err as? ASWebAuthenticationSessionError, err.code == .canceledLogin {
                        } else if let err {
                            error = err.localizedDescription
                            Haptics.error()
                        }
                        return
                    }
                    await handleCallback(callbackURL)
                }
            }
        }
        let session = ASWebAuthenticationSession(
            url: url,
            callback: .customScheme(scheme),
            completionHandler: completion
        )
        session.prefersEphemeralWebBrowserSession = false
        session.presentationContextProvider = presentationProvider
        self.presentationProvider = presentationProvider
        self.session = session
        guard session.start() else {
            self.session = nil
            self.presentationProvider = nil
            appModel.auth.cancelNativeAuth()
            error = "Waynode couldn't open the sign-in window. Please try again."
            return
        }
    }

    private func handleCallback(_ url: URL) async {
        if await appModel.auth.completeNativeAuthCallback(url) {
            await appModel.bootstrap()
        }
    }
}
// MARK: - BrandLogo

struct BrandLogo: View {
    var body: some View {
        GeometryReader { proxy in
            let scale = min(proxy.size.width, proxy.size.height) / 64
            let nodes: [(CGFloat, CGFloat, CGFloat)] = [
                (11, 23, 4), (23, 30, 4), (32, 15, 4.5), (45, 27, 4),
                (55, 11, 4.5), (24, 50, 4.5), (32, 37, 4.5), (45, 50, 4.5),
            ]
            ZStack {
                Path { path in
                    path.move(to: CGPoint(x: 11 * scale, y: 23 * scale))
                    path.addLine(to: CGPoint(x: 24 * scale, y: 50 * scale))
                    path.addLine(to: CGPoint(x: 32 * scale, y: 15 * scale))
                    path.addLine(to: CGPoint(x: 45 * scale, y: 50 * scale))
                    path.addLine(to: CGPoint(x: 55 * scale, y: 11 * scale))
                    path.move(to: CGPoint(x: 11 * scale, y: 23 * scale))
                    path.addLine(to: CGPoint(x: 23 * scale, y: 30 * scale))
                    path.addLine(to: CGPoint(x: 32 * scale, y: 15 * scale))
                    path.addLine(to: CGPoint(x: 45 * scale, y: 27 * scale))
                    path.addLine(to: CGPoint(x: 55 * scale, y: 11 * scale))
                    path.move(to: CGPoint(x: 24 * scale, y: 50 * scale))
                    path.addLine(to: CGPoint(x: 32 * scale, y: 37 * scale))
                    path.addLine(to: CGPoint(x: 45 * scale, y: 50 * scale))
                }
                .stroke(
                    LinearGradient(colors: [.blue.opacity(0.55), .accentColor], startPoint: .topLeading, endPoint: .bottomTrailing),
                    style: StrokeStyle(lineWidth: 3.8 * scale, lineCap: .round, lineJoin: .round)
                )

                ForEach(nodes.indices, id: \.self) { index in
                    let node = nodes[index]
                    Circle()
                        .fill(.white.opacity(0.88))
                        .overlay(Circle().stroke(Color.accentColor, lineWidth: 1.4 * scale))
                        .frame(width: node.2 * 2 * scale, height: node.2 * 2 * scale)
                        .position(x: node.0 * scale, y: node.1 * scale)
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}
