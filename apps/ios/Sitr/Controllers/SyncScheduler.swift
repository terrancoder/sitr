import BackgroundTasks
import Foundation
import SitrCore

/// THE APP'S ONLY NETWORK CALL SITE — the URLSession transport handed to
/// SitrCore's SyncClient, iOS twin of the extension's single fetch()
/// (docs/data-flow.md). No household → zero network requests, enforced by
/// the early return in syncNow.
struct URLSessionTransport: SyncTransport {
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
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        return SyncHTTPResponse(
            status: http?.statusCode ?? 0,
            etagHeader: http?.value(forHTTPHeaderField: "ETag"),
            body: data
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
            scheduleNext()
            let work = Task {
                await onRefresh()
                task.setTaskCompleted(success: true)
            }
            task.expirationHandler = { work.cancel() }
        }
    }

    static func scheduleNext() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Background-refresh path. Same ENGINE-FIRST ordering as the UI:
    /// sync, apply the merged config to Safari, and persist only when
    /// Safari accepted it.
    static func syncAndApply() async {
        guard Storage.loadRootSecret() != nil else { return }
        let next = await syncNow(settings: SettingsStore.load())
        let household = next.household
        let applied = await BlockerController.apply(
            disabledCategories: household?.disabledCategories
                ?? next.disabledCategories,
            userAllow: next.userAllow,
            userBlock: next.userBlock,
            householdAllow: household?.allowDomains ?? [],
            householdBlock: household?.blockDomains ?? []
        )
        if case .success(let outcome) = applied {
            var persisted = next
            if case .applied(let checksum) = outcome {
                persisted.appliedRulesChecksum = checksum
            } else {
                // Written but not reloaded — no checksum, so the next
                // status check shows red rather than a false green.
                persisted.appliedRulesChecksum = nil
            }
            SettingsStore.persist(persisted)
        }
    }

    /// One sync round + honest fair-use device enrollment (mirrors the
    /// extension's service worker and the Android SyncWorker).
    static func syncNow(settings: AppSettings) async -> AppSettings {
        guard let secret = Storage.loadRootSecret() else { return settings }

        let client = SyncClient(
            transport: URLSessionTransport(),
            now: { Date().timeIntervalSince1970 * 1000 }
        )
        let local =
            settings.household
            ?? Household.emptyState(
                deviceId: settings.deviceId,
                now: Date().timeIntervalSince1970 * 1000)

        let outcome = await client.syncOnce(
            SyncInput(
                rootSecret: secret,
                local: local,
                maxSeenRev: settings.maxSeenRev,
                deviceId: settings.deviceId
            ))

        var next = settings
        next.household = outcome.state
        next.maxSeenRev = outcome.maxSeenRev
        next.syncStatus = outcome.status

        if outcome.status.state == .ok,
            !outcome.state.devices.contains(settings.deviceId)
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
                        deviceId: settings.deviceId
                    ))
                next.household = second.state
                next.maxSeenRev = second.maxSeenRev
                next.syncStatus = second.status
            }
        }
        return next
    }
}
