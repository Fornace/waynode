import SwiftUI
import WaynodeCore
import AuthenticationServices
#if canImport(UIKit)
import UIKit
#endif

// MARK: - AuthView
//
// The login screen. Presents two buttons: "Continue with GitHub" and
// "Continue with GitLab" (shown only if enabled on the server).
//
// Uses ASWebAuthenticationSession to perform the OAuth flow in Safari.
// The server redirects to waynode://auth?token=wn_... which
// ASWebAuthenticationSession captures.
//
// Design: centered logo + buttons on a matte background. No glass here —
// this is the content layer before the app shell exists. The primary
// button uses .glassProminent per the Liquid Glass reference.

struct AuthView: View {
    @Environment(AppModel.self) private var appModel
    @State private var session: ASWebAuthenticationSession?
    @State private var error: String?
    @State private var customServerURL: String = ""
    @State private var showingServerSheet = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

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
                    .controlSize(.large)
                }

                if let providers = appModel.auth.providers, providers.gitlab == true {
                    Button {
                        Task { await startAuth(provider: "gitlab") }
                    } label: {
                        Label("Continue with GitLab", systemImage: "person.crop.circle.badge.checkmark")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)
                }

                // If we don't know providers yet, show a generic login.
                if appModel.auth.providers == nil {
                    Button {
                        Task { await startAuth(provider: "github") }
                    } label: {
                        Label("Log In", systemImage: "arrow.right.square")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 8)

            // Server URL config (for self-hosters)
            Button("Server: \(serverHost)") {
                showingServerSheet = true
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
            .padding(.bottom, 24)

            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal)
                    .padding(.bottom, 8)
            } else if let authError = appModel.auth.error {
                Text(authError)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .padding(.horizontal)
                    .padding(.bottom, 8)
            }
        }
        .sheet(isPresented: $showingServerSheet) {
            ServerConfigSheet(
                url: Binding(
                    get: { appModel.auth.serverConfig.baseURL.absoluteString },
                    set: { customServerURL = $0 }
                )
            ) { newURL in
                if let url = URL(string: newURL) {
                    appModel.auth.setServerURL(url)
                    appModel.reconfigureAPI()
                    Task { await fetchProviders() }
                }
            }
            .presentationDetents([.medium])
        }
        .task {
            // Fetch providers list (no auth needed for /api/auth/me shape).
            await fetchProviders()
        }
    }

    private var serverHost: String {
        appModel.auth.serverConfig.baseURL.host ?? "waynode.fornace.net"
    }

    private func fetchProviders() async {
        // Hit /api/auth/me without a token to discover available providers.
        // The server returns providers: {github: bool, gitlab: bool} even
        // when unauthenticated.
        let api = APIClient(baseURL: appModel.auth.serverConfig.baseURL)
        if let resp = try? await api.authMe() {
            appModel.auth.setProviders(resp.providers)
        }
    }

    private func startAuth(provider: String) async {
        error = nil
        appModel.auth.error = nil // Clear stale "session expired" msg
        let baseURL = appModel.auth.serverConfig.baseURL
        var authURL = URLComponents(url: baseURL.appendingPathComponent("/auth/\(provider)"), resolvingAgainstBaseURL: false)!
        authURL.queryItems = [URLQueryItem(name: "native", value: "1")]
        let url = authURL.url!
        let scheme = AuthStore.callbackScheme

        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callbackURL, err in
            Task { @MainActor in
                guard let callbackURL else {
                    // User canceled or session failed
                    if let err = err as? ASWebAuthenticationSessionError, err.code == .canceledLogin {
                        // Silent cancel — user dismissed the browser
                    } else if let err {
                        error = err.localizedDescription
                        Haptics.error()
                    }
                    return
                }
                await handleCallback(callbackURL)
            }
        }
        session.prefersEphemeralWebBrowserSession = false
        session.presentationContextProvider = AuthPresentationProvider.shared
        self.session = session
        session.start()
    }

    private func handleCallback(_ url: URL) async {
        // Expected: waynode://auth?token=wn_...
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let token = components.queryItems?.first(where: { $0.name == "token" })?.value else {
            error = "Invalid callback URL"
            return
        }
        await appModel.auth.completeAuth(token: token)
        if appModel.auth.isAuthenticated {
            await appModel.bootstrap()
        }
    }
}

// MARK: - BrandLogo

struct BrandLogo: View {
    var body: some View {
        ZStack {
            // Outer ring (the "way" paths radiating from center)
            ForEach(0..<4, id: \.self) { i in
                RoundedRectangle(cornerRadius: 2)
                    .fill(LinearGradient(
                        colors: [.accentColor, .accentColor.opacity(0.6)],
                        startPoint: .center,
                        endPoint: edgeFor(i)
                    ))
                    .frame(width: 8, height: 36)
                    .offset(offsetFor(i))
                    .rotationEffect(.degrees(Double(i) * 90))
            }
            // Central node hub
            Circle()
                .fill(Color.accentColor)
                .frame(width: 28, height: 28)
            Circle()
                .fill(.white)
                .frame(width: 12, height: 12)
        }
    }

    private func edgeFor(_ i: Int) -> UnitPoint {
        switch i {
        case 0: return .top
        case 1: return .trailing
        case 2: return .bottom
        default: return .leading
        }
    }

    private func offsetFor(_ i: Int) -> CGSize {
        switch i {
        case 0: return CGSize(width: 0, height: -28)
        case 1: return CGSize(width: 28, height: 0)
        case 2: return CGSize(width: 0, height: 28)
        default: return CGSize(width: -28, height: 0)
        }
    }
}

// MARK: - Presentation provider for ASWebAuthenticationSession

@MainActor
final class AuthPresentationProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AuthPresentationProvider()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if canImport(UIKit)
        // iOS: return the key window from the active scene.
        guard let scene = UIApplication.shared.connectedScenes
            .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
              let window = scene.windows.first else {
            return ASPresentationAnchor()
        }
        return window
        #else
        // macOS: NSApplication.mainWindow or a new window.
        return ASPresentationAnchor()
        #endif
    }
}

// MARK: - Server Config Sheet

struct ServerConfigSheet: View {
    @Binding var url: String
    var onSave: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Server URL") {
                    TextField("https://your-server.com", text: $url)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                Section {
                    Text("Point this at your self-hosted Waynode instance. The default is waynode.fornace.net.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(url)
                        dismiss()
                    }
                    .disabled(url.isEmpty)
                }
            }
        }
    }
}

#Preview {
    AuthView()
        .environment(AppModel(auth: AuthStore()))
}
