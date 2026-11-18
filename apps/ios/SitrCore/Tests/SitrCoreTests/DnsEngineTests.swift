/// Decision ladder, domain sets, SafeSearch, engine and upstream logic.
/// Scenarios and vectors mirror the Kotlin tests named on each test:
/// apps/android/core/src/test (DecisionLayersTest, ArtifactsTest) and
/// apps/android/engine/src/test (DnsForwarderTest, UpstreamResolverTest).
import CryptoKit
import Foundation
import Testing

@testable import SitrCore

private let androidDir = fixturesDir.deletingLastPathComponent().appendingPathComponent("blocklists/android")

private func artifact(_ name: String) throws -> Data {
    try Data(contentsOf: androidDir.appendingPathComponent(name))
}

private func checksums() throws -> [String: String] {
    try #require(JSONSerialization.jsonObject(with: artifact("checksums.json")) as? [String: String])
}

private func sha256Hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

private func set(_ domains: String...) -> DomainSet { try! DomainSet(domains: domains) }

private func loadCategory(_ category: String) throws -> DomainSet {
    let name = "\(category).domains"
    return try DomainSet(artifact: artifact(name), expectedSha256Hex: try #require(checksums()[name]))
}

private func lines(_ d: DomainSet) -> [String] {
    String(decoding: d.bytes, as: UTF8.self).split(separator: "\n").map(String.init)
}

@Suite struct DecisionLayerTests {
    // DecisionLayersTest.staticBlocklistBlocks
    @Test func staticBlocklistBlocks() {
        let s = DecisionSnapshot(staticBlock: [set("blocked.example")])
        #expect(s.decide("blocked.example") == .block)
        #expect(s.decide("sub.blocked.example") == .block)
        #expect(s.decide("fine.example") == .forward)
        #expect(s.decide("notblocked.example") == .forward)
    }

    // DecisionLayersTest: userAllowBeatsStaticBlock, allowWinsOverBlockWithinALayer,
    // householdBlockBeatsUserAllow, householdAllowBeatsUserBlock,
    // managedBlockBeatsHouseholdAllow, managedAllowBeatsEveryBlock
    @Test func ladderPrecedence() {
        let site: Set<String> = ["site.example"]
        let s1 = DecisionSnapshot(userAllow: ["blocked.example"], staticBlock: [set("blocked.example")])
        #expect(s1.decide("blocked.example") == .forward && s1.decide("www.blocked.example") == .forward)
        #expect(DecisionSnapshot(userAllow: site, userBlock: site).decide("site.example") == .forward)
        #expect(DecisionSnapshot(householdBlock: site, userAllow: site).decide("site.example") == .block)
        #expect(DecisionSnapshot(householdAllow: site, userBlock: site).decide("site.example") == .forward)
        #expect(DecisionSnapshot(managedBlock: site, householdAllow: site, userAllow: site).decide("site.example") == .block)
        #expect(
            DecisionSnapshot(managedAllow: site, householdBlock: site, userBlock: site, staticBlock: [set("site.example")])
                .decide("site.example") == .forward)
    }

    // DecisionLayersTest.subdomainMatchingMirrorsRequestDomains + allowScopedToSubdomainDoesNotUnblockParent
    @Test func subdomainMatching() {
        let s = DecisionSnapshot(staticBlock: [set("blocked.example")])
        #expect(s.decide("a.b.c.blocked.example") == .block)
        #expect(s.decide("example") == .forward)
        #expect(s.decide("BLOCKED.example.") == .block)
        let scoped = DecisionSnapshot(userAllow: ["ok.blocked.example"], staticBlock: [set("blocked.example")])
        #expect(scoped.decide("ok.blocked.example") == .forward)
        #expect(scoped.decide("blocked.example") == .block)
        #expect(scoped.decide("other.blocked.example") == .block)
        // Static sets are searched in turn.
        let two = DecisionSnapshot(staticBlock: [set("a.example"), set("b.example")])
        #expect(two.decide("x.b.example") == .block && two.decide("c.example") == .forward)
    }

    private let safeSearch = SafeSearchMap(rules: [
        .init(match: ["google.*", "www.google.*"], target: "forcesafesearch.google.com", fallbackA: [], fallbackAAAA: [])
    ])

    // DecisionLayersTest.blockRuleWinsOverSafeSearchRewrite, allowRuleCannotSwitchSafeSearchOff, ordinaryNamesForward
    @Test func nameActions() {
        let blocked = DecisionSnapshot(userBlock: ["google.co.uk"])
        #expect(NameAction.of("www.google.co.uk", snapshot: blocked, safeSearch: safeSearch) == .block)
        #expect(NameAction.of("google.co.uk", snapshot: blocked, safeSearch: safeSearch) == .block)
        #expect(NameAction.of("www.google.com", snapshot: blocked, safeSearch: safeSearch) == .rewrite(safeSearch.rules[0]))
        let allowed = DecisionSnapshot(userAllow: ["google.com"])
        #expect(NameAction.of("www.google.com", snapshot: allowed, safeSearch: safeSearch) == .rewrite(safeSearch.rules[0]))
        let s = DecisionSnapshot(staticBlock: [set("blocked.example")])
        #expect(NameAction.of("fine.example", snapshot: s, safeSearch: safeSearch) == .forward)
        #expect(NameAction.of("blocked.example", snapshot: s, safeSearch: safeSearch) == .block)
    }
}

