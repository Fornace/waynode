import XCTest

@MainActor
final class GitTerminalUITests: WaynodeUITestCase {
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

    func testDiffFailureShowsRetryWithoutInventingDiffLines() {
        let app = launchFixture(["-ui-test-git", "-ui-test-git-diff-error"])
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["git.file.Sources/Waynode.swift.review"].waitForExistence(timeout: 8))
        any["git.file.Sources/Waynode.swift.review"].tap()
        XCTAssertTrue(any["git.diff.failure"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["git.diff.retry"].exists)
        assertNoFixtureDiffLines(in: app)
        app.buttons["git.diff.retry"].tap()
        XCTAssertTrue(any["git.diff.failure"].waitForExistence(timeout: 4))
        assertNoFixtureDiffLines(in: app)
    }

    func testConflictsBlockPullPushAndCommitWithRecoveryCopy() {
        let app = launchGitState("-ui-test-git-conflicted")
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["git.conflicts"].exists)
        assertSyncCopy(any, contains: "Resolve conflicted files")
        selectFixtureFile(in: any)
        XCTAssertFalse(app.buttons["git.pull"].isEnabled)
        XCTAssertFalse(app.buttons["git.push"].isEnabled)
        XCTAssertFalse(app.buttons["git.commit.open"].isEnabled)
    }

    func testDivergedBranchBlocksUnsafeSynchronization() {
        let app = launchGitState("-ui-test-git-diverged")
        let any = app.descendants(matching: .any)
        assertSyncCopy(any, contains: "merge or rebase strategy")
        XCTAssertFalse(app.buttons["git.pull"].isEnabled)
        XCTAssertFalse(app.buttons["git.push"].isEnabled)
    }

    func testDetachedHeadBlocksUnsafeSynchronization() {
        let app = launchGitState("-ui-test-git-detached")
        let any = app.descendants(matching: .any)
        assertSyncCopy(any, contains: "Check out a branch")
        XCTAssertFalse(app.buttons["git.pull"].isEnabled)
        XCTAssertFalse(app.buttons["git.push"].isEnabled)
    }

    func testNoUpstreamBlocksPullButKeepsRecoveryPushAvailable() {
        let app = launchGitState("-ui-test-git-no-upstream")
        let any = app.descendants(matching: .any)
        assertSyncCopy(any, contains: "Set an upstream")
        XCTAssertFalse(app.buttons["git.pull"].isEnabled)
        XCTAssertTrue(app.buttons["git.push"].isEnabled)
    }

    func testGitSheetOpensAndClosesFromSession() {
        let app = launchFixture(["-space", "ui-space", "-session", "ui-session"])
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["session.detail"].waitForExistence(timeout: 8))
        #if targetEnvironment(macCatalyst)
        app.buttons["git.open"].firstMatch.tap()
        #else
        any["session.more"].firstMatch.tap()
        app.buttons["git.open"].firstMatch.tap()
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
        XCTAssertTrue(app.buttons["terminal.failure.retry"].exists)
        XCTAssertFalse(app.buttons["terminal.exited.restart"].exists)
        capture(app, "terminal-failure")
        app.terminate()
        app = launchFixture(["-ui-test-terminal", "-ui-test-terminal-exited"])
        any = app.descendants(matching: .any)
        XCTAssertTrue(any["terminal.exited"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["terminal.exited.restart"].exists)
        XCTAssertFalse(app.buttons["terminal.reconnect"].exists)
        XCTAssertFalse(app.buttons["terminal.failure.retry"].exists)
        capture(app, "terminal-exited")
    }

    func testTerminalDoesNotClaimConnectedBeforeHandshake() {
        let app = launchFixture(["-ui-test-terminal", "-ui-test-terminal-connecting"])
        let status = app.descendants(matching: .any)["terminal.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 8))
        XCTAssertTrue(status.label.contains("Connecting"))
        XCTAssertFalse(status.label.contains("Connected"))
    }

    private func launchGitState(_ flag: String) -> XCUIApplication {
        let app = launchFixture(["-ui-test-git", flag])
        XCTAssertTrue(app.descendants(matching: .any)["git.surface"].waitForExistence(timeout: 8))
        return app
    }

    private func assertSyncCopy(_ any: XCUIElementQuery, contains expected: String) {
        let copy = any["git.sync.blocked"].firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 4))
        XCTAssertTrue(copy.label.contains(expected), "Missing recovery copy: \(expected)")
    }

    private func selectFixtureFile(in any: XCUIElementQuery) {
        let select = any["git.file.Sources/Waynode.swift.select"]
        XCTAssertTrue(select.waitForExistence(timeout: 4))
        select.tap()
    }

    private func assertNoFixtureDiffLines(in app: XCUIApplication) {
        let fake = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Added line")).firstMatch
        XCTAssertFalse(fake.exists, "Failure state rendered fixture diff content")
    }
}
