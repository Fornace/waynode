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
        let alert = app.alerts.firstMatch
        if alert.waitForExistence(timeout: 2) {
            let identifiedAlertButton = alert.buttons[id].firstMatch
            if identifiedAlertButton.waitForExistence(timeout: 1) { return identifiedAlertButton }
            let labelledAlertButton = alert.buttons[label].firstMatch
            if labelledAlertButton.waitForExistence(timeout: 1) { return labelledAlertButton }
        }
        if let identified = visibleWindowButton(app.buttons.matching(identifier: id), in: app, timeout: 4) {
            return identified
        }
        let labelledButtons = app.buttons.matching(NSPredicate(format: "label == %@", label))
        if let labelled = visibleWindowButton(labelledButtons, in: app, timeout: 2) {
            return labelled
        }
        XCTFail("Missing dialog action \(label)")
        return app.buttons[label].firstMatch
    }

    private func visibleWindowButton(
        _ query: XCUIElementQuery,
        in app: XCUIApplication,
        timeout: TimeInterval
    ) -> XCUIElement? {
        guard query.firstMatch.waitForExistence(timeout: timeout) else { return nil }
        let windowFrame = app.windows.firstMatch.frame
        return query.allElementsBoundByIndex.first { element in
            element.exists && element.isHittable && !element.frame.isEmpty
                && element.frame.intersects(windowFrame)
        }
    }

    func activate(_ element: XCUIElement) {
        #if targetEnvironment(macCatalyst)
        element.click()
        #else
        element.tap()
        #endif
    }

    func activateDialogAction(
        _ app: XCUIApplication,
        id: String,
        label: String,
        cancellation: Bool = false
    ) {
        #if targetEnvironment(macCatalyst)
        // Catalyst mirrors native alert actions into a Touch Bar subtree.
        // XCTest rejects `click()` there, while `tap()` exercises that action.
        let action = app.buttons[label].firstMatch
        XCTAssertTrue(action.waitForExistence(timeout: 4), "Missing dialog action \(label)")
        action.tap()
        #else
        dialogButton(app, id: id, label: label).tap()
        #endif
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
