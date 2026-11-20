/// The NetworkExtension-free parts of the DNS filter (packet tunnel):
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

    /// Parity with the Safari blocker's opt-in lists, plus the DNS-only
    /// encrypted-DNS list: both off unless switched on, each independent.
    @Test func optInListsApplyOnlyWhenSwitchedOn() throws {
        let b = try bundle()
        var s = TunnelSettings()
        #expect(b.snapshot(s).decide("14words.com") == .forward)
        #expect(b.snapshot(s).decide("cloudflare-dns.com") == .forward)
        s.optionalOn = ["violence"]
        #expect(b.snapshot(s).decide("www.14words.com") == .block)
        #expect(b.snapshot(s).decide("cloudflare-dns.com") == .forward)
        s.optionalOn = ["doh"]
        #expect(b.snapshot(s).decide("14words.com") == .forward)
        #expect(b.snapshot(s).decide("cloudflare-dns.com") == .block)
        s.optionalOn = ["violence", "doh", "unknown-list"]  // an unknown id is ignored
        #expect(b.snapshot(s).decide("14words.com") == .block)
        #expect(b.snapshot(s).decide("dns.adguard.com") == .block)
        // A user allow still wins over an opt-in list, as over a category.
        s.userAllow = ["14words.com"]
        #expect(b.snapshot(s).decide("14words.com") == .forward)
    }

    /// Household layer over the device layer (child and guardian devices
    /// filter alike; the role only gates edits): a household allow beats a
    /// device block and a category, a household block beats a device allow.
    @Test func householdLayerBeatsDeviceLayer() throws {
        let b = try bundle()
        var h = Household.emptyState(deviceId: "d", now: 0)
        h.allowDomains = ["bet365.com", "device-blocked.example"]
        h.blockDomains = ["device-allowed.example"]
        let s = TunnelSettings(
            userAllow: ["device-allowed.example"], userBlock: ["device-blocked.example"], household: h)
        let snap = b.snapshot(s)
        #expect(snap.decide("bet365.com") == .forward)
        #expect(snap.decide("device-blocked.example") == .forward)
        #expect(snap.decide("device-allowed.example") == .block)
        #expect(snap.decide("pornhub.com") == .block)
        // Without the household the device lists apply again.
        let alone = b.snapshot(TunnelSettings(userAllow: ["device-allowed.example"], userBlock: ["device-blocked.example"]))
        #expect(alone.decide("device-blocked.example") == .block)
        #expect(alone.decide("device-allowed.example") == .forward)
        #expect(alone.decide("bet365.com") == .block)
    }

    /// Before the first unlock the App Group defaults read as empty: the
    /// snapshot must then be the strict default, gambling and dating ON
    /// even if the user switched them off, until the settings are readable.
    @Test func unreadableSettingsKeepGamblingAndDatingOn() throws {
        let b = try bundle()
        let suite = "sitr-test-\(UUID().uuidString)"
        let d = try #require(UserDefaults(suiteName: suite))
        defer { d.removePersistentDomain(forName: suite) }
        #expect(!tunnelSettingsReadable(d))
        let locked = b.snapshot(TunnelSettings(defaults: d))
        #expect(locked.decide("pornhub.com") == .block)
        #expect(locked.decide("bet365.com") == .block)
        #expect(locked.decide("tinder.com") == .block)
        // Once readable, the user's choice applies.
        d.set("device-1", forKey: "deviceId")
        d.set(["sitr_gambling", "sitr_dating"], forKey: "disabledCategories")
        #expect(tunnelSettingsReadable(d))
        let unlocked = b.snapshot(TunnelSettings(defaults: d))
        #expect(unlocked.decide("bet365.com") == .forward)
        #expect(unlocked.decide("tinder.com") == .forward)
    }

    @Test func settingsReadFromAppGroupKeys() throws {
        let suite = "sitr-test-\(UUID().uuidString)"
        let d = try #require(UserDefaults(suiteName: suite))
        defer { d.removePersistentDomain(forName: suite) }
        d.set(["sitr_dating"], forKey: "disabledCategories")
        d.set(["reddit", "x"], forKey: "mediaOff")
        d.set(["a.example"], forKey: "userAllow")
        d.set(["b.example"], forKey: "userBlock")
        d.set(["doh", "violence"], forKey: "optionalListsOn")
        #expect(!tunnelSettingsReadable(d))
        d.set("device-1", forKey: "deviceId")
        #expect(tunnelSettingsReadable(d))
        let h = Household.emptyState(deviceId: "d", now: 0)
        let json = try JSONSerialization.data(withJSONObject: Household.toJSONObject(h))
        d.set(String(decoding: json, as: UTF8.self), forKey: "householdState")
        let s = TunnelSettings(defaults: d)
        #expect(s.disabledCategories == ["sitr_dating"])
        #expect(s.mediaOff == ["reddit", "x"])
        #expect(s.userAllow == ["a.example"])
        #expect(s.userBlock == ["b.example"])
        #expect(s.optionalOn == ["doh", "violence"])
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

// MARK: - IPv6 upstream, diagnostics record

/// A UDP socket on ::1 that answers each query with itself, QR set.
private func udpServer6() -> UInt16 {
    let fd = socket(AF_INET6, SOCK_DGRAM, 0)
    var addr = sockaddr_in6()
    addr.sin6_family = sa_family_t(AF_INET6)
    addr.sin6_addr = in6addr_loopback
    var len = socklen_t(MemoryLayout<sockaddr_in6>.size)
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
            _ = withUnsafePointer(to: &peer) { p in
                p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sendto(fd, reply, reply.count, 0, $0, peerLen) }
            }
        }
    }
    return UInt16(bigEndian: addr.sin6_port)
}