@Suite struct DomainSetTests {
    // ArtifactsTest.domainSetsLoadWithVerifiedChecksums, plus near misses.
    @Test func realCategoryArtifactsLoadAndMatchExactly() throws {
        for category in ["adult", "gambling", "dating"] {
            let d = try loadCategory(category)
            let all = lines(d)
            #expect(d.count == all.count && d.count > 0, "\(category)")
            let snapshot = DecisionSnapshot(staticBlock: [d])
            let listed = Set(all)
            for entry in all {
                #expect(d.contains(entry), "\(entry)")
                #expect(snapshot.decide("www.\(entry)") == .block, "subdomain of \(entry)")
                // Near misses: a string prefix, an extension sorting just
                // after, a byte just before, and the parent.
                for miss in [String(entry.dropLast()), entry + "a", entry + "-", "0" + entry, String(entry.dropFirst())]
                where !listed.contains(miss) {
                    #expect(!d.contains(miss), "\(miss) must not match")
                }
                if let dot = entry.firstIndex(of: "."), !listed.contains(String(entry[entry.index(after: dot)...])) {
                    let parent = String(entry[entry.index(after: dot)...])
                    #expect(!d.contains(parent), "parent \(parent)")
                    #expect(snapshot.decide(parent) == .forward, "parent \(parent)")  // the compiler drops entries under a listed ancestor
                }
            }
            #expect(d.contains(all.first!) && d.contains(all.last!))
            #expect(!d.contains("") && !d.contains("\n") && !d.contains(all.first! + "\n" + all[1]))
        }
    }

