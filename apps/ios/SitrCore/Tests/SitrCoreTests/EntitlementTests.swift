/// Entitlement version 2 on the client (docs/sync-protocol.md §What each
/// client must do): token reading, the claim call and its reasons, the
/// rules for when to claim, the sync server's E header and 402 reasons.
/// Fixed clocks and a fixed "random" value; no sleeps.
import Foundation
import Testing

@testable import SitrCore

@Suite struct EntitlementTests {
    let day = Entitlement.day
    // 2026-11-10 00:00 UTC, and the December token's exp (2026-12-04 00:00 UTC).
    let nov10: Double = 1_794_268_800_000
    let dec1: Double = 1_796_083_200_000
    var dec4: Double { dec1 + 3 * day }

    func token(per: Double, exp: Double, test: Bool = false) -> EntitlementToken {
        var payload = #"{"v":2,"plan":"family","term":"month","per":\#(Int64(per)),"exp":\#(Int64(exp)),"jti":"AAAAAAAAAAAAAAAAAAAAAA""#
        if test { payload += #","test":true"# }
        payload += "}"
        let raw = "sitr-ent-v2.\(base64URLEncode(Data(payload.utf8))).c2ln"
        return EntitlementToken.parse(raw)!
    }

    // MARK: token

    @Test func parsesAVersion2Token() {
        let t = token(per: dec1, exp: dec4, test: true)
        #expect(t.plan == "family" && t.term == "month" && t.per == dec1 && t.exp == dec4 && t.test)
        #expect(EntitlementToken.parse("sitr-ent-v1.e30.c2ln") == nil)
        #expect(EntitlementToken.parse("sitr-ent-v2.e30") == nil)
        #expect(EntitlementToken.parse(t.raw.replacingOccurrences(of: "sitr-ent-v2", with: "sitr-ent-v3")) == nil)
    }

    // MARK: claim call

    @Test func claimRequestCarriesTheSpecFieldsAndNothingElse() async throws {
        let secret = Data(repeating: 7, count: 32)
        let t = token(per: dec1, exp: dec4)
        let transport = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 200, etagHeader: nil, body: Data(#"{"token":"\#(t.raw)"}"#.utf8)))
        ])
        let client = ClaimClient(transport: transport, baseURL: URL(string: "https://claim.test")!)
        let out = await client.claim(ClaimRequest(credential: "jws", claimSecret: secret, current: true))
        #expect(out == .token(t))
        let sent = transport.recorded[0]
        #expect(sent.method == "POST")
        #expect(sent.url.absoluteString == "https://claim.test/v1/entitlement/claim")
        let body = try JSONSerialization.jsonObject(with: sent.body!) as! [String: Any]
        #expect(Set(body.keys) == ["source", "credential", "claim_secret", "replace", "current"])
        #expect(body["source"] as? String == "apple")
        #expect((body["claim_secret"] as? String)?.count == 43)
        #expect(body["current"] as? Bool == true && body["replace"] as? Bool == false)
        #expect(sent.headers["Authorization"] == nil, "the claim carries no household credential")
    }

