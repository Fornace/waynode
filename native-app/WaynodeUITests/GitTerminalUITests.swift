import XCTest

@MainActor
final class GitTerminalUITests: WaynodeUITestCase {
    func testGitFileDiffCommitAndBranchSwitch() {
        let app = launchFixture(["-ui-test-git", "-ui-test-git-error"])
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["git.surface"].waitForExistence(timeout: 8))
        XCTAssertTrue(any["git.file.Sources/Waynode.swift.review"].waitForExistence(timeout: 4))
        activate(any["git.file.Sources/Waynode.swift.review"])
        #if targetEnvironment(macCatalyst)
        let inlineDiff = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Added line in Sources/Waynode.swift")
        ).firstMatch
        XCTAssertTrue(inlineDiff.waitForExistence(timeout: 4))
        #else
        XCTAssertTrue(any["git.diff.surface"].waitForExistence(timeout: 4))
        capture(app, "git-file-diff")
        app.buttons["git.diff.done"].tap()
        XCTAssertTrue(any["git.surface"].waitForExistence(timeout: 3))
        #endif
        activate(any["git.file.Sources/Waynode.swift.select"])
        XCTAssertTrue(app.buttons["git.commit.open"].isEnabled)
        activate(app.buttons["git.commit.open"])
        XCTAssertTrue(any["git.commit.surface"].waitForExistence(timeout: 4))
        activate(app.buttons["git.commit.cancel"])
        XCTAssertFalse(any["git.commit.surface"].waitForExistence(timeout: 3))
        activate(app.buttons["git.commit.open"])
        let message = any["git.commit.message"]
        message.tap()
        message.typeText("Polish every interaction")
        capture(app, "git-commit")
        activate(app.buttons["git.commit.confirm"])
        XCTAssertFalse(any["git.commit.surface"].waitForExistence(timeout: 3))
        activate(any["git.branches.disclosure"].firstMatch)
        activate(app.buttons["git.branch.review/ui-polish"])
        activateDialogAction(app, id: "git.branch.switch.cancel", label: "Cancel", cancellation: true)
        activate(app.buttons["git.branch.review/ui-polish"])
        activateDialogAction(app, id: "git.branch.switch.confirm", label: "Switch to review/ui-polish")
        let summary = any["git.branch.summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 3))
        XCTAssertEqual(summary.value as? String, "review/ui-polish")
        #if !targetEnvironment(macCatalyst)
        activate(app.buttons["git.pull"])
        XCTAssertTrue(app.alerts["Git action failed"].waitForExistence(timeout: 4))
        activateDialogAction(app, id: "git.error.dismiss", label: "OK")
        XCTAssertFalse(app.alerts["Git action failed"].waitForExistence(timeout: 3))
        #endif
    }

    func testTrackedFileDiscardRequiresConfirmation() {
        let app = launchFixture(["-ui-test-git"])
        let any = app.descendants(matching: .any)
        let discard = any["git.file.Sources/Waynode.swift.discard"]
        XCTAssertTrue(discard.waitForExistence(timeout: 8))
        XCTAssertFalse(any["git.file.README.md.discard"].exists, "Added files must not offer ambiguous discard")
        XCTAssertFalse(any["git.file.scratch-notes.txt.discard"].exists, "Untracked files must never offer discard")

        activate(discard)
        activateDialogAction(app, id: "git.discard.cancel", label: "Keep Changes", cancellation: true)
        XCTAssertTrue(discard.waitForExistence(timeout: 3))
        activate(discard)
        activateDialogAction(app, id: "git.discard.confirm", label: "Discard Changes")
        XCTAssertFalse(discard.waitForExistence(timeout: 4))
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