    // ArtifactsTest.checksumMismatchRefusesToLoad
    @Test func corruptedByteFailsTheChecksum() throws {
        let name = "adult.domains"
        var bytes = try artifact(name)
        let expected = try #require(checksums()[name])
        bytes[bytes.startIndex + bytes.count / 2] ^= 0x01
        #expect(throws: DomainSetError.checksumMismatch) { try DomainSet(artifact: bytes, expectedSha256Hex: expected) }
        #expect(throws: DomainSetError.checksumMismatch) {
            try DomainSet(artifact: try artifact(name), expectedSha256Hex: String(repeating: "00", count: 32))
        }
    }

    // ArtifactsTest.invalidLineIsAHardError; the checksum is computed over
    // the bad bytes so the later checks are what fires.
    @Test func invalidOrUnsortedFilesAreRejected() {
        func load(_ s: String) throws -> DomainSet {
            let d = Data(s.utf8)
            return try DomainSet(artifact: d, expectedSha256Hex: sha256Hex(d))
        }
        #expect(throws: DomainSetError.invalidLine(2)) { try load("ok.example\nNOT A DOMAIN\n") }
        #expect(throws: DomainSetError.invalidLine(2)) { try load("a.example\n\nb.example\n") }
        #expect(throws: DomainSetError.invalidLine(1)) { try load("example\n") }
        #expect(throws: DomainSetError.unsorted(2)) { try load("b.example\na.example\n") }
        #expect(throws: DomainSetError.unsorted(2)) { try load("a.example\na.example\n") }
        #expect(throws: DomainSetError.unsorted(3)) { try load("a.example\nab.example\naa.example\n") }
        #expect((try? load(""))?.count == 0)
        #expect((try? load("\n"))?.count == 0)
        #expect((try? load("\n"))?.contains("") == false)
        #expect((try? load("a.example\nb.example"))?.contains("b.example") == true)  // no final LF
        // Uppercase hex checksum is accepted.
        let d = Data("a.example\n".utf8)
        #expect((try? DomainSet(artifact: d, expectedSha256Hex: sha256Hex(d).uppercased())) != nil)
    }

    /// The byte validator and `DomainInput.isValidDomain` agree.
    @Test func byteValidatorMatchesDomainInput() {
        for s in [
            "a.b", "example.com", "-a.com", "a-.com", "a..com", ".a.com", "a.com.", "A.com", "a_b.com", "a",
            "xn--bcher-kva.example", String(repeating: "a", count: 63) + ".com", String(repeating: "a", count: 64) + ".com",
            String(repeating: "a.", count: 126) + "a", String(repeating: "a.", count: 127) + "a", "1.2", "é.com", "",
        ] {
            let bytes = Array(s.utf8)
            let viaBytes = bytes.withUnsafeBytes { DomainSet.isValidDomainBytes($0) }
            #expect(viaBytes == DomainInput.isValidDomain(s), "\(s)")
        }
    }

    /// 150,000 generated domains: load, then hits and misses with a time
    /// bound that a linear scan (~150k × ~20 bytes per lookup) cannot meet.
    @Test func scaleTest150k() throws {
        var rng = SplitMix(seed: 42)
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789".utf8)
        var names = Set<String>()
        while names.count < 150_000 {
            let len = 4 + Int(rng.next() % 14)
            let label = String(decoding: (0..<len).map { _ in alphabet[Int(rng.next() % 26)] }, as: UTF8.self)
            names.insert(label + [".com", ".net", ".xxx", ".co.uk"][Int(rng.next() % 4)])
        }
        let sorted = names.map { Array($0.utf8) }.sorted { $0.lexicographicallyPrecedes($1) }
        var data = Data()
        for n in sorted { data.append(contentsOf: n); data.append(0x0a) }

        let loadStart = Date()
        let d = try DomainSet(artifact: data, expectedSha256Hex: sha256Hex(data))
        let loadTime = Date().timeIntervalSince(loadStart)
        #expect(d.count == 150_000)

        let probes = Array(names.prefix(50_000))
        let start = Date()
        var hits = 0
        var misses = 0
        for n in probes {
            if d.contains(n) { hits += 1 }
            if !d.contains(n + "x") { misses += 1 }  // sorts right after a hit
            if !d.contains("q" + n) { misses += 1 }
        }
        let elapsed = Date().timeIntervalSince(start)
        #expect(hits == probes.count)
        #expect(misses >= 2 * probes.count - 10)  // a generated "q…" may exist
        print("DomainSet scale: 150000 entries, \(d.bytes.count) bytes backing, load \(String(format: "%.3f", loadTime)) s, 150000 lookups \(String(format: "%.3f", elapsed)) s")
        // Debug build on a shared machine: generous, but a linear scan
        // would take minutes.
        #expect(elapsed < 10)
    }
}

