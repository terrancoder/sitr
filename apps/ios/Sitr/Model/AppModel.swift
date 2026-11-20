import Foundation
import SitrCore
import StoreKit
import SwiftUI

/// The app's single source of truth. Every mutation is gate-checked
/// through the ported authority ladder (child role > PIN; no managed
/// layer on iOS v1) and applied ENGINE FIRST: BlockerController must
/// accept the new rules before the settings persist. Sitr Family: a device
/// joins by pairing code, or subscribes in the app and creates a household
/// (AppModel+Family.swift, docs/sync-protocol.md §Entitlement version 2).
@MainActor
final class AppModel: ObservableObject {
    @Published var settings: AppSettings
    @Published var blockerStatus: BlockerStatus = .unknown("not checked yet")
    @Published var screenTimeStatus: ScreenTimeStatus = .off
    @Published var dnsFilterStatus: DnsFilterStatus = DnsFilterText.available ? .off : .unavailable
    @Published var lastError: String?
    /// Why the last Safari reload did not take — shown on the red status
    /// card. Not persisted: the next apply attempt replaces it.
    @Published var reloadError: String?

    // Sitr Family (AppModel+Family.swift).
    @Published var products: [Product] = []
    @Published var subscribed = false
    @Published var familyNotice: FamilyNotice = .none
    @Published var familyEnd: Double?
    @Published var familyMessage: String?
    @Published var familyBusy = false
    @Published var familyStopped = false
    @Published var offersReplace = false
    @Published var askReplace = false
    @Published var newPairingCode: String?
    @Published var iCloudKeyFound = false
    @Published var keychainInICloud = Storage.keychainInICloud
    var familyChain: Task<Void, Never>?
    /// The transaction just bought, in memory only, for a "Create household"
    /// retry: StoreKit can take a moment to list it in Transaction.latest.
    var purchasedCredential: String?

    /// Tail of the mutation chain — see `mutate`.
    private var pending: Task<Void, Never>?
    private var healing = false

    init() {
        settings = SettingsStore.load()
        screenTimeStatus = ScreenTimeController.status()
        listenForTransactions()
    }

    // MARK: - Gate

    /// Gate first, then "wait before loosening", then the PIN.
    func decide(_ action: DelayAction, phase: DelayPhase) -> MutationStep {
        Delay.decide(
            action,
            ctx: GateContext(
                managedLockOptions: false,  // no managed layer on iOS v1
                role: settings.role.flatMap(HouseholdRole.init(rawValue:)),
                hasPin: settings.household?.pin != nil
            ),
            phase: phase)
    }

    // MARK: - Wait before loosening

    struct DelayState {
        let minutes: Int
        let phase: DelayPhase
        let remainingMs: Int64
    }

    /// Evaluate on both clocks now; persist the request only when the
    /// evaluation changed it (restarted or expired).
    func delayState() -> DelayState {
        let minutes = DelayStore.minutes
        let stored = DelayStore.stamp
        let ev = Delay.evaluate(delayMinutes: minutes, stamp: stored, now: DelayStore.now())
        if ev.stamp != stored { DelayStore.stamp = ev.stamp }
        return DelayState(minutes: minutes, phase: ev.phase, remainingMs: ev.remainingMs)
    }

    /// Starting or cancelling never waits.
    func startDelayRequest() {
        objectWillChange.send()
        DelayStore.stamp = DelayStamp(DelayStore.now())
    }

    func cancelDelayRequest() {
        objectWillChange.send()
        DelayStore.stamp = nil
    }

