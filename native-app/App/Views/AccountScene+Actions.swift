import SwiftUI
import WaynodeCore

extension AccountScene {
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

    func revokeToken(_ token: APIClient.TokenInfo) async {
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
}