@Suite struct SafeSearchArtifactTests {
    private func map() throws -> SafeSearchMap {
        try SafeSearchMap.parse(artifact("safesearch-hosts.json")).get()
    }

    // ArtifactsTest.safesearchMapLoadsAndMatches
    @Test func safesearchMapLoadsAndMatches() throws {
        let m = try map()
        #expect(m.rules.count == 4)
        #expect(m.rule(for: "bing.com")?.target == "strict.bing.com")
        #expect(m.rule(for: "www.bing.com")?.target == "strict.bing.com")
        #expect(m.rule(for: "duckduckgo.com")?.target == "safe.duckduckgo.com")
        #expect(m.rule(for: "m.youtube.com")?.target == "restrict.youtube.com")
        #expect(m.rule(for: "www.google.com")?.target == "forcesafesearch.google.com")
        #expect(m.rule(for: "google.de")?.target == "forcesafesearch.google.com")
        #expect(m.rule(for: "WWW.google.co.uk.")?.target == "forcesafesearch.google.com")
        for miss in ["maps.google.com", "evilgoogle.com", "google.a.b.c", "youtube.com.evil.example"] {
            #expect(m.rule(for: miss) == nil, "\(miss)")
        }
    }

    // ArtifactsTest.wildcardMatcherEdgeCases
    @Test func wildcardMatcherEdgeCases() {
        #expect(SafeSearchMap.matches("google.*", "google.de"))
        #expect(SafeSearchMap.matches("google.*", "google.co.uk"))
        #expect(!SafeSearchMap.matches("google.*", "google.a.b.c"))
        #expect(!SafeSearchMap.matches("google.*", "google."))
        #expect(!SafeSearchMap.matches("google.*", "google"))
        #expect(!SafeSearchMap.matches("google.*", "notgoogle.de"))
        #expect(!SafeSearchMap.matches("google.*", "google..de"))
        #expect(SafeSearchMap.matches("bing.com", "bing.com"))
        #expect(!SafeSearchMap.matches("bing.com", "www.bing.com"))
    }

    // ArtifactsTest.strictSearchRejectsMalformedArtifacts (+ an inline good one;
    // strict-search-hosts.json itself is not read here by design).
    @Test func strictSearchParsing() throws {
        for bad in ["not json", #"{"v":2,"hosts":[]}"#, #"{"v":1}"#, #"{"v":1,"hosts":[{"engine":"X"}]}"#] {
            #expect((try? StrictSearchHosts.parse(Data(bad.utf8)).get()) == nil, "\(bad)")
        }
        let good = #"{"v":1,"hosts":[{"engine":"Brave Search","host":"imgs.search.brave.com","safeModeAvailable":false},{"engine":"Brave Search","host":"cdn.search.brave.com"},{"engine":"G","host":"x.g.com","safeModeAvailable":true}]}"#
        let s = try StrictSearchHosts.parse(Data(good.utf8)).get()
        #expect(s.enginesWithoutSafeMode == ["Brave Search"])
        let folded = try DomainSet(domains: Array(s.hosts))
        #expect(DecisionSnapshot(staticBlock: [folded]).decide("imgs.search.brave.com") == .block)
    }

