import XCTest

@MainActor
final class WaynodeUITests: XCTestCase {
    func testSignedOutAuthAndServerConfiguration() {
        let app = launch(["-ui-test", "-server-url", "https://waynode.fornace.net"])
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["auth.surface"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["auth.github"].exists)
        XCTAssertTrue(app.buttons["auth.server.change"].exists)
        capture(app, "signed-out-auth")

        app.buttons["auth.server.change"].tap()
        XCTAssertTrue(any["server.url.surface"].waitForExistence(timeout: 4))
        let field = app.textFields["server.url.field"]
        XCTAssertTrue(field.isHittable)
        XCTAssertEqual(field.value as? String, "https://waynode.fornace.net")
        XCTAssertTrue(app.buttons["server.url.save"].exists)
        capture(app, "server-configuration")
        app.buttons["server.url.cancel"].tap()
        XCTAssertTrue(any["auth.surface"].waitForExistence(timeout: 4))
    }

    func testCloneCreatesAWorktreeAndDismisses() {
        let app = launchFixture()
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["worktrees.list"].waitForExistence(timeout: 8))
        app.buttons["worktree.clone"].firstMatch.tap()
        XCTAssertTrue(any["clone.surface"].waitForExistence(timeout: 4))
        XCTAssertFalse(app.buttons["clone.start"].isEnabled)

        app.textFields["clone.repository.url"].tap()
        app.textFields["clone.repository.url"].typeText("https://github.com/example/design-system.git")
        app.textFields["clone.branch"].tap()
        app.textFields["clone.branch"].typeText("release/27")
        XCTAssertTrue(app.buttons["clone.start"].isEnabled)
        capture(app, "clone-ready")
        app.buttons["clone.start"].tap()

