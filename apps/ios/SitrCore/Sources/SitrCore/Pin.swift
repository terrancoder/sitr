/// Guardian PIN — pure derivation and lockout policy.
/// Port of extension/src/lib/pin.ts, pinned by apps/shared/fixtures/pin.json.
///
/// The PIN is FRICTION, not security (threat-model.md): it stops a child
/// from casually loosening the filter. That limitation is stated, never
/// overclaimed. Hashing: PBKDF2-SHA256 (CommonCrypto), salted per record.
/// Lockout: no delay for the first few attempts, then exponential backoff.
/// The attempt counter is persisted BEFORE reporting failure so an app
/// restart cannot reset it.
import CommonCrypto
import Foundation

public struct PinAttempts: Equatable {
    public let count: Int
    /// Epoch ms until which verification is refused. 0 = not locked.
    public let lockedUntil: Double

    public init(count: Int, lockedUntil: Double) {
        self.count = count
        self.lockedUntil = lockedUntil
    }
}

public enum Pin {
    public static let iterations = 600_000
    public static let minLength = 4
    public static let maxLength = 32

    public static let noAttempts = PinAttempts(count: 0, lockedUntil: 0)

    static let freeAttempts = 4
    static let baseDelayMs: Double = 30_000
    static let maxDelayMs: Double = 15 * 60_000

    public static func isValidInput(_ pin: String) -> Result<Void, SitrError> {
        guard pin.count >= minLength && pin.count <= maxLength else {
            return .failure(
                SitrError("PIN must be \(minLength)–\(maxLength) characters"))
        }
        return .success(())
    }

    public static func hash(pin: String, salt: Data, iterations: Int) -> Data {
        let pinBytes = Array(pin.utf8)
        var derived = Data(count: 32)
        derived.withUnsafeMutableBytes { derivedBuf in
            salt.withUnsafeBytes { saltBuf in
                _ = CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    pin,
                    pinBytes.count,
                    saltBuf.bindMemory(to: UInt8.self).baseAddress,
                    salt.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                    UInt32(iterations),
                    derivedBuf.bindMemory(to: UInt8.self).baseAddress,
                    32
                )
            }
        }
        return derived
    }

    public static func createRecord(pin: String) -> Result<PinRecord, SitrError> {
        if case .failure(let e) = isValidInput(pin) { return .failure(e) }
        var salt = Data(count: 16)
        salt.withUnsafeMutableBytes { buf in
            guard let base = buf.baseAddress else { return }
            _ = SecRandomCopyBytes(kSecRandomDefault, 16, base)
        }
        let hashed = hash(pin: pin, salt: salt, iterations: iterations)
        return .success(
            PinRecord(
                iterations: iterations,
                saltB64: salt.base64EncodedString(),
                hashB64: hashed.base64EncodedString()
            ))
    }

    /// Constant-time-ish comparison; length leak is fine (fixed 32 bytes).
    static func bytesEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count {
            diff |= a[a.startIndex + i] ^ b[b.startIndex + i]
        }
        return diff == 0
    }

    public static func verify(pin: String, record: PinRecord) -> Bool {
        guard
            let salt = Data(base64Encoded: record.saltB64),
            let expected = Data(base64Encoded: record.hashB64)
        else { return false }
        let got = hash(pin: pin, salt: salt, iterations: record.iterations)
        return bytesEqual(got, expected)
    }

    /// Attempt state after one more failure at time `now` (epoch ms).
    public static func backoffAfterFailure(count: Int, now: Double) -> PinAttempts {
        let next = count + 1
        if next <= freeAttempts { return PinAttempts(count: next, lockedUntil: 0) }
        let delay = min(
            baseDelayMs * pow(2, Double(next - freeAttempts - 1)),
            maxDelayMs
        )
        return PinAttempts(count: next, lockedUntil: now + delay)
    }

    public static func isLockedOut(
        _ attempts: PinAttempts,
        now: Double
    ) -> Result<Void, SitrError> {
        if attempts.lockedUntil > now {
            return .failure(SitrError("locked until \(attempts.lockedUntil)"))
        }
        return .success(())
    }
}
