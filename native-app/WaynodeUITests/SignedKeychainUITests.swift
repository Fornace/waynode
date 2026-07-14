import XCTest

@MainActor
final class SignedKeychainUITests: XCTestCase {
    func testSignedAppCanWriteReadAndDeleteKeychainItem() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-test-keychain"]
        app.terminate()
        app.launch()

        let elements = app.descendants(matching: .any)
        XCTAssertTrue(elements["keychain.smoke.surface"].waitForExistence(timeout: 8))
        XCTAssertTrue(
            elements["keychain.smoke.passed"].waitForExistence(timeout: 8),
            "Signed runtime keychain round-trip failed. AX tree:\n\(app.debugDescription)"
        )
    }
}