        XCTAssertTrue(any["worktree.row.ui-clone-1"].waitForExistence(timeout: 6))
        XCTAssertFalse(any["clone.surface"].exists)
    }

    func testWorktreeDeletionCanCancelAndConfirm() {
        let app = launchFixture()
        let any = app.descendants(matching: .any)
        let row = any["worktree.row.ui-space"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        invokeRowDelete(app, row: row, buttonID: "worktree.ui-space.delete")
        dialogButton(app, id: "worktree.delete.cancel", label: "Cancel").tap()
        XCTAssertTrue(row.exists)

        invokeRowDelete(app, row: row, buttonID: "worktree.ui-space.delete")
        dialogButton(app, id: "worktree.delete.confirm", label: "Delete").tap()
        XCTAssertFalse(row.waitForExistence(timeout: 4))
    }

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
        XCTAssertTrue(any["account.tokens.disclosure"].waitForExistence(timeout: 4))

        app.buttons["account.token.create"].tap()
        XCTAssertTrue(any["token.surface"].waitForExistence(timeout: 4))
        XCTAssertTrue(any["token.value"].exists)
        app.buttons["token.done"].tap()
        dialogButton(app, id: "token.discard.cancel", label: "Keep Open").tap()
        XCTAssertTrue(any["token.surface"].exists)
        app.buttons["token.copy"].tap()
        app.buttons["token.done"].tap()
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 4))
        XCTAssertFalse(any["token.surface"].exists)

        reveal(any["account.billing.manage"], in: app)
        XCTAssertTrue(any["account.billing.manage"].exists, "Hosted billing controls are missing")
        capture(app, "account-hosted-billing")

        reveal(any["account.server.change"], in: app)
        app.buttons["account.server.change"].tap()
        XCTAssertTrue(any["server.url.surface"].waitForExistence(timeout: 4))
        app.buttons["server.url.cancel"].tap()
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 4))

        app.terminate()
        app = launchAccount()
        any = app.descendants(matching: .any)
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 8))
        app.buttons["account.token.create"].tap()
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
        reveal(selfHosted, in: app)
        XCTAssertTrue(selfHosted.exists)
    }

    func testTokenRevocationCanCancelAndConfirm() {
        let app = launchAccount()
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 8))
        any["account.tokens.disclosure"].firstMatch.tap()
        app.buttons["account.token.ui-token.revoke"].tap()
        dialogButton(app, id: "account.token.revoke.cancel", label: "Cancel").tap()
        XCTAssertTrue(any["account.token.ui-token.revoke"].waitForExistence(timeout: 3))

        app.buttons["account.token.ui-token.revoke"].tap()
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

    func testNewSessionSupportsCancelAndCreation() {
        var app = launchFixture(["-ui-test-new-session"])
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["session.new.surface"].waitForExistence(timeout: 8))
        app.buttons["session.new.cancel"].tap()
        XCTAssertFalse(any["session.new.surface"].waitForExistence(timeout: 2))

        app.terminate()
        app = launchFixture(["-ui-test-new-session"])
        XCTAssertTrue(app.descendants(matching: .any)["session.new.surface"].waitForExistence(timeout: 8))
        let title = app.textFields["session.new.title"]
        title.tap()
        title.typeText("Audit every popup")
        capture(app, "new-session")
        app.buttons["session.new.create"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["session.new.created"].waitForExistence(timeout: 5))
    }

    func testSessionListDeletionCanCancelAndConfirm() {
        let app = launchFixture(["-space", "ui-space"])
        let any = app.descendants(matching: .any)
        let row = any["session.row.ui-session"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        invokeRowDelete(app, row: row, buttonID: "session.ui-session.delete")
        dialogButton(app, id: "session.delete.cancel", label: "Cancel").tap()
        XCTAssertTrue(row.exists)

        invokeRowDelete(app, row: row, buttonID: "session.ui-session.delete")
        dialogButton(app, id: "session.delete.confirm", label: "Delete").tap()
        XCTAssertFalse(row.waitForExistence(timeout: 4))
    }

    func testSessionSettingsSupportsCloseAndDeleteConfirmation() {
        var app = launchFixture(["-ui-test-settings"])
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["session.settings"].waitForExistence(timeout: 8))
        XCTAssertTrue(any["session.settings.model"].waitForExistence(timeout: 4))
        app.buttons["session.delete.request"].tap()
        dialogButton(app, id: "session.delete.cancel", label: "Cancel").tap()
        XCTAssertTrue(any["session.settings"].exists)
        app.buttons["session.settings.close"].tap()
        XCTAssertTrue(any["session.settings.result"].waitForExistence(timeout: 4))

        app.terminate()
        app = launchFixture(["-ui-test-settings"])
        XCTAssertTrue(app.descendants(matching: .any)["session.settings"].waitForExistence(timeout: 8))
        app.buttons["session.delete.request"].tap()
        dialogButton(app, id: "session.delete.confirm", label: "Delete").tap()
        let result = app.descendants(matching: .any)["session.settings.result"]
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        XCTAssertEqual(result.label, "Session deleted")
    }

    func testGitFileDiffCommitAndBranchSwitch() {
        let app = launchFixture(["-ui-test-git", "-ui-test-git-error"])
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["git.surface"].waitForExistence(timeout: 8))
        XCTAssertTrue(any["git.file.Sources/Waynode.swift.review"].waitForExistence(timeout: 4))

        any["git.file.Sources/Waynode.swift.review"].tap()
        XCTAssertTrue(any["git.diff.surface"].waitForExistence(timeout: 4))
        capture(app, "git-file-diff")
        app.buttons["git.diff.done"].tap()
        XCTAssertTrue(any["git.surface"].waitForExistence(timeout: 3))

        any["git.file.Sources/Waynode.swift.select"].tap()
        XCTAssertTrue(app.buttons["git.commit.open"].isEnabled)
        app.buttons["git.commit.open"].tap()
        XCTAssertTrue(any["git.commit.surface"].waitForExistence(timeout: 4))
        app.buttons["git.commit.cancel"].tap()
        XCTAssertFalse(any["git.commit.surface"].waitForExistence(timeout: 3))
        app.buttons["git.commit.open"].tap()
        XCTAssertTrue(any["git.commit.surface"].waitForExistence(timeout: 4))
        let message = any["git.commit.message"]
        message.tap()
        message.typeText("Polish every interaction")
        capture(app, "git-commit")
        app.buttons["git.commit.confirm"].tap()
        XCTAssertFalse(any["git.commit.surface"].waitForExistence(timeout: 3))

        any["git.branches.disclosure"].firstMatch.tap()
        app.buttons["git.branch.review/ui-polish"].tap()
        dialogButton(app, id: "git.branch.switch.cancel", label: "Cancel").tap()
        app.buttons["git.branch.review/ui-polish"].tap()
        dialogButton(app, id: "git.branch.switch.confirm", label: "Switch to review/ui-polish").tap()
        let summary = any["git.branch.summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 3))
        XCTAssertEqual(summary.value as? String, "review/ui-polish")

        app.buttons["git.pull"].tap()
        XCTAssertTrue(app.alerts["Git action failed"].waitForExistence(timeout: 4))
        dialogButton(app, id: "git.error.dismiss", label: "OK").tap()
        XCTAssertFalse(app.alerts["Git action failed"].waitForExistence(timeout: 3))
    }

    func testGitSheetOpensAndClosesFromSession() {
        let app = launchFixture(["-space", "ui-space", "-session", "ui-session"])
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["session.detail"].waitForExistence(timeout: 8))
        #if targetEnvironment(macCatalyst)
        app.buttons["git.open"].firstMatch.tap()
        #else
        any["session.more"].firstMatch.tap()
        app.buttons["Git Worktree"].firstMatch.tap()
        #endif
        XCTAssertTrue(any["git.surface"].waitForExistence(timeout: 4))
        app.buttons["git.done"].tap()
        XCTAssertTrue(any["session.detail"].waitForExistence(timeout: 4))
        XCTAssertFalse(any["git.surface"].exists)
    }

    func testTerminalFailureAndExitStatesAreRecoverable() {
        var app = launchFixture(["-ui-test-terminal", "-ui-test-terminal-error"])
        var any = app.descendants(matching: .any)
        XCTAssertTrue(any["terminal.failure"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["terminal.reconnect"].exists)
        capture(app, "terminal-failure")

        app.terminate()
        app = launchFixture(["-ui-test-terminal", "-ui-test-terminal-exited"])
        any = app.descendants(matching: .any)
        XCTAssertTrue(any["terminal.exited"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["terminal.reconnect"].exists)
        capture(app, "terminal-exited")
    }

    private func launchFixture(_ extra: [String] = []) -> XCUIApplication {
        launch(["-ui-test-auth", "-server-url", "https://waynode.fornace.net"] + extra)
    }

    private func launchAccount(_ extra: [String] = []) -> XCUIApplication {
        let app = launchFixture(extra)
        let worktrees = app.descendants(matching: .any)["worktrees.list"]
        XCTAssertTrue(worktrees.waitForExistence(timeout: 8))
        app.buttons["account.open"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["account.surface"].waitForExistence(timeout: 4))
        return app
    }

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = arguments.filter { $0 != "-ui-test-billing-hosted" }
        if arguments.contains("-ui-test-auth") {
            app.launchEnvironment["WAYNODE_UI_TEST_AUTH"] = "1"
        }
        if arguments.contains("-ui-test-billing-hosted") {
            app.launchEnvironment["WAYNODE_UI_TEST_BILLING_HOSTED"] = "1"
        }
        app.launch()
        return app
    }

    private func dialogButton(_ app: XCUIApplication, id: String, label: String) -> XCUIElement {
        let identified = app.buttons[id].firstMatch
        if identified.waitForExistence(timeout: 4) { return identified }
        let visible = app.buttons[label].firstMatch
        XCTAssertTrue(visible.waitForExistence(timeout: 2), "Missing dialog action \(label)")
        return visible
    }

    private func invokeRowDelete(_ app: XCUIApplication, row: XCUIElement, buttonID: String) {
        #if targetEnvironment(macCatalyst)
        row.rightClick()
        #else
        row.swipeLeft()
        #endif
        let delete = app.buttons[buttonID].firstMatch
        XCTAssertTrue(delete.waitForExistence(timeout: 3), "Missing row delete action \(buttonID)")
        delete.tap()
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<5 where !element.exists || !element.isHittable { app.swipeUp() }
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
