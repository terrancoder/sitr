/// Sitr Family end to end on the simulator: StoreKit's local test
/// environment (SKTestSession, which reaches the app only from a test
/// hosted in it) → claim → household creation → renewal state, against
/// LOCAL claim and sync servers. Skipped unless they are named:
///
///   TEST_RUNNER_SITR_LOCAL_CLAIM=http://127.0.0.1:8788 \
///   TEST_RUNNER_SITR_LOCAL_SYNC=http://127.0.0.1:8787 \
///   xcodebuild test … -only-testing:SitrAppTests/FamilyFlowTests
///
/// Optional: SITR_PAIRING_FILE, where testSubscribeClaimCreate writes the
/// pairing code and testJoinWithPairingCode (on a second simulator) reads it.
/// Never point these at the live servers.
import StoreKit
import StoreKitTest
import SitrCore
import XCTest

@testable import Sitr

@MainActor
final class FamilyFlowTests: XCTestCase {
    private var session: SKTestSession!
    private var usingLocalServers = false
    private let env = ProcessInfo.processInfo.environment

    override func setUp() async throws {
        guard let claim = env["SITR_LOCAL_CLAIM"], let sync = env["SITR_LOCAL_SYNC"],
            claim.hasPrefix("http://127.0.0.1"), sync.hasPrefix("http://127.0.0.1")
        else { throw XCTSkip("local claim and sync servers not named (SITR_LOCAL_CLAIM, SITR_LOCAL_SYNC)") }
        UserDefaults.standard.set(claim, forKey: "SitrClaimBaseURL")
        UserDefaults.standard.set(sync, forKey: "SitrSyncBaseURL")
        usingLocalServers = true
        XCTAssertEqual(Endpoints.claim.absoluteString, claim, "never the live claim host")
        XCTAssertEqual(Endpoints.sync.absoluteString, sync, "never the live sync host")
        let config = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Configs/Sitr.storekit")
        session = try SKTestSession(contentsOf: config)
        session.disableDialogs = true
        session.clearTransactions()
    }

    override func tearDown() async throws {
        guard usingLocalServers else { return }  // skipped: touch nothing
        // Leave nothing behind: a household made against the local servers
        // would otherwise sync with the production server at the next
        // normal launch, where no override is set.
        let model = AppModel()
        await model.leaveHousehold()  // its unenroll still goes to the local server
        Storage.forgetRootSecret()
        Family.saveState(ClaimState())
        Family.createPending = false
        UserDefaults.standard.removeObject(forKey: "SitrClaimBaseURL")
        UserDefaults.standard.removeObject(forKey: "SitrSyncBaseURL")
    }

    private func freshModel() async -> AppModel {
        let model = AppModel()
        await model.leaveHousehold()
        Storage.forgetRootSecret()
        Family.saveState(ClaimState())
        Family.createPending = false
        await model.refreshFamily()
        return model
    }

    private func monthly(_ model: AppModel) throws -> Product {
        try XCTUnwrap(model.products.first { $0.id == Entitlement.Products.monthly })
    }

