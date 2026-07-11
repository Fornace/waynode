import SwiftUI
import WaynodeCore
import AuthenticationServices
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
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
    @State private var isFetchingProviders = false
    @State private var providersFetchFailed = false

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

                // If we don't know providers yet, show loading or retry.
                if appModel.auth.providers == nil {
                    if isFetchingProviders {
                        ProgressView()
                            .controlSize(.large)
                            .frame(maxWidth: .infinity, minHeight: 50)
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
                            .controlSize(.large)
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
                        .controlSize(.large)
                    }
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
        error = nil
        appModel.auth.error = nil // Clear stale "session expired" msg
        let baseURL = appModel.auth.serverConfig.baseURL
        var authURL = URLComponents(url: baseURL.appendingPathComponent("/auth/\(provider)"), resolvingAgainstBaseURL: false)!
        authURL.queryItems = [URLQueryItem(name: "native", value: "1")]
        let url = authURL.url!
        let scheme = AuthStore.callbackScheme

        let completion: @Sendable (URL?, Error?) -> Void = { callbackURL, err in
            // ASWebAuthenticationSession invokes its completion from Safari's
            // XPC queue on macOS. Creating a @MainActor Task directly there
            // inherits an invalid executor and trips Swift 6's runtime
            // isolation assertion (EXC_BREAKPOINT). Hop to the main dispatch
            // queue first, then touch SwiftUI state or the AppModel.
            DispatchQueue.main.async {
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
        }
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme, completionHandler: completion)
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
        #elseif canImport(AppKit)
        // macOS: return the key window (or main window as fallback).
        if let window = NSApplication.shared.keyWindow ?? NSApplication.shared.mainWindow {
            return window
        }
        return ASPresentationAnchor()
        #else
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
