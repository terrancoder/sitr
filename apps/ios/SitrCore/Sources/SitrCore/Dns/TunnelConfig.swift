/// What the DEBUG-only packet-tunnel prototype (apps/ios/SitrTunnel) filters
/// with: the checksum-verified compiler lists plus the app's settings,
/// assembled into a `DecisionSnapshot` the way the Android app's
/// SitrApp.rebuildEngine does (no managed-config layer on iOS).
import CryptoKit
import Foundation

/// The tunnel's fixed addresses (Android SitrVpnService).
public enum DnsTunnel {
    public static let tunnelV4 = "10.111.222.2"
    public static let resolverV4 = "10.111.222.1"
    public static let tunnelV6 = "fd66:f83a:c650::2"
    public static let resolverV6 = "fd66:f83a:c650::1"
    public static let syntheticResolvers: Set<String> = [resolverV4, resolverV6]
}

/// The plain-domain artifacts in apps/shared/blocklists/android, loaded
/// from a directory and verified against its checksums.json.
public struct BlocklistBundle: Sendable {
    /// Must verify or the tunnel refuses to start (Android: same three).
    public static let requiredLists = ["adult", "gambling", "dating"]

    /// Verified sets keyed by file stem ("adult", "x-media", …).
    public let sets: [String: DomainSet]
    public let safeSearch: SafeSearchMap
    /// Optional `.domains` files listed in checksums.json that were missing
    /// or failed verification; only their switch is lost (Android: same).
    public let skipped: [String]

    public static func load(from directory: URL) -> Result<BlocklistBundle, SitrError> {
        func read(_ name: String) -> Data? { try? Data(contentsOf: directory.appendingPathComponent(name)) }
        guard let checksumData = read("checksums.json"),
            let checksums = (try? JSONSerialization.jsonObject(with: checksumData)) as? [String: String]
        else { return .failure(SitrError("checksums.json missing or unreadable")) }

        var sets: [String: DomainSet] = [:]
        var skipped: [String] = []
        for file in checksums.keys.sorted() where file.hasSuffix(".domains") {
            let stem = String(file.dropLast(".domains".count))
            if let data = read(file), let set = try? DomainSet(artifact: data, expectedSha256Hex: checksums[file]!) {
                sets[stem] = set
            } else if requiredLists.contains(stem) {
                return .failure(SitrError("\(file) failed verification"))
            } else {
                skipped.append(file)
            }
        }
        for stem in requiredLists where sets[stem] == nil {
            return .failure(SitrError("\(stem).domains not listed in checksums.json"))
        }
        // The map is checksummed too: a tampered map could point SafeSearch
        // hosts anywhere.
        guard let mapData = read("safesearch-hosts.json"), let expected = checksums["safesearch-hosts.json"],
            sha256Hex(mapData) == expected.lowercased()
        else { return .failure(SitrError("safesearch-hosts.json failed verification")) }
        switch SafeSearchMap.parse(mapData) {
        case .failure(let e): return .failure(e)
        case .success(let map): return .success(BlocklistBundle(sets: sets, safeSearch: map, skipped: skipped))
        }
    }

    /// Port of rebuildEngine: adult always; gambling and dating unless
    /// disabled (the household's list wins when joined); each site in
    /// `mediaOff` adds `<site>-media.domains`. Other listed files (e.g.
    /// doh.domains) are loaded but not enabled, as on Android today.
    public func snapshot(_ settings: TunnelSettings) -> DecisionSnapshot {
        let disabled = Set(settings.household?.disabledCategories ?? settings.disabledCategories)
        var stems = ["adult"]
        if !disabled.contains("sitr_gambling") { stems.append("gambling") }
        if !disabled.contains("sitr_dating") { stems.append("dating") }
        stems += settings.mediaOff.sorted().map { "\($0)-media" }
        return DecisionSnapshot(
            householdAllow: Set(settings.household?.allowDomains ?? []),
            householdBlock: Set(settings.household?.blockDomains ?? []),
            userAllow: Set(settings.userAllow),
            userBlock: Set(settings.userBlock),
            staticBlock: stems.compactMap { sets[$0] }
        )
    }
}

/// The app settings the filter depends on, read from the App Group
/// defaults with the same keys as Sitr/Model/AppSettings.swift.
public struct TunnelSettings: Equatable {
    public var disabledCategories: [String] = []
    public var mediaOff: Set<String> = []
    public var userAllow: [String] = []
    public var userBlock: [String] = []
    public var household: HouseholdState?

    public init(
        disabledCategories: [String] = [], mediaOff: Set<String> = [],
        userAllow: [String] = [], userBlock: [String] = [], household: HouseholdState? = nil
    ) {
        self.disabledCategories = disabledCategories
        self.mediaOff = mediaOff
        self.userAllow = userAllow
        self.userBlock = userBlock
        self.household = household
    }

    public init(defaults d: UserDefaults) {
        disabledCategories = d.stringArray(forKey: "disabledCategories") ?? []
        mediaOff = Set(d.stringArray(forKey: "mediaOff") ?? [])
        userAllow = d.stringArray(forKey: "userAllow") ?? []
        userBlock = d.stringArray(forKey: "userBlock") ?? []
        if let json = d.string(forKey: "householdState"),
            let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
            case .success(let state) = Household.sanitize(parsed)
        {
            household = state
        }
    }
}

/// Darwin notification the DEBUG app posts after persisting settings.
public let tunnelSettingsChangedNotification = "com.sitrshield.sitr.settings-changed"

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
