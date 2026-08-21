/// Pairing codes — Crockford Base32(version ‖ rootSecret ‖ CRC-16), grouped
/// for readability. Port of the pairing-code half of
/// extension/src/lib/sync/crypto.ts, pinned by apps/shared/fixtures/
/// {pairing,crc16}.json. Possession of this code IS household membership.
import Foundation

public enum PairingCode {
    /// Crockford Base32 — no I, L, O, U; case-insensitive on decode.
    static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    static let pairVersion: UInt8 = 0x01

    /// CRC-16/CCITT-FALSE over the payload, catches typos in manual entry.
    public static func crc16(_ bytes: Data) -> UInt16 {
        var crc: UInt32 = 0xffff
        for byte in bytes {
            crc ^= UInt32(byte) << 8
            for _ in 0..<8 {
                crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
            }
        }
        return UInt16(crc)
    }

    static func b32encode(_ bytes: Data) -> String {
        var bits = 0
        var acc = 0
        var out = ""
        for byte in bytes {
            acc = (acc << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[(acc >> (bits - 5)) & 31])
                bits -= 5
            }
        }
        if bits > 0 {
            out.append(alphabet[(acc << (5 - bits)) & 31])
        }
        return out
    }

    static func b32decode(_ s: String) -> Result<Data, SitrError> {
        let normalized = s.uppercased()
            .replacingOccurrences(of: "O", with: "0")
            .replacingOccurrences(of: "I", with: "1")
            .replacingOccurrences(of: "L", with: "1")
        var bits = 0
        var acc = 0
        var out = Data()
        for ch in normalized {
            guard let v = alphabet.firstIndex(of: ch) else {
                return .failure(SitrError("invalid pairing-code character: \(ch)"))
            }
            acc = (acc << 5) | v
            bits += 5
            if bits >= 8 {
                out.append(UInt8((acc >> (bits - 8)) & 0xff))
                bits -= 8
            }
        }
        return .success(out)
    }

    public static func encode(rootSecret: Data) -> String {
        var payload = Data([pairVersion])
        payload.append(rootSecret)
        let crc = crc16(payload)
        payload.append(UInt8(crc >> 8))
        payload.append(UInt8(crc & 0xff))
        let raw = b32encode(payload)
        // Group in 4-character blocks joined by dashes.
        var groups: [String] = []
        var index = raw.startIndex
        while index < raw.endIndex {
            let end = raw.index(index, offsetBy: 4, limitedBy: raw.endIndex) ?? raw.endIndex
            groups.append(String(raw[index..<end]))
            index = end
        }
        return groups.joined(separator: "-")
    }

    public static func decode(_ code: String) -> Result<Data, SitrError> {
        let cleaned = code.filter { $0 != "-" && !$0.isWhitespace }
        let decoded = b32decode(cleaned)
        guard case .success(let payload) = decoded else { return decoded }
        guard payload.count >= 1 + SyncCrypto.rootSecretBytes + 2 else {
            return .failure(SitrError("pairing code is too short"))
        }
        guard payload[payload.startIndex] == pairVersion else {
            return .failure(SitrError("pairing code is from a newer version of Sitr"))
        }
        let bodyEnd = payload.startIndex + 1 + SyncCrypto.rootSecretBytes
        let body = payload.subdata(in: payload.startIndex..<bodyEnd)
        let expected = crc16(body)
        let got = (UInt16(payload[bodyEnd]) << 8) | UInt16(payload[bodyEnd + 1])
        guard expected == got else {
            return .failure(
                SitrError("pairing code check failed — please re-check the characters")
            )
        }
        return .success(body.subdata(in: body.startIndex + 1..<body.endIndex))
    }
}
