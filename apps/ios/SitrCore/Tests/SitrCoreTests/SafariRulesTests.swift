/// Safari rule assembly — the ladder-precedence scenarios from
/// tests/src/ruleLayers.test.ts, expressed as rule ORDER (WebKit evaluates
/// in order; ignore-previous-rules cancels only earlier rules).
import Foundation
import Testing

@testable import SitrCore

@Suite struct SafariRulesTests {
    let staticRule = SafariRule(ifDomain: ["*blocked.example"], action: .block)

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
        #expect(rules[0].ifDomain == ["*blocked.example"] && rules[0].action == .block)
        #expect(rules[1].ifDomain == ["*ub.example"] && rules[1].action == .block)
        #expect(rules[2].ifDomain == ["*ua.example"] && rules[2].action == .ignorePreviousRules)
        #expect(rules[3].ifDomain == ["*hb.example"] && rules[3].action == .block)
        #expect(rules[4].ifDomain == ["*ha.example"] && rules[4].action == .ignorePreviousRules)
        // The order encodes the ladder: user allow (2) cancels only the
        // blocks before it; household block (3) comes after and wins;
        // household allow (4) is last and beats everything.
    }

    @Test func batchingMatchesCompilerContract() throws {
        let domains = (0..<(SafariRules.domainsPerRule + 1)).map {
            String(format: "d%06d.example", $0)
        }
        guard
            case .success(let rules) = SafariRules.build(
                staticRules: [], userBlock: domains, userAllow: [],
                householdBlock: [], householdAllow: [])
        else {
            Issue.record("build failed")
            return
        }
        #expect(rules.count == 2)
        #expect(rules[0].ifDomain?.count == SafariRules.domainsPerRule)
        #expect(rules[1].ifDomain?.count == 1)
    }

    @Test func overflowIsSurfacedNeverTruncated() {
        let tooMany = Array(
            repeating: SafariRule(ifDomain: ["*x.example"], action: .block),
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
        #expect(rules.allSatisfy { $0.ifDomain?.allSatisfy { $0.hasPrefix("*") } ?? false })
    }
}
