import SwiftUI
import WaynodeCore
import AuthenticationServices

struct NewTokenPresentation: Identifiable {
    let id = UUID()
    let value: String
}

struct AccountScene: View {
    @Environment(AppModel.self) var appModel
    @Environment(\.openURL) var openURL
    @Environment(\.dismiss) var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @State var tokens: [APIClient.TokenInfo] = []
    @State var newToken: NewTokenPresentation?
    @State var isLoadingTokens = false
    @State var isCreatingToken = false
    @State var error: String?
    @State var showingServerSheet = false
    @State var serverURL = ""
    @State var tokenToRevoke: APIClient.TokenInfo?
    @State var showingLogoutConfirm = false
    @State var billingCapability: BillingCapabilityState = .checking
    @State var billing: APIClient.BillingInfo?
    @State var isLoadingBilling = false
    @State var billingBusy = false
    @State var billingError: String?
    @State var showingDeleteAccount = false
    @State var isDeletingAccount = false
    @State var accountDeletionError: String?
    @State var deletionSession: ASWebAuthenticationSession?
    @State var deletionPresentationProvider: AuthPresentationProvider?

    var body: some View {
        List {
            profileSection
            providersSection
            organizationSection
            tokensSection
            billingSection
            serverSection
            aboutSection
            logoutSection
            deleteAccountSection
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("account.surface")
        .refreshable {
            await loadTokens()
            await loadBilling()
        }
        .navigationTitle("Account")
        .platformInlineNavigationTitle()
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
            guard phase == .active, billingCapability == .hosted else { return }
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
        .platformSensitiveCover(item: $newToken) { presentation in
            NewTokenSheet(token: presentation.value) {
                newToken = nil
            }
        }
        .sheet(isPresented: $showingServerSheet) {
            ServerConfigSheet(url: $serverURL) { newURL in
                if let url = ServerConfig.validatedBaseURL(from: newURL) {
                    Task { await appModel.changeServer(to: url) }
                }
            }
            .platformAdaptiveSheet()
            .macSheetFrame(minWidth: 480, idealWidth: 540, maxWidth: 620, minHeight: 360, idealHeight: 420, maxHeight: 560)
        }
        .sheet(isPresented: $showingDeleteAccount, onDismiss: cancelAccountDeletion) {
            AccountDeletionSheet(
                accountName: appModel.auth.user?.name ?? "this account",
                providers: linkedDeletionProviders,
                isDeleting: isDeletingAccount,
                error: accountDeletionError,
                onCancel: { showingDeleteAccount = false },
                onDelete: { provider in Task { await beginAccountDeletion(provider: provider) } }
            )
            .platformAdaptiveSheet()
            .macSheetFrame(minWidth: 480, idealWidth: 540, maxWidth: 620, minHeight: 520, idealHeight: 600, maxHeight: 760)
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
                    icon: "chevron.left.forwardslash.chevron.right",
                    connected: providers.github ?? false
                )
                providerRow(
                    name: "GitLab",
                    icon: "square.stack.3d.up",
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
                Label("Loading…", systemImage: "arrow.triangle.2.circlepath")
                    .foregroundStyle(.secondary)
                    .symbolEffect(.rotate, isActive: !reduceMotion)
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
                    .symbolEffect(.bounce, value: connected)
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
            Button {
                requestTokenCreation()
            } label: {
                HStack {
                    if isCreatingToken {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Label("Create Token", systemImage: isCreatingToken ? "key.fill" : "plus.circle")
                        .symbolEffect(.bounce, value: isCreatingToken)
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .disabled(tokens.count >= 10 || isCreatingToken)
            .accessibilityIdentifier("account.token.create")
            .accessibilityHint(tokens.count >= 10 ? "Token limit reached; revoke a token first" : "Creates a token that is shown only once")

            if isLoadingTokens {
                HStack { Spacer(); ProgressView(); Spacer() }
            } else if tokens.isEmpty {
                Label("No API tokens", systemImage: "key.slash")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("account.tokens.empty")
            } else {
                Label("\(tokens.count) active token\(tokens.count == 1 ? "" : "s")", systemImage: "key.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText(value: Double(tokens.count)))
                    .accessibilityIdentifier("account.tokens.summary")
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
            }

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
            Button {
                serverURL = appModel.auth.serverConfig.baseURL.absoluteString
                showingServerSheet = true
            } label: {
                Label("Change Server URL", systemImage: "link")
            }
            .accessibilityIdentifier("account.server.change")
            .accessibilityHint("Opens server address settings")
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        Section("About") {
            LabeledContent {
                Text(appVersion)
            } label: {
                Label("Version", systemImage: "app.badge")
            }
            LabeledContent {
                Text(buildNumber)
            } label: {
                Label("Build", systemImage: "hammer")
            }
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
