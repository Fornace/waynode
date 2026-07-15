import Foundation
import Testing
@testable import WaynodeCore

@Suite("AppModel organization selection", .serialized)
struct AppModelOrganizationTests {
    @Test("Selection persists across multiple memberships")
    @MainActor
    func selectionPersists() {
        let fixture = Fixture()
        fixture.model.applyOrganizations([fixture.admin, fixture.viewer])
        #expect(fixture.model.activeOrgId == fixture.admin.id)
        fixture.model.selectOrganization(fixture.viewer.id)

        let restored = AppModel(auth: fixture.auth, preferences: fixture.preferences)
        restored.applyOrganizations([fixture.admin, fixture.viewer])
        #expect(restored.activeOrgId == fixture.viewer.id)
        #expect(restored.activeOrg?.name == fixture.viewer.name)
    }

    @Test("Removed membership falls back to a valid organization")
    @MainActor
    func removedMembershipFallback() {
        let fixture = Fixture()
        fixture.model.applyOrganizations([fixture.admin, fixture.viewer])
        fixture.model.selectOrganization(fixture.viewer.id)
        fixture.model.applyOrganizations([fixture.admin])

        #expect(fixture.model.activeOrgId == fixture.admin.id)
        #expect(fixture.model.activeOrg?.id == fixture.admin.id)
    }

    @Test("Billing management follows the selected membership role")
    @MainActor
    func billingRoleTruth() {
        let fixture = Fixture()
        fixture.model.applyOrganizations([fixture.admin, fixture.viewer])
        #expect(fixture.model.activeOrgCanManageBilling)
        fixture.model.selectOrganization(fixture.viewer.id)
        #expect(!fixture.model.activeOrgCanManageBilling)
    }

    @Test("Fixture clone uses the selected organization")
    @MainActor
    func selectedOrganizationClone() async throws {
        let fixture = Fixture()
        fixture.model.installUITestFixture()
        fixture.model.selectOrganization("ui-viewer-org")

        let space = try await fixture.model.createSpace(repoUrl: "https://example.test/repo.git")
        #expect(space.orgId == "ui-viewer-org")
    }

    @Test("Billing deployment failure is unavailable, never self-hosted")
    func billingCapabilityTruth() {
        #expect(BillingCapabilityState(deployment: "hosted") == .hosted)
        #expect(BillingCapabilityState(deployment: "self-hosted") == .selfHosted)
        #expect(BillingCapabilityState(deployment: nil) == .unavailable)
        #expect(BillingCapabilityState(deployment: "unknown") == .unavailable)
    }

    @MainActor
    private final class Fixture {
        let preferences: UserDefaults
        let auth: AuthStore
        let model: AppModel
        let admin = Org(id: "admin-org", name: "Admin Studio", slug: "admin", createdAt: "2026-01-01", myRole: "admin")
        let viewer = Org(id: "viewer-org", name: "Viewer Studio", slug: "viewer", createdAt: "2026-01-02", myRole: "viewer")

        init() {
            let suite = "WaynodeOrgTests.\(UUID().uuidString)"
            preferences = UserDefaults(suiteName: suite)!
            preferences.removePersistentDomain(forName: suite)
            auth = AuthStore(serverConfig: .default, keychain: EmptyCredentialStore())
            auth.markAuthenticated(token: "wn_test")
            model = AppModel(auth: auth, preferences: preferences)
        }
    }
}

private struct EmptyCredentialStore: CredentialStore {
    func readToken(for serverOrigin: String) -> String? { nil }
    func writeToken(_ token: String, for serverOrigin: String) throws {}
    func deleteToken(for serverOrigin: String) {}
}
