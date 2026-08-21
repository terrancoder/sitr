/// Sync-client scenarios against a scripted transport — mirrors
/// tests/src/syncClient.test.ts case by case: create, pull-merge, push
/// preconditions, one 409 retry, rollback refusal, offline mapping.
import Foundation
import Testing

@testable import SitrCore

struct Recorded {
    let method: String
    let url: URL
    let headers: [String: String]
    let body: Data?
}

final class ScriptedTransport: SyncTransport, @unchecked Sendable {
    enum Step {
        case respond(SyncHTTPResponse)
        case offline
    }

    var steps: [Step]
    var recorded: [Recorded] = []

    init(_ steps: [Step]) {
        self.steps = steps
    }

    func request(
        method: String, url: URL, headers: [String: String], body: Data?
    ) async throws -> SyncHTTPResponse {
        recorded.append(Recorded(method: method, url: url, headers: headers, body: body))
        guard !steps.isEmpty else {
            throw SitrError("transport script exhausted")
        }
        switch steps.removeFirst() {
        case .offline: throw SitrError("offline")
        case .respond(let response): return response
        }
    }
}

@Suite struct SyncClientTests {
    let secret = Data((0..<32).map { UInt8($0) })
    let now: Double = 1_700_000_000_000

    var keys: SyncCrypto.HouseholdKeys {
        guard case .success(let k) = SyncCrypto.deriveKeys(rootSecret: secret) else {
            fatalError("derivation failed")
        }
        return k
    }

    func state(rev: Int, by: String = "device-a") -> HouseholdState {
        HouseholdState(rev: rev, updatedAt: Double(rev) * 1000, updatedBy: by)
    }

    func sealed(_ s: HouseholdState) -> Data {
        guard case .success(let blob) = Household.sealState(s, encKey: keys.encKey) else {
            fatalError("seal failed")
        }
        return blob
    }

    func client(_ transport: ScriptedTransport) -> SyncClient {
        SyncClient(transport: transport, now: { self.now })
    }

