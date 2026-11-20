import BackgroundTasks
import Foundation
import SitrCore

/// THE APP'S ONLY NETWORK CALL SITE — the URLSession transport handed to
/// SitrCore's SyncClient and, for Sitr Family claims only, its ClaimClient;
/// iOS twin of the extension's single fetch() (docs/data-flow.md). No
/// household and no purchase → zero network requests, enforced by the
/// early return in syncNow and by Family.claim needing a transaction.
struct URLSessionTransport: SyncTransport {
    /// Ephemeral: nothing about a sync (the blob, the household's URL,
    /// cookies) is written to disk by the URL loading system.
    private static let session = URLSession(configuration: .ephemeral)

    func request(
        method: String, url: URL, headers: [String: String], body: Data?
    ) async throws -> SyncHTTPResponse {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 15
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let (data, response) = try await Self.session.data(for: request)
        let http = response as? HTTPURLResponse
        return SyncHTTPResponse(
            status: http?.statusCode ?? 0,
            etagHeader: http?.value(forHTTPHeaderField: "ETag"),
            body: data,
            entitlementExpiresHeader: http?.value(forHTTPHeaderField: "X-Sitr-Entitlement-Expires")
        )
    }
}

/// Sync cadence: on app foreground, after every household mutation, and
/// opportunistically via BGAppRefreshTask (best-effort on iOS — the
/// honest copy in the UI says state converges on app open). Outcomes
/// touch only household state + sync status, never protection status.
enum SyncScheduler {
    static let taskIdentifier = "com.sitrshield.sitr.sync"

    static func register(onRefresh: @escaping () async -> Void) {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: taskIdentifier, using: nil
        ) { task in
            // Without a household there is nothing to sync and no reason to
            // be woken again; joining one schedules the next run.
            guard Storage.loadRootSecret() != nil else {
                task.setTaskCompleted(success: true)
                return
            }
            scheduleNext()
            let work = Task {
                await onRefresh()
                task.setTaskCompleted(success: true)
            }
            task.expirationHandler = { work.cancel() }
        }
    }

    static func cancel() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
    }

    static func scheduleNext() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Background-refresh path. Same PERSIST-FIRST ordering as the UI
    /// (AppModel.persistNow): the merged household reaches the DNS filter
    /// at once; Safari follows, and its checksum is recorded only when it
    /// accepted the rules (otherwise status shows red on the next check).
    static func syncAndApply() async {
        guard let secret = Storage.loadRootSecret() else { return }
        let started = SettingsStore.load()
        let synced = await syncNow(settings: started)
        // Merge into the store as it is NOW, as AppModel.runSync does: saving
        // `synced` wholesale reverted a change made during the round-trip.
        // On the main actor, where AppModel saves, so the two cannot interleave.
        let merged: AppSettings? = await MainActor.run {
            guard stillInHousehold(secret) else { return nil }  // left meanwhile
            var current = SettingsStore.load()
            merge(into: &current, started: started, synced: synced)
            SettingsStore.persist(current)
            return current
        }
        guard let next = merged else { return }
        ScreenTimeController.apply(next)
        // Most refreshes change nothing but the sync status: rules Safari
        // already holds are not reloaded. Records what Safari holds after.
        _ = await BlockerController.applyIfNeeded(next)
    }

    /// Folds a sync result into the settings as they are NOW (both sync
    /// paths). `synced` was computed from `started`, taken before the
    /// round-trip; applying it wholesale reverted changes made meanwhile.
    /// The caller checks first that the household key is still the same.
    static func merge(into current: inout AppSettings, started: AppSettings, synced: AppSettings) {
        if current.household != started.household {
            // Edited meanwhile: keep the edit — the sync that edit started
            // will carry it.
            current.maxSeenRev = max(current.maxSeenRev, synced.maxSeenRev)
            return
        }
        current.household = synced.household
        current.maxSeenRev = synced.maxSeenRev
        current.syncStatus = synced.syncStatus
    }

    /// One sync round + honest fair-use device enrollment (mirrors the
    /// extension's service worker and the Android SyncWorker).
    /// Sitr Family: a claim first when one is due (§When to claim), then
    /// the held token on the write; the answer's `E` and any `402 lapsed`
    /// go back into the claim state.
    static func syncNow(settings: AppSettings) async -> AppSettings {
        // A key found in iCloud Keychain is not membership: joining it goes
        // through the gate (HouseholdView), which sets the household first.
        guard let secret = Storage.loadRootSecret(), let local = settings.household,
            let householdId = Family.householdId(secret)
        else { return settings }

        await Family.renewIfDue(householdId: householdId)
        let claimState = Family.loadState()
        let token = ClaimPlan.tokenToSend(claimState)?.raw
        let force = ClaimPlan.forcesWrite(claimState)

        let client = SyncClient(
            transport: URLSessionTransport(),
            now: { Date().timeIntervalSince1970 * 1000 },
            baseURL: Endpoints.sync
        )

        let outcome = await client.syncOnce(
            SyncInput(
                rootSecret: secret,
                local: local,
                maxSeenRev: settings.maxSeenRev,
                deviceId: settings.deviceId,
                entitlement: token,
                forceWrite: force
            ))
        observe(outcome, householdId: householdId, forced: force ? token : nil)

        var next = settings
        next.household = outcome.state
        next.maxSeenRev = outcome.maxSeenRev
        next.syncStatus = outcome.status

        // Not after a leave during the round: that would undo its unenroll.
        // ponytail: a leave landing after this check still races.
        if outcome.status.state == .ok,
            !outcome.state.devices.contains(settings.deviceId),
            stillInHousehold(secret)
        {
            if outcome.state.devices.count >= Household.maxHouseholdDevices {
                next.syncStatus = SyncStatus(
                    state: .error,
                    error:
                        "this household is at its \(Household.maxHouseholdDevices)-device fair-use cap"
                )
            } else {
                var enrolled = outcome.state
                enrolled.devices = (enrolled.devices + [settings.deviceId]).sorted()
                let bumped = Household.bumpRev(
                    enrolled,
                    deviceId: settings.deviceId,
                    now: Date().timeIntervalSince1970 * 1000)
                let second = await client.syncOnce(
                    SyncInput(
                        rootSecret: secret,
                        local: bumped,
                        maxSeenRev: outcome.maxSeenRev,
                        deviceId: settings.deviceId,
                        entitlement: token
                    ))
                next.household = second.state
                next.maxSeenRev = second.maxSeenRev
                next.syncStatus = second.status
                observe(second, householdId: householdId)
            }
        }
        return next
    }

    /// "Did the user leave meanwhile?" The stored key alone no longer says:
    /// with iCloud Keychain on, it stays after a leave. Also true only while
    /// the stored settings still hold a household.
    static func stillInHousehold(_ secret: Data) -> Bool {
        Storage.loadRootSecret() == secret && SettingsStore.load().household != nil
    }

    static func observe(_ outcome: SyncOutcome, householdId: String, forced: String? = nil) {
        Family.update {
            $0 = ClaimPlan.observe(
                entExp: outcome.entExp, lapsedResponse: outcome.refusal == .lapsed,
                succeeded: outcome.status.state == .ok, state: $0, householdId: householdId,
                now: Family.nowMs, forced: forced)
        }
    }
}
