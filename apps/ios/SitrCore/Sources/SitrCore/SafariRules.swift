/// Safari content-blocker rule assembly — the iOS embodiment of the rule
/// ladder in extension/src/lib/ruleLayers.ts.
///
/// WebKit evaluates rules in order and `ignore-previous-rules` cancels only
/// EARLIER rules, so emitting weakest layer first reproduces the ladder
/// exactly (no managed layer on iOS v1):
///
///   1. static category blocks   (compiler-emitted fragments)
///   2. device-user blocks
///   3. device-user allows       → ignore-previous-rules
///   4. household blocks         (beats user allows: comes later)
///   5. household allows         → ignore-previous-rules (beats everything)
///
/// Semantics preserved: allow wins within a layer; a higher layer's block
/// beats a lower layer's allow. Overflow is a surfaced error, never a
/// truncation.
import Foundation

public struct SafariRule: Equatable {
    public enum Action: String {
        case block
        case ignorePreviousRules = "ignore-previous-rules"
    }

    public let urlFilter: String
    public let ifDomain: [String]?
    public let action: Action

    public init(urlFilter: String = ".*", ifDomain: [String]?, action: Action) {
        self.urlFilter = urlFilter
        self.ifDomain = ifDomain
        self.action = action
    }

    var jsonObject: [String: Any] {
        var trigger: [String: Any] = ["url-filter": urlFilter]
        if let ifDomain { trigger["if-domain"] = ifDomain }
        return ["trigger": trigger, "action": ["type": action.rawValue]]
    }
}

public enum SafariRules {
    /// Conservative floor across supported iOS versions; overflow is a
    /// surfaced error, mirroring MAX_SAFARI_RULES in the compiler emitter.
    public static let maxRules = 50_000

    /// Same batch size as the compiler (part of the deterministic contract).
    public static let domainsPerRule = 1_000

    static func batched(_ domains: [String], action: SafariRule.Action) -> [SafariRule] {
        stride(from: 0, to: domains.count, by: domainsPerRule).map { start in
            let slice = domains[start..<min(start + domainsPerRule, domains.count)]
            return SafariRule(
                ifDomain: slice.map { "*\($0)" },
                action: action
            )
        }
    }

    /// Assemble the full blocker list from the bundled static fragments and
    /// the dynamic layers. `staticRules` are the compiler-emitted rules for
    /// the ENABLED categories, in sorted-category order.
    public static func build(
        staticRules: [SafariRule],
        userBlock: [String],
        userAllow: [String],
        householdBlock: [String],
        householdAllow: [String]
    ) -> Result<[SafariRule], SitrError> {
        var rules = staticRules
        rules += batched(userBlock, action: .block)
        rules += batched(userAllow, action: .ignorePreviousRules)
        rules += batched(householdBlock, action: .block)
        rules += batched(householdAllow, action: .ignorePreviousRules)
        if rules.count > maxRules {
            return .failure(
                SitrError(
                    "content blocker would need \(rules.count) rules (limit \(maxRules)) — remove some rules"
                ))
        }
        return .success(rules)
    }

    /// Stable JSON for SFContentBlockerManager: 2-space indent, sorted keys,
    /// trailing newline — deterministic so the applied-rules checksum in the
    /// fail-visible status check is meaningful.
    public static func serialize(_ rules: [SafariRule]) -> Data {
        let objects = rules.map { $0.jsonObject }
        let data =
            (try? JSONSerialization.data(
                withJSONObject: objects,
                options: [.prettyPrinted, .sortedKeys]
            )) ?? Data("[]".utf8)
        var text = String(decoding: data, as: UTF8.self)
        if !text.hasSuffix("\n") { text += "\n" }
        return Data(text.utf8)
    }

    /// Parse compiler-emitted fragment JSON (apps/shared/blocklists/safari).
    public static func parseFragment(_ data: Data) -> Result<[SafariRule], SitrError> {
        guard let parsed = try? JSONSerialization.jsonObject(with: data),
            let array = parsed as? [[String: Any]]
        else {
            return .failure(SitrError("ruleset fragment is not a JSON array"))
        }
        var rules: [SafariRule] = []
        for item in array {
            guard
                let trigger = item["trigger"] as? [String: Any],
                let urlFilter = trigger["url-filter"] as? String,
                let actionObject = item["action"] as? [String: Any],
                let actionType = actionObject["type"] as? String,
                let action = SafariRule.Action(rawValue: actionType)
            else {
                return .failure(SitrError("ruleset fragment has an unknown rule shape"))
            }
            rules.append(
                SafariRule(
                    urlFilter: urlFilter,
                    ifDomain: trigger["if-domain"] as? [String],
                    action: action
                ))
        }
        return .success(rules)
    }
}
