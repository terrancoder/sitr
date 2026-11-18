/// DNS-side SafeSearch and Strict Search host maps. Ports of
/// SafeSearchMap.kt and StrictSearchHosts.kt, reading the same compiler
/// artifacts (apps/shared/blocklists/android/safesearch-hosts.json and
/// strict-search-hosts.json).
import Foundation

/// A `*` suffix in a match pattern stands for one or two trailing DNS
/// labels (Google's ccTLDs); every other pattern is an exact hostname.
/// Runtime resolution of the target is primary; the fallback addresses are
/// used only when that lookup fails, so SafeSearch never drops out.
public struct SafeSearchMap: Equatable, Sendable {
    public struct Rule: Equatable, Sendable {
        public let match: [String]
        public let target: String
        public let fallbackA: [String]
        public let fallbackAAAA: [String]

        /// The fallback addresses as 4- / 16-byte network-order values
        /// (inet_pton; unparseable strings are skipped).
        public var fallbackAddresses: [[UInt8]] {
            fallbackA.compactMap { ipBytes($0, AF_INET, 4) } + fallbackAAAA.compactMap { ipBytes($0, AF_INET6, 16) }
        }
    }

    public let rules: [Rule]

    public func rule(for qname: String) -> Rule? {
        var name = Substring(qname.lowercased())
        while name.hasSuffix(".") { name = name.dropLast() }
        return rules.first { $0.match.contains { Self.matches($0, String(name)) } }
    }

    static func matches(_ pattern: String, _ qname: String) -> Bool {
        guard pattern.hasSuffix(".*") else { return pattern == qname }
        let base = pattern.dropLast(2)  // "www.google.*" -> "www.google"
        guard qname.hasPrefix(base + ".") else { return false }
        let labels = qname.dropFirst(base.count + 1).split(separator: ".", omittingEmptySubsequences: false)
        return (1...2).contains(labels.count) && labels.allSatisfy { !$0.isEmpty }
    }

    public static func parse(_ json: Data) -> Result<SafeSearchMap, SitrError> {
        guard let o = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] else {
            return .failure(SitrError("safesearch host map is not valid JSON"))
        }
        guard (o["v"] as? Int) == 1 else { return .failure(SitrError("unknown safesearch host map version")) }
        guard let rulesJson = o["rules"] as? [Any] else {
            return .failure(SitrError("safesearch host map has no rules"))
        }
        var rules: [Rule] = []
        for (i, item) in rulesJson.enumerated() {
            guard let rule = item as? [String: Any] else {
                return .failure(SitrError("safesearch rule \(i) is not an object"))
            }
            let match = (rule["match"] as? [Any])?.compactMap { $0 as? String } ?? []
            let target = rule["target"] as? String ?? ""
            if match.isEmpty || target.isEmpty {
                return .failure(SitrError("safesearch rule \(i) is missing match/target"))
            }
            let fallback = rule["fallback"] as? [String: Any]
            func strings(_ key: String) -> [String] { (fallback?[key] as? [Any])?.compactMap { $0 as? String } ?? [] }
            rules.append(Rule(match: match, target: target, fallbackA: strings("a"), fallbackAAAA: strings("aaaa")))
        }
        return .success(SafeSearchMap(rules: rules))
    }
}

private func ipBytes(_ s: String, _ family: Int32, _ size: Int) -> [UInt8]? {
    var out = [UInt8](repeating: 0, count: size)
    return inet_pton(family, s, &out) == 1 ? out : nil
}

/// Strict Search: optional, off by default — image/thumbnail hosts of
/// search engines with no vendor safe mode. When enabled, `hosts` is
/// folded into the static block layer (`DomainSet(domains:)`), as the
/// Android app does (SitrApp.kt).
public struct StrictSearchHosts: Equatable, Sendable {
    public struct Entry: Equatable, Sendable {
        public let engine: String
        public let host: String
        /// True when the engine also has a vendor safe-mode endpoint.
        public let safeModeAvailable: Bool
    }

    public let entries: [Entry]

    public var hosts: Set<String> { Set(entries.map(\.host)) }

    /// Engines with no vendor safe mode, first-seen order, no repeats.
    public var enginesWithoutSafeMode: [String] {
        var seen = Set<String>()
        return entries.filter { !$0.safeModeAvailable }.map(\.engine).filter { seen.insert($0).inserted }
    }

    public static func parse(_ json: Data) -> Result<StrictSearchHosts, SitrError> {
        guard let o = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] else {
            return .failure(SitrError("strict-search host map is not valid JSON"))
        }
        guard (o["v"] as? Int) == 1 else { return .failure(SitrError("unknown strict-search host map version")) }
        guard let array = o["hosts"] as? [Any] else {
            return .failure(SitrError("strict-search host map has no hosts"))
        }
        var entries: [Entry] = []
        for (i, item) in array.enumerated() {
            guard let e = item as? [String: Any] else {
                return .failure(SitrError("strict-search entry \(i) is not an object"))
            }
            let host = e["host"] as? String ?? ""
            let engine = e["engine"] as? String ?? ""
            if host.isEmpty || engine.isEmpty {
                return .failure(SitrError("strict-search entry \(i) is missing engine/host"))
            }
            entries.append(Entry(engine: engine, host: host, safeModeAvailable: e["safeModeAvailable"] as? Bool ?? false))
        }
        return .success(StrictSearchHosts(entries: entries))
    }
}
