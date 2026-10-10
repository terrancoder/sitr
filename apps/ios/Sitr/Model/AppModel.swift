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

    /// Tail of the mutation chain — see `mutate`.
    private var pending: Task<Void, Never>?
    private var healing = false

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

    /// PBKDF2 at 600,000 iterations: off the main actor, or the PIN sheet
    /// freezes for as long as the hash takes.
    func verifyPin(_ pin: String) async -> Bool {
        guard let record = settings.household?.pin else { return false }
        return await Task.detached(priority: .userInitiated) {
            Pin.verify(pin: pin, record: record)
        }.value
    }

    // MARK: - The one mutation path

    /// Every settings change goes through here, one at a time. `transform`
    /// runs against the settings as they are when its turn comes — not as
    /// they were when the caller started — so two overlapping changes (two
    /// quick toggles, or an edit made while a sync is on the network) can
    /// no longer be computed from the same stale copy and undo each other.
    func mutate(_ transform: @escaping (inout AppSettings) -> Void) async {
        let previous = pending
        let task = Task { @MainActor in
            await previous?.value
            var next = settings
            transform(&next)
            await apply(next)
        }
        pending = task
        await task.value
    }

    /// Apply `next`'s configuration to Safari, and persist ONLY on
    /// success; on failure surface the error and keep the old settings.
    /// Called from `mutate` alone.
    private func apply(_ next: AppSettings) async {
        busy = true
        defer { busy = false }

        // Rules Safari already holds need no reload: a sync that changed
        // only its own status would otherwise recompile them every time.
        let expected = BlockerController.expectedChecksum(next)
        if let expected, expected == settings.appliedRulesChecksum {
            var persisted = next
            persisted.appliedRulesChecksum = expected
            settings = persisted
            SettingsStore.persist(persisted)
        } else {
            switch await BlockerController.apply(next) {
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
            }
        }
        ScreenTimeController.apply(settings)
        blockerStatus = await StatusModel.blockerStatus(settings: settings)
        screenTimeStatus = ScreenTimeController.status()
    }

    private func describe(_ error: BlockerController.ApplyError) -> String {
        switch error {
        case .fragments(let m): return m
        case .write(let m): return m
        }
    }

    // MARK: - Status (fail-visible)

    /// The background refresh persists straight to the store while this
    /// object may still hold older values; pick them up on foreground
    /// before anything is computed from them.
    func reloadFromStore() async {
        await pending?.value
        settings = SettingsStore.load()
    }

    func refreshStatus() async {
        await pending?.value
        blockerStatus = await StatusModel.blockerStatus(settings: settings)
        screenTimeStatus = ScreenTimeController.status()
        // "Stale" means Safari is on but is not known to hold these rules:
        // they changed while the blocker was off, or an update brought new
        // lists. Re-applying is the whole fix, so do it instead of asking.
        // (`healing` keeps the two refreshes that overlap at launch from
        // both doing it.)
        if blockerStatus == .stale, !healing {
            healing = true
            await mutate { _ in }
            healing = false
        }
    }

    // MARK: - Sync

    func runSync() async {
        guard let secret = Storage.loadRootSecret() else {
            // A household with no key on this device (restored from a
            // backup, say) cannot sync; say so instead of showing the last
            // "up to date".
            let message = "this device has no household key — leave the household and join again with a pairing code"
            if settings.household != nil, settings.syncStatus.error != message {
                await mutate { $0.syncStatus = SyncStatus(state: .error, error: message) }
            }
            return
        }
        await pending?.value
        let started = settings
        let result = await SyncScheduler.syncNow(settings: started)
        // Merge into the settings as they are NOW. The round-trip takes
        // seconds; applying `result` wholesale reverted anything changed
        // meanwhile (it was computed from the copy taken before the call).
        await mutate { current in
            // Left the household while the request was out.
            guard Storage.loadRootSecret() == secret else { return }
            if current.household != started.household {
                // Edited meanwhile: keep the edit — the sync that edit
                // started will carry it.
                current.maxSeenRev = max(current.maxSeenRev, result.maxSeenRev)
                return
            }
            current.household = result.household
            current.maxSeenRev = result.maxSeenRev
            current.syncStatus = result.syncStatus
        }
        SyncScheduler.scheduleNext()
    }

    // MARK: - Household actions (join-only on iOS)

    func joinHousehold(code: String, asChild: Bool) async {
        switch PairingCode.decode(code) {
        case .failure(let error):
            lastError = error.message
        case .success(let secret):
            guard Storage.saveRootSecret(secret) else {
                lastError = "The household key could not be stored on this device."
                return
            }
            await mutate { next in
                next.household = Household.emptyState(
                    deviceId: next.deviceId,
                    now: Date().timeIntervalSince1970 * 1000)
                next.role = asChild ? "child" : "guardian"
                next.maxSeenRev = 0
                next.syncStatus = .neverSynced
            }
            await runSync()
        }
    }

    func leaveHousehold() async {
        // Key first: a sync still on the network checks for it before
        // merging, so its late result cannot bring the household back.
        Storage.clearRootSecret()
        SyncScheduler.cancel()
        await mutate { next in
            next.household = nil
            next.role = nil
            next.maxSeenRev = 0
            next.syncStatus = .neverSynced
        }
    }

    func pairingCode() -> String? {
        Storage.loadRootSecret().map { PairingCode.encode(rootSecret: $0) }
    }

    func setPin(_ pin: String) async {
        let created = await Task.detached(priority: .userInitiated) {
            Pin.createRecord(pin: pin)
        }.value
        switch created {
        case .failure(let error):
            lastError = error.message
        case .success(let record):
            await mutateHousehold { $0.pin = record }
        }
    }

    func setCategoryDisabled(_ rulesetId: String, disabled: Bool) async {
        func toggle(_ list: inout [String]) {
            if disabled {
                if !list.contains(rulesetId) { list.append(rulesetId) }
            } else {
                list.removeAll { $0 == rulesetId }
            }
        }
        if settings.household != nil {
            await mutateHousehold { toggle(&$0.disabledCategories) }
        } else {
            await mutate { toggle(&$0.disabledCategories) }
        }
    }

    func addDeviceDomain(allow: Bool, domain: String) async {
        await mutate { next in
            if allow {
                next.userAllow = Array(Set(next.userAllow + [domain])).sorted()
            } else {
                next.userBlock = Array(Set(next.userBlock + [domain])).sorted()
            }
        }
    }

    func removeDeviceDomain(allow: Bool, domain: String) async {
        await mutate { next in
            if allow {
                next.userAllow.removeAll { $0 == domain }
            } else {
                next.userBlock.removeAll { $0 == domain }
            }
        }
    }

    func addHouseholdDomain(allow: Bool, domain: String) async {
        // Refuse at the cap instead of saving a list that
        // Household.sanitize would reject wholesale on every device.
        let list = (allow ? settings.household?.allowDomains : settings.household?.blockDomains) ?? []
        if !list.contains(domain), list.count >= Household.maxHouseholdDomains {
            lastError = "A household list holds at most \(Household.maxHouseholdDomains) sites."
            return
        }
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

    private func mutateHousehold(_ transform: @escaping (inout HouseholdState) -> Void) async {
        await mutate { next in
            guard var household = next.household else { return }
            transform(&household)
            next.household = Household.bumpRev(
                household,
                deviceId: next.deviceId,
                now: Date().timeIntervalSince1970 * 1000)
        }
        await runSync()
    }
}