    func testSubscribeClaimCreate() async throws {
        let model = await freshModel()
        XCTAssertEqual(Set(model.products.map(\.id)), Set(Entitlement.Products.all))
        XCTAssertNil(model.settings.household)

        // Subscribe monthly through the app's own Subscribe path, with the
        // sync server unreachable: the claim succeeds, the creation gets no
        // answer, and the key is kept for the retry.
        let sync = try XCTUnwrap(env["SITR_LOCAL_SYNC"])
        UserDefaults.standard.set("http://127.0.0.1:9", forKey: "SitrSyncBaseURL")
        await model.subscribe(try monthly(model))
        XCTAssertNil(model.settings.household)
        XCTAssertTrue(Family.createPending)
        let firstId = try XCTUnwrap(Storage.loadRootSecret().flatMap(Family.householdId))
        XCTAssertTrue(model.familyMessage?.contains("try again") == true, model.familyMessage ?? "")

        // Retry ("Create household") with the server back: same key, created.
        UserDefaults.standard.set(sync, forKey: "SitrSyncBaseURL")
        await model.createHousehold()
        XCTAssertNil(model.familyMessage, model.familyMessage ?? "")
        XCTAssertFalse(Family.createPending)
        XCTAssertEqual(Storage.loadRootSecret().flatMap(Family.householdId), firstId, "the retry used the same household")
        let household = try XCTUnwrap(model.settings.household, "household created")
        XCTAssertEqual(model.settings.role, "guardian")
        XCTAssertEqual(household.devices, [model.settings.deviceId])
        let code = try XCTUnwrap(model.newPairingCode, "pairing code shown")
        let state = Family.loadState()
        XCTAssertNotNil(state.entExp, "E from the sync server")
        XCTAssertTrue(state.testHousehold, "an Xcode receipt gives a test token")
        XCTAssertTrue(state.tokens.isEmpty, "the creating token was used")
        XCTAssertEqual(state.appliedHousehold, Storage.loadRootSecret().flatMap(Family.householdId))
        if let file = env["SITR_PAIRING_FILE"] { try code.write(toFile: file, atomically: true, encoding: .utf8) }

        // "Relaunch": a new model from storage is still entitled and in sync.
        let relaunched = AppModel()
        // StoreKit lists a fresh purchase in currentEntitlements a moment later.
        for _ in 0..<10 where !relaunched.subscribed {
            await relaunched.refreshFamily()
            if !relaunched.subscribed { try await Task.sleep(nanoseconds: 500_000_000) }
        }
        XCTAssertTrue(relaunched.subscribed)
        XCTAssertNotNil(relaunched.settings.household)
        await relaunched.runSync()
        XCTAssertEqual(relaunched.settings.syncStatus.state, .ok, relaunched.settings.syncStatus.describe)
        XCTAssertEqual(relaunched.familyNotice, .none)

        // Expire the subscription with StoreKit's test tools. The household
        // runs on to E; this device's own claim now says inactive, so at E
        // the screen says "ended" (the server's clock cannot be moved here).
        try session.expireSubscription(productIdentifier: Entitlement.Products.monthly)
        try await Task.sleep(nanoseconds: 2_000_000_000)
        await relaunched.refreshFamily()
        XCTAssertFalse(relaunched.subscribed)
        Family.update { $0 = ClaimPlan.userRetry($0) }
        let refused = await Family.claim(current: true)
        XCTAssertEqual(refused, .refused(.inactive, retryAfter: nil))
        let e = try XCTUnwrap(Family.loadState().entExp)
        XCTAssertEqual(ClaimPlan.notice(Family.loadState(), now: e), .ended(lapsed: true))
        XCTAssertEqual(ClaimPlan.notice(Family.loadState(), now: e - 1), .none, "test household: no early notice")

        // Resubscribe, with the household marked lapsed (as after a 402
        // lapsed): the device claims with current: true and writes the
        // token; the lapse clears.
        Family.update { $0.lapsed = true }
        await relaunched.refreshFamily()
        await relaunched.subscribe(try monthly(relaunched))
        XCTAssertTrue(relaunched.subscribed)
        let after = Family.loadState()
        XCTAssertFalse(after.lapsed, "reopened")
        XCTAssertNil(after.lastRefusal)
        XCTAssertEqual(relaunched.settings.syncStatus.state, .ok, relaunched.settings.syncStatus.describe)
        XCTAssertEqual(relaunched.familyNotice, .none)
    }

    /// Second simulator: joins with the code the first one wrote.
    func testJoinWithPairingCode() async throws {
        guard let file = env["SITR_PAIRING_FILE"], let code = try? String(contentsOfFile: file, encoding: .utf8)
        else { throw XCTSkip("no pairing code file") }
        let model = await freshModel()
        await model.joinHousehold(code: code, asChild: true)
        let household = try XCTUnwrap(model.settings.household)
        XCTAssertEqual(model.settings.syncStatus.state, .ok, model.settings.syncStatus.describe)
        // (The creating device's tearDown left, so it may no longer be listed.)
        XCTAssertTrue(household.devices.contains(model.settings.deviceId))
        XCTAssertNotNil(Family.loadState().entExp, "a joined device learns E from the server")
        XCTAssertFalse(model.subscribed, "no purchase on this device: it only shows E and the lapse state")
    }
}
