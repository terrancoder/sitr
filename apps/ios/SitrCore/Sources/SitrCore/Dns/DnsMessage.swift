/// DNS wire-format parsing — strict, pure. Port of
/// apps/android/core/.../dns/DnsMessage.kt; behaviour-identical, pinned to
/// it by the shared vectors in DnsCodecTests.
///
/// Every function here reads bytes sent by any app on the phone, so the
/// input is hostile: every index is bounds-checked, and a malformed packet
/// returns nil (or comes back unchanged) instead of trapping. Functions
/// take `[UInt8]`, which always starts at index 0 — convert a `Data` with
/// `[UInt8](data)` first, never pass a slice's indices along.
import Foundation

/// A parsed single-question standard query.
public struct DnsQuery: Equatable, Sendable {
    public let id: Int
    public let flags: Int
    /// Lowercased, no trailing dot. Each wire byte is one character
    /// (Latin-1), as in the Kotlin parser — never decoded as UTF-8.
    public let qname: String
    public let qtype: Int
    public let qclass: Int
    /// The raw question section, echoed verbatim into answers.
    public let questionBytes: [UInt8]

    public var recursionDesired: Bool { flags & 0x0100 != 0 }
}

public enum DnsMessage {
    public static let typeA = 1
    public static let typeCNAME = 5
    public static let typeAAAA = 28
    public static let typeSVCB = 64
    public static let typeHTTPS = 65
    public static let typeANY = 255
    public static let classIN = 1

    /// Parse a DNS QUERY payload: exactly one question, standard opcode,
    /// QR=0, no compression pointer in the qname, label ≤ 63 and name
    /// ≤ 254 wire bytes. Anything else is nil and the caller DROPS it
    /// (forwarding what the filter cannot read lets a blocked name
    /// through). The Kotlin doc comment says such packets are "forwarded
    /// raw"; its code and DnsForwarder drop them, and so does this port.
    public static func parseQuery(_ payload: [UInt8]) -> DnsQuery? {
        if payload.count < 12 + 1 + 4 { return nil }
        let id = u16(payload, 0)
        let flags = u16(payload, 2)
        if flags & 0x8000 != 0 { return nil }  // a response, not a query
        if (flags >> 11) & 0xf != 0 { return nil }  // non-standard opcode
        if u16(payload, 4) != 1 { return nil }  // QDCOUNT must be exactly 1

        var scalars = String.UnicodeScalarView()
        var offset = 12
        var totalLength = 0
        while true {
            if offset >= payload.count { return nil }
            let len = Int(payload[offset])
            if len == 0 {
                offset += 1
                break
            }
            if len & 0xc0 != 0 { return nil }  // compression pointer in a query
            if len > 63 { return nil }
            if offset + 1 + len > payload.count { return nil }
            totalLength += len + 1
            if totalLength > 254 { return nil }
            if !scalars.isEmpty { scalars.append(".") }
            for i in 0..<len {
                scalars.append(Unicode.Scalar(payload[offset + 1 + i]))
            }
            offset += 1 + len
        }
        // An empty name is the root (". NS"): legitimate, nothing to block.
        if offset + 4 > payload.count { return nil }
        return DnsQuery(
            id: id,
            flags: flags,
            qname: String(scalars).lowercased(),
            qtype: u16(payload, offset),
            qclass: u16(payload, offset + 2),
            questionBytes: Array(payload[12..<(offset + 4)])
        )
    }

    /// True when `reply` answers `query`: same id, QR set, and (when the
    /// query parsed) exactly one question equal to `question` — name bytes
    /// ASCII-case-insensitive, type and class exact. Check every upstream
    /// datagram with this before caching or returning it.
    public static func isReplyTo(_ query: [UInt8], question: [UInt8]?, reply: [UInt8]) -> Bool {
        if query.count < 12 || reply.count < 12 { return false }
        if reply[0] != query[0] || reply[1] != query[1] { return false }
        if reply[2] & 0x80 == 0 { return false }
        guard let question else { return true }
        if u16(reply, 4) != 1 || reply.count < 12 + question.count { return false }
        let nameLength = question.count - 4
        for i in 0..<question.count {
            var a = question[i]
            var b = reply[12 + i]
            if i < nameLength {
                if a >= 0x41 && a <= 0x5a { a += 32 }
                if b >= 0x41 && b <= 0x5a { b += 32 }
            }
            if a != b { return false }
        }
        return true
    }

