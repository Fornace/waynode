import SwiftUI
import WaynodeCore

// MARK: - AccountScene
//
// The account management tab. Shows:
//   • User profile (avatar, name, email)
//   • Connected providers (GitHub, GitLab)
//   • API tokens (create, list, revoke)
//   • Server configuration
//   • About / version
//   • Logout

struct AccountScene: View {
    @Environment(AppModel.self) private var appModel
    @State private var tokens: [APIClient.TokenInfo] = []
    @State private var newToken: String?
    @State private var isLoadingTokens = false
    @State private var isCreatingToken = false
    @State private var error: String?
    @State private var showingServerSheet = false
    @State private var serverURL = ""
    @State private var tokenToRevoke: APIClient.TokenInfo?
    @State private var showingLogoutConfirm = false
    @State private var showingNewTokenSheet = false

    var body: some View {
        List {
            profileSection
            providersSection
            tokensSection
            serverSection
            aboutSection
            logoutSection
        }
        .navigationTitle("Account")
        .task {
            await loadTokens()
        }
        .confirmationDialog(
            "Log Out?",
            isPresented: $showingLogoutConfirm,
            titleVisibility: .visible
        ) {
            Button("Log Out", role: .destructive) {
                Haptics.warning()
                appModel.auth.logout()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You will be signed out and returned to the login screen. Your spaces and sessions remain on the server.")
        }
        .confirmationDialog(
            "Revoke Token?",
            isPresented: Binding(
                get: { tokenToRevoke != nil },
                set: { if !$0 { tokenToRevoke = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Revoke", role: .destructive) {
                if let token = tokenToRevoke {
                    Haptics.rigid()
                    Task { await revokeToken(token) }
                }
                tokenToRevoke = nil
            }
            Button("Cancel", role: .cancel) { tokenToRevoke = nil }
        } message: {
            if let token = tokenToRevoke {
                Text("The token \"\(token.label)\" will be permanently revoked. Any app using it will lose access immediately.")
            } else {
                Text("This action cannot be undone.")
            }
        }
        .sheet(isPresented: $showingNewTokenSheet) {
            if let newToken {
                NewTokenSheet(token: newToken) {
                    showingNewTokenSheet = false
                    self.newToken = nil
                }
            }
        }
    }

    // MARK: - Profile

    private var profileSection: some View {
        Section {
            HStack(spacing: 12) {
                Circle()
                    .fill(Color.accentColor.opacity(0.2))
                    .overlay(
                        Text(initials)
                            .font(.title2.bold())
                            .foregroundStyle(.tint)
                    )
                    .frame(width: 56, height: 56)

                VStack(alignment: .leading) {
                    Text(appModel.auth.user?.name ?? "Unknown")
                        .font(.headline)
                    if let email = appModel.auth.user?.email {
                        Text(email)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: - Providers

    private var providersSection: some View {
        Section("Connected Accounts") {
            if let providers = appModel.auth.providers {
                providerRow(
                    name: "GitHub",
                    icon: "network",
                    connected: providers.github ?? false
                )
                providerRow(
                    name: "GitLab",
                    icon: "fox",
                    connected: providers.gitlab ?? false
                )
                if providers.dev == true {
                    providerRow(
                        name: "Developer",
                        icon: "wrench.and.screwdriver",
                        connected: true
                    )
                }
            } else {
                Text("Loading…")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func providerRow(name: String, icon: String, connected: Bool) -> some View {
        HStack {
            Image(systemName: icon)
                .foregroundStyle(connected ? .green : .secondary)
            Text(name)
            Spacer()
            if connected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Text("Not connected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Tokens

    private var tokensSection: some View {
        Section {
            if isLoadingTokens {
                HStack { Spacer(); ProgressView(); Spacer() }
            } else if tokens.isEmpty {
                Text("No API tokens")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(tokens) { token in
                    VStack(alignment: .leading) {
                        Text(token.label)
                            .font(.subheadline)
                        HStack {
                            Text("wn_\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}")
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                            Spacer()
                            if let lastUsed = token.lastUsedAt {
                                Text("Last used: \(Format.compactRelative(fromISO: lastUsed))")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            } else {
                                Text("Never used")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            tokenToRevoke = token
                        } label: {
                            Label("Revoke", systemImage: "trash")
                        }
                    }
                }
            }

            Button {
                Task { await createToken() }
            } label: {
                HStack {
                    if isCreatingToken {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Label("Create Token", systemImage: "plus.circle")
                }
            }
            .disabled(tokens.count >= 10 || isCreatingToken)

            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        } header: {
            Text("API Tokens")
        } footer: {
            Text("Tokens let the native app authenticate with the server. Max 10 per account.")
        }
    }

    // MARK: - Server

    private var serverSection: some View {
        Section("Server") {
            HStack {
                Image(systemName: "server.rack")
                Text(appModel.auth.serverConfig.baseURL.host ?? "Unknown")
                    .font(.subheadline)
            }
            Button("Change Server URL") {
                serverURL = appModel.auth.serverConfig.baseURL.absoluteString
                showingServerSheet = true
            }
        }
        .sheet(isPresented: $showingServerSheet) {
            ServerConfigSheet(url: $serverURL) { newURL in
                if let url = URL(string: newURL) {
                    appModel.auth.setServerURL(url)
                    appModel.reconfigureAPI()
                    Task { await appModel.bootstrap() }
                }
            }
            .presentationDetents([.medium])
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("Version", value: appVersion)
            LabeledContent("Build", value: buildNumber)
            Link(destination: URL(string: "https://github.com/earendil-works/waynode")!) {
                Label("View on GitHub", systemImage: "chevron.left.slash.chevron.right")
            }
        }
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    }

    // MARK: - Logout

    private var logoutSection: some View {
        Section {
            Button(role: .destructive) {
                showingLogoutConfirm = true
            } label: {
                Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
                    .frame(maxWidth: .infinity)
            }
        } footer: {
            Text("You will need to sign in again to access your spaces.")
        }
    }

    // MARK: - Helpers

    private var initials: String {
        guard let name = appModel.auth.user?.name, !name.isEmpty else { return "?" }
        let parts = name.split(separator: " ")
        if parts.count >= 2 {
            return String(parts[0].prefix(1) + parts[1].prefix(1)).uppercased()
        }
        return String(name.prefix(2)).uppercased()
    }

    // MARK: - Token actions

    private func loadTokens() async {
        guard let api = appModel.currentAPI() else { return }
        isLoadingTokens = true
        error = nil
        do {
            tokens = try await api.listTokens()
        } catch {
            self.error = error.localizedDescription
        }
        isLoadingTokens = false
    }

    private func createToken() async {
        guard let api = appModel.currentAPI() else { return }
        error = nil
        isCreatingToken = true
        do {
            let label = "iOS App — \(formattedDate)"
            let created = try await api.createToken(label: label)
            newToken = created.token
            await loadTokens()
            Haptics.success()
            showingNewTokenSheet = true
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
        isCreatingToken = false
    }

    private func revokeToken(_ token: APIClient.TokenInfo) async {
        guard let api = appModel.currentAPI() else { return }
        do {
            try await api.revokeToken(id: token.id)
            await loadTokens()
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
    }

    private var formattedDate: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: Date())
    }
}

// MARK: - New Token Sheet

/// Shows a freshly-created token with copy button. The token is shown only
/// once — the user must copy it before dismissing. Uses a dedicated sheet
/// (not onDisappear) to prevent accidental clearing on scroll.
struct NewTokenSheet: View {
    let token: String
    var onDone: () -> Void
    @State private var hasCopied = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.green)

                Text("Token Created")
                    .font(.title2.bold())

                Text("Copy this token now. For security, it will not be shown again.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                // Token display — selectable for manual copy
                Text(token)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity)
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal)

                Button {
                    copyToClipboard(token)
                    Haptics.success()
                    hasCopied = true
                } label: {
                    Label(hasCopied ? "Copied!" : "Copy Token", systemImage: hasCopied ? "checkmark" : "doc.on.doc")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .padding(.horizontal)

                Spacer()
            }
            .padding(.top, 40)
            .navigationTitle("New Token")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        onDone()
                    }
                    .disabled(!hasCopied)
                }
            }
            .interactiveDismissDisabled(!hasCopied)
        }
    }
}
