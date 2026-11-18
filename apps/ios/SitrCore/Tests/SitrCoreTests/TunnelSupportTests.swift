/// The NetworkExtension-free parts of the DEBUG-only tunnel prototype:
/// list loading and snapshot assembly, settings parsing, resolver-list
/// filtering, the POSIX transport (against loopback servers), SafeSearch
/// target caching, the in-flight gate and the probe-name privacy rule.
import Darwin
import Foundation
import Testing

@testable import SitrCore

private let listsDir = fixturesDir.deletingLastPathComponent().appendingPathComponent("blocklists/android")

private func bundle() throws -> BlocklistBundle { try BlocklistBundle.load(from: listsDir).get() }

/// A copy of the lists in a temp dir, with `file` overwritten.
private func tamperedCopy(_ file: String) throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.copyItem(at: listsDir, to: dir)
    try Data("evil.example\n".utf8).write(to: dir.appendingPathComponent(file))
    return dir
}

@Suite struct BlocklistBundleTests {
    @Test func loadsAndVerifiesTheCommittedLists() throws {
        let b = try bundle()
        for stem in BlocklistBundle.requiredLists { #expect(b.sets[stem] != nil) }
        #expect(b.sets["x-media"] != nil)
        #expect(b.skipped.isEmpty)
        #expect(b.safeSearch.rule(for: "www.google.com")?.target == "forcesafesearch.google.com")
    }

    @Test func refusesATamperedRequiredList() throws {
        let dir = try tamperedCopy("adult.domains")
        guard case .failure = BlocklistBundle.load(from: dir) else { Issue.record("loaded a tampered list"); return }
    }

    @Test func refusesATamperedSafeSearchMap() throws {
        let dir = try tamperedCopy("safesearch-hosts.json")
        guard case .failure = BlocklistBundle.load(from: dir) else { Issue.record("loaded a tampered map"); return }
    }

    @Test func skipsATamperedOptionalList() throws {
        let b = try BlocklistBundle.load(from: tamperedCopy("x-media.domains")).get()
        #expect(b.sets["x-media"] == nil)
        #expect(b.skipped == ["x-media.domains"])
    }

    @Test func snapshotFollowsSettings() throws {
        let b = try bundle()
        var s = TunnelSettings()
        #expect(b.snapshot(s).decide("www.pornhub.com") == .block)
        #expect(b.snapshot(s).decide("bet365.com") == .block)
        #expect(b.snapshot(s).decide("tinder.com") == .block)
        #expect(b.snapshot(s).decide("pbs.twimg.com") == .forward)
        #expect(b.snapshot(s).decide("example.com") == .forward)

        s.disabledCategories = ["sitr_gambling", "sitr_adult"]  // adult cannot be disabled
        s.mediaOff = ["x"]
        s.userAllow = ["tinder.com"]
        s.userBlock = ["example.com"]
        let snap = b.snapshot(s)
        #expect(snap.decide("bet365.com") == .forward)
        #expect(snap.decide("pornhub.com") == .block)
        #expect(snap.decide("pbs.twimg.com") == .block)
        #expect(snap.decide("tinder.com") == .forward)
        #expect(snap.decide("www.example.com") == .block)
    }

    @Test func householdCategoriesAndListsWin() throws {
        let b = try bundle()
        var h = Household.emptyState(deviceId: "d", now: 0)
        h.disabledCategories = ["sitr_dating"]
        h.blockDomains = ["blocked-by-household.example"]
        let s = TunnelSettings(disabledCategories: ["sitr_gambling"], household: h)
        let snap = b.snapshot(s)
        #expect(snap.decide("tinder.com") == .forward)
        #expect(snap.decide("bet365.com") == .block)
        #expect(snap.decide("blocked-by-household.example") == .block)
    }

    @Test func settingsReadFromAppGroupKeys() throws {
        let suite = "sitr-test-\(UUID().uuidString)"
        let d = try #require(UserDefaults(suiteName: suite))
        defer { d.removePersistentDomain(forName: suite) }
        d.set(["sitr_dating"], forKey: "disabledCategories")
        d.set(["reddit", "x"], forKey: "mediaOff")
        d.set(["a.example"], forKey: "userAllow")
        d.set(["b.example"], forKey: "userBlock")
        let h = Household.emptyState(deviceId: "d", now: 0)
        let json = try JSONSerialization.data(withJSONObject: Household.toJSONObject(h))
        d.set(String(decoding: json, as: UTF8.self), forKey: "householdState")
        let s = TunnelSettings(defaults: d)
        #expect(s.disabledCategories == ["sitr_dating"])
        #expect(s.mediaOff == ["reddit", "x"])
        #expect(s.userAllow == ["a.example"])
        #expect(s.userBlock == ["b.example"])
        #expect(s.household == h)
    }
}

@Suite struct ResolverListTests {
    @Test func usableDropsTheTunnelsOwnAddressesKeepsScope() {
        let raw = ["10.111.222.1", "192.168.1.1", "fe80::1%en0", "fd66:f83a:c650::1", "192.168.1.1"]
        #expect(SystemResolvers.usable(raw) == ["192.168.1.1", "fe80::1%en0"])
        #expect(SystemResolvers.usable(["10.111.222.1"]).isEmpty)
    }