@Suite struct Ipv6UpstreamTests {
    /// IPv6-only (DNS64) networks: the network's resolver is an IPv6
    /// address; AAAA queries go to it unchanged.
    @Test func forwardsOverIpv6() async throws {
        let resolver = UpstreamResolver(transport: PosixDnsTransport(timeout: 1, port: udpServer6()))
        await resolver.setUpstreams(["::1"])
        let query = DnsMessage.buildQuery(id: 0x6666, name: "example.com", qtype: DnsMessage.typeAAAA)
        let question = Array(query[12...])
        let reply = try #require(await resolver.forward(query, accept: { DnsMessage.isReplyTo(query, question: question, reply: $0) }))
        #expect(reply[0] == 0x66 && reply[1] == 0x66)
    }

    /// A blocked name must be blocked for AAAA as well (::), or a DNS64
    /// resolver's synthesised AAAA would get around the block.
    @Test func blockedAaaaIsAnsweredWithTheUnspecifiedAddress() throws {
        let snap = DecisionSnapshot(userBlock: ["blocked.example"])
        let map = try SafeSearchMap.parse(Data(#"{"v":1,"rules":[]}"#.utf8)).get()
        let payload = DnsMessage.buildQuery(id: 7, name: "www.blocked.example", qtype: DnsMessage.typeAAAA)
        guard case .answer(let bytes) = DnsEngine().decide(payload: payload, snapshot: snap, safeSearch: map, now: 0) else {
            Issue.record("expected an answer"); return
        }
        #expect(DnsMessage.addresses(in: bytes) == [[UInt8](repeating: 0, count: 16)])
    }
}

@Suite struct DiagnosticsRecordTests {
    @Test func neverRecordsANameOutsideTheFixedList() throws {
        let secret = "very-private-lookup.example.org"
        var d = TunnelDiagnostics(writer: "test")
        d.beginRun(at: Date())
        d.probe(secret, qtype: 1, decision: "forward", ms: 3)
        d.probe("pornhub.com", qtype: 1, decision: "block", ms: 1)
        d.probe("a.sitr-probe.test", qtype: 1, decision: "block", ms: 1)
        d.record(TunnelDiagnostics.PathChange(at: Date(), status: "satisfied", interfaces: ["en0 wifi"], gateways: ["192.168.1.1"]))
        d.sample(MemorySample.now())
        d.closeInterval(at: Date(), latencies: [5, 9], peakFootprint: 1)
        d.endRun(at: Date(), reason: "userInitiated")
        let json = String(decoding: try #require(d.encoded()), as: UTF8.self)
        #expect(!json.contains("very-private"))
        #expect(json.contains("pornhub.com"))
        // Counts are kept only for the fixed names, never for any other name.
        #expect(d.probeCounts == ["pornhub.com": 1])
    }

    @Test func staysBoundedInSize() throws {
        var d = TunnelDiagnostics(writer: "test")
        for i in 0..<2000 {
            d.beginRun(at: Date())
            d.log(String(repeating: "x", count: 120))
            d.record(.init(at: Date(), trigger: "t", method: "m", raw: ["192.168.1.1", "fe80::1%en0"], usable: ["192.168.1.1"], ms: i))
            d.probe("www.google.com", qtype: 1, decision: "safesearch -> forcesafesearch.google.com (2 resolved)", ms: i)
            var p = TunnelDiagnostics.PathChange(at: Date(), status: "satisfied", interfaces: ["en0 wifi", "pdp_ip0 cellular"], gateways: ["192.168.1.1"])
            (p.method, p.upstreams, p.forwardingOffMs, p.unfilteredMs) = ("remove/re-apply", ["192.168.1.1"], 1000, 500)
            d.record(p)
            d.sample(MemorySample.now())
            d.closeInterval(at: Date(), latencies: Array(0..<100), peakFootprint: 1)
        }
        let size = try #require(d.encoded()).count
        #expect(size < 512 * 1024, "diagnostics grew to \(size) bytes")
    }

    @Test func runWithoutAStopIsMarkedAtTheNextStart() {
        var d = TunnelDiagnostics(writer: "test")
        d.beginRun(at: Date(timeIntervalSince1970: 100))
        d.endRun(at: Date(timeIntervalSince1970: 200), reason: "userInitiated")
        d.beginRun(at: Date(timeIntervalSince1970: 300))
        d.counters.seen = 5
        d.beginRun(at: Date(timeIntervalSince1970: 400))  // jetsam: no endRun
        #expect(d.runs.count == 3)
        #expect(d.runs[0].stopReason == "userInitiated" && d.runs[0].lastSeenAt == nil)
        #expect(d.runs[1].stoppedAt == nil && d.runs[1].lastSeenAt != nil)
        #expect(d.counters.seen == 0)
        #expect(d.intervals.map(\.counts.seen) == [5])  // the killed run's open interval was kept
        #expect(d.events.last?.message.contains("ended without stop") == true)
    }

    @Test func intervalsHoldDeltasAndLatencyPercentiles() {
        var d = TunnelDiagnostics(writer: "test")
        d.beginRun(at: Date(timeIntervalSince1970: 0))
        d.counters.blocked = 3
        d.counters.forwarded = 10
        d.closeInterval(at: Date(timeIntervalSince1970: 300), latencies: Array(1...100), peakFootprint: 7)
        d.counters.forwarded = 12
        d.closeInterval(at: Date(timeIntervalSince1970: 600), latencies: [], peakFootprint: 7)
        #expect(d.intervals[0].counts.blocked == 3 && d.intervals[0].counts.forwarded == 10 && d.intervals[0].seconds == 300)
        #expect((d.intervals[0].p50, d.intervals[0].p90, d.intervals[0].p99, d.intervals[0].max) == (50, 90, 99, 100))
        #expect(d.intervals[1].counts.forwarded == 2 && d.intervals[1].counts.blocked == 0 && d.intervals[1].p50 == nil)
        #expect(TunnelDiagnostics.percentile([42], 99) == 42)
    }

    /// The lists stay compact sorted bytes: loading every list costs a few
    /// MB, far under the ~50 MB packet-tunnel limit.
    @Test func loadingEveryListIsSmall() throws {
        let before = MemorySample.now().footprintBytes
        #expect(before > 0)
        let b = try bundle()
        let after = MemorySample.now().footprintBytes
        let bytes = b.sets.values.reduce(0) { $0 + $1.bytes.count }
        print("lists: \(b.sets.count) sets, \(bytes) bytes; footprint \(before >> 10) KiB -> \(after >> 10) KiB (\((Int64(after) - Int64(before)) >> 10) KiB)")
        // Footprint is process-wide (other tests run in parallel), so the
        // check is on what the sets retain: the artifact bytes, nothing per entry.
        #expect(bytes < 3 << 20)
    }
}

// MARK: - Per-type answers, forward retry, failure attribution

@Suite struct PerTypeAnswerTests {
    private let map = try! SafeSearchMap.parse(Data(#"{"v":1,"rules":[{"match":["www.google.com"],"target":"forcesafesearch.google.com","fallback":{"A":["216.239.38.120"]}}]}"#.utf8)).get()
    private let snap = DecisionSnapshot(userBlock: ["blocked.example"])

    private func decide(_ name: String, _ qtype: Int) -> DnsDecision {
        DnsEngine().decide(payload: DnsMessage.buildQuery(id: 9, name: name, qtype: qtype), snapshot: snap, safeSearch: map, now: 0)
    }

    /// NOERROR with no answer records.
    private func isNodata(_ d: DnsDecision) -> Bool {
        guard case .answer(let b) = d else { return false }
        return DnsMessage.rcode(b) == 0 && DnsMessage.u16(b, 6) == 0
    }

    @Test func blockedNameGivesNoUsableAnswerForAnyType() {
        guard case .answer(let a) = decide("www.blocked.example", DnsMessage.typeA),
            case .answer(let aaaa) = decide("www.blocked.example", DnsMessage.typeAAAA)
        else { Issue.record("expected answers"); return }
        #expect(DnsMessage.addresses(in: a) == [[0, 0, 0, 0]])
        #expect(DnsMessage.addresses(in: aaaa) == [[UInt8](repeating: 0, count: 16)])
        for qtype in [DnsMessage.typeSVCB, DnsMessage.typeHTTPS, DnsMessage.typeCNAME, 16, DnsMessage.typeANY, 15] {
            #expect(isNodata(decide("www.blocked.example", qtype)), "qtype \(qtype)")
        }
    }

    /// HTTPS/SVCB hints or ANY's A records would skip the SafeSearch CNAME.
    @Test func safeSearchHostLeaksNoAddressesOutsideTheRewrite() {
        for qtype in [DnsMessage.typeSVCB, DnsMessage.typeHTTPS, DnsMessage.typeANY] {
            #expect(isNodata(decide("www.google.com", qtype)), "qtype \(qtype)")
        }
        guard case .rewrite = decide("www.google.com", DnsMessage.typeA) else { Issue.record("A not rewritten"); return }
        guard case .rewrite = decide("www.google.com", DnsMessage.typeAAAA) else { Issue.record("AAAA not rewritten"); return }
        guard case .forward = decide("www.google.com", 16) else { Issue.record("TXT not forwarded"); return }
    }
}

@Suite struct ForwardRetryTests {
    @Test func retriesOnlyWhenTheFailureSaysNothingAboutTheCurrentUpstream() {
        func retry(_ sent: Int, _ now: Int, _ forwarding: Bool, _ elapsed: TimeInterval) -> Bool {
            ForwardRetry.shouldRetry(sentGeneration: sent, generation: now, forwarding: forwarding, elapsed: elapsed, timeout: 2)
        }
        #expect(retry(1, 2, true, 2.0))  // sent on the previous network; new resolvers known
        #expect(!retry(1, 2, false, 2.0))  // new resolvers not known yet: nothing to retry on
        #expect(retry(2, 2, true, 0.01))  // send error right away
        #expect(!retry(2, 2, true, 2.0))  // a real timeout on the current upstream
        #expect(!retry(2, 2, false, 0.01))
        // A timeout before anything answered on this network: retried once.
        #expect(ForwardRetry.shouldRetry(sentGeneration: 2, generation: 2, forwarding: true, elapsed: 2.0, timeout: 2, answeredOnThisNetwork: false))
        #expect(!ForwardRetry.shouldRetry(sentGeneration: 2, generation: 2, forwarding: false, elapsed: 2.0, timeout: 2, answeredOnThisNetwork: false))
    }

    @Test func failureDetailSplitsCausesAndCountsDistinctLookups() {
        var d = TunnelDiagnostics(writer: "test")
        d.beginRun(at: Date(timeIntervalSince1970: 100))
        d.record(TunnelDiagnostics.PathChange(at: Date(timeIntervalSince1970: 200), status: "satisfied", interfaces: [], gateways: []))
        var open: TunnelDiagnostics.PathChange? = nil
        d.recordFailure(sentBeforeChange: false, open: &open, timedOut: true, queryHash: 1)
        d.recordFailure(sentBeforeChange: false, open: &open, timedOut: true, queryHash: 1)  // the same lookup retried
        d.recordFailure(sentBeforeChange: false, open: &open, timedOut: false, queryHash: 2)
        d.recordFirstAnswer(ms: 850)
        d.recordFirstAnswer(ms: 2000)  // only the first counts
        let p = d.paths.last!
        #expect(p.failedAfter == 3 && p.failedTimeout == 2 && p.failedSendError == 1)
        #expect(p.failedQueryHashes == [1, 2])
        #expect(p.firstAnswerMs == 850)
    }
}

@Suite struct FailureAttributionTests {
    @Test func failuresLandOnTheRightNetworkChange() {
        var d = TunnelDiagnostics(writer: "test")
        d.record(TunnelDiagnostics.PathChange(at: Date(timeIntervalSince1970: 10), status: "satisfied", interfaces: [], gateways: []))
        d.beginRun(at: Date(timeIntervalSince1970: 100))
        var open: TunnelDiagnostics.PathChange? = nil
        d.recordFailure(sentBeforeChange: false, open: &open)  // only an earlier run's entry: untouched
        #expect(d.paths[0].failedAfter == nil && d.counters.failed == 1)

        d.record(TunnelDiagnostics.PathChange(at: Date(timeIntervalSince1970: 200), status: "satisfied", interfaces: [], gateways: []))
        d.recordFailure(sentBeforeChange: false, open: &open)
        d.recordFailure(sentBeforeChange: true, open: &open)  // change already resolved
        #expect(d.paths[1].failedAfter == 1 && d.paths[1].failedInFlight == 1)

        open = TunnelDiagnostics.PathChange(at: Date(timeIntervalSince1970: 300), status: "unsatisfied", interfaces: [], gateways: [])
        d.recordFailure(sentBeforeChange: true, open: &open)
        #expect(open?.failedInFlight == 1 && d.paths[1].failedInFlight == 1 && d.counters.failed == 4)
    }
}

@Suite struct RediscoveryLimitTests {
    @Test func networkKeyFollowsOnlyThePrimaryInterface() {
        let wifi = [(name: "en0", type: "wifi")]
        let base = NetworkKey.make(status: "satisfied", interfaces: wifi, gateways: ["192.168.1.1"])
        // A secondary interface appears or disappears: no change.
        #expect(NetworkKey.make(status: "satisfied", interfaces: wifi + [(name: "pdp_ip0", type: "cellular")], gateways: ["192.168.1.1"]) == base)
        // Primary moves from Wi-Fi to cellular: change.
        #expect(NetworkKey.make(status: "satisfied", interfaces: [(name: "pdp_ip0", type: "cellular"), (name: "en0", type: "wifi")], gateways: ["192.168.1.1"]) != base)
        // Same interface, new gateway (another Wi-Fi network): change.
        #expect(NetworkKey.make(status: "satisfied", interfaces: wifi, gateways: ["10.0.0.1"]) != base)
        // Status change: change. Gateway order: no change.
        #expect(NetworkKey.make(status: "unsatisfied", interfaces: wifi, gateways: ["192.168.1.1"]) != base)
        #expect(NetworkKey.make(status: "satisfied", interfaces: wifi, gateways: ["b", "a"]) == NetworkKey.make(status: "satisfied", interfaces: wifi, gateways: ["a", "b"]))
    }

    @Test func threeAttemptsPerNetworkWithLongerReadsThenGiveUp() {
        var r = ResolverRediscovery()
        do { let v = r.next(generation: 1, now: 0); #expect(v == .attempt(readWait: 0.1, after: 0)) }
        do { let v = r.next(generation: 1, now: 1); #expect(v == .attempt(readWait: 0.5, after: 0)) }
        do { let v = r.next(generation: 1, now: 2); #expect(v == .attempt(readWait: 1.5, after: 0)) }
        do { let v = r.next(generation: 1, now: 3); #expect(v == .giveUp) }
        do { let v = r.next(generation: 1, now: 500); #expect(v == .giveUp) }  // never again on this network
        // A new network starts over (well past the window budget).
        do { let v = r.next(generation: 2, now: 600); #expect(v == .attempt(readWait: 0.1, after: 0)) }
    }

    @Test func windowBudgetDelaysAnyFourthWindowWithinAMinute() {
        var r = ResolverRediscovery()
        for g in 1...3 { let v = r.next(generation: g, now: Double(g)); #expect(v == .attempt(readWait: 0.1, after: 0)) }
        // A fourth network change 1 s later must wait until 60 s after the first window.
        do { let v = r.next(generation: 4, now: 4); #expect(v == .attempt(readWait: 0.1, after: 57)) }
        do { let v = r.staleRetry(generation: 4, now: 4); #expect(v == 58) }
    }

    @Test func staleRetryOncePerNetwork() {
        var r = ResolverRediscovery()
        do { let v = r.staleRetry(generation: 1, now: 0); #expect(v == 0) }
        do { let v = r.staleRetry(generation: 1, now: 100); #expect(v == nil) }
        do { let v = r.staleRetry(generation: 2, now: 200); #expect(v == 0) }
    }

    @Test func staleRetryAgainOnSameNetworkOnlyAfterAnAnswer() {
        var r = ResolverRediscovery()
        do { let v = r.staleRetry(generation: 1, now: 0); #expect(v == 0) }
        do { let v = r.staleRetry(generation: 1, now: 100); #expect(v == nil) }  // nothing answered since
        r.answered()
        do { let v = r.staleRetry(generation: 1, now: 200); #expect(v == 0) }
        do { let v = r.staleRetry(generation: 1, now: 300); #expect(v == nil) }
        // Still bound by the window budget: windows at 400, 401, 402, so a
        // fourth at 403 waits until 400 + 60.
        for t in 400...402 {
            r.answered()
            let v = r.staleRetry(generation: 1, now: Double(t)); #expect(v == 0)
        }
        r.answered()
        do { let v = r.staleRetry(generation: 1, now: 403); #expect(v == 57) }
    }

    @Test func upstreamHealthNeedsSustainedFailuresWithoutSuccess() {
        var h = UpstreamHealth()
        for i in 0..<7 { let v = h.failure(generation: 1, now: Double(i) * 10); #expect(!v) }
        do { let v = h.failure(generation: 1, now: 70); #expect(v) }  // 8 failures over 70 s
        h.success()
        for i in 0..<7 { let v = h.failure(generation: 1, now: 100 + Double(i)); #expect(!v) }
        do { let v = h.failure(generation: 1, now: 107); #expect(!v) }  // 8 failures but only 7 s
        do { let v = h.failure(generation: 1, now: 131); #expect(v) }
        // A new network starts counting again.
        do { let v = h.failure(generation: 2, now: 200); #expect(!v) }
    }
}

@Suite struct CoalescedRefreshTests {
    @Test func requestsDuringARunFoldIntoOneFollowUp() {
        var c = CoalescedRefresh()
        do { let v = c.begin(); #expect(v) }
        for _ in 0..<50 { let v = c.begin(); #expect(!v) }  // a burst of notifications
        do { let v = c.finish(); #expect(v) }    // exactly one follow-up run
        do { let v = c.finish(); #expect(!v) }   // then idle
        do { let v = c.begin(); #expect(v) }     // next request starts fresh
        do { let v = c.finish(); #expect(!v) }
    }
}

@Suite struct SafariHeldTests {
    /// Safari holds A; the user changes to B; the apply of B runs while they
    /// revert to A; B lands. The follow-up for A must reload.
    @Test func aChangeAndRevertDuringAnApplyStillReloads() {
        var held: String? = "cA"
        #expect(!SafariHeld.needsReload(expected: "cA", held: held))
        #expect(SafariHeld.needsReload(expected: "cB", held: held))  // change to B
        held = SafariHeld.after(.applied(checksum: "cB"), before: held)  // B lands, settings already back at A
        #expect(SafariHeld.needsReload(expected: "cA", held: held))  // follow-up must reload A
        held = SafariHeld.after(.applied(checksum: "cA"), before: held)
        #expect(!SafariHeld.needsReload(expected: "cA", held: held))
    }

    @Test func pendingFailedAndUnknown() {
        #expect(SafariHeld.after(.pendingReload, before: "cA") == nil)
        #expect(SafariHeld.after(.failed, before: "cA") == "cA")
        #expect(SafariHeld.needsReload(expected: "cA", held: nil))
        #expect(SafariHeld.needsReload(expected: nil, held: "cA"))
    }
}
