import SwiftUI
import WaynodeCore

struct NewTokenPresentation: Identifiable {
    let id = UUID()
    let value: String
}

struct AccountScene: View {
    @Environment(AppModel.self) var appModel
    @Environment(\.openURL) var openURL
    @Environment(\.dismiss) var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State var tokens: [APIClient.TokenInfo] = []
    @State var newToken: NewTokenPresentation?
    @State var isLoadingTokens = false
    @State var isCreatingToken = false
    @State var error: String?
    @State var showingServerSheet = false
    @State var serverURL = ""
    @State var tokenToRevoke: APIClient.TokenInfo?
    @State var showingLogoutConfirm = false
    @State var hostedBillingEnabled = false
    @State var billing: APIClient.BillingInfo?
    @State var isLoadingBilling = false
    @State var billingBusy = false
    @State var billingError: String?
    @State var areTokensExpanded = false

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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("account.surface")
        .refreshable {
            await loadTokens()
            await loadBilling()
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("account.done")
                    .accessibilityHint("Closes Account")
            }
        }
        .macSheetFrame(minWidth: 520, idealWidth: 620, minHeight: 600, idealHeight: 720)
        .task {
            if await prepareUITestFixture() { return }
            await loadTokens()
            await loadBilling()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, hostedBillingEnabled else { return }
            Task { await loadBilling() }
        }
        .alert(
            "Log Out?",
            isPresented: $showingLogoutConfirm
        ) {
            Button("Log Out", role: .destructive) {
                Haptics.warning()
                Task { await appModel.auth.logoutRevokingCurrentToken() }
            }
            .disabled(appModel.auth.isLoading)
            .accessibilityIdentifier("account.logout.confirm")
            Button("Cancel", role: .cancel) {}
                .accessibilityIdentifier("account.logout.cancel")
        } message: {
            Text("You will be signed out and returned to the login screen. Your spaces and sessions remain on the server.")
        }
        .alert(
            "Revoke Token?",
            isPresented: Binding(
                get: { tokenToRevoke != nil },
                set: { if !$0 { tokenToRevoke = nil } }
            )
        ) {
            Button("Revoke", role: .destructive) {
                if let token = tokenToRevoke {
                    Haptics.rigid()
                    Task { await revokeToken(token) }
                }
                tokenToRevoke = nil
            }
            .accessibilityIdentifier("account.token.revoke.confirm")
            Button("Cancel", role: .cancel) { tokenToRevoke = nil }
                .accessibilityIdentifier("account.token.revoke.cancel")
        } message: {
            if let token = tokenToRevoke {
                Text("The token \"\(token.label)\" will be permanently revoked. Any app using it will lose access immediately.")
            } else {
                Text("This action cannot be undone.")
            }
        }
        .sheet(item: $newToken) { presentation in
            NewTokenSheet(token: presentation.value) {
                newToken = nil
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
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .macSheetFrame(minWidth: 480, idealWidth: 540, maxWidth: 620, minHeight: 360, idealHeight: 420, maxHeight: 560)
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
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if let email = appModel.auth.user?.email {
                        Text(email)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Signed in as \(appModel.auth.user?.name ?? "Unknown")")
            .accessibilityValue(appModel.auth.user?.email ?? "Email unavailable")
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
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), \(connected ? "connected" : "not connected")")
    }

    // MARK: - Tokens

    private var tokensSection: some View {
        Section {
            if isLoadingTokens {
                HStack { Spacer(); ProgressView(); Spacer() }
            } else if tokens.isEmpty {
                Text("No API tokens")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("account.tokens.empty")
            } else {
                DisclosureGroup(isExpanded: $areTokensExpanded) {
                    ForEach(tokens) { token in
                        HStack(alignment: .top, spacing: 10) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(token.label)
                                    .font(.subheadline)
                                    .lineLimit(2)
                                ViewThatFits(in: .horizontal) {
                                    tokenMetadata(token)
                                    tokenMetadata(token, stacked: true)
                                }
                            }
                            Spacer(minLength: 4)
                            Button(role: .destructive) { tokenToRevoke = token } label: {
                                Label("Revoke Token", systemImage: "trash")
                                    .labelStyle(.iconOnly)
                            }
                            .accessibilityLabel("Revoke \(token.label)")
                            .accessibilityIdentifier("account.token.\(token.id).revoke")
                            .accessibilityHint("Asks before permanently revoking this token")
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                tokenToRevoke = token
                            } label: {
                                Label("Revoke", systemImage: "trash")
                            }
                            .accessibilityIdentifier("account.token.\(token.id).revoke.swipe")
                        }
                    }
                } label: {
                    Text("\(tokens.count) active token\(tokens.count == 1 ? "" : "s")")
                        .accessibilityIdentifier("account.tokens.disclosure")
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
            .accessibilityIdentifier("account.token.create")
            .accessibilityHint(tokens.count >= 10 ? "Token limit reached; revoke a token first" : "Creates a token that is shown only once")

            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
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
                    .accessibilityIdentifier("account.billing.selfhosted")
            } else if let billing, let org = appModel.orgs.first {
                LabeledContent("Plan", value: billingLabel(billing.plan))
                LabeledContent("Status", value: billingLabel(billing.status))
                if billing.status != "active" && billing.status != "trialing" {
                    Text("Agent work is paused until this workspace has an active plan.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                if billing.plan == "free" || billing.status == "expired" {
                    Menu {
                        Button("Starter · $39/month") { Task { await beginCheckout(org.id, plan: "starter") } }.accessibilityIdentifier("account.billing.plan.starter")
                        Button("Pro · $99/month") { Task { await beginCheckout(org.id, plan: "pro") } }.accessibilityIdentifier("account.billing.plan.pro")
                        Button("Team · $249/month") { Task { await beginCheckout(org.id, plan: "team") } }.accessibilityIdentifier("account.billing.plan.team")
                    } label: {
                        Label(billingBusy ? "Opening checkout…" : "Choose a plan", systemImage: "creditcard")
                    }
                    .disabled(billingBusy)
                    .accessibilityIdentifier("account.billing.plan.menu")
                    .accessibilityHint("Choose a workspace plan and open secure checkout")
                } else {
                    Button {
                        Task { await manageBilling(org.id) }
                    } label: {
                        Label(billingBusy ? "Opening billing…" : "Manage billing", systemImage: "creditcard")
                    }
                    .disabled(billingBusy)
                    .accessibilityIdentifier("account.billing.manage")
                    .accessibilityHint("Opens the secure billing portal")
                }
            } else {
                Text("No organization is available for billing.")
                    .foregroundStyle(.secondary)
            }

            if let billingError {
                Text(billingError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityLabel("Billing error: \(billingError)")
                    .accessibilitySortPriority(2)
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
                Text(appModel.auth.serverConfig.baseURL.absoluteString)
                    .font(.subheadline)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Server, \(appModel.auth.serverConfig.baseURL.absoluteString)")
            Button("Change Server URL") {
                serverURL = appModel.auth.serverConfig.baseURL.absoluteString
                showingServerSheet = true
            }
            .accessibilityIdentifier("account.server.change")
            .accessibilityHint("Opens server address settings")
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
            .accessibilityIdentifier("account.about.github")
        }
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    }

}
