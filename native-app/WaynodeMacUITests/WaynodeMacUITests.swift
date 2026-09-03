import XCTest

final class WaynodeMacUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testOpensNativeWorkbenchWithSelectedSession() throws {
        let app = try launchApp()
        XCTAssertTrue(element("worktrees.list", in: app).waitForExistence(timeout: 8))
        XCTAssertTrue(element("sessions.list", in: app).waitForExistence(timeout: 4))
        XCTAssertTrue(element("session.detail", in: app).waitForExistence(timeout: 4))
    }

    @MainActor
    func testSettingsCommandsHaveDistinctOwnership() throws {
        let app = try launchApp()
        XCTAssertTrue(element("session.detail", in: app).waitForExistence(timeout: 8))

        app.activate()
        app.typeKey(",", modifierFlags: .command)
        XCTAssertTrue(element("account.surface", in: app).waitForExistence(timeout: 4))
        XCTAssertFalse(element("session.settings", in: app).exists)

        app.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(waitUntilGone(element("account.surface", in: app)))

        app.typeKey(",", modifierFlags: [.command, .option])
        XCTAssertTrue(element("session.settings", in: app).waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["session.settings.close"].isHittable)
        app.buttons["session.settings.close"].tap()
        XCTAssertTrue(app.buttons["session.settings.open"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["session.settings.open"].isHittable)
    }

    @MainActor
    func testCloneSheetHasVisibleCancelAndDismisses() throws {
        let app = try launchApp()
        XCTAssertTrue(element("worktrees.list", in: app).waitForExistence(timeout: 8))
        app.activate()
        app.typeKey("o", modifierFlags: [.command, .shift])

        XCTAssertTrue(element("clone.surface", in: app).waitForExistence(timeout: 4))
        let cancel = app.buttons["clone.dismiss"].firstMatch
        XCTAssertTrue(cancel.isHittable)
        XCTAssertEqual(cancel.label, "Cancel")
        cancel.tap()
        XCTAssertTrue(element("session.detail", in: app).waitForExistence(timeout: 4))
        let settings = app.buttons["session.settings.open"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 4))
        XCTAssertTrue(settings.isHittable)
    }

    @MainActor
    private func launchApp() throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ui-test-auth",
            "-server-url", "https://waynode.fornace.net",
        ]
        app.launchEnvironment = ["WAYNODE_UI_TEST_AUTH": "1"]
        app.launch()
        app.activate()
        addTeardownBlock { @MainActor [app] in
            app.terminate()
        }
        if !app.windows.firstMatch.waitForExistence(timeout: 2) {
            app.typeKey("n", modifierFlags: .command)
        }
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 4))
        return app
    }

    @MainActor
    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    @MainActor
    private func waitUntilGone(_ element: XCUIElement, timeout: TimeInterval = 3) -> Bool {
        element.waitForNonExistence(timeout: timeout)
    }
}
