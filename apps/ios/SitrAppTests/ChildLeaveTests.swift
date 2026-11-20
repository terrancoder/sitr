/// C1 in the app: a child device leaves with the guardian PIN (the gate
/// asks for it, the PIN verifies, the device leaves exactly as any device
/// does); with no household PIN it is refused. The unenroll write goes to
/// a dead local port, never to a real server. Puts the device's state back.
import SitrCore
import XCTest

@testable import Sitr

@MainActor
final class ChildLeaveTests: XCTestCase {
    func testChildLeavesWithThePinAndIsRefusedWithoutOne() async throws {
        let originalSettings = SettingsStore.load()
        let originalKey = Storage.loadRootSecret()
        UserDefaults.standard.set("http://127.0.0.1:9", forKey: "SitrSyncBaseURL")
        defer {
            UserDefaults.standard.removeObject(forKey: "SitrSyncBaseURL")
            Storage.forgetRootSecret()
            if let originalKey { Storage.saveRootSecret(originalKey) }
            SettingsStore.persist(originalSettings)
        }
        XCTAssertEqual(Endpoints.sync.absoluteString, "http://127.0.0.1:9")

        let record = try Pin.createRecord(pin: "4821").get()
        var household = Household.emptyState(deviceId: SettingsStore.load().deviceId, now: 1000)
        household.pin = record
        var settings = SettingsStore.load()
        settings.household = household
        settings.role = "child"
        SettingsStore.persist(settings)
        XCTAssertTrue(Storage.saveRootSecret(SyncCrypto.generateRootSecret()))

        let model = AppModel()
        // With a PIN: the gate asks for it (wait-before-loosening off here).
        XCTAssertEqual(model.decide(.kind(.leaveHousehold), phase: .off), .pin)
        // Every other loosening stays refused on the child device (C3).
        XCTAssertEqual(model.decide(.kind(.addDeviceAllowRule), phase: .off), .refused(.childDevice))
        let ok = await model.verifyPin("4821")
        XCTAssertTrue(ok)
        let wrong = await model.verifyPin("0000")
        XCTAssertFalse(wrong)
        await model.leaveHousehold()
        XCTAssertNil(model.settings.household)
        XCTAssertNil(model.settings.role)
        XCTAssertNil(SettingsStore.load().household)

        // Without a household PIN: refused (child-device; the UI says the PIN is needed).
        var noPin = SettingsStore.load()
        noPin.household = Household.emptyState(deviceId: noPin.deviceId, now: 1000)
        noPin.role = "child"
        SettingsStore.persist(noPin)
        let model2 = AppModel()
        XCTAssertEqual(model2.decide(.kind(.leaveHousehold), phase: .off), .refused(.childDevice))
    }
}
