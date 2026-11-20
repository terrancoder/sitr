/// No allow entry opens an adult-listed name (the owner's rules R1–R3):
/// the DNS filter's decision, the Safari rule order, and the lookup the app
/// uses to refuse such an entry. The DNS cases are a table so they can be
/// driven from apps/shared/fixtures/decision.json once that fixture exists.
import CryptoKit
import Foundation
import Testing

@testable import SitrCore

private let androidDir = fixturesDir.deletingLastPathComponent().appendingPathComponent("blocklists/android")

private func realBundle() throws -> BlocklistBundle {
    switch BlocklistBundle.load(from: androidDir) {
    case .success(let b): return b
    case .failure(let e): throw e
    }
}

/// One decision case: who allows (or blocks) what, and the verdict for a name.
struct DecisionCase: CustomTestStringConvertible {
    let note: String
    var userAllow: Set<String> = []
    var userBlock: Set<String> = []
    var householdAllow: Set<String> = []
    var householdBlock: Set<String> = []
    let name: String
    let blocked: Bool
    var testDescription: String { note }
}

// Real list entries: pornhub.com (adult), 403.hqhost.net (adult; its
// parent hqhost.net is not listed), jewishfriendfinder.com (dating) with
// ads.jewishfriendfinder.com (adult) under it, bet365.com (gambling).
let adultDecisionCases: [DecisionCase] = [
    // R1, device user layer
    .init(note: "user allow does not open an adult name", userAllow: ["pornhub.com"], name: "pornhub.com", blocked: true),
    .init(note: "user allow does not open its subdomains", userAllow: ["pornhub.com"], name: "www.pornhub.com", blocked: true),
    .init(note: "user allow on a subdomain of an adult parent has no effect", userAllow: ["www.pornhub.com"], name: "www.pornhub.com", blocked: true),
    .init(note: "user allow on the parent of an adult subdomain opens the parent", userAllow: ["hqhost.net"], name: "hqhost.net", blocked: false),
    .init(note: "…and its other subdomains", userAllow: ["hqhost.net"], name: "www.hqhost.net", blocked: false),
    .init(note: "…but not the listed subdomain", userAllow: ["hqhost.net"], name: "403.hqhost.net", blocked: true),
    .init(note: "…nor names under it", userAllow: ["hqhost.net"], name: "x.403.hqhost.net", blocked: true),
    // R1, household layer
    .init(note: "household allow does not open an adult name", householdAllow: ["pornhub.com"], name: "pornhub.com", blocked: true),
    .init(note: "household allow beats a user block but not adult", userBlock: ["pornhub.com"], householdAllow: ["pornhub.com"], name: "pornhub.com", blocked: true),
    .init(note: "household allow on a dating parent opens it", householdAllow: ["jewishfriendfinder.com"], name: "jewishfriendfinder.com", blocked: false),
    .init(note: "…but not its adult-listed subdomain", householdAllow: ["jewishfriendfinder.com"], name: "ads.jewishfriendfinder.com", blocked: true),
    .init(note: "both layers allowing still does not open it", userAllow: ["pornhub.com"], householdAllow: ["pornhub.com"], name: "m.pornhub.com", blocked: true),
    // R3, other categories unchanged
    .init(note: "user allow opens a gambling name", userAllow: ["bet365.com"], name: "bet365.com", blocked: false),
    .init(note: "household allow opens a dating name", householdAllow: ["jewishfriendfinder.com"], name: "www.jewishfriendfinder.com", blocked: false),
    .init(note: "household block beats user allow (order unchanged)", userAllow: ["bet365.com"], householdBlock: ["bet365.com"], name: "bet365.com", blocked: true),
    .init(note: "household allow beats user block (order unchanged)", userBlock: ["example.com"], householdAllow: ["example.com"], name: "example.com", blocked: false),
    .init(note: "no entry: gambling blocked", name: "bet365.com", blocked: true),
    .init(note: "no entry: adult blocked", name: "pornhub.com", blocked: true),
]

@Suite struct AdultAllowTests {
    @Test(arguments: adultDecisionCases)
    func dnsDecision(_ c: DecisionCase) throws {
        let b = try realBundle()
        let inputs = FilterInputs(
            lists: ["adult", "gambling", "dating"], householdAllow: c.householdAllow,
            householdBlock: c.householdBlock, userAllow: c.userAllow, userBlock: c.userBlock)
        #expect(b.snapshot(inputs).decide(c.name) == (c.blocked ? .block : .forward), "\(c.note)")
    }

    @Test func adultLayerWorksOnSyntheticListsToo() throws {
        let adult = try DomainSet(domains: ["adult.example", "x.parent.example"])
        let other = try DomainSet(domains: ["gamble.example"])
        let s = DecisionSnapshot(
            householdAllow: ["adult.example"], userAllow: ["parent.example", "gamble.example"],
            staticBlock: [other], alwaysBlock: [adult])
        #expect(s.decide("adult.example") == .block)
        #expect(s.decide("parent.example") == .forward)
        #expect(s.decide("x.parent.example") == .block)
        #expect(s.decide("gamble.example") == .forward)
    }

