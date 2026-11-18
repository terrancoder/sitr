/// The DNS decision function. Port of rules/DecisionLayers.kt: managed >
/// household > device-user > static; allow wins within a layer; the first
/// layer that matches at all decides. An entry matches the name itself
/// and every subdomain of it (DNR `requestDomains` semantics).
import Foundation

public struct DecisionSnapshot: Sendable {
    public enum Verdict: Equatable, Sendable { case block, forward }

    // Substring keys let the suffix walk look up `name[i...]` without
    // allocating a String per label.
    let managedAllow, managedBlock, householdAllow, householdBlock, userAllow, userBlock: Set<Substring>
    /// The ENABLED static category sets (and Strict Search hosts), searched
    /// in turn — never unioned into a copy.
    let staticBlock: [DomainSet]

    public init(
        managedAllow: Set<String> = [], managedBlock: Set<String> = [],
        householdAllow: Set<String> = [], householdBlock: Set<String> = [],
        userAllow: Set<String> = [], userBlock: Set<String> = [],
        staticBlock: [DomainSet] = []
    ) {
        func keys(_ s: Set<String>) -> Set<Substring> { Set(s.map { Substring($0) }) }
        self.managedAllow = keys(managedAllow)
        self.managedBlock = keys(managedBlock)
        self.householdAllow = keys(householdAllow)
        self.householdBlock = keys(householdBlock)
        self.userAllow = keys(userAllow)
        self.userBlock = keys(userBlock)
        self.staticBlock = staticBlock
    }

    /// True when `contains` holds for `name` or any suffix of it that
    /// starts after a dot (labels stripped from the left).
    private static func anySuffix(_ name: Substring, _ contains: (Substring) -> Bool) -> Bool {
        var suffix = name
        while true {
            if contains(suffix) { return true }
            guard let dot = suffix.utf8.firstIndex(of: 0x2e) else { return false }
            suffix = suffix[suffix.utf8.index(after: dot)...]
        }
    }

    public func decide(_ qname: String) -> Verdict {
        var name = Substring(qname.lowercased())
        while name.hasSuffix(".") { name = name.dropLast() }
        for (allow, block) in [(managedAllow, managedBlock), (householdAllow, householdBlock), (userAllow, userBlock)] {
            if !allow.isEmpty && Self.anySuffix(name, allow.contains) { return .forward }
            if !block.isEmpty && Self.anySuffix(name, block.contains) { return .block }
        }
        for set in staticBlock where set.count > 0 {
            if Self.anySuffix(name, set.contains) { return .block }
        }
        return .forward
    }
}

/// The engine's whole decision for one name. The ladder runs FIRST, so a
/// block wins even for a SafeSearch host; anything not blocked then gets
/// the rewrite, so an ALLOW rule can never switch SafeSearch off.
public enum NameAction: Equatable, Sendable {
    case block
    case rewrite(SafeSearchMap.Rule)
    case forward

    public static func of(_ qname: String, snapshot: DecisionSnapshot, safeSearch: SafeSearchMap) -> NameAction {
        if snapshot.decide(qname) == .block { return .block }
        return safeSearch.rule(for: qname).map { .rewrite($0) } ?? .forward
    }
}
