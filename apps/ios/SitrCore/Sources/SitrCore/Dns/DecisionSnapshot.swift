/// The DNS decision function. Port of rules/DecisionLayers.kt: the adult
/// list first (no allow entry of any layer opens it), then managed >
/// household > device-user > the other static lists; allow wins within a
/// layer; the first layer that matches at all decides. An entry matches
/// the name itself and every subdomain of it (DNR `requestDomains`
/// semantics), so an allow on a parent of an adult-listed name still opens
/// the parent and its other subdomains, but never the listed one.
import Foundation

public struct DecisionSnapshot: Sendable {
    public enum Verdict: Equatable, Sendable { case block, forward }

    // Substring keys let the suffix walk look up `name[i...]` without
    // allocating a String per label.
    let managedAllow, managedBlock, householdAllow, householdBlock, userAllow, userBlock: Set<Substring>
    /// The ENABLED static category sets (and Strict Search hosts), searched
    /// in turn — never unioned into a copy. An allow entry opens them.
    let staticBlock: [DomainSet]
    /// Lists checked BEFORE every allow entry: the adult list. No allow of
    /// any layer opens a name on them.
    let alwaysBlock: [DomainSet]

    public init(
        managedAllow: Set<String> = [], managedBlock: Set<String> = [],
        householdAllow: Set<String> = [], householdBlock: Set<String> = [],
        userAllow: Set<String> = [], userBlock: Set<String> = [],
        staticBlock: [DomainSet] = [],
        alwaysBlock: [DomainSet] = []
    ) {
        func keys(_ s: Set<String>) -> Set<Substring> { Set(s.map { Substring($0) }) }
        self.managedAllow = keys(managedAllow)
        self.managedBlock = keys(managedBlock)
        self.householdAllow = keys(householdAllow)
        self.householdBlock = keys(householdBlock)
        self.userAllow = keys(userAllow)
        self.userBlock = keys(userBlock)
        self.staticBlock = staticBlock
        self.alwaysBlock = alwaysBlock
    }

    /// Whether `set` lists `name` itself or a parent of it (the same walk
    /// the decision uses). For "is this name on the adult list" checks.
    public static func covers(_ set: DomainSet, _ name: String) -> Bool {
        var n = Substring(name.lowercased())
        while n.hasSuffix(".") { n = n.dropLast() }
        return !n.isEmpty && anySuffix(n, set.contains)
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
        for set in alwaysBlock where set.count > 0 {
            if Self.anySuffix(name, set.contains) { return .block }
        }
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
