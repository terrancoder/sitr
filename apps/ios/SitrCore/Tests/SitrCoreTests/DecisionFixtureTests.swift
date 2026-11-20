/// apps/shared/fixtures/decision.json (tools/conformance): the decision
/// order every platform must give. R1: no allow entry opens an adult-listed
/// name. R2: an allow entry never switches SafeSearch off. R3: the other
/// lists and the layer order as before. Replayed on the DNS filter's
/// decision and, for the layers Safari has (no managed layer, no
/// SafeSearch on iOS Safari), on the Safari rule order.
import Foundation
import Testing

@testable import SitrCore

private struct Layer {
    var allow: Set<String> = []
    var block: Set<String> = []
    init(_ raw: Any?) {
        let d = raw as? [String: Any] ?? [:]
        allow = Set(d["allow"] as? [String] ?? [])
        block = Set(d["block"] as? [String] ?? [])
    }
}

@Suite struct DecisionFixtureTests {
    let doc: [String: Any]
    let lists: [String: DomainSet]
    let cases: [[String: Any]]

    init() throws {
        doc = try fixture("decision.json")
        let raw = try #require(doc["lists"] as? [String: [String]])
        lists = try raw.mapValues { try DomainSet(domains: $0) }
        cases = try #require(doc["cases"] as? [[String: Any]])
    }

    /// The builder's split (BlocklistBundle.snapshot): the adult list before
    /// every allow entry, the rest after.
    func snapshot(_ c: [String: Any]) -> DecisionSnapshot {
        let (m, h, u) = (Layer(c["managed"]), Layer(c["household"]), Layer(c["user"]))
        let stems = lists.keys.sorted()
        return DecisionSnapshot(
            managedAllow: m.allow, managedBlock: m.block,
            householdAllow: h.allow, householdBlock: h.block,
            userAllow: u.allow, userBlock: u.block,
            staticBlock: stems.filter { !BlocklistBundle.alwaysBlockLists.contains($0) }.compactMap { lists[$0] },
            alwaysBlock: stems.filter(BlocklistBundle.alwaysBlockLists.contains).compactMap { lists[$0] })
    }

    @Test func dnsDecisionMatchesTheFixture() throws {
        let safeSearch: SafeSearchMap
        switch BlocklistBundle.load(
            from: fixturesDir.deletingLastPathComponent().appendingPathComponent("blocklists/android"))
        {
        case .success(let b): safeSearch = b.safeSearch
        case .failure(let e): throw e
        }
        let engine = try #require(doc["searchEngine"] as? String)
        #expect(safeSearch.rule(for: engine) != nil, "the real SafeSearch map covers \(engine)")
        #expect(cases.count >= 25)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let host = try #require(c["host"] as? String)
            let action = NameAction.of(host, snapshot: snapshot(c), safeSearch: safeSearch)
            let got: String
            switch action {
            case .block: got = "block"
            case .rewrite: got = "safesearch"
            case .forward: got = "forward"
            }
            #expect(got == c["expected"] as? String, "\(name)")
        }
    }

    /// WebKit's model: in order, a matching ignore-previous-rules cancels
    /// what triggered so far; a later matching block triggers again.
    func safariBlocks(_ host: String, _ rules: [SafariRule]) throws -> Bool {
        let url = "https://\(host)/"
        var blocked = false
        for r in rules {
            let re = try NSRegularExpression(pattern: r.urlFilter)
            if re.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil {
                blocked = r.action == .block
            }
        }
        return blocked
    }

    @Test func safariOrderMatchesTheFixture() throws {
        func rules(_ stem: String) -> [SafariRule] {
            (doc["lists"] as? [String: [String]])?[stem]?.map {
                SafariRule(urlFilter: SafariRules.urlFilter(for: $0), ifDomain: nil, action: .block)
            } ?? []
        }
        var replayed = 0
        for c in cases where c["managed"] == nil && c["expected"] as? String != "safesearch" {
            let (h, u) = (Layer(c["household"]), Layer(c["user"]))
            let built = try SafariRules.build(
                staticRules: ["dating", "gambling", "violence"].flatMap(rules),
                userBlock: u.block.sorted(), userAllow: u.allow.sorted(),
                householdBlock: h.block.sorted(), householdAllow: h.allow.sorted(),
                alwaysBlock: rules("adult")
            ).get()
            let host = try #require(c["host"] as? String)
            #expect(try safariBlocks(host, built) == (c["expected"] as? String == "block"), "\(c["name"] ?? "?")")
            replayed += 1
        }
        #expect(replayed >= 15)
    }
}
