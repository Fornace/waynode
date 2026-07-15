import XCTest

@MainActor
class WaynodeUITestCase: XCTestCase {
    func launchFixture(_ extra: [String] = []) -> XCUIApplication {
        launch(["-ui-test-auth", "-server-url", "https://waynode.fornace.net"] + extra)
    }

    func launchAccessibilityFixture(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-test-auth", "-server-url", "https://waynode.fornace.net"] + extra
        app.launchEnvironment["WAYNODE_UI_TEST_AUTH"] = "1"
        app.launchEnvironment["WAYNODE_UI_TEST_DYNAMIC_TYPE"] = "accessibility3"
        app.launch()
        return app
    }

    func launchAccount(_ extra: [String] = []) -> XCUIApplication {
        let app = launchFixture(extra)
        let worktrees = app.descendants(matching: .any)["worktrees.list"]
        XCTAssertTrue(worktrees.waitForExistence(timeout: 8))
        app.buttons["account.open"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["account.surface"].waitForExistence(timeout: 4))
        return app
    }

    func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = arguments.filter { $0 != "-ui-test-billing-hosted" }
        if arguments.contains("-ui-test-auth") { app.launchEnvironment["WAYNODE_UI_TEST_AUTH"] = "1" }
        if arguments.contains("-ui-test-billing-hosted") { app.launchEnvironment["WAYNODE_UI_TEST_BILLING_HOSTED"] = "1" }
        app.launch()
        return app
    }

    func dialogButton(_ app: XCUIApplication, id: String, label: String) -> XCUIElement {
        let identified = app.buttons[id].firstMatch
        if identified.waitForExistence(timeout: 4) { return identified }
        let visible = app.buttons[label].firstMatch
        XCTAssertTrue(visible.waitForExistence(timeout: 2), "Missing dialog action \(label)")
        return visible
    }

    func invokeRowDelete(_ app: XCUIApplication, row: XCUIElement, buttonID: String) {
        #if targetEnvironment(macCatalyst)
        row.rightClick()
        #else
        row.swipeLeft()
        #endif
        let delete = app.buttons[buttonID].firstMatch
        if !delete.waitForExistence(timeout: 2) { row.press(forDuration: 0.8) }
        XCTAssertTrue(delete.waitForExistence(timeout: 3), "Missing row delete action \(buttonID)")
        delete.tap()
    }

    func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        let match = element.firstMatch
        for _ in 0..<5 where !match.exists || !match.isHittable { app.swipeUp() }
    }

    func revealPresence(_ element: XCUIElement, in app: XCUIApplication) {
        let match = element.firstMatch
        for _ in 0..<5 {
            if match.exists, match.frame.intersects(app.windows.firstMatch.frame) { return }
            app.swipeUp()
        }
    }

    func revealFully(_ element: XCUIElement, in app: XCUIApplication) {
        let match = element.firstMatch
        for _ in 0..<6 {
            if match.exists {
                let usableFrame = app.windows.firstMatch.frame.insetBy(dx: 8, dy: 72)
                if !match.frame.isEmpty, usableFrame.contains(match.frame) { return }
            }
            app.swipeUp()
        }
        XCTAssertTrue(match.exists, "Expected the control to remain available after scrolling")
    }

    func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
