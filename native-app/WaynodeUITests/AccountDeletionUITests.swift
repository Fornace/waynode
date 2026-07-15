import XCTest

@MainActor
final class AccountDeletionUITests: XCTestCase {
    func testDeletionRequiresTypedConfirmationAndClearsAuthOnSuccess() {
        let app = launchAccount()
        let any = app.descendants(matching: .any)
        reveal(any["account.delete.request"], in: app)
        app.buttons["account.delete.request"].tap()
        XCTAssertTrue(any["account.delete.surface"].waitForExistence(timeout: 4))
        XCTAssertFalse(app.buttons["account.delete.confirm"].isEnabled)

        reveal(any["account.delete.confirmation"], in: app)
        let confirmation = app.textFields["account.delete.confirmation"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 4))
        confirmation.tap()
        confirmation.typeText("DELETE")
        let confirm = app.buttons["account.delete.confirm"]
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: confirm)
        waitForExpectations(timeout: 3)
        confirm.tap()
        XCTAssertTrue(any["auth.surface"].waitForExistence(timeout: 5))
    }

    func testDeletionFailurePreservesAccountAndCanBeCancelled() {
        let app = launchAccount(["-ui-test-account-deletion-failure"])
        let any = app.descendants(matching: .any)
        reveal(any["account.delete.request"], in: app)
        app.buttons["account.delete.request"].tap()
        XCTAssertTrue(any["account.delete.surface"].waitForExistence(timeout: 4))
        reveal(any["account.delete.confirmation"], in: app)
        let confirmation = app.textFields["account.delete.confirmation"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 4))
        confirmation.tap()
        confirmation.typeText("DELETE")
        let confirm = app.buttons["account.delete.confirm"]
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: confirm)
        waitForExpectations(timeout: 3)
        confirm.tap()

        let deletionError = any["account.delete.error"]
        revealPresence(deletionError, in: app)
        XCTAssertTrue(deletionError.waitForExistence(timeout: 4))
        XCTAssertFalse(any["auth.surface"].exists)
        app.buttons["account.delete.cancel"].tap()
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 4))
    }

    private func launchAccount(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-test-auth", "-server-url", "https://waynode.fornace.net"] + extra
        app.launchEnvironment["WAYNODE_UI_TEST_AUTH"] = "1"
        app.launch()
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["worktrees.list"].waitForExistence(timeout: 8))
        app.buttons["account.open"].firstMatch.tap()
        XCTAssertTrue(any["account.surface"].waitForExistence(timeout: 4))
        return app
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<7 where !element.exists || !element.isHittable { app.swipeUp() }
    }

    private func revealPresence(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<7 {
            if element.exists, element.frame.intersects(app.windows.firstMatch.frame) { return }
            app.swipeUp()
        }
    }
}
