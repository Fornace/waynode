import XCTest
import UIKit

@MainActor
final class IPadResponsiveUITests: WaynodeUITestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
    }

    func testRegularWidthWorkbenchSurvivesPortraitAndLandscape() {
        let app = launchFixture()
        let any = app.descendants(matching: .any)
        let worktrees = any["worktrees.list"].firstMatch
        let sessions = any["sessions.list"].firstMatch
        let detail = any["session.detail"].firstMatch

        XCTAssertTrue(worktrees.waitForExistence(timeout: 8))
        XCTAssertTrue(sessions.waitForExistence(timeout: 4))
        XCTAssertTrue(detail.waitForExistence(timeout: 4))
        assertInsideWindow(worktrees, app: app)
        assertInsideWindow(sessions, app: app)
        assertInsideWindow(detail, app: app)

        let archived = any["session.row.ui-archived"].firstMatch
        XCTAssertTrue(archived.waitForExistence(timeout: 4))
        archived.tap()
        expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: archived)
        waitForExpectations(timeout: 4)

        rotate(.landscapeLeft, app: app)

        XCTAssertTrue(worktrees.exists)
        XCTAssertTrue(sessions.exists)
        XCTAssertTrue(detail.exists)
        XCTAssertTrue(archived.isSelected)
        assertInsideWindow(worktrees, app: app)
        assertInsideWindow(sessions, app: app)
        assertInsideWindow(detail, app: app)
        XCTAssertTrue(app.buttons["account.open"].firstMatch.isHittable)
        XCTAssertTrue(app.buttons["session.new"].firstMatch.isHittable)
    }

    func testNewSessionSheetKeepsKeyboardAndActionsReachable() {
        let app = launchFixture()
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["worktrees.list"].waitForExistence(timeout: 8))

        let newSession = app.buttons["session.new"].firstMatch
        XCTAssertTrue(newSession.waitForExistence(timeout: 4))
        XCTAssertTrue(newSession.isHittable)
        newSession.tap()

        let surface = any["session.new.surface"].firstMatch
        let title = app.textFields["session.new.title"]
        let cancel = app.buttons["session.new.cancel"]
        let create = app.buttons["session.new.create"]
        XCTAssertTrue(surface.waitForExistence(timeout: 4))
        XCTAssertTrue(title.waitForExistence(timeout: 4))
        title.tap()
        title.typeText("Review every long account and billing label")
        XCTAssertTrue((title.value as? String)?.contains("billing label") == true)

        assertInsideWindow(surface, app: app)
        assertInsideWindow(title, app: app)
        assertInsideWindow(cancel, app: app)
        assertInsideWindow(create, app: app)
        XCTAssertTrue(cancel.isHittable)
        XCTAssertTrue(create.isHittable)

        rotate(.landscapeRight, app: app)

        XCTAssertTrue(surface.exists)
        XCTAssertTrue((title.value as? String)?.contains("billing label") == true)
        assertInsideWindow(title, app: app)
        assertInsideWindow(cancel, app: app)
        assertInsideWindow(create, app: app)
        XCTAssertTrue(cancel.isHittable)
        XCTAssertTrue(create.isHittable)
        cancel.tap()
        XCTAssertFalse(surface.waitForExistence(timeout: 3))
        XCTAssertTrue(any["session.detail"].waitForExistence(timeout: 4))
    }

    func testGitReviewUsesRegularWidthForInlineDiff() {
        let app = launchFixture(["-ui-test-git"])
        let any = app.descendants(matching: .any)
        let wide = any["git.layout.wide"]
        XCTAssertTrue(wide.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Choose a File"].firstMatch.waitForExistence(timeout: 4))

        let review = any["git.file.Sources/Waynode.swift.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 4))
        review.tap()
        let inlineDiff = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Added line in Sources/Waynode.swift")
        ).firstMatch
        XCTAssertTrue(inlineDiff.waitForExistence(timeout: 4))
        XCTAssertFalse(any["git.diff.surface"].exists)
        assertInsideWindow(inlineDiff, app: app)

        rotate(.landscapeLeft, app: app)
        XCTAssertTrue(any["git.layout.wide"].exists)
        XCTAssertTrue(inlineDiff.exists)
        assertInsideWindow(inlineDiff, app: app)
    }

    private func rotate(_ orientation: UIDeviceOrientation, app: XCUIApplication) {
        XCUIDevice.shared.orientation = orientation
        let landscape = NSPredicate { object, _ in
            guard let application = object as? XCUIApplication else { return false }
            return application.frame.width > application.frame.height
        }
        expectation(for: landscape, evaluatedWith: app)
        waitForExpectations(timeout: 5)
    }

    private func assertInsideWindow(
        _ element: XCUIElement,
        app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(element.waitForExistence(timeout: 4), "Missing \(element)", file: file, line: line)
        let frame = element.frame
        let windowFrame = app.windows.firstMatch.frame
        XCTAssertFalse(frame.isEmpty, "Element has an empty frame", file: file, line: line)
        XCTAssertTrue(
            windowFrame.insetBy(dx: -1, dy: -1).contains(frame),
            "Element frame \(frame) escapes window \(windowFrame)",
            file: file,
            line: line
        )
    }
}