    /// A reply carrying only the header (QR, TC, RA, RD as asked, NOERROR)
    /// and the question: "too big for this path". nil for an unparseable query.
    public static func truncatedReply(to query: [UInt8]) -> [UInt8]? {
        guard let q = parseQuery(query) else { return nil }
        return [query[0], query[1], 0x80 | 0x02 | (query[2] & 0x01), 0x80, 0, 1, 0, 0, 0, 0, 0, 0] + q.questionBytes
    }

    /// The TC bit: the answer did not fit in the datagram.
    public static func isTruncated(_ message: [UInt8]) -> Bool {
        message.count > 2 && message[2] & 0x02 != 0
    }

    /// RCODE (0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN), or -1 when too short.
    public static func rcode(_ message: [UInt8]) -> Int {
        message.count > 3 ? Int(message[3] & 0x0f) : -1
    }

    /// Copy of `message` with every record TTL lowered to at most `max`
    /// seconds; the EDNS OPT record (type 41) is left alone. Names are
    /// skipped, never followed, so pointer loops cannot spin. Anything
    /// unparseable comes back unchanged.
    /// ponytail: costs more upstream queries for long-TTL names; the 60 s
    /// DnsCache in front absorbs most of them (same as Kotlin).
    public static func capTtls(_ message: [UInt8], max: UInt32) -> [UInt8] {
        if message.count < 12 { return message }
        var out = message
        var p = 12
        func skipName() -> Bool {
            while p < out.count {
                let len = Int(out[p])
                if len == 0 {
                    p += 1
                    return true
                } else if len & 0xc0 == 0xc0 {
                    p += 2
                    return p <= out.count
                } else {
                    p += 1 + len
                }
            }
            return false
        }
        for _ in 0..<u16(out, 4) {
            if !skipName() || p + 4 > out.count { return message }
            p += 4
        }
        let records = u16(out, 6) + u16(out, 8) + u16(out, 10)
        for _ in 0..<records {
            if !skipName() || p + 10 > out.count { return message }
            if u16(out, p) != 41 {
                let ttl =
                    UInt32(out[p + 4]) << 24 | UInt32(out[p + 5]) << 16
                    | UInt32(out[p + 6]) << 8 | UInt32(out[p + 7])
                if ttl > max {
                    for i in 0..<4 { out[p + 4 + i] = UInt8(truncatingIfNeeded: max >> (24 - 8 * i)) }
                }
            }
            p += 10 + u16(out, p + 8)
            if p > out.count { return message }
        }
        return out
    }

    /// Big-endian u16. Callers check bounds first.
    static func u16(_ bytes: [UInt8], _ offset: Int) -> Int {
        Int(bytes[offset]) << 8 | Int(bytes[offset + 1])
    }

    /// Encode a dotted name as uncompressed labels. Mirrors Kotlin's
    /// `toByteArray(US_ASCII)`: a non-ASCII character becomes `?`.
    static func encodeName(_ name: String) -> [UInt8] {
        var trimmed = Substring(name)
        while trimmed.hasSuffix(".") { trimmed = trimmed.dropLast() }
        var out: [UInt8] = []
        out.reserveCapacity(trimmed.utf8.count + 2)
        for label in trimmed.split(separator: ".", omittingEmptySubsequences: false) {
            let bytes = label.unicodeScalars.map { $0.value < 0x80 ? UInt8($0.value) : 0x3f }
            out.append(UInt8(truncatingIfNeeded: bytes.count))
            out.append(contentsOf: bytes)
        }
        out.append(0)
        return out
    }
}