    @Test func rewriteBlockAndHttpsThroughTheEngine() throws {
        let m = try map()
        let engine = DnsEngine()
        let snapshot = DecisionSnapshot(staticBlock: [set("blocked.example")])

        // www.google.com A → CNAME to the target plus addresses.
        let a = dnsQuery("www.google.com", DnsMessage.typeA)
        guard case .rewrite(let q, let rule) = engine.decide(payload: a, snapshot: snapshot, safeSearch: m, now: 0) else {
            Issue.record("expected a rewrite"); return
        }
        #expect(rule.target == "forcesafesearch.google.com")
        let fallback = engine.rewriteAnswer(q, rule: rule, resolved: [])
        #expect(fallback.suffix(4) == [216, 239, 38, 120])
        #expect(Int(fallback[7]) == 2)  // CNAME + A
        let resolved = engine.rewriteAnswer(q, rule: rule, resolved: [[1, 2, 3, 4], [1, 2, 3, 5]])
        #expect(Int(resolved[7]) == 3 && resolved.suffix(4) == [1, 2, 3, 5])
        let cnameAt = 12 + q.questionBytes.count + DnsMessage.encodeName("www.google.com").count
        #expect(Int(fallback[cnameAt + 1]) == DnsMessage.typeCNAME)

        // AAAA gets the v6 fallback.
        let aaaa = dnsQuery("www.google.com", DnsMessage.typeAAAA)
        guard case .rewrite(let q6, let rule6) = engine.decide(payload: aaaa, snapshot: snapshot, safeSearch: m, now: 0) else {
            Issue.record("expected a rewrite"); return
        }
        let r6 = engine.rewriteAnswer(q6, rule: rule6, resolved: [])
        #expect(Int(r6[7]) == 2 && r6.suffix(2) == [0, 0x78])

        // Type 65 → NODATA.
        guard case .answer(let https) = engine.decide(payload: dnsQuery("www.google.com", 65), snapshot: snapshot, safeSearch: m, now: 0)
        else { Issue.record("expected NODATA"); return }
        #expect(https[3] & 0x0f == 0 && https[6] == 0 && https[7] == 0)

        // Other types for a rewrite host are forwarded.
        #expect(engine.decide(payload: dnsQuery("www.google.com", 16), snapshot: snapshot, safeSearch: m, now: 0) == .forward(DnsMessage.parseQuery(dnsQuery("www.google.com", 16))!))

        // A blocked SafeSearch host is answered as blocked, never rewritten.
        let blockGoogle = DecisionSnapshot(userBlock: ["google.com"])
        guard case .answer(let blocked) = engine.decide(payload: a, snapshot: blockGoogle, safeSearch: m, now: 0) else {
            Issue.record("expected a blocked answer"); return
        }
        #expect(blocked == DnsAnswerBuilder.blocked(q))
    }
}

/// A scripted upstream: per address, the UDP datagrams it sends back (nil
/// = unreachable) and its TCP answer (nil = refused).
private final class FakeTransport: DnsUpstreamTransport, @unchecked Sendable {
    var udpReplies: [String: [[UInt8]]] = [:]
    var tcpReplies: [String: [UInt8]] = [:]
    private(set) var udpAsked: [String] = []
    private(set) var tcpAsked: [[UInt8]] = []
    private let lock = NSLock()

    struct Unreachable: Error {}

    func udp(_ query: [UInt8], to upstream: String) async throws -> AsyncThrowingStream<[UInt8], Error> {
        lock.withLock { udpAsked.append(upstream) }
        guard let replies = udpReplies[upstream] else { throw Unreachable() }
        return AsyncThrowingStream { c in
            for r in replies { c.yield(r) }
            c.finish()  // the timeout
        }
    }

    func tcp(_ query: [UInt8], to upstream: String) async throws -> [UInt8] {
        lock.withLock { tcpAsked.append(query) }
        guard let r = tcpReplies[upstream] else { throw Unreachable() }
        return r
    }
}

@Suite struct UpstreamAndEngineTests {
    // UpstreamResolverTest.query / reply()
    private let query: [UInt8] = [0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 7] + Array("example".utf8) + [3] + Array("com".utf8) + [0, 0, 1, 0, 1]
    private var question: [UInt8] { DnsMessage.parseQuery(query)!.questionBytes }

    private func reply(truncated: Bool = false, tail: Int = 0) -> [UInt8] {
        var r = query + [UInt8](repeating: 0, count: tail)
        r[2] = 0x81 | (truncated ? 0x02 : 0)
        r[3] = 0x80
        return r
    }

    private func accept() -> @Sendable ([UInt8]) -> Bool {
        let q = query, qs = question
        return { DnsMessage.isReplyTo(q, question: qs, reply: $0) }
    }

