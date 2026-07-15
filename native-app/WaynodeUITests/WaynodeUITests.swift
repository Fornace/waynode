import XCTest

@MainActor
final class WaynodeUITests: WaynodeUITestCase {
    func testCoreWorkbenchPassesFocusedAccessibilityAudit() throws {
        let app = launchFixture()
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["worktrees.list"].waitForExistence(timeout: 8))

        #if targetEnvironment(macCatalyst)
        let audits: XCUIAccessibilityAuditType = [
            .sufficientElementDescription, .hitRegion, .action, .parentChild,
        ]
        #else
        let audits: XCUIAccessibilityAuditType = [
            .sufficientElementDescription, .hitRegion, .trait,
        ]
        #endif
        try app.performAccessibilityAudit(for: audits)

        if !any["sessions.list"].exists {
            any["worktree.row.ui-space"].firstMatch.tap()
            XCTAssertTrue(any["sessions.list"].waitForExistence(timeout: 4))
            try app.performAccessibilityAudit(for: audits)
        }
        if !any["session.detail"].exists {
            any["session.row.ui-session"].firstMatch.tap()
            XCTAssertTrue(any["session.detail"].waitForExistence(timeout: 4))
        }
        try app.performAccessibilityAudit(for: audits)
    }

    func testLongContentAtAccessibilityTextSizeKeepsCoreActionsAvailable() {
        let app = launchAccessibilityFixture([
            "-ui-test-long-content", "-space", "ui-space",
        ])
        let any = app.descendants(matching: .any)
        let session = any["session.row.ui-session"].firstMatch
        XCTAssertTrue(session.waitForExistence(timeout: 8))
        XCTAssertTrue(session.label.contains("Review every reconnecting"))

        let newSession = app.buttons["session.new"].firstMatch
        XCTAssertTrue(newSession.waitForExistence(timeout: 4))
        XCTAssertTrue(newSession.isHittable)
        newSession.tap()

        XCTAssertTrue(any["session.new.surface"].waitForExistence(timeout: 4))
        let title = app.textFields["session.new.title"].firstMatch
        XCTAssertTrue(title.isHittable)
        title.tap()
        title.typeText("Investigate an unusually long production incident title without losing the primary actions")
        XCTAssertTrue(app.buttons["session.new.cancel"].isHittable)
        XCTAssertTrue(app.buttons["session.new.create"].isHittable)
    }

    func testActiveRunKeepsStopAvailableWhileOfferingQueue() {
        let app = launchFixture(["-ui-test-chat-active"])
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["composer.stop"].waitForExistence(timeout: 8))
        XCTAssertFalse(any["composer.queue"].exists)
        let input = any["composer.input"]
        input.tap()
        input.typeText("Follow up after this run")
        XCTAssertTrue(any["composer.queue"].waitForExistence(timeout: 3))
        XCTAssertTrue(any["composer.stop"].exists)
        XCTAssertTrue(any["chat.submission.running"].exists)
    }

    func testHistoryFailureBlocksFalseEmptyStateAndOffersRetry() {
        let app = launchFixture(["-ui-test-chat-history-failure"])
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["chat.history.failure"].waitForExistence(timeout: 8))
        XCTAssertTrue(any["chat.history.retry"].exists)
        XCTAssertFalse(any["chat.empty"].exists)
    }

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

    func testCloneUsesSelectedViewerOrganization() {
        let app = launchFixture(["-ui-test-org-viewer"])
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["worktrees.list"].waitForExistence(timeout: 8))
        app.buttons["worktree.clone"].firstMatch.tap()
        let summary = any["clone.organization.summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 4))
        XCTAssertTrue(summary.label.contains("Research Collective"))
        XCTAssertTrue(summary.label.contains("Viewer"))
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
}
