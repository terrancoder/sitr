import XCTest

/// End-to-end smoke test — the iOS analogue of tests/smoke/smoke.mjs.
///
/// One flow, because the app's state persists across tests in a run: it
/// walks onboarding when onboarding is showing (a fresh install, as in
/// CI) and otherwise starts from the home screen, then asserts the same
/// properties either way.
///
/// Three properties matter, and each guards something real:
///  1. Onboarding COMPLETES even though Safari cannot reload the blocker
///     in the simulator (and on a device before the user enables the
///     extension). Settings persist when the rules file is written; only
///     the "is it live" claim depends on Safari. This was a real bug.
///  2. With the blocker not enforcing, the app says so in red rather
///     than claiming protection — fail-visible, never optimistic.
///  3. The Family screen stays join-only: no entitlement-token field and
///     no purchase steering (App Store 3.1.1 posture).
final class SmokeTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testSmokeFlow() {
        let app = XCUIApplication()
        app.launch()

        walkOnboardingIfPresent(app)

        // The home list is showing — on a fresh install this proves the
        // onboarding settings persisted despite Safari refusing to
        // reload rules for a blocker that isn't enabled.
        let categories = app.buttons["Filter categories"]
        XCTAssertTrue(
            categories.waitForExistence(timeout: 10),
            "home screen never appeared — onboarding settings failed to persist")

        // Fail-visible: the blocker cannot enforce in the simulator, so
        // the app must say INACTIVE and must not claim protection.
        // Matched by identifier, not wording, on any element type.
        let inactive = app.descendants(matching: .any)["status.inactive"]
        XCTAssertTrue(
            inactive.waitForExistence(timeout: 5),
            "status must be red when the blocker is not enforcing")
        XCTAssertFalse(app.descendants(matching: .any)["status.active"].exists)

        // SafeSearch is permanently disclosed as unavailable on iOS.
        // LabeledContent merges its label and value into one element, so
        // match on a substring rather than the exact value.
        XCTAssertTrue(
            app.descendants(matching: .any).matching(
                NSPredicate(format: "label CONTAINS[c] %@", "not available on iOS")
            ).firstMatch.exists,
            "the iOS SafeSearch limitation must be stated on the home screen")

        // Family screen: join-only.
        app.buttons["Sitr Family"].tap()
        XCTAssertTrue(app.buttons["Join"].waitForExistence(timeout: 5))
        XCTAssertFalse(
            app.textFields["sitr-ent-v1.… (paste your token)"].exists,
            "iOS must not offer an entitlement-token field")
        XCTAssertFalse(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS[c] 'sitrshield.com/family'")
            ).element.exists,
            "iOS must not steer to an external purchase")
    }

    private func walkOnboardingIfPresent(_ app: XCUIApplication) {
        guard app.buttons["Continue"].waitForExistence(timeout: 10) else { return }
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 5))
        app.buttons["Continue"].tap()
        let finish = app.buttons["Finish"]
        XCTAssertTrue(finish.waitForExistence(timeout: 5))
        finish.tap()
    }
}
