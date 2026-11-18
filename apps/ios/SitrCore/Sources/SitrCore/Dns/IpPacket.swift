/// Minimal IPv4/IPv6 + UDP codec and TCP RST crafting for a DNS-only
/// tunnel. Ports of IpPacket.kt and TcpReset.kt. Fragments, IPv6
/// extension headers and non-UDP protocols parse to nil. All checksums are
/// computed (the IPv6 UDP checksum is mandatory, RFC 8200). Input is
/// hostile: every read is bounds-checked; malformed → nil.
import Foundation

public struct UdpDatagram: Equatable, Sendable {
    public let ipVersion: Int
    public let srcIp: [UInt8]
    public let dstIp: [UInt8]
    public let srcPort: Int
    public let dstPort: Int
    public let payload: [UInt8]
}

public enum IpPacket {
    public static let protoUDP: UInt8 = 17
    public static let protoTCP: UInt8 = 6

    public static func ipVersion(_ packet: [UInt8]) -> Int {
        packet.isEmpty ? 0 : Int(packet[0] >> 4)
    }

    /// A UDP datagram out of an IPv4 or IPv6 packet; nil otherwise.
    public static func parseUdp(_ packet: [UInt8]) -> UdpDatagram? {
        switch ipVersion(packet) {
        case 4: return parseUdp4(packet)
        case 6: return parseUdp6(packet)
        default: return nil
        }
    }

    private static func parseUdp4(_ packet: [UInt8]) -> UdpDatagram? {
        if packet.count < 20 { return nil }
        let ihl = Int(packet[0] & 0x0f) * 4
        if ihl < 20 || packet.count < ihl + 8 { return nil }
        if packet[9] != protoUDP { return nil }
        if u16(packet, 6) & 0x3fff != 0 { return nil }  // MF set or fragment offset
        let udpLen = u16(packet, ihl + 4)
        if udpLen < 8 || ihl + udpLen > packet.count { return nil }
        return UdpDatagram(
            ipVersion: 4,
            srcIp: Array(packet[12..<16]),
            dstIp: Array(packet[16..<20]),
            srcPort: u16(packet, ihl),
            dstPort: u16(packet, ihl + 2),
            payload: Array(packet[(ihl + 8)..<(ihl + udpLen)])
        )
    }

    private static func parseUdp6(_ packet: [UInt8]) -> UdpDatagram? {
        if packet.count < 40 + 8 { return nil }
        if packet[6] != protoUDP { return nil }  // no extension headers
        let payloadLen = u16(packet, 4)
        if payloadLen < 8 || 40 + payloadLen > packet.count { return nil }
        return UdpDatagram(
            ipVersion: 6,
            srcIp: Array(packet[8..<24]),
            dstIp: Array(packet[24..<40]),
            srcPort: u16(packet, 40),
            dstPort: u16(packet, 42),
            payload: Array(packet[48..<(40 + payloadLen)])
        )
    }

    /// The reply datagram: addresses and ports swapped, checksums correct.
    public static func buildUdpReply(_ request: UdpDatagram, payload: [UInt8]) -> [UInt8] {
        let udpLen = 8 + payload.count
        if request.ipVersion == 4 {
            var p = [UInt8](repeating: 0, count: 20 + udpLen)
            p[0] = 0x45
            put16(&p, 2, 20 + udpLen)
            put16(&p, 6, 0x4000)  // DF
            p[8] = 64
            p[9] = protoUDP
            p.replaceSubrange(12..<16, with: request.dstIp.prefix(4))
            p.replaceSubrange(16..<20, with: request.srcIp.prefix(4))
            put16(&p, 10, checksum(p, 0, 20))
            put16(&p, 20, request.dstPort)
            put16(&p, 22, request.srcPort)
            put16(&p, 24, udpLen)
            p.replaceSubrange(28..<(28 + payload.count), with: payload)
            let seed = pseudoSum(p, 12, 8) + Int(protoUDP) + udpLen
            let sum = checksum(p, 20, udpLen, seed: seed)
            put16(&p, 26, sum == 0 ? 0xffff : sum)
            return p
        }
        var p = [UInt8](repeating: 0, count: 40 + udpLen)
        p[0] = 0x60
        put16(&p, 4, udpLen)
        p[6] = protoUDP
        p[7] = 64  // hop limit
        p.replaceSubrange(8..<24, with: request.dstIp.prefix(16))
        p.replaceSubrange(24..<40, with: request.srcIp.prefix(16))
        put16(&p, 40, request.dstPort)
        put16(&p, 42, request.srcPort)
        put16(&p, 44, udpLen)
        p.replaceSubrange(48..<(48 + payload.count), with: payload)
        let seed = pseudoSum(p, 8, 32) + udpLen + Int(protoUDP)
        let sum = checksum(p, 40, udpLen, seed: seed)
        put16(&p, 46, sum == 0 ? 0xffff : sum)  // never zero over IPv6
        return p
    }

