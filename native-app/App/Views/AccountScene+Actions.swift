import SwiftUI
import WaynodeCore

extension AccountScene {
    func prepareUITestFixture() async -> Bool {
        #if DEBUG
        guard appModel.isUITestFixture else { return false }
        await loadTokens()
        if CommandLine.arguments.contains("-ui-test-billing-unavailable") {
            billingCapability = .unavailable
            billingError = "Waynode couldn't verify billing availability."
        } else if CommandLine.arguments.contains("-ui-test-billing-hosted")
            || ProcessInfo.processInfo.environment["WAYNODE_UI_TEST_BILLING_HOSTED"] == "1" {
            billingCapability = .hosted
            let data = Data("{\"plan\":\"pro\",\"status\":\"active\",\"current_period_end\":\"2026-08-14T12:00:00Z\"}".utf8)
            billing = try? JSONDecoder().decode(APIClient.BillingInfo.self, from: data)
        } else {
            billingCapability = .selfHosted
        }
        return true
        #else
        return false
        #endif
    }

    // MARK: - Hosted billing actions

    func loadBilling() async {
        guard let api = appModel.currentAPI() else { return }
        isLoadingBilling = true
        billingCapability = .checking
        billing = nil
        billingError = nil
        defer { isLoadingBilling = false }
        do {
            billingCapability = try await api.billingCapability()
            guard billingCapability == .hosted,
                  let org = appModel.activeOrg,
                  appModel.activeOrgCanManageBilling else { return }
            billing = try await api.billing(orgId: org.id)
        } catch {
            if billingCapability == .checking { billingCapability = .unavailable }
            billingError = error.localizedDescription
        }
    }

    func beginCheckout(_ orgId: String, plan: String) async {
        guard let api = appModel.currentAPI() else { return }
        billingBusy = true
        billingError = nil
        defer { billingBusy = false }
        do {
            openURL(try await api.startCheckout(orgId: orgId, plan: plan))
        } catch {
            billingError = error.localizedDescription
        }
    }

    func manageBilling(_ orgId: String) async {
        guard let api = appModel.currentAPI() else { return }
        billingBusy = true
        billingError = nil
        defer { billingBusy = false }
        do {
            openURL(try await api.openBillingPortal(orgId: orgId))
        } catch {
            billingError = error.localizedDescription
        }
    }

    // MARK: - Logout

    var organizationSection: some View {
        Section("Organization") {
            if appModel.orgs.isEmpty {
                Text("No organization membership is available.")
                    .foregroundStyle(.secondary)
            } else {
                Picker("Active organization", selection: Binding(
                    get: { appModel.activeOrgId ?? "" },
                    set: { appModel.selectOrganization($0); refreshBillingForSelection() }
                )) {
                    ForEach(appModel.orgs) { org in
                        Text("\(org.name) · \(roleLabel(org.myRole))").tag(org.id)
                    }
                }
                .accessibilityIdentifier("account.organization")
                if let org = appModel.activeOrg {
                    LabeledContent("Your role", value: roleLabel(org.myRole))
                        .accessibilityIdentifier("account.organization.role")
                }
            }
        }
    }

