/// Household state — the settings a family shares across devices.
/// Port of extension/src/lib/household.ts, pinned by apps/shared/fixtures/
/// {sanitize,merge,blob}.json.
///
/// Merge strategy: last-writer-wins on a monotonic `rev` counter; ties
/// broken by `updatedAt`, then `updatedBy`. String comparisons match the
/// reference's JavaScript semantics (UTF-16 code units), so every
/// implementation picks the same winner.
import Foundation

public struct PinRecord: Equatable {
    public let iterations: Int
    public let saltB64: String
    public let hashB64: String

    public init(iterations: Int, saltB64: String, hashB64: String) {
        self.iterations = iterations
        self.saltB64 = saltB64
        self.hashB64 = hashB64
    }
}

public struct HouseholdState: Equatable {
    public var rev: Int
    public var updatedAt: Double
    public var updatedBy: String
    public var allowDomains: [String]
    public var blockDomains: [String]
    public var devices: [String]
    public var disabledCategories: [String]
    public var pin: PinRecord?
    public var childLockOptions: Bool

    public init(
        rev: Int,
        updatedAt: Double,
        updatedBy: String,
        allowDomains: [String] = [],
        blockDomains: [String] = [],
        devices: [String] = [],
        disabledCategories: [String] = [],
        pin: PinRecord? = nil,
        childLockOptions: Bool = true
    ) {
        self.rev = rev
        self.updatedAt = updatedAt
        self.updatedBy = updatedBy
        self.allowDomains = allowDomains
        self.blockDomains = blockDomains
        self.devices = devices
        self.disabledCategories = disabledCategories
        self.pin = pin
        self.childLockOptions = childLockOptions
    }
}

public enum Household {
    /// Hard cap keeps the encrypted blob far under the server's 64 KiB limit.
    public static let maxHouseholdDomains = 2_000

    /// Fair-use soft cap (threat-model: friction, never surveillance).
    /// Enforced by honest clients only — the server cannot count devices,
    /// which is the product working as designed.
    public static let maxHouseholdDevices = 20

    public static func emptyState(deviceId: String, now: Double) -> HouseholdState {
        HouseholdState(
            rev: 1,
            updatedAt: now,
            updatedBy: deviceId,
            devices: [deviceId]
        )
    }

    /// JavaScript string comparison (UTF-16 code units) — what the
    /// reference's `sort()` and `>` do. ASCII inputs behave identically,
    /// but the parity is kept exact regardless.
    static func jsLess(_ a: String, _ b: String) -> Bool {
        let au = Array(a.utf16)
        let bu = Array(b.utf16)
        var i = 0
        while i < au.count && i < bu.count {
            if au[i] != bu[i] { return au[i] < bu[i] }
            i += 1
        }
        return au.count < bu.count
    }

    static func jsGreater(_ a: String, _ b: String) -> Bool { jsLess(b, a) }

