/// Mirrors tests/src/household.test.ts (join placeholder) and
/// tests/src/pin.test.ts (lockout clamp).
import Testing

@testable import SitrCore

struct JoinAndLockoutTests {
    @Test func onlyTheNeverSyncedJoinStateIsAPlaceholder() {
        let joined = Household.emptyState(deviceId: "dev-a", now: 0)
        #expect(Household.isJoinPlaceholder(joined))
        #expect(!Household.isJoinPlaceholder(Household.emptyState(deviceId: "dev-a", now: 1000)))
        #expect(!Household.isJoinPlaceholder(Household.bumpRev(joined, deviceId: "dev-a", now: 0)))
        #expect(!Household.isJoinPlaceholder(Household.bumpRev(joined, deviceId: "dev-a", now: 5000)))
    }

    @Test func aDeadlineFromAClockMovedAheadIsClamped() {
        let now: Double = 1_000_000
        let yearAway = PinAttempts(count: 9, lockedUntil: now + 365 * 86_400_000)
        let clamped = Pin.clamp(yearAway, now: now)
        #expect(clamped == PinAttempts(count: 9, lockedUntil: now + Pin.maxDelayMs))
        let later = now + Pin.maxDelayMs
        if case .failure = Pin.isLockedOut(Pin.clamp(clamped, now: later), now: later) {
            Issue.record("a stored clamp must expire, not restart")
        }
        let soon = Pin.backoffAfterFailure(count: 6, now: now)
        #expect(Pin.clamp(soon, now: now) == soon)
    }
}
