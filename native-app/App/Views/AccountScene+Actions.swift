import SwiftUI
import WaynodeCore

extension AccountScene {
    func prepareUITestFixture() async -> Bool {
        #if DEBUG
        guard appModel.isUITestFixture else { return false }
        await loadTokens()
        if CommandLine.arguments.contains("-ui-test-billing-hosted")
            || ProcessInfo.processInfo.environment["WAYNODE_UI_TEST_BILLING_HOSTED"] == "1" {
            hostedBillingEnabled = true
            let data = Data("{\"plan\":\"pro\",\"status\":\"active\",\"current_period_end\":\"2026-08-14T12:00:00Z\"}".utf8)
            billing = try? JSONDecoder().decode(APIClient.BillingInfo.self, from: data)
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
        billingError = nil
        defer { isLoadingBilling = false }
        do {
            hostedBillingEnabled = try await api.hostedBillingEnabled()
            guard hostedBillingEnabled, let org = appModel.orgs.first else { return }
            billing = try await api.billing(orgId: org.id)
        } catch {
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

    func createToken() async {
        #if DEBUG
        if appModel.isUITestFixture {
            newToken = NewTokenPresentation(value: "wn_ui_test_token_1234567890")
            return
        }
        #endif
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