    @Test func createWhenServerHasNoBlob() async {
        let transport = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 404, etagHeader: nil, body: Data())),
            .respond(SyncHTTPResponse(status: 201, etagHeader: "\"1\"", body: Data())),
        ])
        let local = state(rev: 1)
        let outcome = await client(transport).syncOnce(
            SyncInput(rootSecret: secret, local: local, maxSeenRev: 0, deviceId: "device-a"))

        #expect(outcome.status.state == .ok)
        #expect(outcome.state == local)
        #expect(outcome.maxSeenRev == 1)
        #expect(outcome.etag == 1)

        #expect(transport.recorded.count == 2)
        let put = transport.recorded[1]
        #expect(put.method == "PUT")
        #expect(put.headers["If-None-Match"] == "*")
        #expect(put.headers["If-Match"] == nil)
        #expect(put.headers["X-Sitr-Entitlement"] == nil)
        #expect(put.headers["Authorization"] == "Bearer \(keys.authToken)")
        #expect(put.url.path.hasSuffix("/v1/blob/\(keys.householdId)"))
    }

    @Test func entitlementHeaderSentOnCreateWhenProvided() async {
        let transport = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 404, etagHeader: nil, body: Data())),
            .respond(SyncHTTPResponse(status: 201, etagHeader: "\"1\"", body: Data())),
        ])
        _ = await client(transport).syncOnce(
            SyncInput(
                rootSecret: secret, local: state(rev: 1), maxSeenRev: 0,
                deviceId: "device-a", entitlement: "sitr-ent-v1.x.y"))
        #expect(transport.recorded[1].headers["X-Sitr-Entitlement"] == "sitr-ent-v1.x.y")
    }

    @Test func remoteNewerStateWinsWithoutPush() async {
        let remote = state(rev: 5, by: "device-b")
        let transport = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"7\"", body: sealed(remote)))
        ])
        let outcome = await client(transport).syncOnce(
            SyncInput(
                rootSecret: secret, local: state(rev: 3), maxSeenRev: 3,
                deviceId: "device-a"))

        #expect(outcome.status.state == .ok)
        #expect(outcome.state == remote)
        #expect(outcome.maxSeenRev == 5)
        #expect(outcome.etag == 7)
        #expect(transport.recorded.count == 1, "no push when the server copy won")
    }

    @Test func localAheadPushesWithIfMatch() async {
        let remote = state(rev: 5, by: "device-b")
        let transport = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"9\"", body: sealed(remote))),
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"10\"", body: Data())),
        ])
        let local = state(rev: 7)
        let outcome = await client(transport).syncOnce(
            SyncInput(rootSecret: secret, local: local, maxSeenRev: 5, deviceId: "device-a"))

        #expect(outcome.status.state == .ok)
        #expect(outcome.state == local, "local won the merge; pushed unbumped")
        #expect(outcome.etag == 10)
        #expect(transport.recorded[1].headers["If-Match"] == "\"9\"")
        #expect(transport.recorded[1].headers["If-None-Match"] == nil)
    }

    @Test func rollbackIsRefused() async {
        let stale = state(rev: 2, by: "device-b")
        let transport = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"4\"", body: sealed(stale)))
        ])
        let local = state(rev: 6)
        let outcome = await client(transport).syncOnce(
            SyncInput(rootSecret: secret, local: local, maxSeenRev: 5, deviceId: "device-a"))

        #expect(outcome.status.state == .error)
        #expect(outcome.status.error?.contains("older household state") == true)
        #expect(outcome.state == local, "stale server state must never be applied")
        #expect(outcome.maxSeenRev == 5)
        #expect(transport.recorded.count == 1)
    }

    @Test func conflictRetriesExactlyOnce() async {
        let remoteFirst = state(rev: 5, by: "device-b")
        let remoteSecond = state(rev: 6, by: "device-c")
        let transport = ScriptedTransport([
            .respond(
                SyncHTTPResponse(status: 200, etagHeader: "\"5\"", body: sealed(remoteFirst))),
            .respond(SyncHTTPResponse(status: 409, etagHeader: "\"6\"", body: Data())),
            .respond(
                SyncHTTPResponse(status: 200, etagHeader: "\"6\"", body: sealed(remoteSecond))),
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"7\"", body: Data())),
        ])
        let local = state(rev: 7)
        let outcome = await client(transport).syncOnce(
            SyncInput(rootSecret: secret, local: local, maxSeenRev: 5, deviceId: "device-a"))

        #expect(outcome.status.state == .ok)
        #expect(transport.recorded.count == 4, "pull, conflicted push, re-pull, re-push")
        #expect(outcome.etag == 7)
    }

    @Test func repeatedConflictSurfacesError() async {
        let remote = state(rev: 5, by: "device-b")
        let transport = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"5\"", body: sealed(remote))),
            .respond(SyncHTTPResponse(status: 409, etagHeader: "\"6\"", body: Data())),
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"6\"", body: sealed(remote))),
            .respond(SyncHTTPResponse(status: 409, etagHeader: "\"7\"", body: Data())),
        ])
        let outcome = await client(transport).syncOnce(
            SyncInput(
                rootSecret: secret, local: state(rev: 7), maxSeenRev: 5,
                deviceId: "device-a"))
        #expect(outcome.status.state == .error)
        #expect(outcome.status.error?.contains("conflict") == true)
    }

    @Test func offlineIsOfflineNotError() async {
        let transport = ScriptedTransport([.offline])
        let local = state(rev: 1)
        let outcome = await client(transport).syncOnce(
            SyncInput(rootSecret: secret, local: local, maxSeenRev: 1, deviceId: "device-a"))
        #expect(outcome.status.state == .offline)
        #expect(outcome.state == local)
    }

    @Test func equalStatesNoPush() async {
        // Server holds exactly the local state: nothing to push.
        let shared = state(rev: 4)
        let transport = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"4\"", body: sealed(shared)))
        ])
        let outcome = await client(transport).syncOnce(
            SyncInput(rootSecret: secret, local: shared, maxSeenRev: 4, deviceId: "device-a"))
        #expect(outcome.status.state == .ok)
        #expect(transport.recorded.count == 1)
    }
}