    // R2: an allow entry for a search engine does not skip the SafeSearch
    // rewrite (the decision runs first; only a block stops the rewrite).
    @Test func allowNeverSwitchesSafeSearchOff() throws {
        let b = try realBundle()
        let host = try #require(b.safeSearch.rules.first?.match.first)
        let inputs = FilterInputs(
            lists: ["adult"], householdAllow: [host], householdBlock: [], userAllow: [host], userBlock: [])
        let action = NameAction.of(host, snapshot: b.snapshot(inputs), safeSearch: b.safeSearch)
        guard case .rewrite = action else {
            Issue.record("\(host) allowed: expected the SafeSearch rewrite, got \(action)")
            return
        }
    }

    @Test func coversWalksParentsOnly() throws {
        let adult = try DomainSet(domains: ["adult.example", "x.parent.example"])
        #expect(DecisionSnapshot.covers(adult, "adult.example"))
        #expect(DecisionSnapshot.covers(adult, "WWW.Adult.Example."))
        #expect(DecisionSnapshot.covers(adult, "a.x.parent.example"))
        #expect(!DecisionSnapshot.covers(adult, "parent.example"), "a parent of a listed name is not listed")
        #expect(!DecisionSnapshot.covers(adult, "notadult.example"))
        #expect(!DecisionSnapshot.covers(adult, ""))
    }

    // MARK: - Safari

    func rule(_ domain: String, _ action: SafariRule.Action = .block) -> SafariRule {
        SafariRule(urlFilter: SafariRules.urlFilter(for: domain), ifDomain: nil, action: action)
    }

    @Test func adultRulesComeAfterEveryAllow() throws {
        let built = SafariRules.build(
            staticRules: [rule("gamble.example")],
            userBlock: ["ub.example"], userAllow: ["adult.example", "gamble.example"],
            householdBlock: ["hb.example"], householdAllow: ["adult.example"],
            alwaysBlock: [rule("adult.example")])
        guard case .success(let rules) = built else {
            Issue.record("build failed")
            return
        }
        #expect(rules.map(\.action) == [.block, .block, .ignorePreviousRules, .ignorePreviousRules, .block, .ignorePreviousRules, .block])
        #expect(rules.last == rule("adult.example"))
        let lastIgnore = try #require(rules.lastIndex { $0.action == .ignorePreviousRules })
        #expect(rules.firstIndex(of: rule("adult.example"))! > lastIgnore)
    }

    /// WebKit's documented model: rules apply in order; a matching
    /// `ignore-previous-rules` cancels the actions triggered so far; a
    /// later matching `block` triggers again. This evaluates a built list
    /// that way.
    func blocked(_ url: String, by rules: [SafariRule]) throws -> Bool {
        var blocked = false
        for r in rules {
            let re = try NSRegularExpression(pattern: r.urlFilter)
            guard re.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil else { continue }
            blocked = r.action == .block
        }
        return blocked
    }

    @Test func allowedAdultStaysBlockedAllowedGamblingOpens() throws {
        guard
            case .success(let rules) = SafariRules.build(
                staticRules: [rule("gamble.example")], userBlock: [],
                userAllow: ["adult.example", "gamble.example", "parent.example"],
                householdBlock: [], householdAllow: ["adult.example"],
                alwaysBlock: [rule("adult.example"), rule("x.parent.example")])
        else {
            Issue.record("build failed")
            return
        }
        #expect(try blocked("https://adult.example/", by: rules))
        #expect(try blocked("https://www.adult.example/page", by: rules))
        #expect(try !blocked("https://gamble.example/", by: rules))
        #expect(try !blocked("https://parent.example/", by: rules))
        #expect(try blocked("https://x.parent.example/", by: rules))
    }

    @Test func budgetCountsTheAdultRules() {
        let half = (SafariRules.ruleBudget - SafariRules.ruleReserve) / 2 + 1
        let many = Array(repeating: rule("a.example"), count: half)
        guard case .failure = SafariRules.build(
            staticRules: many, userBlock: [], userAllow: [], householdBlock: [], householdAllow: [],
            alwaysBlock: many)
        else {
            Issue.record("static + adult over the budget must fail")
            return
        }
    }

    /// The real bundled fragments in the app's order: the adult rules,
    /// moved last, still fit the budget with every list on.
    @Test func realListsStillFitWithAdultLast() throws {
        let dir = fixturesDir.deletingLastPathComponent().appendingPathComponent("blocklists/safari")
        func fragment(_ n: String) throws -> [SafariRule] {
            switch SafariRules.parseFragment(try Data(contentsOf: dir.appendingPathComponent("\(n).safari.json"))) {
            case .success(let r): return r
            case .failure(let e): throw e
            }
        }
        let adult = try fragment("adult")
        var others: [SafariRule] = []
        for n in ["dating", "gambling", "imgur-media", "pinterest-media", "reddit-media", "tumblr-media", "violence"] {
            others += try fragment(n)
        }
        let built = SafariRules.build(
            staticRules: others, userBlock: [], userAllow: ["pornhub.com"], householdBlock: [], householdAllow: [],
            alwaysBlock: adult)
        guard case .success(let rules) = built else {
            Issue.record("the full set no longer fits")
            return
        }
        #expect(rules.count == adult.count + others.count + 1)
        #expect(Array(rules.suffix(adult.count)) == adult)
    }
}