    // UpstreamResolverTest.skipsDatagramsThatAreNotTheAnswer
    @Test func skipsDatagramsThatAreNotTheAnswer() async {
        let t = FakeTransport()
        var wrongId = reply(); wrongId[1] = 0x35
        t.udpReplies["127.0.0.1"] = [[], [0], wrongId, reply()]
        let r = UpstreamResolver(transport: t)
        await r.setUpstreams(["127.0.0.1"])
        #expect(await r.forward(query, accept: accept()) == reply())
    }

    // UpstreamResolverTest.givesUpWhenOnlyJunkArrives
    @Test func givesUpWhenOnlyJunkArrives() async {
        let t = FakeTransport()
        var wrongId = reply(); wrongId[1] = 0x35
        t.udpReplies["127.0.0.1"] = [[], wrongId]
        let r = UpstreamResolver(transport: t)
        await r.setUpstreams(["127.0.0.1"])
        #expect(await r.forward(query, accept: accept()) == nil)
    }

    // UpstreamResolverTest.fallsBackToTheNextUpstreamAndRemembersIt
    @Test func fallsBackToTheNextUpstreamAndRemembersIt() async {
        let t = FakeTransport()
        t.udpReplies["::1"] = []  // silent: times out with nothing
        t.udpReplies["127.0.0.1"] = [reply()]
        let r = UpstreamResolver(transport: t)
        await r.setUpstreams(["::1", "127.0.0.1"])
        #expect(await r.forward(query, accept: accept()) == reply())
        #expect(await r.forward(query, accept: accept()) == reply())
        #expect(t.udpAsked == ["::1", "127.0.0.1", "127.0.0.1"])  // the dead one was not asked first again
        // A changed list resets the preference; the tunnel's own address is filtered.
        #expect(await r.setUpstreams(["10.111.222.1", "::1", "127.0.0.1"]) == false)
        #expect(await r.setUpstreams(["127.0.0.1"]) == true)
    }

    // UpstreamResolverTest.refetchesATruncatedAnswerOverTcp
    @Test func refetchesATruncatedAnswerOverTcp() async throws {
        let t = FakeTransport()
        let full = reply(tail: 900)
        t.udpReplies["127.0.0.1"] = [reply(truncated: true)]
        t.tcpReplies["127.0.0.1"] = full
        let r = UpstreamResolver(transport: t)
        await r.setUpstreams(["127.0.0.1"])
        let answer = try #require(await r.forward(query, accept: accept()))
        #expect(answer.count == full.count && !DnsMessage.isTruncated(answer))
        #expect(t.tcpAsked == [query])
    }

    // UpstreamResolverTest.keepsTheTruncatedAnswerWhenTcpIsRefused (+ oversized / unaccepted TCP)
    @Test func keepsTheTruncatedAnswerWhenTcpFails() async throws {
        let t = FakeTransport()
        t.udpReplies["127.0.0.1"] = [reply(truncated: true)]
        let r = UpstreamResolver(transport: t)
        await r.setUpstreams(["127.0.0.1"])
        #expect(DnsMessage.isTruncated(try #require(await r.forward(query, accept: accept()))))
        t.tcpReplies["127.0.0.1"] = reply(tail: 5000)  // > 4096
        #expect(DnsMessage.isTruncated(try #require(await r.forward(query, accept: accept()))))
        var wrongId = reply(); wrongId[1] = 0x35
        t.tcpReplies["127.0.0.1"] = wrongId
        #expect(DnsMessage.isTruncated(try #require(await r.forward(query, accept: accept()))))
    }