    var billingSection: some View {
        Section {
            switch billingCapability {
            case .checking:
                Label("Checking billing availability…", systemImage: "arrow.triangle.2.circlepath")
                    .accessibilityIdentifier("account.billing.checking")
            case .selfHosted:
                Label("This server is self-hosted", systemImage: "server.rack")
                    .foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("account.billing.selfhosted")
            case .unavailable:
                Label("Billing availability couldn't be verified", systemImage: "wifi.exclamationmark")
                    .foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("account.billing.unavailable")
                Button("Try Again") { Task { await loadBilling() } }
                    .accessibilityIdentifier("account.billing.retry")
            case .hosted:
                hostedBillingContent
            }
            if let billingError {
                Text(billingError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityLabel("Billing error: \(billingError)")
            }
        } header: {
            Text("Billing")
        } footer: {
            Text("Plans apply to the selected organization. This app treats server plan status as authoritative.")
        }
    }

    @ViewBuilder
    private var hostedBillingContent: some View {
        if let org = appModel.activeOrg {
            LabeledContent("Organization", value: org.name)
                .accessibilityIdentifier("account.billing.organization")
            LabeledContent("Your role", value: roleLabel(org.myRole))
            if !appModel.activeOrgCanManageBilling {
                Button("Manage billing") {}
                    .disabled(true)
                    .accessibilityIdentifier("account.billing.manage.disabled")
                Text("Only organization admins can view plans or manage billing for \(org.name).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("account.billing.admin.required")
            } else if isLoadingBilling && billing == nil {
                HStack { Spacer(); ProgressView(); Spacer() }
            } else if let billing {
                billingDetails(billing, org: org)
            }
        } else {
            Text("No organization is available for billing.")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func billingDetails(_ billing: APIClient.BillingInfo, org: Org) -> some View {
        LabeledContent("Plan", value: billingLabel(billing.plan))
        LabeledContent("Status", value: billingLabel(billing.status))
        #if os(macOS)
        if billing.plan == "free" || billing.status == "expired" {
            Menu {
                Button("Starter · $39/month") { Task { await beginCheckout(org.id, plan: "starter") } }
                Button("Pro · $99/month") { Task { await beginCheckout(org.id, plan: "pro") } }
                Button("Team · $249/month") { Task { await beginCheckout(org.id, plan: "team") } }
            } label: {
                Label(billingBusy ? "Opening checkout…" : "Choose a plan", systemImage: "creditcard")
            }
            .disabled(billingBusy)
            .accessibilityIdentifier("account.billing.plan.menu")
        } else {
            Button { Task { await manageBilling(org.id) } } label: {
                Label(billingBusy ? "Opening billing…" : "Manage billing", systemImage: "creditcard")
            }
            .disabled(billingBusy)
            .accessibilityIdentifier("account.billing.manage")
        }
        #else
        Text("Plan changes are not available in this iPhone or iPad app. The status above is read-only.")
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("account.billing.readonly")
        #endif
    }

    func roleLabel(_ role: String?) -> String {
        (role ?? "member").replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func refreshBillingForSelection() {
        #if DEBUG
        if appModel.isUITestFixture { return }
        #endif
        Task { await loadBilling() }
    }

    var logoutSection: some View {
        Section {
            Button(role: .destructive) {
                showingLogoutConfirm = true
            } label: {
                Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
                    .frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier("account.logout")
            .accessibilityHint("Signs out of this device")
        } footer: {
            Text("You will need to sign in again to access your spaces.")
        }
    }

    // MARK: - Helpers

    var initials: String {
        guard let name = appModel.auth.user?.name, !name.isEmpty else { return "?" }
        let parts = name.split(separator: " ")
        if parts.count >= 2 {
            return String(parts[0].prefix(1) + parts[1].prefix(1)).uppercased()
        }
        return String(name.prefix(2)).uppercased()
    }

    // MARK: - Token actions

    func loadTokens() async {
        #if DEBUG
        if appModel.isUITestFixture {
            let data = Data("{\"id\":\"ui-token\",\"label\":\"iOS test token\",\"created_at\":\"2026-07-14T12:00:00Z\"}".utf8)
            tokens = (try? JSONDecoder().decode(APIClient.TokenInfo.self, from: data)).map { [$0] } ?? []
            return
        }
        #endif
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

    func requestTokenCreation() {
        #if DEBUG
        if appModel.isUITestFixture {
            newToken = NewTokenPresentation(value: "wn_ui_test_token_1234567890")
            return
        }
        #endif
        Task { await createToken() }
    }

    func createToken() async {
        guard let api = appModel.currentAPI() else { return }
        error = nil
        isCreatingToken = true
        do {
            let label = "iOS App — \(formattedDate)"
            let created = try await api.createToken(label: label)
            newToken = NewTokenPresentation(value: created.token)
            await loadTokens()
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
            Haptics.error()
        }
        isCreatingToken = false
    }

    func revokeToken(_ token: APIClient.TokenInfo) async {
        #if DEBUG
        if appModel.isUITestFixture {
            tokens.removeAll { $0.id == token.id }
            return
        }
        #endif
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

    var formattedDate: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: Date())
    }

    func billingLabel(_ value: String) -> String {
        value.replacingOccurrences(of: "_", with: " ").capitalized
    }

    @ViewBuilder
    func tokenMetadata(_ token: APIClient.TokenInfo, stacked: Bool = false) -> some View {
        let lastUsed = token.lastUsedAt.map { "Last used \(Format.compactRelative(fromISO: $0))" } ?? "Never used"
        if stacked {
            VStack(alignment: .leading, spacing: 2) {
                tokenMask
                Text(lastUsed).font(.caption2).foregroundStyle(.secondary)
            }
        } else {
            HStack {
                tokenMask
                Spacer()
                Text(lastUsed).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    var tokenMask: some View {
        Text("wn_\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}")
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
    }
}
