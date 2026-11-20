import Foundation
import StoreKit
import SitrCore

/// The two hosts the app talks to: the sync server and, for Sitr Family
/// claims only, the claim service (docs/sync-protocol.md §What each client
/// must do). Release builds use the production constants and nothing else.
enum Endpoints {
    static var sync: URL {
        #if DEBUG
        if let url = debugOverride("SitrSyncBaseURL", env: "SITR_LOCAL_SYNC") { return url }
        #endif
        return SyncClient.defaultBaseURL
    }

    static var claim: URL {
        #if DEBUG
        if let url = debugOverride("SitrClaimBaseURL", env: "SITR_LOCAL_CLAIM") { return url }
        #endif
        return Entitlement.claimBaseURL
    }

    #if DEBUG
    /// Debug builds only: point the app at local test servers, for example
    /// `-SitrSyncBaseURL http://127.0.0.1:8787 -SitrClaimBaseURL
    /// http://127.0.0.1:8788` (launch arguments land in standard defaults),
    /// or the environment SitrAppTests runs with (SITR_LOCAL_SYNC /
    /// SITR_LOCAL_CLAIM), which covers the host app's own launch-time sync.
    private static func debugOverride(_ key: String, env: String) -> URL? {
        let raw = UserDefaults.standard.string(forKey: key) ?? ProcessInfo.processInfo.environment[env]
        guard let raw, !raw.isEmpty else { return nil }
        return URL(string: raw)
    }
    #endif
}

/// Sitr Family on this device: the claim state (App Group storage, never
/// the household blob), the StoreKit credential, and the claim call. The
/// app stores no credential: StoreKit holds the transaction.
enum Family {
    private static let stateKey = "familyClaimState"

    static func loadState() -> ClaimState {
        guard let data = Storage.defaults.data(forKey: stateKey),
            let state = try? JSONDecoder().decode(ClaimState.self, from: data)
        else { return ClaimState() }
        return state
    }

    static func saveState(_ state: ClaimState) {
        if let data = try? JSONEncoder().encode(state) {
            Storage.defaults.set(data, forKey: stateKey)
        }
    }

    static func update(_ change: (inout ClaimState) -> Void) {
        var s = loadState()
        change(&s)
        saveState(s)
    }

    static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    /// A household key made for a creation that has had no definite answer
    /// yet (App Group storage).
    static var createPending: Bool {
        get { Storage.defaults.bool(forKey: "familyCreatePending") }
        set { Storage.defaults.set(newValue, forKey: "familyCreatePending") }
    }

    /// The latest transaction of either product, expired ones included (an
    /// expired one gets `inactive` from the claim service, which is what
    /// lets this device say "ended"). nil: no purchase on this Apple ID.
    static func latestTransaction() async -> VerificationResult<Transaction>? {
        var best: VerificationResult<Transaction>?
        for id in Entitlement.Products.all {
            guard let result = await Transaction.latest(for: id) else { continue }
            if let b = best, b.unsafePayloadValue.purchaseDate >= result.unsafePayloadValue.purchaseDate {
                continue
            }
            best = result
        }
        return best
    }

    /// An active subscription on this Apple ID.
    static func isSubscribed() async -> Bool {
        for await result in Transaction.currentEntitlements {
            if Entitlement.Products.all.contains(result.unsafePayloadValue.productID) { return true }
        }
        return false
    }

    /// One claim with this device's credential and claim secret. nil: no
    /// credential (no purchase on this Apple ID), no claim secret, or a
    /// child-role device, which never claims.
    /// `credential`: the just-purchased transaction (right after a purchase
    /// `Transaction.latest` may not list it yet); otherwise the latest one.
    static func claim(current: Bool, replace: Bool = false, credential: String? = nil) async -> ClaimOutcome? {
        guard ClaimPlan.mayClaim(role: SettingsStore.load().role.flatMap(HouseholdRole.init(rawValue:))) else {
            return nil
        }
        var jws = credential
        if jws == nil { jws = await latestTransaction()?.jwsRepresentation }
        guard let credential = jws, let secret = Storage.claimSecret() else { return nil }
        let client = ClaimClient(transport: URLSessionTransport(), baseURL: Endpoints.claim)
        let outcome = await client.claim(
            ClaimRequest(credential: credential, claimSecret: secret, replace: replace, current: current))
        update { $0 = ClaimPlan.record(outcome, current: current, state: $0, now: nowMs) }
        return outcome
    }

    /// Renewal: claims when §When to claim says so and this device holds a
    /// credential. Runs before every sync round (foreground, background,
    /// Transaction.updates). Returns the claim's outcome, nil if none ran.
    @discardableResult
    static func renewIfDue(householdId: String) async -> ClaimOutcome? {
        let (decision, drawn) = ClaimPlan.next(
            loadState(), now: nowMs, householdId: householdId, random: { Double.random(in: 0..<1) })
        saveState(drawn)
        guard decision.claim else { return nil }
        return await claim(current: decision.current)
    }

    /// The household's id, as the sync server knows it.
    static func householdId(_ secret: Data) -> String? {
        if case .success(let keys) = SyncCrypto.deriveKeys(rootSecret: secret) { return keys.householdId }
        return nil
    }

    // MARK: - Texts

    static func text(_ notice: FamilyNotice) -> String? {
        switch notice {
        case .none:
            return nil
        case .waiting(let lapsed):
            return (lapsed ? "" : "Renewal is due. ")
                + "Waiting for renewal on the guardian device that renews the Family plan. Filtering continues; changes will sync after renewal."
        case .ended(let lapsed):
            return lapsed
                ? "Sitr Family has ended. Filtering continues with the last settings; renew the subscription to sync changes again."
                : "Sitr Family is ending: the subscription is no longer active. Renew it to keep the household syncing."
        case .paymentProblem:
            return "Payment problem: update the payment method of your Apple Account to keep Sitr Family. Filtering continues."
        case .replacementUsed(let until):
            return text(.replacementUsed, retryAfter: until)
        }
    }

    static func text(_ reason: ClaimReason, retryAfter: Double?) -> String {
        switch reason {
        case .boundToOtherDevice:
            return "Another device renews this subscription."
        case .replacementUsed:
            let when = retryAfter.map {
                Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .omitted)
            } ?? "later"
            return "The renewing device was already moved recently. It can be moved again on \(when)."
        case .paymentPending:
            return "The payment is being retried. Update the payment method of your Apple Account."
        case .inactive:
            return "The subscription is not active. Subscribe again to keep Sitr Family."
        case .revoked:
            return "The purchase was refunded or revoked."
        case .testPurchase:
            return "This purchase was made in a test environment and cannot be used here."
        case .familySharing:
            return "A subscription shared through Family Sharing cannot create a household. Subscribe on this Apple Account."
        case .invalidReceipt, .wrongProduct, .unknownCode, .badRequest, .unrecognized:
            return "The purchase could not be confirmed (\(reason.rawValue)). Try Restore Purchases, or contact support."
        }
    }
}