    @Test func claimAnswersMapToOutcomes() {
        func out(_ status: Int, _ body: String) -> ClaimOutcome {
            ClaimClient.outcome(status: status, body: Data(body.utf8))
        }
        #expect(out(409, #"{"error":"bound-to-other-device"}"#) == .refused(.boundToOtherDevice, retryAfter: nil))
        #expect(out(409, #"{"error":"replacement-used","retry_after":123}"#) == .refused(.replacementUsed, retryAfter: 123))
        #expect(out(402, #"{"error":"payment-pending"}"#) == .refused(.paymentPending, retryAfter: nil))
        #expect(out(402, #"{"error":"inactive"}"#) == .refused(.inactive, retryAfter: nil))
        #expect(out(402, #"{"error":"revoked"}"#) == .refused(.revoked, retryAfter: nil))
        for r in ["unknown-code", "wrong-product", "invalid-receipt", "test-purchase", "family-sharing", "bad-request"] {
            #expect(out(422, #"{"error":"\#(r)"}"#) == .refused(ClaimReason(rawValue: r)!, retryAfter: nil))
        }
        #expect(out(404, #"{"error":"not-found"}"#) == .refused(.unrecognized, retryAfter: nil))
        for status in [429, 500, 502, 503] {
            if case .unavailable = out(status, "{}") {} else { Issue.record("\(status) must retry with backoff") }
        }
        if case .unavailable = out(200, #"{"token":"garbage"}"#) {} else { Issue.record("unreadable token") }
    }

    @Test func offlineClaimIsUnavailable() async {
        let client = ClaimClient(transport: ScriptedTransport([.offline]))
        if case .unavailable = await client.claim(ClaimRequest(credential: "x", claimSecret: Data(count: 32))) {
        } else { Issue.record("offline must be unavailable") }
    }

    // MARK: when to claim

    func applied(_ e: Double) -> ClaimState {
        var s = ClaimState()
        s.appliedHousehold = "h1"
        s.entExp = e
        return s
    }

    @Test func ruleBClaimsAtOnceForAHouseholdWithoutAV2Token() {
        var s = ClaimState()
        s.entExp = dec4
        let (d, _) = ClaimPlan.next(s, now: nov10, householdId: "h1", random: { 0.5 })
        #expect(d.claim && !d.current)
        s.appliedHousehold = "other"
        #expect(ClaimPlan.next(s, now: nov10, householdId: "h1", random: { 0.5 }).0.claim)
    }

    @Test func ruleCWaitsForTheRandomTimeInTheFirstFiveDays() {
        let s = applied(dec4)
        let opens = dec4 - 10 * day
        // Before the window: nothing.
        #expect(!ClaimPlan.next(s, now: opens - 1, householdId: "h1", random: { 0.5 }).0.claim)
        // random 0.5 → 2.5 days into the window.
        let (d1, s1) = ClaimPlan.next(s, now: opens + day, householdId: "h1", random: { 0.5 })
        #expect(!d1.claim)
        #expect(s1.windowAt == opens + 2.5 * day && s1.windowFor == dec4)
        // The drawn time is kept, not redrawn.
        let (d2, _) = ClaimPlan.next(s1, now: opens + 2.5 * day, householdId: "h1", random: { 0.0 })
        #expect(d2.claim && !d2.current)
        // From E − 5 days on: at once, whatever was drawn.
        let (d3, _) = ClaimPlan.next(s, now: dec4 - 5 * day, householdId: "h1", random: { 0.999 })
        #expect(d3.claim)
    }

    @Test func aTokenThatDoesNotMoveETriesAgainADayLater() {
        let s = applied(dec4)
        let now = dec4 - 4 * day
        let same = ClaimPlan.record(.token(token(per: nov10, exp: dec4)), current: false, state: s, now: now)
        #expect(same.notBefore == now + day)
        #expect(!ClaimPlan.next(same, now: now + day - 1, householdId: "h1", random: { 0 }).0.claim)
        #expect(ClaimPlan.next(same, now: now + day, householdId: "h1", random: { 0 }).0.claim)
    }

    @Test func aHeldTokenThatMovesEStopsFurtherClaimsUntilTheServerAppliesIt() {
        let s = applied(dec4)
        let now = dec4 - 4 * day
        let jan4 = dec4 + 31 * day
        let held = ClaimPlan.record(.token(token(per: dec1, exp: jan4)), current: false, state: s, now: now)
        #expect(held.notBefore == nil)
        #expect(!ClaimPlan.next(held, now: now + 1, householdId: "h1", random: { 0 }).0.claim)
        #expect(ClaimPlan.tokenToSend(held)?.exp == jan4)
        // The PUT's answer shows E = jan4: the token is deleted.
        let after = ClaimPlan.observe(
            entExp: jan4, lapsedResponse: false, succeeded: true, state: held, householdId: "h1", now: now + 2)
        #expect(after.tokens.isEmpty && after.entExp == jan4)
    }

    @Test func testHouseholdsClaimInTheLastHour() {
        var s = applied(dec4)
        s.testHousehold = true
        #expect(!ClaimPlan.next(s, now: dec4 - Entitlement.hour - 1, householdId: "h1", random: { 0 }).0.claim)
        #expect(ClaimPlan.next(s, now: dec4 - Entitlement.hour + 1, householdId: "h1", random: { 0 }).0.claim)
    }

    @Test func ruleDClaimsCurrentAtOnceWhenLapsedThenContinuesWithC() {
        var s = applied(dec4)
        let dec26 = dec1 + 25 * day
        let (d, _) = ClaimPlan.next(s, now: dec26, householdId: "h1", random: { 0 })
        #expect(d.claim && d.current)
        // A 402 lapsed also counts, whatever E says locally.
        s.entExp = dec4 + 40 * day
        s.lapsed = true
        #expect(ClaimPlan.next(s, now: dec26, householdId: "h1", random: { 0 }).0 == .init(claim: true, current: true))
        // After the current token: no second current claim; once applied, (c).
        let jan4 = dec4 + 31 * day
        s = applied(dec4)
        s = ClaimPlan.record(.token(token(per: dec1, exp: jan4)), current: true, state: s, now: dec26)
        #expect(!ClaimPlan.next(s, now: dec26 + 1, householdId: "h1", random: { 0 }).0.claim)
        s = ClaimPlan.observe(entExp: jan4, lapsedResponse: false, succeeded: true, state: s, householdId: "h1", now: dec26 + 2)
        #expect(!s.lapsed && !s.lapseClaimed)
        let (c, _) = ClaimPlan.next(s, now: dec26 + 3, householdId: "h1", random: { 0 })
        #expect(c.claim && !c.current, "the January window is already open")
    }

    @Test func claimReasonsSetTheRightWaits() {
        let s = applied(dec4)
        let now = dec4 - 3 * day
        let bound = ClaimPlan.record(.refused(.boundToOtherDevice, retryAfter: nil), current: false, state: s, now: now)
        #expect(bound.notBefore == now + day && !bound.stopped)
        // Once E has passed, a plain (current) claim goes at once despite the wait.
        #expect(ClaimPlan.next(bound, now: dec4 + 1, householdId: "h1", random: { 0 }).0 == .init(claim: true, current: true))
        let used = ClaimPlan.record(.refused(.replacementUsed, retryAfter: now + 30 * day), current: false, state: s, now: now)
        #expect(used.retryAfter == now + 30 * day && used.notBefore == now + 30 * day)
        for r in [ClaimReason.paymentPending, .inactive, .revoked] {
            let x = ClaimPlan.record(.refused(r, retryAfter: nil), current: false, state: s, now: now)
            #expect(x.notBefore == now + day && !x.stopped && x.lastRefusal == r)
        }
        for r in [ClaimReason.unknownCode, .wrongProduct, .invalidReceipt, .testPurchase, .familySharing, .badRequest] {
            let x = ClaimPlan.record(.refused(r, retryAfter: nil), current: false, state: s, now: now)
            #expect(x.stopped)
            #expect(!ClaimPlan.next(x, now: dec4 + day, householdId: "h1", random: { 0 }).0.claim, "stopped even when lapsed")
            #expect(ClaimPlan.next(ClaimPlan.userRetry(x), now: dec4 + day, householdId: "h1", random: { 0 }).0.claim)
        }
    }

    @Test func unavailableBacksOffAndCaps() {
        var s = applied(dec4)
        let now = dec4 - 3 * day
        var waits: [Double] = []
        for _ in 0..<10 {
            s = ClaimPlan.record(.unavailable("503"), current: false, state: s, now: now)
            waits.append(s.notBefore! - now)
        }
        #expect(waits[0] == 5 * 60_000 && waits[1] == 10 * 60_000)
        #expect(waits.last == 6 * Entitlement.hour)
    }

    @Test func tokensAreSentEarliestPeriodFirst() {
        var s = applied(dec4)
        let dec = token(per: dec1, exp: dec4 + 31 * day)
        let nov = token(per: nov10, exp: dec4)
        s.tokens = [dec, nov]
        #expect(ClaimPlan.tokenToSend(s) == nov)
    }

    // MARK: what the screen says

    @Test func noticeIsNeutralUnlessThisDevicesClaimSaidOtherwise() {
        var s = applied(dec4)
        #expect(ClaimPlan.notice(s, now: dec4 - 3 * day) == .none)
        #expect(ClaimPlan.notice(s, now: dec4 - day) == .waiting(lapsed: false))
        #expect(ClaimPlan.notice(s, now: dec4) == .waiting(lapsed: true))
        s.lastRefusal = .boundToOtherDevice
        #expect(ClaimPlan.notice(s, now: dec4) == .waiting(lapsed: true))
        s.lastRefusal = .inactive
        #expect(ClaimPlan.notice(s, now: dec4) == .ended(lapsed: true))
        s.lastRefusal = .revoked
        #expect(ClaimPlan.notice(s, now: dec4 - day) == .ended(lapsed: false))
        s.lastRefusal = .paymentPending
        #expect(ClaimPlan.notice(s, now: dec4) == .paymentProblem(lapsed: true))
        // A test household's E is always under a day away: no early notice.
        var t = applied(dec4)
        t.testHousehold = true
        #expect(ClaimPlan.notice(t, now: dec4 - Entitlement.hour) == .none)
        #expect(ClaimPlan.notice(t, now: dec4) == .waiting(lapsed: true))
    }

    @Test func replaceIsOfferedOnlyWhenBoundElsewhereAndEIsClose() {
        var s = applied(dec4)
        s.lastRefusal = .boundToOtherDevice
        #expect(!ClaimPlan.offersReplace(s, now: dec4 - 3 * day))
        #expect(ClaimPlan.offersReplace(s, now: dec4 - day))
        #expect(!ClaimPlan.offersReplace(s, now: dec4 + 1), "after E: plain claim first")
    }

    // MARK: sync server

    func sealed(_ st: HouseholdState, _ secret: Data) -> Data {
        guard case .success(let k) = SyncCrypto.deriveKeys(rootSecret: secret),
            case .success(let blob) = Household.sealState(st, encKey: k.encKey)
        else { fatalError() }
        return blob
    }

    @Test func syncReadsEAndSendsTheTokenAndWritesWhenForced() async {
        let secret = Data(repeating: 3, count: 32)
        let st = HouseholdState(rev: 2, updatedAt: 2000, updatedBy: "a")
        let transport = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"4\"", body: sealed(st, secret), entitlementExpiresHeader: "1000")),
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"5\"", body: Data(), entitlementExpiresHeader: "2000")),
        ])
        let client = SyncClient(transport: transport, now: { 1 })
        let out = await client.syncOnce(
            SyncInput(rootSecret: secret, local: st, maxSeenRev: 2, deviceId: "a", entitlement: "tok", forceWrite: true))
        #expect(out.status.state == .ok && out.entExp == 2000)
        #expect(transport.recorded.count == 2)
        #expect(transport.recorded[1].headers["X-Sitr-Entitlement"] == "tok")
        #expect(transport.recorded[1].headers["If-Match"] == "\"4\"")
        // Without force and nothing changed: no PUT, E from the GET.
        let t2 = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"4\"", body: sealed(st, secret), entitlementExpiresHeader: "1000"))
        ])
        let out2 = await SyncClient(transport: t2, now: { 1 }).syncOnce(
            SyncInput(rootSecret: secret, local: st, maxSeenRev: 2, deviceId: "a", entitlement: "tok"))
        #expect(t2.recorded.count == 1 && out2.entExp == 1000)
    }

    @Test func sync402ReasonsAreSurfaced() async {
        let secret = Data(repeating: 4, count: 32)
        let st = HouseholdState(rev: 1, updatedAt: 1000, updatedBy: "a")
        let transport = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 404, etagHeader: nil, body: Data())),
            .respond(SyncHTTPResponse(status: 402, etagHeader: nil, body: Data("token-used\n".utf8))),
        ])
        let out = await SyncClient(transport: transport, now: { 1 }).syncOnce(
            SyncInput(rootSecret: secret, local: st, maxSeenRev: 0, deviceId: "a", entitlement: "tok"))
        #expect(out.refusal == .tokenUsed && out.status.state == .error)
        #expect(out.refusal?.retryCreateWithNewClaim == true)
        let lapsed = ScriptedTransport([
            .respond(SyncHTTPResponse(status: 200, etagHeader: "\"4\"", body: sealed(HouseholdState(rev: 1, updatedAt: 900, updatedBy: "b"), secret), entitlementExpiresHeader: "500")),
            .respond(SyncHTTPResponse(status: 402, etagHeader: nil, body: Data("lapsed".utf8), entitlementExpiresHeader: "500")),
        ])
        let out2 = await SyncClient(transport: lapsed, now: { 1 }).syncOnce(
            SyncInput(rootSecret: secret, local: HouseholdState(rev: 2, updatedAt: 2000, updatedBy: "a"), maxSeenRev: 1, deviceId: "a"))
        #expect(out2.refusal == .lapsed && out2.entExp == 500)
        #expect(SyncRefusal.parse(Data("plan-not-accepted\nmore".utf8)) == .planNotAccepted)
        #expect(SyncRefusal.parse(Data("server responded".utf8)) == nil)
    }
}

