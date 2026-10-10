import Foundation

#if canImport(FamilyControls) && canImport(ManagedSettings)
    import FamilyControls
    import ManagedSettings
#endif

/// Screen Time integration — Apple's web content filter (system-wide in
/// WebKit browsers) plus a capped part of the user's own block lists and
/// their allow exceptions, applied through ManagedSettings.
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
    static func enable(child: Bool, settings: AppSettings) async -> String? {
        #if canImport(FamilyControls)
            do {
                try await AuthorizationCenter.shared.requestAuthorization(
                    for: child ? .child : .individual)
            } catch {
                return "Screen Time authorization failed: \(error.localizedDescription)"
            }
            userEnabled = true
            Storage.defaults.set(child ? "child" : "individual", forKey: "screenTimeMode")
            apply(settings)
            return nil
        #else
            return "Screen Time is not available in this build."
        #endif
    }

    /// ManagedSettings accepts only a small domain set (~50 in practice).
    static let domainCap = 40

    /// What this layer carries: Apple's own adult filter, plus the first
    /// `domainCap` sites of the household and device BLOCK lists, minus the
    /// allow lists. It does NOT carry Sitr's gambling and dating category
    /// lists — they are far larger than the set allows — so in other
    /// browsers those categories are filtered only as far as Apple's
    /// filter covers them. The setup screen says exactly this.
    static func apply(_ s: AppSettings) {
        #if canImport(ManagedSettings)
            guard userEnabled else { return }
            let householdBlock = s.household?.blockDomains ?? []
            let householdAllow = s.household?.allowDomains ?? []
            // Same precedence as the Safari rules: household over device,
            // allow over block within a layer.
            let block = (householdBlock + s.userBlock.filter { !s.userAllow.contains($0) })
                .filter { !householdAllow.contains($0) }
            let allow = householdAllow + s.userAllow.filter { !householdBlock.contains($0) }
            let store = ManagedSettingsStore(
                named: ManagedSettingsStore.Name(storeName))
            store.webContent.blockedByFilter = .auto(
                Set(block.prefix(domainCap).map { WebDomain(domain: $0) }),
                except: Set(allow.prefix(domainCap).map { WebDomain(domain: $0) }))
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
