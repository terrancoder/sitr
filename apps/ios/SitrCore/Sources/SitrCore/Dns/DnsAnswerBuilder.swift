/// DNS answer crafting — pure byte assembly. Port of DnsAnswerBuilder.kt.
///
/// Blocked A/AAAA are answered NOERROR with 0.0.0.0 / :: (not NXDOMAIN:
/// some apps treat NXDOMAIN as "try the next resolver"); every other type
/// gets NODATA, so HTTPS/SVCB hints cannot bypass the answer. Names are
/// written uncompressed.
import Foundation

public enum DnsAnswerBuilder {
    /// Short, so removing a block (or adding an allow) applies within a minute.
    public static let blockedTTL: UInt32 = 60

    struct ResourceRecord {
        let name: String
        let type: Int
        let ttl: UInt32
        let rdata: [UInt8]
    }

    /// NOERROR + 0.0.0.0 / :: for A / AAAA; NODATA for everything else.
    public static func blocked(_ query: DnsQuery) -> [UInt8] {
        switch query.qtype {
        case DnsMessage.typeA:
            return answer(query, [ResourceRecord(name: query.qname, type: DnsMessage.typeA, ttl: blockedTTL, rdata: [UInt8](repeating: 0, count: 4))])
        case DnsMessage.typeAAAA:
            return answer(query, [ResourceRecord(name: query.qname, type: DnsMessage.typeAAAA, ttl: blockedTTL, rdata: [UInt8](repeating: 0, count: 16))])
        default:
            return nodata(query)
        }
    }

    /// NOERROR with zero answers.
    public static func nodata(_ query: DnsQuery) -> [UInt8] { answer(query, []) }

    /// SafeSearch rewrite: qname CNAME target, plus those of `addresses`
    /// (4- or 16-byte network-order) that match the queried type.
    public static func cnameWithAddresses(
        _ query: DnsQuery, target: String, addresses: [[UInt8]], ttl: UInt32
    ) -> [UInt8] {
        var records = [ResourceRecord(name: query.qname, type: DnsMessage.typeCNAME, ttl: ttl, rdata: DnsMessage.encodeName(target))]
        for address in addresses {
            let type = address.count == 4 ? DnsMessage.typeA : DnsMessage.typeAAAA
            if type != query.qtype { continue }
            records.append(ResourceRecord(name: target, type: type, ttl: ttl, rdata: address))
        }
        return answer(query, records)
    }

    /// A NOERROR response echoing the question.
    static func answer(_ query: DnsQuery, _ records: [ResourceRecord]) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(12 + query.questionBytes.count + records.count * 32)
        func put16(_ v: Int) {
            out.append(UInt8(truncatingIfNeeded: v >> 8))
            out.append(UInt8(truncatingIfNeeded: v))
        }
        put16(query.id)
        // QR=1, opcode 0, AA=0, TC=0, RD copied, RA=1, rcode NOERROR.
        put16(0x8000 | (query.flags & 0x0100) | 0x0080)
        put16(1)  // QDCOUNT
        put16(records.count)  // ANCOUNT
        put16(0)  // NSCOUNT
        put16(0)  // ARCOUNT
        out.append(contentsOf: query.questionBytes)
        for record in records {
            out.append(contentsOf: DnsMessage.encodeName(record.name))
            put16(record.type)
            put16(DnsMessage.classIN)
            put16(Int(record.ttl >> 16))
            put16(Int(record.ttl & 0xffff))
            put16(record.rdata.count)
            out.append(contentsOf: record.rdata)
        }
        return out
    }
}
