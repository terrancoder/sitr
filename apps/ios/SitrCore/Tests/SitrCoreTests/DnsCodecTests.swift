/// DNS + IP codec golden tests. Vectors are the SAME as the Kotlin tests
/// (apps/android/core/src/test/.../DnsCodecTest.kt, TcpResetTest.kt), so
/// both ports are pinned to the wire format and to each other. Packets are
/// hand-assembled, never produced by the code under test.
import Foundation
import Testing

@testable import SitrCore

/// DnsCodecTest.query(): a DNS query payload for `name` / `qtype`.
func dnsQuery(_ name: String, _ qtype: Int, id: Int = 0x1234, flags: Int = 0x0100) -> [UInt8] {
    var out: [UInt8] = []
    func put16(_ v: Int) { out += [UInt8(truncatingIfNeeded: v >> 8), UInt8(truncatingIfNeeded: v)] }
    put16(id); put16(flags); put16(1); put16(0); put16(0); put16(0)
    for label in name.split(separator: ".", omittingEmptySubsequences: false) {
        out.append(UInt8(label.utf8.count))
        out += Array(label.utf8)
    }
    out.append(0)
    put16(qtype); put16(DnsMessage.classIN)
    return out
}

/// DnsCodecTest.refChecksum: independent RFC 1071 checksum.
func refChecksum(_ b: [UInt8], _ offset: Int, _ length: Int, _ seed: Int) -> Int {
    var sum = seed
    var i = offset
    while i + 1 < offset + length { sum += Int(b[i]) << 8 | Int(b[i + 1]); i += 2 }
    if i < offset + length { sum += Int(b[i]) << 8 }
    while sum >> 16 != 0 { sum = (sum & 0xffff) + (sum >> 16) }
    return ~sum & 0xffff
}

private func u16(_ b: [UInt8], _ o: Int) -> Int { Int(b[o]) << 8 | Int(b[o + 1]) }

/// DnsCodecTest.buildIpv4UdpPacket.
private func ipv4Udp(_ src: [UInt8], _ dst: [UInt8], _ sport: Int, _ dport: Int, _ payload: [UInt8]) -> [UInt8] {
    let udpLen = 8 + payload.count
    var p = [UInt8](repeating: 0, count: 20 + udpLen)
    p[0] = 0x45
    p[2] = UInt8((20 + udpLen) >> 8); p[3] = UInt8((20 + udpLen) & 0xff)
    p[8] = 64; p[9] = 17
    p.replaceSubrange(12..<16, with: src); p.replaceSubrange(16..<20, with: dst)
    let s = refChecksum(p, 0, 20, 0)
    p[10] = UInt8(s >> 8); p[11] = UInt8(s & 0xff)
    p[20] = UInt8(sport >> 8); p[21] = UInt8(sport & 0xff)
    p[22] = UInt8(dport >> 8); p[23] = UInt8(dport & 0xff)
    p[24] = UInt8(udpLen >> 8); p[25] = UInt8(udpLen & 0xff)
    p.replaceSubrange(28..<(28 + payload.count), with: payload)
    return p
}

@Suite struct DnsCodecTests {
    // DnsCodecTest.unusualButLegitimateQueriesStillParse
    @Test func unusualButLegitimateQueriesStillParse() throws {
        #expect(DnsMessage.parseQuery(dnsQuery("_dmarc.example.com", 16))?.qname == "_dmarc.example.com")
        #expect(DnsMessage.parseQuery(dnsQuery("_sip._tcp.example.com", 33))?.qname == "_sip._tcp.example.com")
        #expect(DnsMessage.parseQuery(dnsQuery("a.example", 1, flags: 0x0130)) != nil)
        var high = dnsQuery("xa.example", 1)
        high[13] = 0xE9
        #expect(DnsMessage.parseQuery(high)?.qname == "\u{e9}a.example")  // one byte, one char
        let root: [UInt8] = [0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1]
        #expect(DnsMessage.parseQuery(root)?.qname == "")
    }

    // DnsCodecTest.parsesAWellFormedQuery
    @Test func parsesAWellFormedQuery() throws {
        let q = try #require(DnsMessage.parseQuery(dnsQuery("Blocked.Example", DnsMessage.typeA)))
        #expect(q.id == 0x1234 && q.qname == "blocked.example" && q.qtype == 1 && q.qclass == 1 && q.recursionDesired)
    }

