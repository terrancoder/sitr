/// Category model — which rulesets exist and which the user may toggle.
/// Port of extension/src/lib/categories.ts.
///
/// `sitr_adult` and `sitr_safesearch` are always on: they are the product's
/// single purpose. (On iOS the SafeSearch ruleset has no enforceable
/// engine — the app states that plainly; see threat-model.md T10.)
/// A disabled optional category is NOT a protection failure.

public enum Categories {
    public static let alwaysOnRulesets = ["sitr_adult", "sitr_safesearch"]

    public struct ToggleableCategory {
        public let rulesetId: String
        public let label: String
    }

    public static let toggleableCategories = [
        ToggleableCategory(rulesetId: "sitr_gambling", label: "Gambling"),
        ToggleableCategory(rulesetId: "sitr_dating", label: "Dating"),
    ]

    /// Sanitize a stored value: keep only known toggleable ruleset ids.
    public static func sanitizeDisabled(_ stored: Any?) -> [String] {
        guard let array = stored as? [Any] else { return [] }
        let known = Set(toggleableCategories.map { $0.rulesetId })
        var seen = Set<String>()
        var out: [String] = []
        for item in array {
            guard let s = item as? String, known.contains(s) else { continue }
            if seen.insert(s).inserted { out.append(s) }
        }
        return out
    }

    /// The rulesets that MUST be enabled given the user's disabled set.
    public static func requiredRulesets(disabled: [String]) -> [String] {
        let off = Set(disabled)
        return alwaysOnRulesets
            + toggleableCategories.map { $0.rulesetId }.filter { !off.contains($0) }
    }
}
