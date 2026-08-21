import Foundation

#if canImport(FamilyControls) && canImport(ManagedSettings)
    import FamilyControls
    import ManagedSettings
#endif

/// Screen Time integration — Apple's web content filter (system-wide in
/// WebKit browsers) plus Sitr's deny list and the household's allow
/// exceptions, applied through ManagedSettings.
///
/// Two modes, honestly differentiated (threat-model T10):
///  - individual: self-restriction; the owner can revoke in Settings —
///    friction, same class as the guardian PIN;
///  - child (Family Sharing): revocation needs parent approval — the only
///    real tamper resistance on iOS.
///
/// RUNTIME-GATED: the distribution entitlement needs Apple approval
/// (Udocs/family-controls-entitlement-guide.md), so every path degrades
/// to "unavailable" rather than crashing, and the Safari blocker is fully
/// independent of this controller either way.
enum ScreenTimeController {
    static let storeName = "sitr"

    /// The user's opt-in — Screen Time is optional; "off" is grey, never red.
    static var userEnabled: Bool {
        get { Storage.defaults.bool(forKey: "screenTimeEnabled") }
        set { Storage.defaults.set(newValue, forKey: "screenTimeEnabled") }
    }

    static func status() -> ScreenTimeStatus {
        #if canImport(FamilyControls)
            guard userEnabled else { return .off }
            switch AuthorizationCenter.shared.authorizationStatus {
            case .approved:
                return .active(mode: Storage.defaults.string(forKey: "screenTimeMode") ?? "individual")
            case .denied, .notDetermined:
                return .revoked
            @unknown default:
                return .revoked
            }
        #else
            return .unavailable
        #endif
    }

    /// Request authorization and apply the filter. `child: true` uses the
    /// Family Sharing flow (parent approval to enable AND to revoke).
    static func enable(child: Bool, blockDomains: [String], allowDomains: [String]) async -> String? {
        #if canImport(FamilyControls)
            do {
                try await AuthorizationCenter.shared.requestAuthorization(
                    for: child ? .child : .individual)
            } catch {
                return "Screen Time authorization failed: \(error.localizedDescription)"
            }
            userEnabled = true
            Storage.defaults.set(child ? "child" : "individual", forKey: "screenTimeMode")
            apply(blockDomains: blockDomains, allowDomains: allowDomains)
            return nil
        #else
            return "Screen Time is not available in this build."
        #endif
    }

    /// Apple's algorithmic adult filter + Sitr's deny list + the family's
    /// allow exceptions. ManagedSettings domain-set capacity is limited
    /// (~50 entries per set in practice): the Safari blocker carries the
    /// FULL lists; this layer carries auto() plus what fits, and the
    /// status row states exactly that — never overclaims.
    static func apply(blockDomains: [String], allowDomains: [String]) {
        #if canImport(ManagedSettings)
            guard userEnabled else { return }
            let store = ManagedSettingsStore(
                named: ManagedSettingsStore.Name(storeName))
            let block = Set(blockDomains.prefix(40).map { WebDomain(domain: $0) })
            let allow = Set(allowDomains.prefix(40).map { WebDomain(domain: $0) })
            store.webContent.blockedByFilter = .auto(block, except: allow)
        #endif
    }

    static func disable() {
        #if canImport(ManagedSettings)
            let store = ManagedSettingsStore(
                named: ManagedSettingsStore.Name(storeName))
            store.clearAllSettings()
        #endif
        userEnabled = false
    }
}