    /// Any change to the setting clears the request: one made under an old
    /// setting must never open the window early under a new one.
    func setDelayMinutes(_ minutes: Int) {
        objectWillChange.send()
        DelayStore.minutes = Delay.sanitizeMinutes(minutes)
        DelayStore.stamp = nil
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
    /// Loosening changes reach this only after the gate, the wait and the
    /// PIN (RootView.attempt).
    func mutate(_ transform: @escaping (inout AppSettings) -> Void) async {
        let previous = pending
        let task = Task { @MainActor in
            await previous?.value
            var next = settings
            transform(&next)
            persistNow(next)
        }
        pending = task
        await task.value
    }

    /// PERSIST FIRST: the screen shows the change at once and the DNS
    /// filter gets it at once (SettingsStore.persist notifies it), so a
    /// tightening change is enforced there while Safari still compiles.
    /// Safari follows in the background (scheduleSafariApply). The applied
    /// checksum stays the one Safari really holds, so status never claims
    /// rules Safari has not accepted: it shows "Updating Safari rules…"
    /// and, if Safari refuses them, the red card with the reason; the
    /// settings stay as chosen. (Before 2026-11-18 a change was saved only
    /// after Safari accepted it: switches looked dead for 16 s or more on a
    /// phone, and a relaunch in that time lost the change.)
    private func persistNow(_ next: AppSettings) {
        var persisted = next
        // A background sync may have saved a newer household since this copy
        // was loaded: keep it unless this change edits the household itself
        // (then this edit wins and its own sync carries it, as in runSync).
        let stored = SettingsStore.load()
        if next.household == settings.household, stored.household != settings.household {
            persisted.household = stored.household
            persisted.maxSeenRev = max(persisted.maxSeenRev, stored.maxSeenRev)
            persisted.syncStatus = stored.syncStatus
        }
        // What Safari holds comes from the store (written only by applies).
        persisted.appliedRulesChecksum = stored.appliedRulesChecksum
        settings = persisted
        SettingsStore.persist(persisted)
        ScreenTimeController.apply(persisted)
        scheduleSafariApply()
    }

    /// True while Safari is loading new rules.
    @Published var safariUpdating = false
    private var safariRun = CoalescedRefresh()
    #if DEBUG
    /// Last Safari apply (compile + reload), for the Diagnostics screen.
    @Published var lastSafariApplyMs: Int?
    #endif

    /// One Safari apply at a time; changes made meanwhile fold into ONE
    /// follow-up run with the settings as they are then.
    private func scheduleSafariApply() {
        guard safariRun.begin() else { return }
        safariUpdating = true
        Task { @MainActor in
            repeat {
                await applySafari()
            } while safariRun.finish()
            safariUpdating = false
            blockerStatus = await StatusModel.blockerStatus(settings: settings)
            screenTimeStatus = ScreenTimeController.status()
        }
    }

    /// Compiles and reloads off the main actor. Always records what Safari
    /// now holds (SafariHeld), even when the settings changed meanwhile, so
    /// the follow-up run compares against the truth; the error shown is only
    /// for the settings as they are.
    private func applySafari() async {
        let target = settings
        let started = Date()
        let applied = await Task.detached(priority: .userInitiated) { await BlockerController.applyIfNeeded(target) }.value
        // Rules Safari already holds need no reload (applyIfNeeded): a sync
        // that changed only its own status would otherwise recompile them.
        // Safari holding them also settles any earlier failure: a stale
        // reloadError would block refreshStatus's automatic repair later.
        guard case let (result, held)? = applied else {
            // The store is the truth for what Safari holds: a background
            // refresh may have reloaded it while this copy stayed old.
            settings.appliedRulesChecksum = SettingsStore.appliedChecksum
            if BlockerController.ruleInputsKey(target) == BlockerController.ruleInputsKey(settings) { reloadError = nil }
            return
        }
        #if DEBUG
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        lastSafariApplyMs = ms
        UserDefaults.standard.set(ms, forKey: "SitrDebugLastSafariApplyMs")
        #endif
        // applyIfNeeded recorded `held` in the store (only that key).
        settings.appliedRulesChecksum = held
        guard BlockerController.ruleInputsKey(target) == BlockerController.ruleInputsKey(settings) else { return }
        switch result {
        case .failure(let error):
            // Settings stay as chosen; the red card says why.
            reloadError = describe(error)
        case .success(.applied):
            reloadError = nil
        case .success(.pendingReload(let reason)):
            // Switched off is not a failed reload: status says "Blocker is
            // off", and turning it on should heal. Written but not live: no
            // checksum (above), so status stays red until a reload succeeds.
            reloadError = reason == BlockerController.blockerOffReason ? nil : reason
        }
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
        await refreshDnsFilter()
        // "Stale" means Safari is on but is not known to hold these rules:
        // they changed while the blocker was off, or an update brought new
        // lists. Re-applying is the whole fix, so do it instead of asking.
        // (`healing` keeps the two refreshes that overlap at launch from
        // both doing it.)
        // A reload that already failed is not retried on every foreground
        // (on a 100k-rule list each try takes tens of seconds); "Fix" does.
        if blockerStatus == .stale, !healing, !safariUpdating, reloadError == nil {
            healing = true
            await mutate { _ in }
            healing = false
        }
    }

    // MARK: - DNS filter

    private var dnsRefresh = CoalescedRefresh()

    /// One status refresh at a time; requests during one fold into a single
    /// follow-up. Never blocks: every step is an await.
    func refreshDnsFilter() async {
        guard dnsRefresh.begin() else { return }
        repeat {
            dnsFilterStatus = await DnsFilterController.status()
        } while dnsRefresh.finish()
    }

    /// Free: turning protection on never needs the gate.
    func turnDnsFilterOn() async {
        if let error = await DnsFilterController.turnOn() { lastError = error }
        await refreshDnsFilter()
    }

    /// Loosening: call only from inside attempt(.disableCategory, …).
    func turnDnsFilterOff() async {
        if let error = await DnsFilterController.turnOff() { lastError = error }
        await refreshDnsFilter()
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
            guard SyncScheduler.stillInHousehold(secret) else { return }
            SyncScheduler.merge(into: &current, started: started, synced: result)
        }
        SyncScheduler.scheduleNext()
    }