    // DnsCodecTest.rejectsNonQueriesAndMalformedPackets
    @Test func rejectsNonQueriesAndMalformedPackets() {
        #expect(DnsMessage.parseQuery(dnsQuery("a.example", 1, flags: 0x8180)) == nil)
        var two = dnsQuery("a.example", 1); two[5] = 2
        #expect(DnsMessage.parseQuery(two) == nil)
        var pointer = dnsQuery("a.example", 1); pointer[12] = 0xc0
        #expect(DnsMessage.parseQuery(pointer) == nil)
        #expect(DnsMessage.parseQuery(Array(dnsQuery("a.example", 1)[0..<14])) == nil)
        #expect(DnsMessage.parseQuery(dnsQuery("a.example", 1, flags: 0x2800)) == nil)
    }

    // DnsCodecTest.blockedAnswerForAIsZeroAddress
    @Test func blockedAnswerForAIsZeroAddress() throws {
        let q = try #require(DnsMessage.parseQuery(dnsQuery("blocked.example", DnsMessage.typeA)))
        let r = DnsAnswerBuilder.blocked(q)
        #expect(u16(r, 0) == 0x1234 && u16(r, 2) == 0x8180 && u16(r, 4) == 1 && u16(r, 6) == 1)
        let qEnd = 12 + q.questionBytes.count
        #expect(Array(r[12..<qEnd]) == q.questionBytes)
        var at = qEnd + DnsMessage.encodeName("blocked.example").count
        #expect(u16(r, at) == 1); at += 2
        #expect(u16(r, at) == 1); at += 2
        #expect(u16(r, at) == 0 && u16(r, at + 2) == 60); at += 4
        #expect(u16(r, at) == 4); at += 2
        #expect(Array(r[at..<(at + 4)]) == [0, 0, 0, 0])
        #expect(r.count == at + 4)
    }

    // DnsCodecTest.blockedAnswerForHttpsTypeIsNodata
    @Test func blockedAnswerForHttpsTypeIsNodata() throws {
        let q = try #require(DnsMessage.parseQuery(dnsQuery("blocked.example", DnsMessage.typeHTTPS)))
        let r = DnsAnswerBuilder.blocked(q)
        #expect(u16(r, 6) == 0 && u16(r, 2) == 0x8180)
    }

    // DnsCodecTest.cnameRewriteCarriesTargetAddresses
    @Test func cnameRewriteCarriesTargetAddresses() throws {
        let q = try #require(DnsMessage.parseQuery(dnsQuery("www.google.com", DnsMessage.typeA)))
        let r = DnsAnswerBuilder.cnameWithAddresses(q, target: "forcesafesearch.google.com", addresses: [[216, 239, 38, 120]], ttl: 60)
        #expect(u16(r, 6) == 2)
        var at = 12 + q.questionBytes.count + DnsMessage.encodeName("www.google.com").count
        #expect(u16(r, at) == DnsMessage.typeCNAME); at += 2 + 2 + 4
        let rdlen = u16(r, at); at += 2
        #expect(Array(r[at..<(at + rdlen)]) == DnsMessage.encodeName("forcesafesearch.google.com"))
        let q6 = try #require(DnsMessage.parseQuery(dnsQuery("www.google.com", DnsMessage.typeAAAA)))
        let r6 = DnsAnswerBuilder.cnameWithAddresses(q6, target: "forcesafesearch.google.com", addresses: [[216, 239, 38, 120]], ttl: 60)
        #expect(u16(r6, 6) == 1)
    }

