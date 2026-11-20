/// Leaving a household frees this device's place: SyncClient.unenroll,
/// mirroring Android SyncClientTest.unenrollPushesTheLatestStateWithoutThisDevice.
import Foundation
import Testing

@testable import SitrCore

@Suite struct UnenrollTests {
    let secret = Data((0..<32).map { UInt8($0) })
    let now: Double = 1_700_000_000_000

    var keys: SyncCrypto.HouseholdKeys {
        guard case .success(let k) = SyncCrypto.deriveKeys(rootSecret: secret) else {
            fatalError("derivation failed")
        }
        return k
    }

    func state(rev: Int, devices: [String], by: String = "device-a") -> HouseholdState {
        var s = HouseholdState(rev: rev, updatedAt: Double(rev) * 1000, updatedBy: by)
        s.devices = devices
        return s
    }

    func ok(_ etag: Int, _ s: HouseholdState? = nil) -> ScriptedTransport.Step {
        let body: Data
        if let s, case .success(let blob) = Household.sealState(s, encKey: keys.encKey) {
            body = blob
        } else {
            body = Data()
        }
        return .respond(SyncHTTPResponse(status: 200, etagHeader: "\"\(etag)\"", body: body))
    }

    func pushed(_ t: ScriptedTransport) -> HouseholdState? {
        guard let body = t.recorded.last(where: { $0.method == "PUT" })?.body,
            case .success(let s) = Household.openState(blob: body, encKey: keys.encKey)
        else { return nil }
        return s
    }

    func unenroll(_ t: ScriptedTransport, local: HouseholdState, maxSeen: Int) async -> SyncOutcome {
        await SyncClient(transport: t, now: { self.now }).unenroll(
            SyncInput(rootSecret: secret, local: local, maxSeenRev: maxSeen, deviceId: "me"))
    }

    @Test func pushesTheLatestStateWithoutThisDevice() async {
        let remote = state(rev: 5, devices: ["device-a", "me"])
        let t = ScriptedTransport([ok(5, remote), ok(5, remote), ok(6)])
        let outcome = await unenroll(t, local: remote, maxSeen: 5)

        #expect(outcome.status.state == .ok)
        #expect(outcome.state.devices == ["device-a"])
        #expect(pushed(t)?.devices == ["device-a"])
        #expect(pushed(t)?.rev == 6)
        #expect(t.recorded.last?.headers["If-Match"] == "\"5\"")
        #expect(t.recorded.map(\.method) == ["GET", "GET", "PUT"])
    }

    @Test func lastDeviceLeavesAnEmptyListAndNeverDeletes() async {
        let remote = state(rev: 3, devices: ["me"])
        let t = ScriptedTransport([ok(3, remote), ok(3, remote), ok(4)])
        let outcome = await unenroll(t, local: remote, maxSeen: 3)

        #expect(outcome.status.state == .ok)
        #expect(pushed(t)?.devices == [])
        #expect(!t.recorded.contains { $0.method == "DELETE" })
    }

    @Test func offlineLeavesThePlaceTaken() async {
        let local = state(rev: 5, devices: ["device-a", "me"])
        let t = ScriptedTransport([.offline])
        let outcome = await unenroll(t, local: local, maxSeen: 5)

        #expect(outcome.status.state == .offline)
        #expect(t.recorded.count == 1)
    }

    @Test func joinPlaceholderSendsNothing() async {
        // A 404 would otherwise make the round create the household from it.
        let t = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 404, etagHeader: nil, body: Data()))
        ])
        _ = await unenroll(t, local: Household.emptyState(deviceId: "me", now: 0), maxSeen: 0)
        #expect(t.recorded.isEmpty)
    }

    @Test func notListedPushesNothing() async {
        let remote = state(rev: 5, devices: ["device-a"])
        let t = ScriptedTransport([ok(5, remote)])
        let outcome = await unenroll(t, local: remote, maxSeen: 5)

        #expect(outcome.status.state == .ok)
        #expect(t.recorded.map(\.method) == ["GET"])
    }

    @Test func conflictOnRemovalRetriesOnce() async {
        let remote = state(rev: 5, devices: ["device-a", "me"])
        let moved = state(rev: 6, devices: ["device-a", "device-c", "me"], by: "device-c")
        let t = ScriptedTransport([
            ok(5, remote), ok(5, remote),
            .respond(SyncHTTPResponse(status: 409, etagHeader: nil, body: Data())),
            ok(6, moved), ok(7),
        ])
        let outcome = await unenroll(t, local: remote, maxSeen: 5)

        // syncOnce's one retry: re-pull, re-merge, re-push. Whole-state
        // last-writer-wins (sync-protocol.md): the newer leave state wins
        // and overwrites the concurrent write (as Android); device-c
        // re-enrolls on its own next sync.
        #expect(outcome.status.state == .ok)
        #expect(t.recorded.map(\.method) == ["GET", "GET", "PUT", "GET", "PUT"])
        #expect(pushed(t)?.devices == ["device-a"])
        #expect(pushed(t)?.updatedBy == "me")
    }

    @Test func secondPassWhenAConcurrentWritePutItBack() async {
        let remote = state(rev: 5, devices: ["device-a", "me"])
        let newer = state(rev: 9, devices: ["device-a", "me"], by: "device-b")
        let t = ScriptedTransport([ok(5, remote), ok(9, newer), ok(9, newer), ok(10)])
        let outcome = await unenroll(t, local: remote, maxSeen: 5)

        #expect(outcome.status.state == .ok)
        #expect(pushed(t)?.devices == ["device-a"])
        #expect(pushed(t)?.rev == 10)
    }

    @Test func rollbackIsRefusedAndNothingPushed() async {
        let stale = state(rev: 2, devices: ["device-a", "me"])
        let t = ScriptedTransport([ok(2, stale)])
        let outcome = await unenroll(t, local: state(rev: 5, devices: ["device-a", "me"]), maxSeen: 5)

        #expect(outcome.status.state == .error)
        #expect(!t.recorded.contains { $0.method == "PUT" })
    }
}
