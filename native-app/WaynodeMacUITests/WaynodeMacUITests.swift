import XCTest

@MainActor
final class WaynodeMacUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = [
            "-ui-test-auth",
            "-server-url", "https://waynode.fornace.net",
        ]
        app.launchEnvironment["WAYNODE_UI_TEST_AUTH"] = "1"
        app.launch()
        app.activate()
        if !app.windows.firstMatch.waitForExistence(timeout: 2) {
            app.typeKey("n", modifierFlags: .command)
        }
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 4))
    }

    override func tearDownWithError() throws {
        app?.terminate()
        app = nil
    }

    func testOpensNativeWorkbenchWithSelectedSession() {
        XCTAssertTrue(element("worktrees.list").waitForExistence(timeout: 8))
        XCTAssertTrue(element("sessions.list").waitForExistence(timeout: 4))
        XCTAssertTrue(element("session.detail").waitForExistence(timeout: 4))
    }

    func testSettingsCommandsHaveDistinctOwnership() {
        XCTAssertTrue(element("session.detail").waitForExistence(timeout: 8))

        app.activate()
        app.typeKey(",", modifierFlags: .command)
        XCTAssertTrue(element("account.surface").waitForExistence(timeout: 4))
        XCTAssertFalse(element("session.settings").exists)

        app.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(waitUntilGone(element("account.surface")))

        app.typeKey(",", modifierFlags: [.command, .option])
        XCTAssertTrue(element("session.settings").waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["session.settings.close"].isHittable)
        app.buttons["session.settings.close"].tap()
        XCTAssertTrue(app.buttons["session.settings.open"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["session.settings.open"].isHittable)
    }

    func testCloneSheetHasVisibleCancelAndDismisses() {
        XCTAssertTrue(element("worktrees.list").waitForExistence(timeout: 8))
        app.activate()
        app.typeKey("o", modifierFlags: [.command, .shift])

        XCTAssertTrue(element("clone.surface").waitForExistence(timeout: 4))
        let cancel = app.buttons["clone.dismiss"].firstMatch
        XCTAssertTrue(cancel.isHittable)
        XCTAssertEqual(cancel.label, "Cancel")
        cancel.tap()
        XCTAssertTrue(element("session.detail").waitForExistence(timeout: 4))
        let settings = app.buttons["session.settings.open"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 4))
        XCTAssertTrue(settings.isHittable)
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func waitUntilGone(_ element: XCUIElement, timeout: TimeInterval = 3) -> Bool {
        element.waitForNonExistence(timeout: timeout)
    }
}