    // MARK: - Household actions

    func joinHousehold(code: String, asChild: Bool) async {
        switch PairingCode.decode(code) {
        case .failure(let error):
            lastError = error.message
        case .success(let secret):
            await joinHousehold(secret: secret, asChild: asChild)
        }
    }

    /// By pairing code, or with the key found in iCloud Keychain; both come
    /// here only through the gate, the wait and the PIN (attemptJoin).
    func joinHousehold(secret: Data, asChild: Bool) async {
        guard Storage.saveRootSecret(secret) else {
            lastError = "The household key could not be stored on this device."
            return
        }
        await mutate { next in
            // Epoch 0 (as the extension does): the real household must
            // win the first merge, even one still at rev 1.
            next.household = Household.emptyState(deviceId: next.deviceId, now: 0)
            next.role = asChild ? "child" : "guardian"
            next.maxSeenRev = 0
            next.syncStatus = .neverSynced
        }
        await runSync()
        await refreshFamily()
    }

    func leaveHousehold() async {
        let secret = Storage.loadRootSecret()
        let before = settings
        // Key first: a sync still on the network checks for it before
        // merging, so its late result cannot bring the household back.
        // With iCloud Keychain on, the synced key stays (for the user's other
        // devices), so those checks also require the household to be set
        // (SyncScheduler.stillInHousehold).
        Storage.clearRootSecret()
        SyncScheduler.cancel()
        await mutate { next in
            next.household = nil
            next.role = nil
            next.maxSeenRev = 0
            next.syncStatus = .neverSynced
        }
        newPairingCode = nil
        // Then free this device's fair-use place, as Android does, with the
        // key held only in memory. Offline, the place stays taken. A held
        // Sitr Family token goes with the write; a lapsed household with no
        // token refuses it (402) and the place stays taken until renewal.
        if let secret, let household = before.household {
            let client = SyncClient(
                transport: URLSessionTransport(), now: { Date().timeIntervalSince1970 * 1000 },
                baseURL: Endpoints.sync)
            _ = await client.unenroll(
                SyncInput(
                    rootSecret: secret, local: household,
                    maxSeenRev: before.maxSeenRev, deviceId: before.deviceId,
                    entitlement: ClaimPlan.tokenToSend(Family.loadState())?.raw))
        }
        await refreshFamily()
    }

    /// "Refresh device list" (guardians, through the gate): this device
    /// alone, as a household change; the others add themselves again as
    /// they sync. Returns what to say afterwards, failure included (a
    /// lapsed household refuses the write: the change stays on this device
    /// and syncs after renewal, and the count shown is this device's).
    func refreshDeviceList() async -> String {
        guard let household = settings.household, !Household.isJoinPlaceholder(household) else {
            return HouseholdView.waitingForFirstSync
        }
        await mutate { next in
            guard let h = next.household, !Household.isJoinPlaceholder(h) else { return }
            next.household = Household.withOnlyThisDevice(
                h, deviceId: next.deviceId, now: Date().timeIntervalSince1970 * 1000)
        }
        await runSync()
        let count = settings.household?.devices.count ?? 0
        let shown = "Devices: \(count)/\(Household.maxHouseholdDevices). It will rise again as the other devices sync."
        guard settings.syncStatus.state == .ok else {
            return "The new device list is not on the sync server yet (\(settings.syncStatus.error ?? "no answer")). "
                + "It stays on this device and is sent at the next successful sync. " + shown
        }
        return shown
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

    /// Why an allow entry for `domain` is refused, if it is: a name on the
    /// adult list (itself or under a listed parent) cannot be allowed.
    func allowRefusal(_ domain: String) -> String? {
        AdultList.covers(domain) ? AdultList.refusal : nil
    }

    func addDeviceDomain(allow: Bool, domain: String) async {
        if allow, let refusal = allowRefusal(domain) {
            lastError = refusal
            return
        }
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
        if allow, let refusal = allowRefusal(domain) {
            lastError = refusal
            return
        }
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
        // Not before the first sync: see Household.isJoinPlaceholder.
        if let household = settings.household, Household.isJoinPlaceholder(household) {
            lastError = HouseholdView.waitingForFirstSync
            return
        }
        await mutate { next in
            guard var household = next.household,
                !Household.isJoinPlaceholder(household)
            else { return }
            transform(&household)
            next.household = Household.bumpRev(
                household,
                deviceId: next.deviceId,
                now: Date().timeIntervalSince1970 * 1000)
        }
        await runSync()
    }
}
