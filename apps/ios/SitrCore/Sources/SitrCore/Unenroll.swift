/// Leaving a household: port of Android SyncClient.unenroll.
import Foundation

extension SyncClient {
    /// Take this device out of the shared device list so its fair-use place
    /// is freed. A normal round first (adopt the latest state), then the
    /// same state without this device as a new revision; a second pass if a
    /// concurrent write put it back. Best effort: offline or an error leaves
    /// the place taken. Never sends DELETE — the last device leaving leaves
    /// the household's record with an empty device list.
    ///
    /// Unlike Android, a join placeholder sends nothing: it was never
    /// enrolled, and a round would PUT it if the server had no blob.
    public func unenroll(_ input: SyncInput) async -> SyncOutcome {
        if Household.isJoinPlaceholder(input.local) {
            return SyncOutcome(
                state: input.local, maxSeenRev: input.maxSeenRev,
                status: SyncStatus(state: .ok, lastSuccessAt: now()), etag: nil)
        }
        var outcome = await syncOnce(input)
        for _ in 0..<2 {
            guard outcome.status.state == .ok, outcome.state.devices.contains(input.deviceId)
            else { return outcome }
            var without = outcome.state
            without.devices.removeAll { $0 == input.deviceId }
            outcome = await syncOnce(
                SyncInput(
                    rootSecret: input.rootSecret,
                    local: Household.bumpRev(without, deviceId: input.deviceId, now: now()),
                    maxSeenRev: outcome.maxSeenRev,
                    deviceId: input.deviceId,
                    entitlement: input.entitlement))
        }
        return outcome
    }
}
