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

    public static func parse(_ raw: String) -> EntitlementToken? {
        let parts = raw.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "sitr-ent-v2",
            let bytes = base64URLDecode(String(parts[1])),
            let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
            (json["v"] as? NSNumber)?.intValue == 2,
            let plan = json["plan"] as? String,
            let term = json["term"] as? String,
            let per = (json["per"] as? NSNumber)?.doubleValue,
            let exp = (json["exp"] as? NSNumber)?.doubleValue
        else { return nil }
        return EntitlementToken(
            raw: raw, plan: plan, term: term, per: per, exp: exp,
            test: (json["test"] as? Bool) ?? false)
    }
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
            return .token(token)
        }
        if status == 429 || status >= 500 {
            return .unavailable("claim service unavailable (\(status))")
        }
        let reason = (json?["error"] as? String).flatMap(ClaimReason.init(rawValue:)) ?? .unrecognized
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
    /// Tokens held and not yet covered by `E`.
    public var tokens: [EntitlementToken] = []
    /// The token already written with a forced write: "write the household
    /// at the next sync", once per token, not on every round.
    public var forcedToken: String?

    public init() {}
}

/// What the Family screen says about the subscription (§Sync 402).
public enum FamilyNotice: Equatable, Sendable {
    case none
    /// "Waiting for renewal on the subscriber's device." The default.
    case waiting(lapsed: Bool)
    /// Only after a claim on THIS device came back inactive or revoked.
    case ended(lapsed: Bool)
    /// After a claim on this device came back payment-pending.
    case paymentProblem(lapsed: Bool)
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
        // (d) at once, also past a daily wait set by bound-to-other-device:
        // once E has passed, the old binding is stale and a plain claim binds.
        if lapsed {
            // Wait for the held current token to reach the server; but an
            // early token alone, or none (it expired unused), asks again.
            if s.lapseClaimed, s.tokens.contains(where: { $0.per <= now }) { return (.none, s) }
            if let nb = s.notBefore, now < nb, s.lastRefusal != .boundToOtherDevice {
                return (.none, s)
            }
            return (Decision(claim: true, current: true), s)
        }
        if let nb = s.notBefore, now < nb { return (.none, s) }
        // (b): never applied a v2 token to this household.
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
                s.retryAfter = retryAfter
                s.notBefore = max(retryAfter ?? 0, now + Entitlement.day)
            } else {
                // bound-to-other-device: watch E; payment-pending, inactive,
                // revoked: at most once a day.
                s.notBefore = now + Entitlement.day
            }
        case .unavailable:
            let next = min(max((s.backoff ?? 0) * 2, firstBackoff), maxBackoff)
            s.backoff = next
            s.notBefore = now + next
        }
        return s
    }

    /// The user asked (Restore, Try again): lift waits and stops.
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
    /// `402 lapsed`, and whether the round succeeded.
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
        }
        if lapsedResponse {
            s.lapsed = true
        } else if succeeded, let e = s.entExp, e > now {
            s.lapsed = false
            s.lapseClaimed = false
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
        default: return .waiting(lapsed: lapsed)
        }
    }

    /// Offer "renew on this device" (replace: true, asked first): only when
    /// another device holds the binding and E is less than 2 days away.
    public static func offersReplace(_ s: ClaimState, now: Double) -> Bool {
        guard s.lastRefusal == .boundToOtherDevice, let e = s.entExp, !isLapsed(s, now: now) else {
            return false
        }
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

    public static func parse(_ body: Data) -> SyncRefusal? {
        let text = String(decoding: body, as: UTF8.self)
        let first = text.split(separator: "\n", omittingEmptySubsequences: false).first ?? ""
        return SyncRefusal(rawValue: first.trimmingCharacters(in: .whitespacesAndNewlines))
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
