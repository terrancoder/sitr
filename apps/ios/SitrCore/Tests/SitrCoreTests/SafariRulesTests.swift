/// Safari rule assembly — the ladder-precedence scenarios from
/// tests/src/ruleLayers.test.ts, expressed as rule ORDER (WebKit evaluates
/// in order; ignore-previous-rules cancels only earlier rules).
import Foundation
import Testing

@testable import SitrCore

@Suite struct SafariRulesTests {
    let staticRule = SafariRule(
        urlFilter: SafariRules.urlFilter(for: "blocked.example"), ifDomain: nil, action: .block)

    @Test func urlFilterMatchesTheCompilerByteForByte() {
        // The same golden string as tests/src/emitSafari.test.ts.
        #expect(
            SafariRules.urlFilter(for: "b-c.example")
                == #"^[^:]+://+([^/]*@)?([^:/]+\.)?b-c\.example\.?[:/]"#)
    }

    @Test func urlFilterMatchesRequestsToTheDomainOnly() throws {
        // WebKit's regex subset is a subset of NSRegularExpression's.
        let regex = try NSRegularExpression(
            pattern: SafariRules.urlFilter(for: "site.example"), options: [.caseInsensitive])
        func matches(_ url: String) -> Bool {
            regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil
        }
        for url in [
            "https://site.example/", "https://www.site.example/x", "https://a.b.site.example:8443/",
            "https://SITE.example/", "https://user@site.example/", "https://site.example./",
        ] {
            #expect(matches(url), "should match \(url)")
        }
        for url in [
            "https://notsite.example/", "https://site.example.evil.test/",
            "https://evil.test/site.example/", "https://evil.test/@site.example/",
        ] {
            #expect(!matches(url), "should not match \(url)")
        }
    }

    @Test func ladderOrderIsWeakestFirst() throws {
        guard
            case .success(let rules) = SafariRules.build(
                staticRules: [staticRule],
                userBlock: ["ub.example"],
                userAllow: ["ua.example"],
                householdBlock: ["hb.example"],
                householdAllow: ["ha.example"]
            )
        else {
            Issue.record("build failed")
            return
        }

        #expect(rules.count == 5)
        func filter(_ domain: String) -> String { SafariRules.urlFilter(for: domain) }
        #expect(rules[0].urlFilter == filter("blocked.example") && rules[0].action == .block)
        #expect(rules[1].urlFilter == filter("ub.example") && rules[1].action == .block)
        #expect(rules[2].urlFilter == filter("ua.example") && rules[2].action == .ignorePreviousRules)
        #expect(rules[3].urlFilter == filter("hb.example") && rules[3].action == .block)
        #expect(rules[4].urlFilter == filter("ha.example") && rules[4].action == .ignorePreviousRules)
        // Request-level rules only: `if-domain` would scope a rule to the
        // top-level page and let embedded content through.
        #expect(rules.allSatisfy { $0.ifDomain == nil })
        // The order encodes the ladder: user allow (2) cancels only the
        // blocks before it; household block (3) comes after and wins;
        // household allow (4) is last and beats everything.
    }

    @Test func oneRulePerDomain() throws {
        let domains = (0..<1_001).map { String(format: "d%06d.example", $0) }
        guard
            case .success(let rules) = SafariRules.build(
                staticRules: [], userBlock: domains, userAllow: [],
                householdBlock: [], householdAllow: [])
        else {
            Issue.record("build failed")
            return
        }
        #expect(rules.count == domains.count)
    }

    @Test func overflowIsSurfacedNeverTruncated() {
        let tooMany = Array(
            repeating: staticRule,
            count: SafariRules.maxRules + 1
        )
        if case .success = SafariRules.build(
            staticRules: tooMany, userBlock: [], userAllow: [],
            householdBlock: [], householdAllow: [])
        {
            Issue.record("expected surfaced overflow error")
        }
    }

    @Test func serializeIsDeterministicAndRoundTrips() throws {
        guard
            case .success(let rules) = SafariRules.build(
                staticRules: [staticRule],
                userBlock: ["b.example"], userAllow: ["a.example"],
                householdBlock: [], householdAllow: [])
        else {
            Issue.record("build failed")
            return
        }

        let one = SafariRules.serialize(rules)
        let two = SafariRules.serialize(rules)
        #expect(one == two, "serialization must be deterministic")
        #expect(String(decoding: one, as: UTF8.self).hasSuffix("\n"))

        guard case .success(let parsed) = SafariRules.parseFragment(one) else {
            Issue.record("round-trip parse failed")
            return
        }
        #expect(parsed == rules)
    }

    @Test func parsesCompilerEmittedFragment() throws {
        // The committed artifact the app bundles — parse the real thing.
        let dir = fixturesDir.deletingLastPathComponent()
            .appendingPathComponent("blocklists/safari")
        let data = try Data(contentsOf: dir.appendingPathComponent("adult.safari.json"))
        guard case .success(let rules) = SafariRules.parseFragment(data) else {
            Issue.record("compiler fragment must parse")
            return
        }
        #expect(!rules.isEmpty)
        #expect(rules.allSatisfy { $0.action == .block })
        #expect(rules.allSatisfy { $0.ifDomain == nil && $0.urlFilter.hasPrefix("^[^:]+://+") })
    }

    @Test func rejectsUnknownTriggerKeys() {
        // A trigger key this version doesn't understand must be a surfaced
        // error, never skimmed: silently dropping "resource-type" would turn
        // a media-only rule into a block-everything rule for those hosts.
        let fragment = """
            [{"trigger":{"url-filter":".*","if-domain":["*x.com"],
              "resource-type":["image","media"]},
              "action":{"type":"block"}}]
            """
        guard case .failure(let error) = SafariRules.parseFragment(Data(fragment.utf8)) else {
            Issue.record("unknown trigger key must be rejected")
            return
        }
        #expect(error.message.contains("resource-type"))

        let unknownAction = """
            [{"trigger":{"url-filter":".*"},
              "action":{"type":"block","selector":"img"}}]
            """
        guard case .failure = SafariRules.parseFragment(Data(unknownAction.utf8)) else {
            Issue.record("unknown action key must be rejected")
            return
        }

        let unknownTop = """
            [{"trigger":{"url-filter":".*"},"action":{"type":"block"},"extra":1}]
            """
        guard case .failure = SafariRules.parseFragment(Data(unknownTop.utf8)) else {
            Issue.record("unknown top-level rule key must be rejected")
            return
        }
    }
}