    /// True for an NSNumber that is really a JSON boolean.
    private static func isBool(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private static func asNumber(_ value: Any?) -> Double? {
        guard let value, !isBool(value), let number = value as? NSNumber else {
            return nil
        }
        return number.doubleValue
    }

    private static func sanitizeDomains(_ raw: Any?) -> Result<[String], SitrError> {
        guard let array = raw as? [Any] else { return .success([]) }
        var seen = Set<String>()
        var domains: [String] = []
        for item in array {
            guard let s = item as? String, DomainInput.isValidDomain(s) else { continue }
            if seen.insert(s).inserted { domains.append(s) }
        }
        domains.sort(by: jsLess)
        if domains.count > maxHouseholdDomains {
            return .failure(
                SitrError("household list exceeds \(maxHouseholdDomains) domains")
            )
        }
        return .success(domains)
    }

    static func sanitizePinRecord(_ raw: Any?) -> PinRecord? {
        guard let o = raw as? [String: Any] else { return nil }
        guard
            asNumber(o["v"]) == 1,
            o["algo"] as? String == "PBKDF2-SHA256",
            let iterations = asNumber(o["iterations"]),
            iterations >= 1,
            iterations.truncatingRemainder(dividingBy: 1) == 0,
            let saltB64 = o["saltB64"] as? String,
            let hashB64 = o["hashB64"] as? String,
            Data(base64Encoded: saltB64) != nil,
            Data(base64Encoded: hashB64) != nil
        else { return nil }
        return PinRecord(iterations: Int(iterations), saltB64: saltB64, hashB64: hashB64)
    }

    /// Total validator for anything claiming to be a HouseholdState — used
    /// on every decrypted blob and every storage read. Unknown schema
    /// versions are an ERROR, not a guess.
    public static func sanitize(_ raw: Any?) -> Result<HouseholdState, SitrError> {
        guard let o = raw as? [String: Any] else {
            return .failure(SitrError("household state is not an object"))
        }
        guard asNumber(o["v"]) == 1 else {
            return .failure(SitrError("unknown household state version"))
        }
        guard
            let rev = asNumber(o["rev"]),
            rev.truncatingRemainder(dividingBy: 1) == 0,
            rev >= 1
        else {
            return .failure(SitrError("household state has no valid rev"))
        }
        let allowDomains: [String]
        switch sanitizeDomains(o["allowDomains"]) {
        case .failure(let e): return .failure(e)
        case .success(let v): allowDomains = v
        }
        let blockDomains: [String]
        switch sanitizeDomains(o["blockDomains"]) {
        case .failure(let e): return .failure(e)
        case .success(let v): blockDomains = v
        }

        var devices: [String] = []
        if let rawDevices = o["devices"] as? [Any] {
            var seen = Set<String>()
            for item in rawDevices {
                guard let s = item as? String, !s.isEmpty, s.count <= 64 else { continue }
                if seen.insert(s).inserted { devices.append(s) }
            }
            devices.sort(by: jsLess)
        }
        if devices.count > maxHouseholdDevices {
            return .failure(
                SitrError(
                    "household has more than \(maxHouseholdDevices) devices — see the fair-use policy"
                )
            )
        }

        let updatedAtRaw = asNumber(o["updatedAt"])
        let updatedAt = (updatedAtRaw != nil && updatedAtRaw! >= 0) ? updatedAtRaw! : 0
        let updatedBy = (o["updatedBy"] as? String).map { String($0.prefix(64)) } ?? ""
        let policy = o["policy"] as? [String: Any] ?? [:]
        let lockRaw = policy["childLockOptions"]
        let childLockOptions = !(isBool(lockRaw ?? true) && (lockRaw as? Bool) == false)

        return .success(
            HouseholdState(
                rev: Int(rev),
                updatedAt: updatedAt,
                updatedBy: updatedBy,
                allowDomains: allowDomains,
                blockDomains: blockDomains,
                devices: devices,
                disabledCategories: Categories.sanitizeDisabled(o["disabledCategories"]),
                pin: sanitizePinRecord(o["pin"]),
                childLockOptions: childLockOptions
            )
        )
    }

    /// Last-writer-wins; ties broken by updatedAt, then updatedBy (stable).
    public static func merge(_ a: HouseholdState, _ b: HouseholdState) -> HouseholdState {
        if a.rev != b.rev { return a.rev > b.rev ? a : b }
        if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt ? a : b }
        return jsGreater(a.updatedBy, b.updatedBy) ? a : b
    }

    /// A new revision authored by this device.
    public static func bumpRev(
        _ s: HouseholdState,
        deviceId: String,
        now: Double
    ) -> HouseholdState {
        var next = s
        next.rev += 1
        next.updatedAt = now
        next.updatedBy = deviceId
        return next
    }

    /// The JSON object shape shared with the reference implementation.
    public static func toJSONObject(_ s: HouseholdState) -> [String: Any] {
        var o: [String: Any] = [
            "v": 1,
            "rev": s.rev,
            "updatedAt": s.updatedAt.truncatingRemainder(dividingBy: 1) == 0
                ? Int64(s.updatedAt) as Any : s.updatedAt as Any,
            "updatedBy": s.updatedBy,
            "allowDomains": s.allowDomains,
            "blockDomains": s.blockDomains,
            "devices": s.devices,
            "disabledCategories": s.disabledCategories,
            "policy": ["childLockOptions": s.childLockOptions],
        ]
        if let pin = s.pin {
            o["pin"] = [
                "v": 1,
                "algo": "PBKDF2-SHA256",
                "iterations": pin.iterations,
                "saltB64": pin.saltB64,
                "hashB64": pin.hashB64,
            ] as [String: Any]
        }
        return o
    }

    /// Seal a state for the wire: JSON-encode then SyncCrypto.seal.
    public static func sealState(
        _ state: HouseholdState,
        encKey: Data,
        nonce: Data? = nil
    ) -> Result<Data, SitrError> {
        let object = toJSONObject(state)
        guard
            let plaintext = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.sortedKeys]
            )
        else {
            return .failure(SitrError("state could not be encoded"))
        }
        return SyncCrypto.seal(plaintext: plaintext, encKey: encKey, nonce: nonce)
    }

    /// Open a blob to a SANITIZED state — the full reference openState
    /// pipeline (decrypt, JSON-parse, sanitize).
    public static func openState(blob: Data, encKey: Data) -> Result<HouseholdState, SitrError> {
        switch SyncCrypto.open(blob: blob, encKey: encKey) {
        case .failure(let e):
            return .failure(e)
        case .success(let data):
            guard let parsed = try? JSONSerialization.jsonObject(with: data) else {
                return .failure(SitrError("decrypted blob is not valid JSON"))
            }
            return sanitize(parsed)
        }
    }
}
