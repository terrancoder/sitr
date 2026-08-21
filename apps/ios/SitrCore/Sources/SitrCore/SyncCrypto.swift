/// Sync crypto — key derivation and blob sealing.
/// Port of extension/src/lib/sync/crypto.ts; the wire format is normative
/// in docs/sync-protocol.md and pinned by apps/shared/fixtures/{hkdf,blob}.json.
///
/// The server never sees the root secret or the encryption key — only the
/// derived household id, the derived bearer credential, and an opaque
/// AES-256-GCM blob. The three derivations are independent HKDF outputs:
/// knowing any one of them reveals nothing about the others.
import CryptoKit
import Foundation

public enum SyncCrypto {
    public static let rootSecretBytes = 32
    public static let blobVersion: UInt8 = 0x01
    public static let maxBlobBytes = 64 * 1024

    static let infoEncryptionKey = "sitr-sync v1 encryption key"
    static let infoAuthCredential = "sitr-sync v1 auth credential"
    static let infoHouseholdId = "sitr-sync v1 household id"
    static let aad = Data("sitr-sync v1".utf8)

    public struct HouseholdKeys: Equatable {
        /// AES-256-GCM key bytes for sealing/opening the state blob.
        public let encKey: Data
        /// Bearer credential sent to the server (which stores only its SHA-256).
        public let authToken: String
        /// URL path id for the household's blob.
        public let householdId: String
    }

    public static func generateRootSecret() -> Data {
        var bytes = Data(count: rootSecretBytes)
        bytes.withUnsafeMutableBytes { buf in
            guard let base = buf.baseAddress else { return }
            _ = SecRandomCopyBytes(kSecRandomDefault, rootSecretBytes, base)
        }
        return bytes
    }

    public static func toHex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    public static func fromHex(_ hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            out.append(byte)
            index = next
        }
        return out
    }

    static func hkdf(secret: Data, info: String, bytes: Int) -> Data {
        let derived = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: secret),
            salt: Data(),
            info: Data(info.utf8),
            outputByteCount: bytes
        )
        return derived.withUnsafeBytes { Data($0) }
    }

    public static func deriveKeys(rootSecret: Data) -> Result<HouseholdKeys, SitrError> {
        guard rootSecret.count == rootSecretBytes else {
            return .failure(SitrError("root secret must be \(rootSecretBytes) bytes"))
        }
        return .success(
            HouseholdKeys(
                encKey: hkdf(secret: rootSecret, info: infoEncryptionKey, bytes: 32),
                authToken: toHex(hkdf(secret: rootSecret, info: infoAuthCredential, bytes: 32)),
                householdId: toHex(hkdf(secret: rootSecret, info: infoHouseholdId, bytes: 16))
            )
        )
    }

    /// Blob layout: version byte ‖ 12-byte nonce ‖ AES-GCM ciphertext+tag.
    /// `plaintext` is the UTF-8 JSON of a HouseholdState.
    public static func seal(
        plaintext: Data,
        encKey: Data,
        nonce: Data? = nil
    ) -> Result<Data, SitrError> {
        let nonceBytes = nonce ?? generateNonce()
        guard nonceBytes.count == 12 else {
            return .failure(SitrError("nonce must be 12 bytes"))
        }
        let sealed: AES.GCM.SealedBox
        do {
            sealed = try AES.GCM.seal(
                plaintext,
                using: SymmetricKey(data: encKey),
                nonce: AES.GCM.Nonce(data: nonceBytes),
                authenticating: aad
            )
        } catch {
            return .failure(SitrError("seal failed"))
        }
        var blob = Data([blobVersion])
        blob.append(nonceBytes)
        blob.append(sealed.ciphertext)
        blob.append(sealed.tag)
        if blob.count > maxBlobBytes {
            return .failure(SitrError("sealed blob exceeds \(maxBlobBytes) bytes"))
        }
        return .success(blob)
    }

    /// Opens a blob to the raw plaintext. State-level sanitizing lives in
    /// `Household.openState`, mirroring the reference's openState pipeline.
    public static func open(blob: Data, encKey: Data) -> Result<Data, SitrError> {
        guard blob.count >= 1 + 12 + 16 else {
            return .failure(SitrError("blob too short"))
        }
        guard blob[blob.startIndex] == blobVersion else {
            return .failure(SitrError("unknown blob version: \(blob[blob.startIndex])"))
        }
        let nonce = blob.subdata(in: blob.startIndex + 1..<blob.startIndex + 13)
        let ctAndTag = blob.subdata(in: blob.startIndex + 13..<blob.endIndex)
        let ciphertext = ctAndTag.dropLast(16)
        let tag = ctAndTag.suffix(16)
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: nonce),
                ciphertext: ciphertext,
                tag: tag
            )
            let plaintext = try AES.GCM.open(
                box,
                using: SymmetricKey(data: encKey),
                authenticating: aad
            )
            return .success(plaintext)
        } catch {
            return .failure(
                SitrError("blob failed authentication — wrong key or tampered data")
            )
        }
    }

    static func generateNonce() -> Data {
        var bytes = Data(count: 12)
        bytes.withUnsafeMutableBytes { buf in
            guard let base = buf.baseAddress else { return }
            _ = SecRandomCopyBytes(kSecRandomDefault, 12, base)
        }
        return bytes
    }
}
