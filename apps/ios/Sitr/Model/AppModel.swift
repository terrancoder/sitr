import Foundation
import SitrCore
import SwiftUI

/// The app's single source of truth. Every mutation is gate-checked
/// through the ported authority ladder (child role > PIN; no managed
/// layer on iOS v1) and applied ENGINE FIRST: BlockerController must
/// accept the new rules before the settings persist. iOS is JOIN-ONLY —
/// no entitlement token exists anywhere in this app.
@MainActor
final class AppModel: ObservableObject {
    @Published var settings: AppSettings
    @Published var blockerStatus: BlockerStatus = .unknown("not checked yet")
    @Published var screenTimeStatus: ScreenTimeStatus = .off
    @Published var busy = false
    @Published var lastError: String?

    init() {
        settings = SettingsStore.load()
        screenTimeStatus = ScreenTimeController.status()
    }

    // MARK: - Gate

    func gate(_ kind: MutationKind) -> MutationVerdict {
        Gate.gateMutation(
            kind,
            ctx: GateContext(
                managedLockOptions: false,  // no managed layer on iOS v1
                role: settings.role.flatMap(HouseholdRole.init(rawValue:)),
                hasPin: settings.household?.pin != nil
            ))
    }

    func verifyPin(_ pin: String) -> Bool {
        guard let record = settings.household?.pin else { return false }
        return Pin.verify(pin: pin, record: record)
    }

    // MARK: - Engine-first apply

    /// Apply `next`'s configuration to Safari, and persist ONLY on
    /// success; on failure surface the error and keep the old settings.
    func apply(_ next: AppSettings, kickSync: Bool = false) async {
        busy = true
        defer { busy = false }
        let household = next.household
        let result = await BlockerController.apply(
            disabledCategories: household?.disabledCategories
                ?? next.disabledCategories,
            userAllow: next.userAllow,
            userBlock: next.userBlock,
            householdAllow: household?.allowDomains ?? [],
            householdBlock: household?.blockDomains ?? []
        )
        switch result {
        case .failure(let error):
            // Nothing was written — the settings must not claim otherwise.
            lastError = describe(error)
        case .success(let outcome):
            var persisted = next
            switch outcome {
            case .applied(let checksum):
                persisted.appliedRulesChecksum = checksum
            case .pendingReload:
                // Written but not live: record no checksum so the status
                // stays red until a reload succeeds.
                persisted.appliedRulesChecksum = nil
            }
            settings = persisted
            SettingsStore.persist(persisted)
            ScreenTimeController.apply(
                blockDomains: household?.blockDomains ?? [],
                allowDomains: household?.allowDomains ?? []
            )
            if kickSync { await runSync() }
        }
        await refreshStatus()
    }

    private func describe(_ error: BlockerController.ApplyError) -> String {
        switch error {
        case .fragments(let m): return m
        case .write(let m): return m
        }
    }

    // MARK: - Status (fail-visible)

    func refreshStatus() async {
        blockerStatus = await StatusModel.blockerStatus(settings: settings)
        screenTimeStatus = ScreenTimeController.status()
    }

    // MARK: - Sync

    func runSync() async {
        guard Storage.loadRootSecret() != nil else { return }
        let next = await SyncScheduler.syncNow(settings: settings)
        // The merged household config must reach Safari (engine first).
        await apply(next)
        SyncScheduler.scheduleNext()
    }

    // MARK: - Household actions (join-only on iOS)

    func joinHousehold(code: String, asChild: Bool) async {
        switch PairingCode.decode(code) {
        case .failure(let error):
            lastError = error.message
        case .success(let secret):
            Storage.saveRootSecret(secret)
            var next = settings
            next.household = Household.emptyState(
                deviceId: settings.deviceId,
                now: Date().timeIntervalSince1970 * 1000)
            next.role = asChild ? "child" : "guardian"
            next.maxSeenRev = 0
            next.syncStatus = .neverSynced
            await apply(next, kickSync: true)
        }
    }

    func leaveHousehold() async {
        Storage.clearRootSecret()
        var next = settings
        next.household = nil
        next.role = nil
        next.maxSeenRev = 0
        next.syncStatus = .neverSynced
        await apply(next)
    }

    func pairingCode() -> String? {
        Storage.loadRootSecret().map { PairingCode.encode(rootSecret: $0) }
    }

    func setPin(_ pin: String) async {
        switch Pin.createRecord(pin: pin) {
        case .failure(let error):
            lastError = error.message
        case .success(let record):
            await mutateHousehold { $0.pin = record }
        }
    }

    func setCategoryDisabled(_ rulesetId: String, disabled: Bool) async {
        if settings.household != nil {
            await mutateHousehold { state in
                if disabled {
                    if !state.disabledCategories.contains(rulesetId) {
                        state.disabledCategories.append(rulesetId)
                    }
                } else {
                    state.disabledCategories.removeAll { $0 == rulesetId }
                }
            }
        } else {
            var next = settings
            if disabled {
                if !next.disabledCategories.contains(rulesetId) {
                    next.disabledCategories.append(rulesetId)
                }
            } else {
                next.disabledCategories.removeAll { $0 == rulesetId }
            }
            await apply(next)
        }
    }

    func addDeviceDomain(allow: Bool, domain: String) async {
        var next = settings
        if allow {
            next.userAllow = Array(Set(next.userAllow + [domain])).sorted()
        } else {
            next.userBlock = Array(Set(next.userBlock + [domain])).sorted()
        }
        await apply(next)
    }

    func removeDeviceDomain(allow: Bool, domain: String) async {
        var next = settings
        if allow {
            next.userAllow.removeAll { $0 == domain }
        } else {
            next.userBlock.removeAll { $0 == domain }
        }
        await apply(next)
    }

    func addHouseholdDomain(allow: Bool, domain: String) async {
        await mutateHousehold { state in
            if allow {
                state.allowDomains = Array(Set(state.allowDomains + [domain])).sorted()
            } else {
                state.blockDomains = Array(Set(state.blockDomains + [domain])).sorted()
            }
        }
    }

    func removeHouseholdDomain(allow: Bool, domain: String) async {
        await mutateHousehold { state in
            if allow {
                state.allowDomains.removeAll { $0 == domain }
            } else {
                state.blockDomains.removeAll { $0 == domain }
            }
        }
    }

    private func mutateHousehold(_ transform: (inout HouseholdState) -> Void) async {
        guard var household = settings.household else { return }
        transform(&household)
        var next = settings
        next.household = Household.bumpRev(
            household,
            deviceId: settings.deviceId,
            now: Date().timeIntervalSince1970 * 1000)
        await apply(next, kickSync: true)
    }
}
