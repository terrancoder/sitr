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
        d.set(s.appliedRulesChecksum, forKey: "appliedRulesChecksum")
    }
}
