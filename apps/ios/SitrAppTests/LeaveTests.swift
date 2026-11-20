/// "Did the user leave meanwhile?" (SyncScheduler.stillInHousehold): with
/// iCloud Keychain on, leaving keeps the synced household key, so the
/// stored key alone must not count as membership. Needs no server.
import SitrCore
import XCTest

@testable import Sitr

@MainActor
final class LeaveTests: XCTestCase {
    func testAKeyKeptAfterLeavingIsNotMembership() async throws {
        // Runs on whatever simulator the suite runs on: put back the device's
        // own settings and key afterwards.
        let wasOn = Storage.keychainInICloud
        let originalSettings = SettingsStore.load()
        let originalKey = Storage.loadRootSecret()
        defer {
            Storage.forgetRootSecret()
            if let originalKey { Storage.saveRootSecret(originalKey) }
            SettingsStore.persist(originalSettings)
            Storage.setKeychainInICloud(wasOn)
        }
        Storage.setKeychainInICloud(true)
        let secret = SyncCrypto.generateRootSecret()
        XCTAssertTrue(Storage.saveRootSecret(secret))
        var settings = SettingsStore.load()
        settings.household = Household.emptyState(deviceId: settings.deviceId, now: 1)
        SettingsStore.persist(settings)
        XCTAssertTrue(SyncScheduler.stillInHousehold(secret))

        // Leave as AppModel does: the key stays (iCloud on), the household goes.
        Storage.clearRootSecret()
        settings.household = nil
        SettingsStore.persist(settings)
        XCTAssertEqual(Storage.loadRootSecret(), secret, "the synced key is kept for the other devices")
        XCTAssertFalse(SyncScheduler.stillInHousehold(secret))
        XCTAssertFalse(SyncScheduler.stillInHousehold(SyncCrypto.generateRootSecret()))
    }
}
