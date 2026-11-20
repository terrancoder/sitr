/// No allow entry for an adult-listed name: the add screens refuse it, and
/// the Screen Time filter never passes one to Apple's filter. Uses the list
/// bundled in the app. Needs no server; puts the device's lists back.
import SitrCore
import XCTest

@testable import Sitr

@MainActor
final class AdultAllowAppTests: XCTestCase {
    func testTheBundledListLoadsAndWalksParents() {
        XCTAssertNotNil(AdultList.set, "adult.domains is bundled in the app and verifies")
        XCTAssertTrue(AdultList.covers("pornhub.com"))
        XCTAssertTrue(AdultList.covers("www.pornhub.com"), "a listed parent covers its subdomains")
        XCTAssertTrue(AdultList.covers("403.hqhost.net"))
        XCTAssertFalse(AdultList.covers("hqhost.net"), "the parent of a listed subdomain is not listed")
        XCTAssertFalse(AdultList.covers("bet365.com"), "gambling is not the adult list")
    }

    func testAddingAnAdultAllowIsRefusedWithTheSentence() async {
        let model = AppModel()
        let original = SettingsStore.load()
        defer { SettingsStore.persist(original) }

        XCTAssertEqual(
            model.allowRefusal("www.pornhub.com"),
            "This site is on the adult list and cannot be allowed. If it is listed by mistake, report it.")
        XCTAssertNil(model.allowRefusal("hqhost.net"))
        XCTAssertNil(model.allowRefusal("bet365.com"))

        await model.addDeviceDomain(allow: true, domain: "pornhub.com")
        XCTAssertEqual(model.lastError, AdultList.refusal)
        XCTAssertFalse(model.settings.userAllow.contains("pornhub.com"))

        model.lastError = nil
        await model.addHouseholdDomain(allow: true, domain: "m.pornhub.com")
        XCTAssertEqual(model.lastError, AdultList.refusal, "the household list refuses it too")

        // Blocking an adult name, and allowing anything else, still work.
        model.lastError = nil
        await model.addDeviceDomain(allow: false, domain: "pornhub.com")
        await model.addDeviceDomain(allow: true, domain: "bet365.com")
        XCTAssertNil(model.lastError)
        XCTAssertTrue(model.settings.userBlock.contains("pornhub.com"))
        XCTAssertTrue(model.settings.userAllow.contains("bet365.com"))
    }

    func testScreenTimeExceptionsLeaveOutAdultNames() {
        var s = AppSettings()
        s.userAllow = ["pornhub.com", "bet365.com", "hqhost.net"]
        var household = Household.emptyState(deviceId: "d", now: 1)
        household.allowDomains = ["www.pornhub.com", "403.hqhost.net", "example.org"]
        s.household = household
        let except = ScreenTimeController.exceptions(s, isAdult: AdultList.covers)
        XCTAssertEqual(except, ["example.org", "bet365.com", "hqhost.net"])
    }
}