    // DnsCodecTest.parsesIpv4UdpAndBuildsCheckedReply
    @Test func parsesIpv4UdpAndBuildsCheckedReply() throws {
        let payload = dnsQuery("blocked.example", DnsMessage.typeA)
        let packet = ipv4Udp([10, 111, 222, 2], [10, 111, 222, 1], 51000, 53, payload)
        let d = try #require(IpPacket.parseUdp(packet))
        #expect(d.ipVersion == 4 && d.srcPort == 51000 && d.dstPort == 53 && d.payload == payload)
        let answer = DnsAnswerBuilder.blocked(try #require(DnsMessage.parseQuery(d.payload)))
        let reply = IpPacket.buildUdpReply(d, payload: answer)
        let back = try #require(IpPacket.parseUdp(reply))
        #expect(back.srcPort == 53 && back.dstPort == 51000 && back.srcIp == d.dstIp && back.dstIp == d.srcIp && back.payload == answer)
        #expect(refChecksum(reply, 0, 20, 0) == 0)
        let udpLen = 8 + answer.count
        var seed = 0
        for i in stride(from: 12, to: 20, by: 2) { seed += u16(reply, i) }
        seed += 17 + udpLen
        #expect(refChecksum(reply, 20, udpLen, seed) == 0)
    }

    // DnsCodecTest.parsesIpv6UdpAndBuildsCheckedReply
    @Test func parsesIpv6UdpAndBuildsCheckedReply() throws {
        let payload = dnsQuery("blocked.example", DnsMessage.typeAAAA)
        var src = [UInt8](repeating: 0, count: 16); src[0] = 0xfd; src[15] = 2
        var dst = [UInt8](repeating: 0, count: 16); dst[0] = 0xfd; dst[15] = 1
        let udpLen = 8 + payload.count
        var p = [UInt8](repeating: 0, count: 40 + udpLen)
        p[0] = 0x60; p[4] = UInt8(udpLen >> 8); p[5] = UInt8(udpLen & 0xff); p[6] = 17; p[7] = 64
        p.replaceSubrange(8..<24, with: src); p.replaceSubrange(24..<40, with: dst)
        p[40] = UInt8(51000 >> 8); p[41] = UInt8(51000 & 0xff); p[43] = 53
        p[44] = UInt8(udpLen >> 8); p[45] = UInt8(udpLen & 0xff)
        p.replaceSubrange(48..<(48 + payload.count), with: payload)

        let d = try #require(IpPacket.parseUdp(p))
        #expect(d.ipVersion == 6)
        let answer = DnsAnswerBuilder.blocked(try #require(DnsMessage.parseQuery(d.payload)))
        let reply = IpPacket.buildUdpReply(d, payload: answer)
        let back = try #require(IpPacket.parseUdp(reply))
        #expect(back.srcIp == dst && back.dstIp == src && back.payload == answer)
        let rLen = 8 + answer.count
        var seed = 0
        for i in stride(from: 8, to: 40, by: 2) { seed += u16(reply, i) }
        seed += rLen + 17
        #expect(refChecksum(reply, 40, rLen, seed) == 0)
        #expect(u16(reply, 46) != 0)
    }

    // DnsCodecTest.rejectsFragmentsAndNonUdp
    @Test func rejectsFragmentsAndNonUdp() {
        let packet = ipv4Udp([0, 0, 0, 0], [0, 0, 0, 0], 1000, 53, dnsQuery("a.example", 1))
        var frag = packet; frag[7] = 1
        #expect(IpPacket.parseUdp(frag) == nil)
        var tcp = packet; tcp[9] = 6
        #expect(IpPacket.parseUdp(tcp) == nil)
        #expect(IpPacket.parseUdp([0, 0, 0]) == nil)
    }

    // DnsCodecTest.acceptsOnlyGenuineRepliesFromUpstream
    @Test func acceptsOnlyGenuineRepliesFromUpstream() throws {
        let q = dnsQuery("Example.com", DnsMessage.typeA)
        let question = try #require(DnsMessage.parseQuery(q)).questionBytes
        var good = q; good[2] |= 0x80
        #expect(DnsMessage.isReplyTo(q, question: question, reply: good))
        var lowered = good; lowered[13] = UInt8(ascii: "e")
        #expect(DnsMessage.isReplyTo(q, question: question, reply: lowered))
        #expect(!DnsMessage.isReplyTo(q, question: question, reply: []))
        #expect(!DnsMessage.isReplyTo(q, question: question, reply: [0]))
        var wrongId = good; wrongId[1] = 0x35
        #expect(!DnsMessage.isReplyTo(q, question: question, reply: wrongId))
        #expect(!DnsMessage.isReplyTo(q, question: question, reply: q))
        var otherName = dnsQuery("examplf.com", 1); otherName[2] |= 0x80
        #expect(!DnsMessage.isReplyTo(q, question: question, reply: otherName))
        var otherType = dnsQuery("Example.com", DnsMessage.typeAAAA); otherType[2] |= 0x80
        #expect(!DnsMessage.isReplyTo(q, question: question, reply: otherType))
        #expect(!DnsMessage.isReplyTo(q, question: question, reply: Array(good[0..<14])))
        #expect(DnsMessage.isReplyTo(q, question: nil, reply: good))
        #expect(!DnsMessage.isReplyTo(q, question: nil, reply: q))
    }

    // DnsCodecTest.readsTruncationAndRcode
    @Test func readsTruncationAndRcode() {
        var reply = dnsQuery("example.com", 1); reply[2] = 0x83; reply[3] = 0x82
        #expect(DnsMessage.isTruncated(reply) && DnsMessage.rcode(reply) == 2)
        #expect(!DnsMessage.isTruncated(dnsQuery("example.com", 1)))
    }

    // DnsCodecTest.capTtlsLowersRecordTtlsAndLeavesOptAlone
    @Test func capTtlsLowersRecordTtlsAndLeavesOptAlone() {
        func b16(_ v: Int) -> [UInt8] { [UInt8(truncatingIfNeeded: v >> 8), UInt8(truncatingIfNeeded: v)] }
        func b32(_ v: Int) -> [UInt8] { b16(v >> 16) + b16(v) }
        let qname: [UInt8] = [7] + Array("example".utf8) + [3] + Array("com".utf8) + [0]
        var msg = b16(0x1234) + b16(0x8180) + b16(1) + b16(2) + b16(0) + b16(1)
        msg += qname + b16(1) + b16(1)
        msg += [0xc0, 12] + b16(1) + b16(1) + b32(3600) + b16(4) + [1, 2, 3, 4]
        msg += [0xc0, 12] + b16(1) + b16(1) + b32(30) + b16(4) + [5, 6, 7, 8]
        msg += [0] + b16(41) + b16(4096) + b32(0x00ff8000) + b16(0)
        let capped = DnsMessage.capTtls(msg, max: 60)
        func ttl(_ o: Int) -> Int { u16(capped, o) << 16 | u16(capped, o + 2) }
        let first = 12 + qname.count + 4 + 2 + 4
        #expect(ttl(first) == 60)
        #expect(ttl(first + 16) == 30)
        #expect(ttl(first + 31) == 0x00ff8000)
        #expect(capped.count == msg.count)
        let cut = Array(msg[0..<(msg.count - 3)])
        #expect(DnsMessage.capTtls(cut, max: 60) == cut)
    }

    /// TcpResetTest.tcp4
    private func tcp4(flags: UInt8, seq: UInt32 = 0x11223344) -> [UInt8] {
        var p = [UInt8](repeating: 0, count: 40)
        p[0] = 0x45; p[3] = 40; p[8] = 64; p[9] = 6
        p.replaceSubrange(12..<16, with: [10, 111, 222, 2]); p.replaceSubrange(16..<20, with: [10, 111, 222, 1])
        p[20] = UInt8(40000 >> 8); p[21] = UInt8(40000 & 0xff); p[22] = UInt8(853 >> 8); p[23] = UInt8(853 & 0xff)
        p[24] = UInt8(seq >> 24); p[25] = UInt8((seq >> 16) & 0xff); p[26] = UInt8((seq >> 8) & 0xff); p[27] = UInt8(seq & 0xff)
        p[32] = 0x50; p[33] = flags
        return p
    }

    // TcpResetTest.synGetsRstAckWithCorrectFieldsAndChecksums
    @Test func synGetsRstAckWithCorrectFieldsAndChecksums() throws {
        let syn = tcp4(flags: 0x02)
        let rst = try #require(TcpReset.buildRstFor(syn))
        #expect(Array(rst[12..<16]) == Array(syn[16..<20]) && Array(rst[16..<20]) == Array(syn[12..<16]))
        #expect(IpPacket.checksum(rst, 0, 20) == 0)
        #expect(u16(rst, 20) == 853 && u16(rst, 22) == 40000 && rst[33] == 0x14)
        #expect((u16(rst, 28) << 16 | u16(rst, 30)) == 0x11223345)
        var seed = 0
        for i in stride(from: 12, to: 20, by: 2) { seed += u16(rst, i) }
        #expect(IpPacket.checksum(rst, 20, 20, seed: seed + 6 + 20) == 0)
        // Swift-only: the ack wraps instead of trapping.
        let wrap = try #require(TcpReset.buildRstFor(tcp4(flags: 0x02, seq: 0xffff_ffff)))
        #expect((u16(wrap, 28) << 16 | u16(wrap, 30)) == 0)
    }

    // TcpResetTest.nonSynSegmentsGetNoRst
    @Test func nonSynSegmentsGetNoRst() {
        #expect(TcpReset.buildRstFor(tcp4(flags: 0x10)) == nil)
        #expect(TcpReset.buildRstFor(tcp4(flags: 0x12)) == nil)
        #expect(TcpReset.buildRstFor(tcp4(flags: 0x01)) == nil)
        #expect(TcpReset.buildRstFor([UInt8](repeating: 0, count: 10)) == nil)
    }

    // TcpResetTest.ipv6SynGetsCheckedRst
    @Test func ipv6SynGetsCheckedRst() throws {
        var p = [UInt8](repeating: 0, count: 60)
        p[0] = 0x60; p[5] = 20; p[6] = 6; p[7] = 64
        var src = [UInt8](repeating: 0, count: 16); src[0] = 0xfd; src[15] = 2
        var dst = [UInt8](repeating: 0, count: 16); dst[0] = 0xfd; dst[15] = 1
        p.replaceSubrange(8..<24, with: src); p.replaceSubrange(24..<40, with: dst)
        p[40] = UInt8(40000 >> 8); p[41] = UInt8(40000 & 0xff); p[42] = UInt8(853 >> 8); p[43] = UInt8(853 & 0xff)
        p[47] = 0x44; p[52] = 0x50; p[53] = 0x02
        let rst = try #require(TcpReset.buildRstFor(p))
        #expect(Array(rst[8..<24]) == dst && Array(rst[24..<40]) == src && rst[53] == 0x14)
        var seed = 0
        for i in stride(from: 8, to: 40, by: 2) { seed += u16(rst, i) }
        #expect(IpPacket.checksum(rst, 40, 20, seed: seed + 20 + 6) == 0)
    }

    /// Hostile input: nothing may trap. Hand-picked cases, then a seeded
    /// fuzz over every parser, mutating valid packets and random bytes.
    @Test func hostileInputNeverTraps() throws {
        let q = dnsQuery("blocked.example", 1)
        // Truncated IP headers and bad lengths.
        let v4 = ipv4Udp([10, 0, 0, 2], [10, 0, 0, 1], 5000, 53, q)
        for n in 0..<v4.count { _ = IpPacket.parseUdp(Array(v4[0..<n])); _ = TcpReset.buildRstFor(Array(v4[0..<n])) }
        var badIhl = v4; badIhl[0] = 0x4f  // IHL 60 > packet
        #expect(IpPacket.parseUdp(badIhl) == nil)
        var badUdpLen = v4; badUdpLen[24] = 0xff
        #expect(IpPacket.parseUdp(badUdpLen) == nil)
        var shortUdpLen = v4; shortUdpLen[24] = 0; shortUdpLen[25] = 3
        #expect(IpPacket.parseUdp(shortUdpLen) == nil)
        var v6 = [UInt8](repeating: 0, count: 48); v6[0] = 0x60; v6[6] = 17; v6[4] = 0xff
        #expect(IpPacket.parseUdp(v6) == nil)
        // A valid IPv6 UDP query and an IPv6 SYN, every prefix of each.
        var udp6 = [UInt8](repeating: 0, count: 48) + q
        udp6[0] = 0x60; udp6[5] = UInt8(8 + q.count); udp6[6] = 17; udp6[43] = 53; udp6[45] = UInt8(8 + q.count)
        #expect(IpPacket.parseUdp(udp6)?.payload == q)
        var syn6 = [UInt8](repeating: 0, count: 60)
        syn6[0] = 0x60; syn6[5] = 20; syn6[6] = 6; syn6[53] = 0x02
        #expect(TcpReset.buildRstFor(syn6) != nil)
        for p in [udp6, syn6] {
            for n in 0..<p.count { _ = IpPacket.parseUdp(Array(p[0..<n])); _ = TcpReset.buildRstFor(Array(p[0..<n])) }
        }
        // Zero-length.
        #expect(IpPacket.parseUdp([]) == nil && TcpReset.buildRstFor([]) == nil && DnsMessage.parseQuery([]) == nil)
        #expect(DnsMessage.capTtls([], max: 60) == [] && DnsMessage.rcode([]) == -1 && !DnsMessage.isTruncated([]))
        // Oversized label (64), and a name over 254 bytes.
        #expect(DnsMessage.parseQuery(dnsQuery(String(repeating: "a", count: 64) + ".example", 1)) == nil)
        #expect(DnsMessage.parseQuery(dnsQuery(String(repeating: "abcdefghi.", count: 26) + "com", 1)) == nil)
        // A label length running past the end.
        var overrun = q; overrun[12] = 63
        #expect(DnsMessage.parseQuery(overrun) == nil)
        // Multiple questions.
        var three = q; three[5] = 3
        #expect(DnsMessage.parseQuery(three) == nil)
        // Compression pointer loop (points at itself) in a response: capTtls
        // skips names and never follows a pointer.
        var loop: [UInt8] = [0x12, 0x34, 0x81, 0x80, 0, 0, 0, 1, 0, 0, 0, 0]
        loop += [0xc0, 12, 0, 1, 0, 1, 0, 0, 0x0e, 0x10, 0, 4, 1, 2, 3, 4]
        #expect(DnsMessage.capTtls(loop, max: 60).count == loop.count)
        var lying = loop; lying[7] = 0xff  // ANCOUNT 255, one record present
        #expect(DnsMessage.capTtls(lying, max: 60) == lying)
        var qLoop = q; qLoop[12] = 0xc0; qLoop[13] = 12
        #expect(DnsMessage.parseQuery(qLoop) == nil)
        // A Data slice with a non-zero startIndex goes through [UInt8] first.
        let wrapped = Data([0xff, 0xff] + q)
        #expect(DnsMessage.parseQuery([UInt8](wrapped.dropFirst(2)))?.qname == "blocked.example")

        // Seeded fuzz.
        var rng = SplitMix(seed: 0x5175)
        let engine = DnsEngine()
        let snapshot = DecisionSnapshot(userBlock: ["blocked.example"], staticBlock: [try DomainSet(domains: ["blocked.example", "zz.example"])])
        let map = SafeSearchMap(rules: [.init(match: ["google.*", "bing.com"], target: "t.example", fallbackA: ["1.2.3.4"], fallbackAAAA: ["::1"])])
        let seeds = [v4, q, loop, tcp4(flags: 0x02), udp6, syn6, dnsQuery("www.google.co.uk", 1)]
        for i in 0..<20_000 {
            var p: [UInt8]
            if i % 4 == 3 {
                p = (0..<Int(rng.next() % 80)).map { _ in UInt8(truncatingIfNeeded: rng.next()) }
            } else {
                p = seeds[i % seeds.count]
                for _ in 0..<(1 + Int(rng.next() % 4)) where !p.isEmpty {
                    p[Int(rng.next() % UInt64(p.count))] = UInt8(truncatingIfNeeded: rng.next())
                }
                if rng.next() % 3 == 0 { p = Array(p.prefix(Int(rng.next() % UInt64(p.count + 1)))) }
            }
            if let d = IpPacket.parseUdp(p) { _ = IpPacket.buildUdpReply(d, payload: d.payload) }
            _ = TcpReset.buildRstFor(p)
            _ = DnsMessage.capTtls(p, max: 60)
            _ = DnsMessage.isReplyTo(q, question: Array(q[12...]), reply: p)
            for payload in [p, IpPacket.parseUdp(p)?.payload ?? []] {
                switch engine.decide(payload: payload, snapshot: snapshot, safeSearch: map, now: 0) {
                case .answer(let a): #expect(a.count >= 12)
                case .rewrite(let rq, let rule): _ = engine.rewriteAnswer(rq, rule: rule, resolved: [])
                default: break
                }
            }
        }
    }
}

/// Deterministic PRNG for fuzz and scale tests.
struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
