/// Sync client — pull → merge → push against the one documented endpoint
/// (docs/data-flow.md, docs/sync-protocol.md).
/// Port of extension/src/lib/sync/client.ts.
///
/// THIS FILE'S TRANSPORT IS THE iOS APP'S ONLY NETWORK CALL SITE —
/// data-flow.md invites auditors to verify that claim; keep it true.
///
/// INVARIANT: sync outcomes touch ONLY the sync status and household
/// state. They never touch protection status — filtering is local, so a
/// dead server leaves protection fully intact.
///
/// Rollback detection: we remember the highest household rev ever
/// decrypted (`maxSeenRev`). An authenticated blob with a lower rev is an
/// error ("server returned an older state"), surfaced but never applied.
import Foundation

public struct SyncHTTPResponse {
    public let status: Int
    public let etagHeader: String?
    public let body: Data
    /// X-Sitr-Entitlement-Expires: the household's end `E` (epoch ms), sent
    /// by an enforcing server (docs/sync-protocol.md §Telling clients the end).
    public let entitlementExpiresHeader: String?

    public init(status: Int, etagHeader: String?, body: Data, entitlementExpiresHeader: String? = nil) {
        self.status = status
        self.etagHeader = etagHeader
        self.body = body
        self.entitlementExpiresHeader = entitlementExpiresHeader
    }

    var entExp: Double? {
        guard let raw = entitlementExpiresHeader?.trimmingCharacters(in: .whitespaces),
            !raw.isEmpty, raw.count <= 16, raw.allSatisfy({ $0.isASCII && $0.isNumber })
        else { return nil }
        return Double(raw)
    }
}

/// Injected transport — the app wires URLSession in exactly one place;
/// tests inject a stub. Throwing means "offline".
public protocol SyncTransport {
    func request(
        method: String,
        url: URL,
        headers: [String: String],
        body: Data?
    ) async throws -> SyncHTTPResponse
}

public struct SyncInput {
    public let rootSecret: Data
    /// The locally applied state (may be ahead of the server's).
    public let local: HouseholdState
    /// Highest rev this device has ever decrypted from the server.
    public let maxSeenRev: Int
    public let deviceId: String
    /// Signed subscription token: sent with every push when set
    /// (docs/sync-protocol.md §Using the token).
    public let entitlement: String?
    /// Write the household even when nothing changed, so a new token
    /// reaches the server.
    public let forceWrite: Bool

    public init(
        rootSecret: Data,
        local: HouseholdState,
        maxSeenRev: Int,
        deviceId: String,
        entitlement: String? = nil,
        forceWrite: Bool = false
    ) {
        self.rootSecret = rootSecret
        self.local = local
        self.maxSeenRev = maxSeenRev
        self.deviceId = deviceId
        self.entitlement = entitlement
        self.forceWrite = forceWrite
    }
}

public struct SyncOutcome: Equatable {
    /// The state the caller must apply + persist (merge result).
    public let state: HouseholdState
    public let maxSeenRev: Int
    public let status: SyncStatus
    /// ETag of the server copy after this sync (diagnostics only).
    public let etag: Int?
    /// The household's end `E` from the last response that carried it.
    public var entExp: Double? = nil
    /// The sync server's 402 reason, when a write was refused with one.
    public var refusal: SyncRefusal? = nil
}

public struct SyncClient {
    public static let defaultBaseURL = URL(string: "https://sync.sitrshield.com")!

    let transport: SyncTransport
    let now: () -> Double
    let baseURL: URL

    public init(
        transport: SyncTransport,
        now: @escaping () -> Double,
        baseURL: URL = SyncClient.defaultBaseURL
    ) {
        self.transport = transport
        self.now = now
        self.baseURL = baseURL
    }

