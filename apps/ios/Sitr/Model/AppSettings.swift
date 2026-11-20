import Foundation
import SitrCore

/// The app's settings — the iOS twin of the extension's storage.local
/// (docs/data-flow.md §Data stored locally). iOS is JOIN-ONLY: there is
/// no entitlement token anywhere (household creation happens on the
/// extension or the Android app; the server checks tokens only there).
struct AppSettings {
    var onboarded = false
    var deviceId = ""
    /// Device-level toggles; the household's list wins when joined.
    var disabledCategories: [String] = []
    /// Sites whose images and video are off in Safari ("x", "reddit", …)
    /// — none by default; see SITE_MEDIA_HOSTS in the compiler.
    var mediaOff: Set<String> = []
    /// Opt-in lists switched on ("violence", and "doh" for the DNS filter
    /// only) — none by default.
    /// Device-local like mediaOff: never synced, never in the household
    /// state (older app versions erase unknown household fields).
    var optionalOn: Set<String> = []
    var userAllow: [String] = []
    var userBlock: [String] = []
    var role: String?
    var household: HouseholdState?
    var maxSeenRev = 0
    var syncStatus = SyncStatus.neverSynced
    /// SHA-256 of the last blocker JSON successfully applied — the
    /// freshness half of the fail-visible status check.
    var appliedRulesChecksum: String?
}

enum SettingsStore {
    /// SHA-256 of the rules Safari holds (nil: unknown). Written only after
    /// an apply (AppModel.applySafari, SyncScheduler.syncAndApply).
    static var appliedChecksum: String? {
        get { Storage.defaults.string(forKey: "appliedRulesChecksum") }
        set { Storage.defaults.set(newValue, forKey: "appliedRulesChecksum") }
    }

    static func load() -> AppSettings {
        let d = Storage.defaults
        var s = AppSettings()
        s.onboarded = d.bool(forKey: "onboarded")
        if let id = d.string(forKey: "deviceId") {
            s.deviceId = id
        } else {
            s.deviceId = UUID().uuidString
            d.set(s.deviceId, forKey: "deviceId")
        }
        s.disabledCategories = d.stringArray(forKey: "disabledCategories") ?? []
        s.mediaOff = Set(d.stringArray(forKey: "mediaOff") ?? [])
        s.optionalOn = Set(d.stringArray(forKey: "optionalListsOn") ?? [])
        s.userAllow = d.stringArray(forKey: "userAllow") ?? []
        s.userBlock = d.stringArray(forKey: "userBlock") ?? []
        s.role = d.string(forKey: "householdRole")
        if let json = d.string(forKey: "householdState"),
            let data = json.data(using: .utf8),
            let parsed = try? JSONSerialization.jsonObject(with: data),
            case .success(let state) = Household.sanitize(parsed)
        {
            s.household = state
        }
        s.maxSeenRev = d.integer(forKey: "syncMaxSeenRev")
        if let raw = d.string(forKey: "syncState"),
            let state = SyncStatus.State(rawValue: raw)
        {
            s.syncStatus = SyncStatus(
                state: state,
                lastSuccessAt: d.object(forKey: "syncLastSuccessAt") as? Double,
                error: d.string(forKey: "syncError")
            )
        }
        s.appliedRulesChecksum = d.string(forKey: "appliedRulesChecksum")
        return s
    }

    static func persist(_ s: AppSettings) {
        let d = Storage.defaults
        d.set(s.onboarded, forKey: "onboarded")
        d.set(s.deviceId, forKey: "deviceId")
        d.set(s.disabledCategories, forKey: "disabledCategories")
        d.set(s.mediaOff.sorted(), forKey: "mediaOff")
        d.set(s.optionalOn.sorted(), forKey: "optionalListsOn")
        d.set(s.userAllow, forKey: "userAllow")
        d.set(s.userBlock, forKey: "userBlock")
        d.set(s.role, forKey: "householdRole")
        if let household = s.household,
            let data = try? JSONSerialization.data(
                withJSONObject: Household.toJSONObject(household),
                options: [.sortedKeys])
        {
            d.set(String(decoding: data, as: UTF8.self), forKey: "householdState")
        } else {
            d.removeObject(forKey: "householdState")
        }
        d.set(s.maxSeenRev, forKey: "syncMaxSeenRev")
        d.set(s.syncStatus.state.rawValue, forKey: "syncState")
        d.set(s.syncStatus.lastSuccessAt, forKey: "syncLastSuccessAt")
        d.set(s.syncStatus.error, forKey: "syncError")
        // appliedRulesChecksum is NOT written here: it records what Safari
        // holds, and only an apply knows that (appliedChecksum below). A
        // whole-settings save from an older copy must never overwrite it.
        #if SITR_DNS_FILTER
        // A running DNS filter rebuilds its snapshot from these keys. Every
        // persist comes through here: UI changes and household sync,
        // foreground or background (SyncScheduler.syncAndApply).
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(tunnelSettingsChangedNotification as CFString), nil, nil, true)
        #endif
    }
}

/// "Wait before loosening" (SitrCore/Delay.swift): device-local, its own
/// keys — NOT in AppSettings (SettingsStore.persist rewrites every key from
/// a possibly older copy) and NOT in the household state (older versions
/// erase unknown household fields).
enum DelayStore {
    private static let minutesKey = "loosenDelayMinutes"
    private static let requestKey = "loosenDelayRequest"

    static var minutes: Int {
        get { Delay.sanitizeMinutes(Storage.defaults.integer(forKey: minutesKey)) }
        set { Storage.defaults.set(newValue, forKey: minutesKey) }
    }

    static var stamp: DelayStamp? {
        get {
            guard let raw = Storage.defaults.dictionary(forKey: requestKey),
                let mono = (raw["atMono"] as? NSNumber)?.int64Value,
                let wall = (raw["atWall"] as? NSNumber)?.int64Value,
                mono >= 0, wall >= 0
            else { return nil }
            return DelayStamp(atMono: mono, atWall: wall)
        }
        set {
            if let s = newValue {
                Storage.defaults.set(["atMono": s.atMono, "atWall": s.atWall], forKey: requestKey)
            } else {
                Storage.defaults.removeObject(forKey: requestKey)
            }
        }
    }

    /// Both clocks, in ms. Clock A is mach_continuous_time, which (per
    /// mach_time.h in the iOS SDK) is "like mach_absolute_time, but advances
    /// during sleep"; mach_absolute_time / CLOCK_UPTIME_RAW stop while
    /// asleep. It restarts at boot and the user cannot set it. Clock B is
    /// the wall clock.
    static func now() -> DelayClockReading {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        var mono = Int64(mach_continuous_time() * UInt64(tb.numer) / UInt64(tb.denom) / 1_000_000)
        var wall = Int64(Date().timeIntervalSince1970 * 1000)
        #if DEBUG
        // Simulator testing of the open window without waiting in real
        // time: launch with `-SitrDebugClockOffsetMs <ms>`. Debug builds only.
        let offset = Int64(UserDefaults.standard.integer(forKey: "SitrDebugClockOffsetMs"))
        mono += offset
        wall += offset
        #endif
        return DelayClockReading(mono: mono, wall: wall)
    }
}