    @Test func readDoesNotCrash() {
        // Whatever this Mac uses; only the shape is checked.
        for s in SystemResolvers.read() { #expect(!s.isEmpty) }
    }
}

@Suite struct QueryCodecTests {
    @Test func builtQueryParsesBack() throws {
        let q = DnsMessage.buildQuery(id: 0xbeef, name: "forcesafesearch.google.com", qtype: DnsMessage.typeAAAA)
        let parsed = try #require(DnsMessage.parseQuery(q))
        #expect(parsed.id == 0xbeef)
        #expect(parsed.qname == "forcesafesearch.google.com")
        #expect(parsed.qtype == DnsMessage.typeAAAA)
        #expect(parsed.recursionDesired)
    }

    @Test func addressesFromAnAnswer() throws {
        let q = try #require(DnsMessage.parseQuery(DnsMessage.buildQuery(id: 1, name: "www.google.com", qtype: DnsMessage.typeA)))
        let reply = DnsAnswerBuilder.cnameWithAddresses(
            q, target: "forcesafesearch.google.com", addresses: [[216, 239, 38, 120], [UInt8](repeating: 1, count: 16)], ttl: 60)
        #expect(DnsMessage.addresses(in: reply) == [[216, 239, 38, 120]])  // CNAME skipped, AAAA filtered by builder
        #expect(DnsMessage.addresses(in: Array(reply.prefix(30))).isEmpty)
        #expect(DnsMessage.addresses(in: [1, 2, 3]).isEmpty)
    }
}

// MARK: - Transport against loopback servers

/// A UDP socket on 127.0.0.1 that answers each query with junk first, then
/// a proper reply (same id, QR set, question echoed).
private func udpServer() -> UInt16 {
    let fd = socket(AF_INET, SOCK_DGRAM, 0)
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    withUnsafeMutablePointer(to: &addr) { p in
        p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
            _ = bind(fd, sa, len)
            _ = getsockname(fd, sa, &len)
        }
    }
    Thread.detachNewThread {
        var buf = [UInt8](repeating: 0, count: 512)
        var peer = sockaddr_storage()
        var peerLen = socklen_t(MemoryLayout<sockaddr_storage>.size)
        while true {
            let n = withUnsafeMutablePointer(to: &peer) { p in
                p.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(fd, &buf, buf.count, 0, $0, &peerLen) }
            }
            if n <= 0 { return }
            var reply = Array(buf[0..<n])
            reply[2] |= 0x80
            let junk: [UInt8] = [0, 0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0]
            for packet in [junk, reply] {
                _ = withUnsafePointer(to: &peer) { p in
                    p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sendto(fd, packet, packet.count, 0, $0, peerLen) }
                }
            }
        }
    }
    return UInt16(bigEndian: addr.sin_port)
}

/// A TCP listener on 127.0.0.1 that answers one framed query, framed.
private func tcpServer() -> UInt16 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    withUnsafeMutablePointer(to: &addr) { p in
        p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
            _ = bind(fd, sa, len)
            _ = getsockname(fd, sa, &len)
        }
    }
    listen(fd, 1)
    Thread.detachNewThread {
        let c = accept(fd, nil, nil)
        var buf = [UInt8](repeating: 0, count: 1024)
        let n = recv(c, &buf, buf.count, 0)
        if n > 2 {
            var body = Array(buf[2..<n])
            body[2] |= 0x80
            let framed = [UInt8(body.count >> 8), UInt8(body.count & 0xff)] + body
            _ = send(c, framed, framed.count, 0)
        }
        close(c)
        close(fd)
    }
    return UInt16(bigEndian: addr.sin_port)
}

@Suite struct PosixTransportTests {
    @Test func udpSkipsJunkAndReturnsTheMatchingReply() async throws {
        let resolver = UpstreamResolver(transport: PosixDnsTransport(timeout: 1, port: udpServer()))
        await resolver.setUpstreams(["127.0.0.1"])
        let query = DnsMessage.buildQuery(id: 0x1234, name: "example.com", qtype: DnsMessage.typeA)
        let question = Array(query[12...])
        let reply = try #require(await resolver.forward(query, accept: { DnsMessage.isReplyTo(query, question: question, reply: $0) }))
        #expect(reply[0] == 0x12 && reply[1] == 0x34)
    }