@Suite struct EntitlementExitTests {
    let day = Entitlement.day
    let dec1: Double = 1_796_083_200_000

    func token(per: Double, exp: Double) -> EntitlementToken {
        let payload = #"{"v":2,"plan":"family","term":"month","per":\#(Int64(per)),"exp":\#(Int64(exp)),"jti":"AAAAAAAAAAAAAAAAAAAAAA"}"#
        return EntitlementToken.parse("sitr-ent-v2.\(base64URLEncode(Data(payload.utf8))).c2ln")!
    }

    @Test func aLapseClaimWithoutAUsableTokenAsksAgain() {
        var s = ClaimState()
        s.appliedHousehold = "h1"
        s.entExp = dec1
        let now = dec1 + 2 * day
        // Answered with a current token: wait for it to reach the server.
        s = ClaimPlan.record(.token(token(per: dec1, exp: dec1 + 34 * day)), current: true, state: s, now: now)
        #expect(!ClaimPlan.next(s, now: now + 1, householdId: "h1", random: { 0 }).0.claim)
        // Only an early token held (or none): ask again with current.
        s.tokens = [token(per: dec1 + 31 * day, exp: dec1 + 65 * day)]
        #expect(ClaimPlan.next(s, now: now + 1, householdId: "h1", random: { 0 }).0 == .init(claim: true, current: true))
        s.tokens = []
        #expect(ClaimPlan.next(s, now: now + 1, householdId: "h1", random: { 0 }).0.claim)
        // And the user's Restore / Try again lifts it whatever is held.
        s.tokens = [token(per: dec1, exp: dec1 + 34 * day)]
        #expect(ClaimPlan.next(ClaimPlan.userRetry(s), now: now + 1, householdId: "h1", random: { 0 }).0.claim)
    }

    @Test func aNewTokenForcesOneWriteNotEveryRound() {
        var s = ClaimState()
        #expect(!ClaimPlan.forcesWrite(s))
        let t = token(per: dec1, exp: dec1 + 34 * day)
        s.tokens = [t]
        #expect(ClaimPlan.forcesWrite(s))
        // A failed round keeps forcing; a successful one stops.
        s = ClaimPlan.observe(entExp: nil, lapsedResponse: false, succeeded: false, state: s, householdId: "h1", now: dec1, forced: t.raw)
        #expect(ClaimPlan.forcesWrite(s))
        s = ClaimPlan.observe(entExp: nil, lapsedResponse: false, succeeded: true, state: s, householdId: "h1", now: dec1, forced: t.raw)
        #expect(!ClaimPlan.forcesWrite(s))
        #expect(ClaimPlan.tokenToSend(s) == t, "still sent on every PUT until E covers it")
    }
}