    /// RFC 1071 ones'-complement checksum over `bytes[offset..<offset+length]`.
    static func checksum(_ bytes: [UInt8], _ offset: Int, _ length: Int, seed: Int = 0) -> Int {
        var sum = seed
        var i = offset
        let end = offset + length
        while i + 1 < end {
            sum += u16(bytes, i)
            i += 2
        }
        if i < end { sum += Int(bytes[i]) << 8 }
        while sum >> 16 != 0 { sum = (sum & 0xffff) + (sum >> 16) }
        return ~sum & 0xffff
    }

    /// Plain sum of 16-bit words (pseudo-header addresses).
    static func pseudoSum(_ bytes: [UInt8], _ offset: Int, _ length: Int) -> Int {
        var sum = 0
        var i = offset
        while i < offset + length {
            sum += u16(bytes, i)
            i += 2
        }
        return sum
    }

    static func u16(_ bytes: [UInt8], _ offset: Int) -> Int { DnsMessage.u16(bytes, offset) }

    static func put16(_ bytes: inout [UInt8], _ offset: Int, _ value: Int) {
        bytes[offset] = UInt8(truncatingIfNeeded: value >> 8)
        bytes[offset + 1] = UInt8(truncatingIfNeeded: value)
    }
}

/// TCP reaching the tunnel: a SYN (e.g. a DNS-over-TLS :853 probe, or a
/// TCP :53 retry) gets a RST/ACK so the client fails fast; everything else
/// is nil and the caller drops it.
public enum TcpReset {
    public static func buildRstFor(_ packet: [UInt8]) -> [UInt8]? {
        switch IpPacket.ipVersion(packet) {
        case 4:
            if packet.count < 20 { return nil }
            let ihl = Int(packet[0] & 0x0f) * 4
            if ihl < 20 || packet.count < ihl + 20 { return nil }
            if packet[9] != IpPacket.protoTCP { return nil }
            guard isBareSyn(packet[ihl + 13]) else { return nil }
            var r = [UInt8](repeating: 0, count: 40)
            r[0] = 0x45
            IpPacket.put16(&r, 2, 40)
            IpPacket.put16(&r, 6, 0x4000)  // DF
            r[8] = 64
            r[9] = IpPacket.protoTCP
            r.replaceSubrange(12..<16, with: packet[16..<20])  // reply src = request dst
            r.replaceSubrange(16..<20, with: packet[12..<16])
            IpPacket.put16(&r, 10, IpPacket.checksum(r, 0, 20))
            fill(&r, tcp: 20, from: packet, tcpIn: ihl)
            let seed = IpPacket.pseudoSum(r, 12, 8) + Int(IpPacket.protoTCP) + 20
            IpPacket.put16(&r, 36, IpPacket.checksum(r, 20, 20, seed: seed))
            return r
        case 6:
            if packet.count < 40 + 20 { return nil }
            if packet[6] != IpPacket.protoTCP { return nil }
            guard isBareSyn(packet[40 + 13]) else { return nil }
            var r = [UInt8](repeating: 0, count: 60)
            r[0] = 0x60
            IpPacket.put16(&r, 4, 20)
            r[6] = IpPacket.protoTCP
            r[7] = 64
            r.replaceSubrange(8..<24, with: packet[24..<40])
            r.replaceSubrange(24..<40, with: packet[8..<24])
            fill(&r, tcp: 40, from: packet, tcpIn: 40)
            let seed = IpPacket.pseudoSum(r, 8, 32) + 20 + Int(IpPacket.protoTCP)
            IpPacket.put16(&r, 56, IpPacket.checksum(r, 40, 20, seed: seed))
            return r
        default:
            return nil
        }
    }

    /// SYN set, ACK clear.
    private static func isBareSyn(_ flags: UInt8) -> Bool { flags & 0x02 != 0 && flags & 0x10 == 0 }

    /// Ports swapped, seq 0, ack = client seq + 1 (wrapping), RST|ACK.
    private static func fill(_ r: inout [UInt8], tcp: Int, from packet: [UInt8], tcpIn: Int) {
        IpPacket.put16(&r, tcp, IpPacket.u16(packet, tcpIn + 2))
        IpPacket.put16(&r, tcp + 2, IpPacket.u16(packet, tcpIn))
        let seq = UInt32(IpPacket.u16(packet, tcpIn + 4)) << 16 | UInt32(IpPacket.u16(packet, tcpIn + 6))
        let ack = seq &+ 1
        IpPacket.put16(&r, tcp + 8, Int(ack >> 16))
        IpPacket.put16(&r, tcp + 10, Int(ack & 0xffff))
        r[tcp + 12] = 0x50  // data offset 5 words
        r[tcp + 13] = 0x14  // RST | ACK
    }
}
