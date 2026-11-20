/// A household this device never received: leaving it is free for any role
/// (P1), decided from the stored state and checked again in the leave (P2);
/// join and create refuse while a household is stored (P3); leaving clears
/// the stored sync status (P4). Sync goes to a dead local port, never to a
/// real server. Puts the device's state back.
import SitrCore
import XCTest

@testable import Sitr

@MainActor
final class JoinPlaceholderLeaveTests: XCTestCase {
    private var originalSettings: AppSettings!
    private var originalKey: Data?

    override func setUp() async throws {
        originalSettings = SettingsStore.load()
        originalKey = Storage.loadRootSecret()
        UserDefaults.standard.set("http://127.0.0.1:9", forKey: "SitrSyncBaseURL")
        XCTAssertTrue(Storage.saveRootSecret(SyncCrypto.generateRootSecret()))
    }

    override func tearDown() async throws {
        UserDefaults.standard.removeObject(forKey: "SitrSyncBaseURL")
        Storage.forgetRootSecret()
        if let originalKey { Storage.saveRootSecret(originalKey) }
        SettingsStore.persist(originalSettings)
    }

    private func store(_ household: HouseholdState?, role: String?, status: SyncStatus = .neverSynced) {
        var s = SettingsStore.load()
        s.household = household
        s.role = role
        s.syncStatus = status
        SettingsStore.persist(s)
    }

    private var placeholder: HouseholdState {
        Household.emptyState(deviceId: SettingsStore.load().deviceId, now: 0)
    }

    func testP1PlaceholderLeaveIsFreeForGuardianAndChildButNotWithAPin() async {
        for role in ["guardian", "child"] {
            store(placeholder, role: role, status: SyncStatus(state: .notFound))
            let model = AppModel()
            let asPlaceholder = await model.leaveIsJoinPlaceholder()
            XCTAssertTrue(asPlaceholder, role)
            XCTAssertEqual(model.decide(.leaveJoinPlaceholder, phase: .idle), .go, role)
            await model.leaveHousehold(asJoinPlaceholder: true)
            XCTAssertNil(SettingsStore.load().household, role)
            XCTAssertEqual(SettingsStore.load().syncStatus, .neverSynced, "leaving clears the sync status")
            XCTAssertNil(model.lastError)
        }
        // rev 1, updatedAt 0, but holding a PIN: not free.
        var withPin = placeholder
        withPin.pin = PinRecord(
            iterations: 600_000, saltB64: "AAECAwQFBgcICQoLDA0ODw==",
            hashB64: "nznZxxwixMRZvCy6zG104hhBhdZx2R8KNKaDRBOghJ0=")
        store(withPin, role: "child")
        let model = AppModel()
        let asPlaceholder = await model.leaveIsJoinPlaceholder()
        XCTAssertFalse(asPlaceholder)
        XCTAssertEqual(model.decide(.kind(.leaveHousehold), phase: .off), .pin)
    }

    func testP2HouseholdArrivingBeforeTheLeaveStopsIt() async {
        store(placeholder, role: "child")
        let model = AppModel()
        let asPlaceholder = await model.leaveIsJoinPlaceholder()
        XCTAssertTrue(asPlaceholder)
        // A background refresh writes the real household behind `settings`.
        var real = Household.emptyState(deviceId: "creator", now: 1000)
        real.rev = 3
        store(real, role: "child", status: SyncStatus(state: .ok, lastSuccessAt: 1))
        await model.leaveHousehold(asJoinPlaceholder: true)
        XCTAssertEqual(model.lastError, "The household has just arrived on this device. Leave again.")
        XCTAssertEqual(SettingsStore.load().household, real, "nothing was left")
        XCTAssertNotNil(Storage.loadRootSecret())
    }

    func testP3JoinAndCreateRefuseWhileAHouseholdIsStored() async {
        store(placeholder, role: "guardian")
        let key = Storage.loadRootSecret()
        let refusal = "This device is already in a household. Leave it first."
        // A screen opened before the join still shows the forms.
        let model = AppModel()
        model.settings.household = nil

        await model.joinHousehold(code: PairingCode.encode(rootSecret: SyncCrypto.generateRootSecret()), asChild: false)
        XCTAssertEqual(model.lastError, refusal)
        model.lastError = nil
        await model.joinFromICloudKey(asChild: true)
        XCTAssertEqual(model.lastError, refusal)
        await model.createHousehold()
        XCTAssertEqual(model.familyMessage, refusal)

        XCTAssertEqual(Storage.loadRootSecret(), key, "the household key is unchanged")
        XCTAssertEqual(SettingsStore.load().household, placeholder)
        XCTAssertEqual(SettingsStore.load().role, "guardian")
    }
}