    static func parseEtag(_ raw: String?) -> Int? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard
            trimmed.count >= 3, trimmed.hasPrefix("\""), trimmed.hasSuffix("\""),
            case let digits = String(trimmed.dropFirst().dropLast()),
            digits.count <= 15, !digits.isEmpty,
            digits.allSatisfy({ $0.isASCII && $0.isNumber })
        else { return nil }
        return Int(digits)
    }

    struct Remote {
        let state: HouseholdState?
        let etag: Int?
        var entExp: Double? = nil
    }

    enum PullError: Error {
        case offline
        case message(String)
    }

    func blobURL(_ keys: SyncCrypto.HouseholdKeys) -> URL {
        baseURL.appendingPathComponent("v1/blob/\(keys.householdId)")
    }

    func pull(keys: SyncCrypto.HouseholdKeys) async -> Result<Remote, PullError> {
        let response: SyncHTTPResponse
        do {
            response = try await transport.request(
                method: "GET",
                url: blobURL(keys),
                headers: ["Authorization": "Bearer \(keys.authToken)"],
                body: nil
            )
        } catch {
            return .failure(.offline)
        }
        if response.status == 404 { return .success(Remote(state: nil, etag: nil, entExp: response.entExp)) }
        guard (200..<300).contains(response.status) else {
            return .failure(.message("server responded \(response.status)"))
        }
        let etag = Self.parseEtag(response.etagHeader)
        switch Household.openState(blob: response.body, encKey: keys.encKey) {
        case .failure(let e): return .failure(.message(e.message))
        case .success(let state): return .success(Remote(state: state, etag: etag, entExp: response.entExp))
        }
    }

    enum PushError: Error {
        case offline
        case conflict
        case message(String)
        case refused(SyncRefusal, entExp: Double?)
    }

    func push(
        keys: SyncCrypto.HouseholdKeys,
        state: HouseholdState,
        etag: Int?,
        entitlement: String?
    ) async -> Result<(etag: Int, entExp: Double?), PushError> {
        let sealed = Household.sealState(state, encKey: keys.encKey)
        guard case .success(let blob) = sealed else {
            if case .failure(let e) = sealed { return .failure(.message(e.message)) }
            return .failure(.message("seal failed"))
        }
        var headers = ["Authorization": "Bearer \(keys.authToken)"]
        if let etag {
            headers["If-Match"] = "\"\(etag)\""
        } else {
            headers["If-None-Match"] = "*"
        }
        if let entitlement, !entitlement.isEmpty {
            headers["X-Sitr-Entitlement"] = entitlement
        }
        let response: SyncHTTPResponse
        do {
            response = try await transport.request(
                method: "PUT",
                url: blobURL(keys),
                headers: headers,
                body: blob
            )
        } catch {
            return .failure(.offline)
        }
        if response.status == 409 { return .failure(.conflict) }
        if response.status == 402, let reason = SyncRefusal.parse(response.body) {
            return .failure(.refused(reason, entExp: response.entExp))
        }
        guard (200..<300).contains(response.status) else {
            return .failure(.message("server responded \(response.status)"))
        }
        return .success((Self.parseEtag(response.etagHeader) ?? 0, response.entExp))
    }

    /// One full sync round. Never throws. The returned state is always safe
    /// to apply: merged, sanitized (via openState), and rollback-checked.
    public func syncOnce(_ input: SyncInput) async -> SyncOutcome {
        func failed(_ error: String, offline: Bool = false) -> SyncOutcome {
            SyncOutcome(
                state: input.local,
                maxSeenRev: input.maxSeenRev,
                status: SyncStatus(state: offline ? .offline : .error, error: error),
                etag: nil
            )
        }

        let derived = SyncCrypto.deriveKeys(rootSecret: input.rootSecret)
        guard case .success(let keys) = derived else {
            if case .failure(let e) = derived { return failed(e.message) }
            return failed("key derivation failed")
        }

        enum AttemptError: Error {
            case retry
            case offline
            case message(String)
            case refused(SyncRefusal, entExp: Double?)
        }

        func attempt() async -> Result<SyncOutcome, AttemptError> {
            let remote: Remote
            switch await pull(keys: keys) {
            case .failure(.offline): return .failure(.offline)
            case .failure(.message(let m)): return .failure(.message(m))
            case .success(let r): remote = r
            }

            var merged = input.local
            var maxSeen = input.maxSeenRev
            if let remoteState = remote.state {
                if remoteState.rev < input.maxSeenRev {
                    return .failure(
                        .message(
                            "server returned an older household state than previously seen — refusing to apply it"
                        ))
                }
                maxSeen = max(maxSeen, remoteState.rev)
                merged = Household.merge(input.local, remoteState)
            }
            // Push only when the server copy differs from the merge result.
            if let remoteState = remote.state, remoteState.rev == merged.rev,
                remoteState == merged, !input.forceWrite
            {
                return .success(
                    SyncOutcome(
                        state: merged,
                        maxSeenRev: max(maxSeen, merged.rev),
                        status: SyncStatus(state: .ok, lastSuccessAt: now()),
                        etag: remote.etag,
                        entExp: remote.entExp
                    ))
            }
            let toPush: HouseholdState
            if let remoteState = remote.state, remoteState.rev >= merged.rev,
                remoteState != merged
            {
                toPush = Household.bumpRev(merged, deviceId: input.deviceId, now: now())
            } else {
                toPush = merged
            }
            switch await push(
                keys: keys, state: toPush, etag: remote.etag,
                entitlement: input.entitlement)
            {
            case .failure(.conflict): return .failure(.retry)
            case .failure(.offline): return .failure(.offline)
            case .failure(.message(let m)): return .failure(.message(m))
            case .failure(.refused(let r, let e)): return .failure(.refused(r, entExp: e ?? remote.entExp))
            case .success(let pushed):
                return .success(
                    SyncOutcome(
                        state: toPush,
                        maxSeenRev: max(maxSeen, toPush.rev),
                        status: SyncStatus(state: .ok, lastSuccessAt: now()),
                        etag: pushed.etag,
                        entExp: pushed.entExp ?? remote.entExp
                    ))
            }
        }

        func refused(_ reason: SyncRefusal, _ entExp: Double?) -> SyncOutcome {
            var out = failed(reason.message)
            out.entExp = entExp
            out.refusal = reason
            return out
        }

        switch await attempt() {
        case .success(let outcome): return outcome
        case .failure(.offline): return failed("offline", offline: true)
        case .failure(.message(let m)): return failed(m)
        case .failure(.refused(let r, let e)): return refused(r, e)
        case .failure(.retry):
            // One concurrent-write retry: re-pull, re-merge, re-push.
            switch await attempt() {
            case .success(let outcome): return outcome
            case .failure(.retry): return failed("repeated version conflicts")
            case .failure(.offline): return failed("offline", offline: true)
            case .failure(.message(let m)): return failed(m)
            case .failure(.refused(let r, let e)): return refused(r, e)
            }
        }
    }
}
