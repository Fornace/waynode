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
    @Environment(AppModel.self) var appModel
    @Environment(\.openURL) var openURL
    @State var tokens: [APIClient.TokenInfo] = []
    @State var newToken: String?
    @State var isLoadingTokens = false
    @State var isCreatingToken = false
    @State var error: String?
    @State var showingServerSheet = false
    @State var serverURL = ""
    @State var tokenToRevoke: APIClient.TokenInfo?
    @State var showingLogoutConfirm = false
    @State var showingNewTokenSheet = false
    @State var hostedBillingEnabled = false
    @State var billing: APIClient.BillingInfo?
    @State var isLoadingBilling = false
    @State var billingBusy = false
    @State var billingError: String?

    var body: some View {
        List {
            profileSection
            providersSection
            tokensSection
            billingSection
            serverSection
            aboutSection
            logoutSection
        }
        .navigationTitle("Account")
        .task {
            await loadTokens()
            await loadBilling()
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

    // MARK: - Billing

    private var billingSection: some View {
        Section {
            if isLoadingBilling {
                HStack { Spacer(); ProgressView(); Spacer() }
            } else if !hostedBillingEnabled {
                Label("This server is self-hosted", systemImage: "server.rack")
                    .foregroundStyle(.secondary)
            } else if let billing, let org = appModel.orgs.first {
                LabeledContent("Plan", value: billing.plan.capitalized)
                LabeledContent("Status", value: billing.status.capitalized)
                if billing.status != "active" && billing.status != "trialing" {
                    Text("Agent work is paused until this workspace has an active plan.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                if billing.plan == "free" || billing.status == "expired" {
                    Menu {
                        Button("Starter · $39/month") { Task { await beginCheckout(org.id, plan: "starter") } }
                        Button("Pro · $99/month") { Task { await beginCheckout(org.id, plan: "pro") } }
                        Button("Team · $249/month") { Task { await beginCheckout(org.id, plan: "team") } }
                    } label: {
                        Label(billingBusy ? "Opening checkout…" : "Choose a plan", systemImage: "creditcard")
                    }
                    .disabled(billingBusy)
                } else {
                    Button {
                        Task { await manageBilling(org.id) }
                    } label: {
                        Label(billingBusy ? "Opening billing…" : "Manage billing", systemImage: "creditcard")
                    }
                    .disabled(billingBusy)
                }
            } else {
                Text("No organization is available for billing.")
                    .foregroundStyle(.secondary)
            }

            if let billingError {
                Text(billingError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        } header: {
            Text("Hosted Billing")
        } footer: {
            Text("Plans apply to the whole workspace. App Store subscriptions remain separate until server verification is available.")
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
            Link(destination: URL(string: "https://github.com/Fornace/waynode")!) {
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

}
