/// MANUAL simulator check of the Safari rule order (run on a simulator
/// where the Sitr content blocker is enabled in Settings → Apps → Safari →
/// Extensions). Skipped unless SITR_SAFARI_PROBE=1:
///
///   TEST_RUNNER_SITR_SAFARI_PROBE=1 xcodebuild test … \
///     -only-testing:SitrAppTests/SafariOrderProbeTests
///
/// It loads a SYNTHETIC list into Safari, built by the app's own
/// SafariRules.build: gamble.localtest.me as a category block, every name
/// on the allow lists, adult.localtest.me in the adult position (last).
/// `*.localtest.me` resolves to 127.0.0.1, so serve a page on port 8080 on
/// the Mac and open http://<name>.localtest.me:8080/ in Safari: the adult
/// name must fail to load (blocked), the gambling and control names must
/// load. Open the app afterwards: it writes its real list back.
import SafariServices
import SitrCore
import XCTest

@testable import Sitr

final class SafariOrderProbeTests: XCTestCase {
    func testLoadSyntheticOrderIntoSafari() async throws {
        guard ProcessInfo.processInfo.environment["SITR_SAFARI_PROBE"] == "1" else {
            throw XCTSkip("manual simulator check; set SITR_SAFARI_PROBE=1")
        }
        func rule(_ d: String) -> SafariRule {
            SafariRule(urlFilter: SafariRules.urlFilter(for: d), ifDomain: nil, action: .block)
        }
        let rules = try SafariRules.build(
            staticRules: [rule("gamble.localtest.me")],
            userBlock: [],
            userAllow: ["adult.localtest.me", "gamble.localtest.me"],
            householdBlock: [],
            householdAllow: ["adult.localtest.me"],
            alwaysBlock: [rule("adult.localtest.me")]
        ).get()
        let container = try XCTUnwrap(Storage.groupContainer)
        try SafariRules.serialize(rules).write(to: container.appendingPathComponent("blockerList.json"), options: .atomic)
        try await SFContentBlockerManager.reloadContentBlocker(withIdentifier: BlockerController.blockerIdentifier)
        let enabled = await StatusModel.isBlockerEnabled()
        XCTAssertEqual(enabled, true, "enable the Sitr content blocker in Safari's settings on this simulator")
    }
}