    @Test func udpToASilentServerTimesOut() async throws {
        // Port 9 (discard) on loopback: refused or silent; either way nil, and quickly.
        let resolver = UpstreamResolver(transport: PosixDnsTransport(timeout: 0.3, port: 9))
        await resolver.setUpstreams(["127.0.0.1"])
        let start = Date()
        let reply = await resolver.forward(DnsMessage.buildQuery(id: 1, name: "example.com", qtype: 1), accept: { _ in true })
        #expect(reply == nil)
        #expect(Date().timeIntervalSince(start) < 2)
    }

    @Test func tcpExchange() async throws {
        let t = PosixDnsTransport(timeout: 1, port: tcpServer())
        let query = DnsMessage.buildQuery(id: 0x4242, name: "example.com", qtype: DnsMessage.typeA)
        let reply = try await t.tcp(query, to: "127.0.0.1")
        #expect(reply.count == query.count && reply[0] == 0x42 && reply[2] & 0x80 != 0)
    }

    @Test func rejectsANonNumericUpstream() async {
        await #expect(throws: SitrError.self) { _ = try await PosixDnsTransport().udp([0], to: "dns.example") }
    }
}

// MARK: - SafeSearch targets, gate, probes

private final class CountingTransport: DnsUpstreamTransport, @unchecked Sendable {
    let lock = NSLock()
    var calls = 0
    func udp(_ query: [UInt8], to upstream: String) async throws -> AsyncThrowingStream<[UInt8], Error> {
        lock.withLock { calls += 1 }
        let q = DnsMessage.parseQuery(query)!
        let reply = q.qtype == DnsMessage.typeA
            ? DnsAnswerBuilder.cnameWithAddresses(q, target: q.qname, addresses: [[1, 2, 3, 4]], ttl: 60)
            : DnsAnswerBuilder.nodata(q)
        return AsyncThrowingStream { $0.yield(reply); $0.finish() }
    }
    func tcp(_ query: [UInt8], to upstream: String) async throws -> [UInt8] { throw SitrError("no tcp") }
}

@Suite struct SafeSearchTargetTests {
    @Test func resolvesBothFamiliesAndCachesFiveMinutes() async {
        let t = CountingTransport()
        let resolver = UpstreamResolver(transport: t)
        await resolver.setUpstreams(["192.0.2.1"])
        let targets = SafeSearchTargets()
        #expect(await targets.addresses(for: "forcesafesearch.google.com", via: resolver, now: 0) == [[1, 2, 3, 4]])
        #expect(t.calls == 2)  // A and AAAA
        _ = await targets.addresses(for: "forcesafesearch.google.com", via: resolver, now: 299)
        #expect(t.calls == 2)
        _ = await targets.addresses(for: "forcesafesearch.google.com", via: resolver, now: 301)
        #expect(t.calls == 4)
    }

    @Test func emptyResultsAreNotCached() async {
        let resolver = UpstreamResolver(transport: CountingTransport())  // no upstreams: every lookup fails
        let targets = SafeSearchTargets()
        #expect(await targets.addresses(for: "strict.bing.com", via: resolver, now: 0).isEmpty)
        await resolver.setUpstreams(["192.0.2.1"])
        #expect(await targets.addresses(for: "strict.bing.com", via: resolver, now: 1) == [[1, 2, 3, 4]])
    }
}

@Suite struct InFlightGateTests {
    @Test func boundsHoldersAndWaiters() async throws {
        let gate = InFlightGate(limit: 1, queueLimit: 1)
        #expect(await gate.enter())
        let waiter = Task { await gate.enter() }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(await gate.enter() == false)  // holder + one waiter: full
        await gate.leave()
        #expect(await waiter.value)
        await gate.leave()
        #expect(await gate.enter())
    }
}

@Suite struct ProbeNameTests {
    @Test func onlyReservedNamesAreRecorded() {
        var d = TunnelDiagnostics(writer: "test")
        d.probe("private.example.org", qtype: 1, decision: "forward", ms: 1)
        d.probe("a.sitr-probe.test", qtype: 1, decision: "block", ms: 1)
        d.probe("www.google.com", qtype: 28, decision: "rewrite", ms: 1)
        #expect(d.probes.map(\.name) == ["a.sitr-probe.test", "www.google.com"])
        #expect(!ProbeNames.isReserved("sitr-probe.test.evil.example"))
    }

    @Test func roundTripsThroughJSON() throws {
        var d = TunnelDiagnostics(writer: "test")
        d.counters.seen = 3
        d.log("started")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("d.json")
        d.write(to: url)
        let back = try #require(TunnelDiagnostics.read(from: url))
        #expect(back.counters.seen == 3 && back.events.count == 1)
    }
}
