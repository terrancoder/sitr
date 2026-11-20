/// Sitr Family entitlement, version 2 (docs/sync-protocol.md §Entitlement
/// version 2): the token format, the claim call, the claim reasons, and the
/// rules for when this device claims. Pure logic, no StoreKit and no
/// Keychain: the app supplies the credential and the claim secret.
///
/// The claim call goes through the same SyncTransport as the sync client —
/// still the app's only network call site, now with a second host.
import Foundation

public enum Entitlement {
    public static let day: Double = 86_400_000
    public static let hour: Double = 3_600_000
    /// The claim host. Only the claim call uses it.
    public static let claimBaseURL = URL(string: "https://claim.sitrshield.com")!

    /// Placeholder App Store product IDs, the one place they are named.
    /// Apple's real products do not exist yet.
    public enum Products {
        public static let monthly = "com.sitrshield.sitr.family.month"
        public static let yearly = "com.sitrshield.sitr.family.year"
        public static let all = [monthly, yearly]
    }
}

// MARK: - Token

/// A version 2 token as the client reads it. The client never checks the
/// signature and never judges the token by its own clock (§Clocks); it
/// reads `per` and `exp` only to order and retire held tokens.
public struct EntitlementToken: Equatable, Codable, Sendable {
    public let raw: String
    public let plan: String
    public let term: String
    public let per: Double
    public let exp: Double
    public let test: Bool

    /// `v: 2`, string `plan` and `term`, integer `per` and `exp`; `test` is
    /// true only when it is the JSON `true`. Anything else: nil.
    public static func parse(_ raw: String) -> EntitlementToken? {
        let parts = raw.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "sitr-ent-v2",
            let bytes = base64URLDecode(String(parts[1])),
            let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
            integer(json["v"]) == 2,
            let plan = json["plan"] as? String,
            let term = json["term"] as? String,
            let per = integer(json["per"]),
            let exp = integer(json["exp"])
        else { return nil }
        return EntitlementToken(
            raw: raw, plan: plan, term: term, per: per, exp: exp,
            test: isJSONBool(json["test"]) && (json["test"] as? Bool) == true)
    }
}