    // UpstreamResolverTest.cacheNeverServesAReplyItCannotReId (+ expiry and LRU)
    @Test func cacheSemantics() {
        let cache = DnsCache(maxEntries: 2)
        cache.put("example.com", 1, [0], now: 0)
        #expect(cache.get("example.com", 1, id: 7, now: 1) == nil)
        cache.put("example.com", 1, reply(), now: 0)
        let hit = cache.get("example.com", 1, id: 0x0102, now: 1)!
        #expect(hit[0] == 0x01 && hit[1] == 0x02 && Array(hit[2...]) == Array(reply()[2...]))
        #expect(cache.get("example.com", 1, id: 1, now: 60) != nil)  // strict <
        #expect(cache.get("example.com", 1, id: 1, now: 60.5) == nil)
        cache.put("a.example", 1, reply(), now: 0)
        cache.put("b.example", 1, reply(), now: 0)
        _ = cache.get("a.example", 1, id: 1, now: 0)
        cache.put("c.example", 1, reply(), now: 0)  // evicts b, the least recently used
        #expect(cache.get("b.example", 1, id: 1, now: 0) == nil)
        #expect(cache.get("a.example", 1, id: 1, now: 0) != nil)
    }

    private func header(_ questions: UInt8 = 1) -> [UInt8] { [0x12, 0x34, 0x01, 0x00, 0, questions, 0, 0, 0, 0, 0, 0] }
    private func name(_ s: String) -> [UInt8] {
        s.split(separator: ".").flatMap { [UInt8($0.utf8.count)] + Array($0.utf8) } + [0]
    }

    // DnsForwarderTest.dropsQueriesItCannotReadAndAnswersTheDohCanaryItself
    @Test func dropsUnreadableQueriesAnswersTheCanaryAndForwards() async throws {
        let engine = DnsEngine()
        let snapshot = DecisionSnapshot()
        let map = SafeSearchMap(rules: [])
        let a: [UInt8] = [0, 1, 0, 1]
        for bad in [
            header() + [0xC0, 18] + a + name("blocked.example"),
            header(2) + name("example.com") + a + name("blocked.example") + a,
            header() + name("blocked.example") + [0, 1, 0, 3],
        ] {
            #expect(engine.decide(payload: bad, snapshot: snapshot, safeSearch: map, now: 0) == .drop)
        }
        guard case .answer(let canary) = engine.decide(payload: header() + name("use-application-dns.net") + a, snapshot: snapshot, safeSearch: map, now: 0)
        else { Issue.record("canary must be answered locally"); return }
        #expect(canary[3] & 0x0f == 0 && canary[7] == 0)

        // An ordinary query is forwarded, capped, cached, then served from cache.
        let t = FakeTransport()
        var upstreamReply = reply()
        upstreamReply[7] = 1  // ANCOUNT 1
        upstreamReply += [0xc0, 12, 0, 1, 0, 1, 0, 0, 0x0e, 0x10, 0, 4, 93, 184, 216, 34]  // TTL 3600
        t.udpReplies["192.0.2.53"] = [upstreamReply]
        let resolver = UpstreamResolver(transport: t)
        await resolver.setUpstreams(["192.0.2.53"])
        guard case .forward(let q) = engine.decide(payload: query, snapshot: snapshot, safeSearch: map, now: 0) else {
            Issue.record("expected forward"); return
        }
        let answer = try #require(await engine.forward(q, payload: query, via: resolver, now: { 0 }))
        #expect(Array(answer[(answer.count - 10)..<(answer.count - 6)]) == [0, 0, 0, 60])
        var again = query
        again[0] = 0x55
        guard case .answer(let cached) = engine.decide(payload: again, snapshot: snapshot, safeSearch: map, now: 1) else {
            Issue.record("expected a cache hit"); return
        }
        #expect(cached[0] == 0x55 && Array(cached[1...]) == Array(answer[1...]))
        #expect(t.udpAsked.count == 1)

        // SERVFAIL and truncated answers are returned but not cached.
        let fresh = DnsEngine()
        var servfail = reply()
        servfail[3] = 0x82
        t.udpReplies["192.0.2.53"] = [servfail]
        #expect(await fresh.forward(q, payload: query, via: resolver, now: { 0 }) == servfail)
        #expect(fresh.decide(payload: query, snapshot: snapshot, safeSearch: map, now: 1) == .forward(q))
    }
}
