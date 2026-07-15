import XCTest

@MainActor
final class AccountUITests: WaynodeUITestCase {
    func testAccountSheetOpensAndClosesFromWorkbench() {
        let app = launchFixture()
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["worktrees.list"].waitForExistence(timeout: 8))
        app.buttons["account.open"].firstMatch.tap()
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 4))
        app.buttons["account.done"].tap()
        XCTAssertTrue(any["worktrees.list"].waitForExistence(timeout: 4))
        XCTAssertFalse(any["account.surface"].exists)
    }

    func testAccountBillingAndTokenCreationUseProductionSheets() {
        var app = launchAccount(["-ui-test-billing-hosted"])
        var any = app.descendants(matching: .any)
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 8))
        revealFully(any["account.token.create"], in: app)
        any["account.token.create"].firstMatch.tap()
        XCTAssertTrue(any["token.surface"].waitForExistence(timeout: 4))
        XCTAssertTrue(any["token.value"].exists)
        app.buttons["token.done"].tap()
        dialogButton(app, id: "token.discard.cancel", label: "Keep Open").tap()
        XCTAssertTrue(any["token.surface"].exists)
        app.buttons["token.copy"].tap()
        app.buttons["token.done"].tap()
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 4))
        XCTAssertFalse(any["token.surface"].exists)
        #if os(macOS)
        reveal(any["account.billing.manage"], in: app)
        XCTAssertTrue(any["account.billing.manage"].exists, "Hosted billing controls are missing")
        #else
        revealPresence(any["account.billing.readonly"], in: app)
        XCTAssertTrue(any["account.billing.readonly"].exists, "iPhone/iPad billing must remain read-only")
        XCTAssertFalse(any["account.billing.manage"].exists)
        #endif
        capture(app, "account-hosted-billing")
        reveal(any["account.server.change"], in: app)
        app.buttons["account.server.change"].tap()
        XCTAssertTrue(any["server.url.surface"].waitForExistence(timeout: 4))
        app.buttons["server.url.cancel"].tap()
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 4))
        app.buttons["account.done"].tap()
        XCTAssertTrue(any["worktrees.list"].waitForExistence(timeout: 4))
        app.terminate()
        app = launchAccount()
        any = app.descendants(matching: .any)
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 8))
        revealFully(any["account.token.create"], in: app)
        any["account.token.create"].firstMatch.tap()
        XCTAssertTrue(any["token.surface"].waitForExistence(timeout: 4))
        app.buttons["token.done"].tap()
        dialogButton(app, id: "token.discard.confirm", label: "Discard Token").tap()
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 4))
        XCTAssertFalse(any["token.surface"].exists)
    }

    func testAccountSelfHostedBillingIsExplicit() {
        let app = launchAccount()
        let selfHosted = app.descendants(matching: .any)["account.billing.selfhosted"]
        XCTAssertTrue(app.descendants(matching: .any)["account.surface"].waitForExistence(timeout: 8))
        revealPresence(selfHosted, in: app)
        XCTAssertTrue(selfHosted.exists)
    }

    func testViewerOrganizationCannotManageHostedBilling() {
        let app = launchAccount(["-ui-test-billing-hosted", "-ui-test-org-viewer"])
        let any = app.descendants(matching: .any)
        let identity = any["account.billing.organization"]
        revealPresence(identity, in: app)
        XCTAssertTrue(identity.waitForExistence(timeout: 4))
        XCTAssertTrue(identity.label.contains("Research Collective") || identity.value as? String == "Research Collective")
        XCTAssertTrue(any["account.billing.admin.required"].exists)
        XCTAssertTrue(any["account.billing.manage.disabled"].exists)
        XCTAssertFalse(any["account.billing.manage.disabled"].isEnabled)
    }

    func testBillingCapabilityFailureIsNotSelfHosted() {
        let app = launchAccount(["-ui-test-billing-unavailable"])
        let any = app.descendants(matching: .any)
        let unavailable = any["account.billing.unavailable"]
        revealPresence(unavailable, in: app)
        XCTAssertTrue(unavailable.waitForExistence(timeout: 4))
        XCTAssertFalse(any["account.billing.selfhosted"].exists)
        XCTAssertTrue(any["account.billing.retry"].exists)
    }

    func testTokenRevocationCanCancelAndConfirm() {
        let app = launchAccount()
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 8))
        let revoke = any["account.token.ui-token.revoke"].firstMatch
        revealFully(revoke, in: app)
        XCTAssertTrue(revoke.waitForExistence(timeout: 3))
        revoke.tap()
        dialogButton(app, id: "account.token.revoke.cancel", label: "Cancel").tap()
        XCTAssertTrue(revoke.waitForExistence(timeout: 3))
        revoke.tap()
        dialogButton(app, id: "account.token.revoke.confirm", label: "Revoke").tap()
        XCTAssertTrue(any["account.tokens.empty"].waitForExistence(timeout: 4))
    }

    func testLogoutCanCancelAndConfirm() {
        let app = launchAccount()
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 8))
        reveal(any["account.logout"], in: app)
        app.buttons["account.logout"].tap()
        dialogButton(app, id: "account.logout.cancel", label: "Cancel").tap()
        XCTAssertTrue(any["account.surface"].exists)
        app.buttons["account.logout"].tap()
        dialogButton(app, id: "account.logout.confirm", label: "Log Out").tap()
        XCTAssertTrue(any["auth.surface"].waitForExistence(timeout: 5))
    }
}