/// JSONSerialization reads `true` as an NSNumber too: tell them apart.
private func isJSONBool(_ v: Any?) -> Bool {
    (v as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false
}

/// A JSON integer (no fraction, within 2^53), not a boolean.
private func integer(_ v: Any?) -> Double? {
    guard let n = v as? NSNumber, !isJSONBool(n) else { return nil }
    let d = n.doubleValue
    return d.rounded() == d && abs(d) <= 9_007_199_254_740_991 ? d : nil
}

func base64URLDecode(_ s: String) -> Data? {
    var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b.count % 4 != 0 { b += "=" }
    return Data(base64Encoded: b)
}

func base64URLEncode(_ d: Data) -> String {
    d.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

// MARK: - Claim call

/// The claim service's refusal reasons (§Claim API) that the client acts on.
public enum ClaimReason: String, Codable, Sendable {
    case boundToOtherDevice = "bound-to-other-device"
    case replacementUsed = "replacement-used"
    case paymentPending = "payment-pending"
    case inactive
    case revoked
    case unknownCode = "unknown-code"
    case wrongProduct = "wrong-product"
    case invalidReceipt = "invalid-receipt"
    case testPurchase = "test-purchase"
    case familySharing = "family-sharing"
    case badRequest = "bad-request"
    /// Anything else the service sends with a 4xx (no such route, too large,
    /// a reason this client does not know): stop until the user acts.
    case unrecognized

    /// "Show the reason and stop until the user acts."
    var stops: Bool {
        switch self {
        case .unknownCode, .wrongProduct, .invalidReceipt, .testPurchase, .familySharing,
            .badRequest, .unrecognized:
            return true
        default: return false
        }
    }
}

public enum ClaimOutcome: Equatable, Sendable {
    case token(EntitlementToken)
    case refused(ClaimReason, retryAfter: Double?)
    /// 429, 502, 503, 500, no network, or an answer that does not parse:
    /// retry at later runs with backoff.
    case unavailable(String)
}

public struct ClaimRequest: Sendable {
    public let credential: String
    public let claimSecret: Data
    public let replace: Bool
    public let current: Bool

    public init(credential: String, claimSecret: Data, replace: Bool = false, current: Bool = false) {
        self.credential = credential
        self.claimSecret = claimSecret
        self.replace = replace
        self.current = current
    }

    /// The request body. `source` is always `apple` from iOS.
    public var body: Data {
        let object: [String: Any] = [
            "source": "apple",
            "credential": credential,
            "claim_secret": base64URLEncode(claimSecret),
            "replace": replace,
            "current": current,
        ]
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }
}

public struct ClaimClient {
    let transport: SyncTransport
    let baseURL: URL

    public init(transport: SyncTransport, baseURL: URL = Entitlement.claimBaseURL) {
        self.transport = transport
        self.baseURL = baseURL
    }

    public func claim(_ request: ClaimRequest) async -> ClaimOutcome {
        let response: SyncHTTPResponse
        do {
            response = try await transport.request(
                method: "POST",
                url: baseURL.appendingPathComponent("v1/entitlement/claim"),
                headers: ["Content-Type": "application/json"],
                body: request.body)
        } catch {
            return .unavailable("offline")
        }
        return Self.outcome(status: response.status, body: response.body)
    }

    public static func outcome(status: Int, body: Data) -> ClaimOutcome {
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        if status == 200 {
            guard let raw = json?["token"] as? String, let token = EntitlementToken.parse(raw) else {
                return .unavailable("the claim service sent a token this app cannot read")
            }
            // A token of another plan (Institutions) is never stored. Apple
            // sells only Family, so this stops until the user acts.
            guard token.plan == "family" else { return .refused(.wrongProduct, retryAfter: nil) }
            return .token(token)
        }
        if status == 429 || status >= 500 {
            return .unavailable("claim service unavailable (\(status))")
        }
        // Not the claim API's JSON (no claim route on that host): as no network.
        guard let error = json?["error"] as? String else {
            return .unavailable("the claim service is not reachable (\(status))")
        }
        let reason = ClaimReason(rawValue: error) ?? .unrecognized
        let retryAfter = (json?["retry_after"] as? NSNumber)?.doubleValue
        return .refused(reason, retryAfter: retryAfter)
    }
}

// MARK: - When to claim

/// What this device remembers about its household's subscription. Kept by
/// the app in App Group storage; never in the household blob.
public struct ClaimState: Codable, Equatable, Sendable {
    /// Rule (b): the household (id) this device has applied a v2 token to.
    public var appliedHousehold: String?
    /// The household was created by a test (`test: true`) token.
    public var testHousehold = false
    /// `E`, from the sync server's X-Sitr-Entitlement-Expires.
    public var entExp: Double?
    /// The renewal window's random first-attempt time, and the `E` it was
    /// drawn for.
    public var windowFor: Double?
    public var windowAt: Double?
    /// No claim before this time (daily retry, backoff, retry_after).
    public var notBefore: Double?
    public var backoff: Double?
    /// A refusal that waits for the user (§Claim errors).
    public var stopped = false
    /// The last refusal this device got, for the texts; nil after a token.
    public var lastRefusal: ClaimReason?
    public var retryAfter: Double?
    /// A `402 lapsed` was seen and no write has succeeded since.
    public var lapsed = false
    /// Rule (d) was answered with a token for the current lapse.
    public var lapseClaimed = false
    /// Rule (d) was refused as bound-to-other-device in the current lapse.
    public var lapseRefused = false
    /// Tokens held and not yet covered by `E`.
    public var tokens: [EntitlementToken] = []
    /// The token already written with a forced write: "write the household
    /// at the next sync", once per token, not on every round.
    public var forcedToken: String?

    public init() {}

    /// A missing field takes its default, so state stored by an earlier
    /// version of the app still reads.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        appliedHousehold = try c.decodeIfPresent(String.self, forKey: .appliedHousehold)
        testHousehold = try c.decodeIfPresent(Bool.self, forKey: .testHousehold) ?? false
        entExp = try c.decodeIfPresent(Double.self, forKey: .entExp)
        windowFor = try c.decodeIfPresent(Double.self, forKey: .windowFor)
        windowAt = try c.decodeIfPresent(Double.self, forKey: .windowAt)
        notBefore = try c.decodeIfPresent(Double.self, forKey: .notBefore)
        backoff = try c.decodeIfPresent(Double.self, forKey: .backoff)
        stopped = try c.decodeIfPresent(Bool.self, forKey: .stopped) ?? false
        lastRefusal = try c.decodeIfPresent(ClaimReason.self, forKey: .lastRefusal)
        retryAfter = try c.decodeIfPresent(Double.self, forKey: .retryAfter)
        lapsed = try c.decodeIfPresent(Bool.self, forKey: .lapsed) ?? false
        lapseClaimed = try c.decodeIfPresent(Bool.self, forKey: .lapseClaimed) ?? false
        lapseRefused = try c.decodeIfPresent(Bool.self, forKey: .lapseRefused) ?? false
        tokens = try c.decodeIfPresent([EntitlementToken].self, forKey: .tokens) ?? []
        forcedToken = try c.decodeIfPresent(String.self, forKey: .forcedToken)
        // Stored before lapseRefused existed: a bound-elsewhere answer then
        // set a daily or retry_after wait, which now would hold back the
        // claim due once E has passed.
        if !c.contains(.lapseRefused), lastRefusal == .boundToOtherDevice || lastRefusal == .replacementUsed {
            notBefore = nil
        }
    }
}

/// What the Family screen says about the subscription (§Sync 402).
public enum FamilyNotice: Equatable, Sendable {
    case none
    /// The neutral "Waiting for renewal" notice. The default.
    case waiting(lapsed: Bool)
    /// Only after a claim on THIS device came back inactive or revoked.
    case ended(lapsed: Bool)
    /// After a claim on this device came back payment-pending.
    case paymentProblem(lapsed: Bool)
    /// After a rebind refused as replacement-used, until its retry_after.
    case replacementUsed(until: Double)
}

public enum ClaimPlan {
    static let firstBackoff: Double = 5 * 60_000
    static let maxBackoff: Double = 6 * Entitlement.hour

    public struct Decision: Equatable {
        public let claim: Bool
        public let current: Bool
        static let none = Decision(claim: false, current: false)
    }

    public static func isLapsed(_ s: ClaimState, now: Double) -> Bool {
        s.lapsed || (s.entExp.map { $0 <= now } ?? false)
    }

    /// Rules (b), (c) and (d) of §When to claim, for a device that holds a
    /// credential and is in household `householdId`. `random` is uniform in
    /// [0, 1). Returns the decision and the state with the window drawn.
    public static func next(
        _ state: ClaimState, now: Double, householdId: String, random: () -> Double
    ) -> (Decision, ClaimState) {
        var s = state
        if s.stopped { return (.none, s) }
        let lapsed = isLapsed(s, now: now)
        // Bound elsewhere and E in the future (or no E): no automatic claim.
        if boundElsewhere(s) && !lapsed { return (.none, s) }
        if lapsed {
            // (d). Wait for the held current token to reach the server; an
            // early token alone, or none (it expired unused), asks again.
            // Refused as bound in this lapse: at most once a day (notBefore).
            if s.lapseClaimed, s.tokens.contains(where: { $0.per <= now }) { return (.none, s) }
            if let nb = s.notBefore, now < nb { return (.none, s) }
            return (Decision(claim: true, current: true), s)
        }
        if let nb = s.notBefore, now < nb { return (.none, s) }
        // (b): never applied a v2 token to this household. With no E header
        // this is the only rule: one claim, then none while the token is held.
        if s.appliedHousehold != householdId {
            return (s.tokens.isEmpty ? Decision(claim: true, current: false) : .none, s)
        }
        guard let e = s.entExp else { return (.none, s) }
        // A held token that moves E reaches the server at the next write.
        if s.tokens.contains(where: { $0.exp > e }) { return (.none, s) }
        // (c) the renewal window.
        let due: Bool
        if s.testHousehold {
            due = e - now < Entitlement.hour
        } else {
            let opens = e - 10 * Entitlement.day
            let fast = e - 5 * Entitlement.day
            if s.windowFor != e {
                s.windowFor = e
                s.windowAt = opens + random() * (fast - opens)
            }
            due = now >= (s.windowAt ?? fast) || now >= fast
        }
        return (due ? Decision(claim: true, current: false) : .none, s)
    }

    /// Folds a claim's answer into the state (§Claim errors).
    public static func record(
        _ outcome: ClaimOutcome, current: Bool, state: ClaimState, now: Double
    ) -> ClaimState {
        var s = state
        switch outcome {
        case .token(let t):
            if !s.tokens.contains(t) { s.tokens.append(t) }
            s.stopped = false
            s.lastRefusal = nil
            s.retryAfter = nil
            s.backoff = nil
            s.notBefore = nil
            s.lapseRefused = false
            if current { s.lapseClaimed = true }
            // A token that does not move E (a monthly renewal still ahead):
            // try again a day later.
            if let e = s.entExp, t.exp <= e { s.notBefore = now + Entitlement.day }
        case .refused(let reason, let retryAfter):
            s.lastRefusal = reason
            s.backoff = nil
            if reason.stops {
                s.stopped = true
            } else if reason == .replacementUsed {
                // Still bound elsewhere (next() reads lastRefusal); the date
                // is for the text and for "Renew on this device".
                s.retryAfter = retryAfter
            } else if reason == .boundToOtherDevice {
                // Refused while lapsed: at most once a day. Otherwise no
                // retry at all while E is in the future.
                s.notBefore = current ? now + Entitlement.day : nil
                if current { s.lapseRefused = true }
            } else {
                // payment-pending, inactive, revoked: at most once a day.
                s.notBefore = now + Entitlement.day
            }
        case .unavailable:
            let next = min(max((s.backoff ?? 0) * 2, firstBackoff), maxBackoff)
            s.backoff = next
            s.notBefore = now + next
        }
        return s
    }

    /// The household was just created with `token` (201). `entExp` is the
    /// answer's header, nil when it had none: an E seen before goes too.
    public static func created(
        _ state: ClaimState, token: EntitlementToken, householdId: String, entExp: Double?
    ) -> ClaimState {
        var s = state
        s.tokens.removeAll { $0.raw == token.raw }
        s.appliedHousehold = householdId
        s.testHousehold = token.test
        s.entExp = entExp
        s.lapsed = false
        s.lapseClaimed = false
        s.lapseRefused = false
        return s
    }

    /// The credential changed (a new purchase on this device): everything
    /// this device knew about its own claims goes; what the sync server said
    /// about the household stays.
    public static func forgetClaims(_ state: ClaimState) -> ClaimState {
        var s = ClaimState()
        s.testHousehold = state.testHousehold
        s.entExp = state.entExp
        s.lapsed = state.lapsed
        return s
    }

    /// The bound-to-other-device answer is remembered (replacement-used is
    /// also an answer that the subscription is bound elsewhere).
    static func boundElsewhere(_ s: ClaimState) -> Bool {
        s.lastRefusal == .boundToOtherDevice || s.lastRefusal == .replacementUsed
    }

    /// Only a device that may hold the subscription claims: never a child.
    public static func mayClaim(role: HouseholdRole?) -> Bool { role != .child }

    /// The user asked (Restore, Try again): lift waits and stops. The memory
    /// of a bound-to-other-device answer stays (§Claim errors).
    public static func userRetry(_ state: ClaimState) -> ClaimState {
        var s = state
        s.stopped = false
        s.notBefore = nil
        s.backoff = nil
        s.lapseClaimed = false
        return s
    }

    /// Whether the next round writes even when nothing changed: once for
    /// each new token.
    public static func forcesWrite(_ s: ClaimState) -> Bool {
        guard let t = tokenToSend(s) else { return false }
        return t.raw != s.forcedToken
    }

    /// Folds a sync round's answer into the state: the server's `E`, a
    /// `402 lapsed`, and whether the round succeeded. A successful round
    /// without the header is a version 1 household: no E, never lapsed. A
    /// failed round without it changes nothing about E.
    public static func observe(
        entExp: Double?, lapsedResponse: Bool, succeeded: Bool,
        state: ClaimState, householdId: String, now: Double, forced: String? = nil
    ) -> ClaimState {
        var s = state
        if succeeded, let forced { s.forcedToken = forced }
        if let e = entExp {
            s.entExp = e
            let before = s.tokens.count
            // "Delete it once a response shows E ≥ its exp."
            s.tokens.removeAll { $0.exp <= e }
            if s.tokens.count < before { s.appliedHousehold = householdId }
        } else if succeeded {
            s.entExp = nil
        }
        if lapsedResponse {
            s.lapsed = true
        } else if succeeded, s.entExp.map({ $0 > now }) ?? true {
            s.lapsed = false
            s.lapseClaimed = false
            s.lapseRefused = false
        }
        // An unused token simply expires; the same claim gets it again.
        s.tokens.removeAll { $0.exp <= now }
        return s
    }

    /// The token to send on the next PUT: the earliest period first, so a
    /// next-month (early) token goes at the following write.
    public static func tokenToSend(_ s: ClaimState) -> EntitlementToken? {
        s.tokens.min { $0.per < $1.per }
    }

    /// The Family screen's state (§Sync 402). The 2-day notice does not
    /// apply to test households, whose `E` is always less than a day away.
    public static func notice(_ s: ClaimState, now: Double) -> FamilyNotice {
        let lapsed = isLapsed(s, now: now)
        let soon = !s.testHousehold && (s.entExp.map { $0 - now < 2 * Entitlement.day } ?? false)
        guard lapsed || soon else { return .none }
        switch s.lastRefusal {
        case .inactive, .revoked: return .ended(lapsed: lapsed)
        case .paymentPending: return .paymentProblem(lapsed: lapsed)
        default:
            if let until = s.retryAfter, now < until { return .replacementUsed(until: until) }
            return .waiting(lapsed: lapsed)
        }
    }

    /// Offer "Renew on this device" (replace: true, plus current: true when
    /// lapsed; asked first): another device holds the binding and E is less
    /// than 2 days away; once E has passed, only after the claim without
    /// replace was refused; never before a replacement-used retry_after.
    public static func offersReplace(_ s: ClaimState, now: Double) -> Bool {
        guard boundElsewhere(s), let e = s.entExp else { return false }
        if let until = s.retryAfter, now < until { return false }
        if isLapsed(s, now: now) { return s.lapseRefused }
        return e - now < 2 * Entitlement.day
    }
}

// MARK: - Sync 402 reasons

/// The sync server's 402 reasons (§Sync-server rules), first line of the body.
public enum SyncRefusal: String, Sendable {
    case lapsed
    case tokenRequired = "token-required"
    case tokenInvalid = "token-invalid"
    case tokenExpired = "token-expired"
    case planNotAccepted = "plan-not-accepted"
    case tokenUsed = "token-used"
    case v1Ended = "v1-ended"

    /// The version 1 server's 402 bodies (server-hotfix-live), read as reasons.
    static let version1Bodies: [String: SyncRefusal] = [
        "entitlement required": .tokenRequired,
        "malformed entitlement token": .tokenInvalid,
        "invalid entitlement signature": .tokenInvalid,
        "malformed entitlement payload": .tokenInvalid,
        "unsupported entitlement version": .tokenInvalid,
        "entitlement expired — please renew": .tokenExpired,
    ]

    public static func parse(_ body: Data) -> SyncRefusal? {
        let text = String(decoding: body, as: UTF8.self)
        let first = (text.split(separator: "\n", omittingEmptySubsequences: false).first ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return SyncRefusal(rawValue: first) ?? version1Bodies[first]
    }

    /// "Claim once more, then retry the creation once."
    public var retryCreateWithNewClaim: Bool {
        switch self {
        case .tokenUsed, .tokenExpired, .tokenInvalid, .tokenRequired: return true
        default: return false
        }
    }

    public var message: String {
        switch self {
        case .lapsed:
            return "waiting for renewal"
        case .planNotAccepted:
            return "This is a code for Sitr for Institutions."
        case .v1Ended:
            return "This subscription needs renewing before the household can be created."
        case .tokenRequired, .tokenInvalid, .tokenExpired, .tokenUsed:
            return "the subscription could not be confirmed (\(rawValue))"
        }
    }
}
