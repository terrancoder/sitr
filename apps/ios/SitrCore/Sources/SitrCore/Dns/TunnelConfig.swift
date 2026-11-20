/// What the DNS filter (apps/ios/SitrTunnel) filters with: the checksum-verified compiler lists plus the app's settings,
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
    /// The tunnel interface's MTU: the largest reply the resolver passes on
    /// (4096 bytes, after a TCP re-fetch of a truncated answer) plus the
    /// IPv6 (40) and UDP (8) headers, so every reply fits in one packet.
    /// Only DNS crosses this interface. With 1500, replies over ~1450 bytes
    /// (e.g. a large TXT record) were written as one oversized packet and
    /// never arrived.
    public static let mtu = UpstreamResolver.maxReplyBytes + 40 + 8
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

    /// The opt-in lists (Android OptionalLists): device-local, off unless
    /// switched on. "violence" is the Safari blocker's opt-in list too;
    /// "doh" (encrypted-DNS bypass) exists only for the DNS filter.
    public static let optionalLists = ["violence", "doh"]

    /// Port of rebuildEngine, the same inputs as the Safari blocker
    /// (BlockerController.enabledFragments): adult always; gambling and
    /// dating unless disabled (the household's list wins when joined);
    /// each site in `mediaOff` adds `<site>-media.domains`; each opt-in
    /// list switched on adds `<id>.domains`. strict-search-hosts.json is
    /// not used: iOS has no Strict Search switch.
    public func snapshot(_ settings: TunnelSettings) -> DecisionSnapshot { snapshot(filterInputs(settings)) }
}

/// The app settings the filter depends on, read from the App Group
/// defaults with the same keys as Sitr/Model/AppSettings.swift.
public struct TunnelSettings: Equatable {
    public var disabledCategories: [String] = []
    public var mediaOff: Set<String> = []
    public var optionalOn: Set<String> = []
    public var userAllow: [String] = []
    public var userBlock: [String] = []
    public var household: HouseholdState?

    public init(
        disabledCategories: [String] = [], mediaOff: Set<String> = [], optionalOn: Set<String> = [],
        userAllow: [String] = [], userBlock: [String] = [], household: HouseholdState? = nil
    ) {
        self.disabledCategories = disabledCategories
        self.mediaOff = mediaOff
        self.optionalOn = optionalOn
        self.userAllow = userAllow
        self.userBlock = userBlock
        self.household = household
    }

    public init(defaults d: UserDefaults) {
        disabledCategories = d.stringArray(forKey: "disabledCategories") ?? []
        mediaOff = Set(d.stringArray(forKey: "mediaOff") ?? [])
        optionalOn = Set(d.stringArray(forKey: "optionalListsOn") ?? [])
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

/// False when the App Group settings cannot be read yet (before the first
/// unlock after a reboot the defaults file is still protected): the app
/// writes deviceId on its first launch, before the filter can be on.
public func tunnelSettingsReadable(_ d: UserDefaults) -> Bool {
    d.string(forKey: "deviceId") != nil
}

/// Darwin notification the app posts after every settings persist
/// (SettingsStore.persist, which the UI and background sync both use).
public let tunnelSettingsChangedNotification = "com.sitrshield.sitr.settings-changed"

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
