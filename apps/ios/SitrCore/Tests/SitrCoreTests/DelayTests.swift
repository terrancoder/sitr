/// The two-clock rule and the gate → delay → PIN order. The pure
/// single-clock function is pinned by delay.json in FixtureTests.
import Testing

@testable import SitrCore

@Suite struct DelayTests {
    let min5: Int64 = 5 * 60_000
    let T: Int64 = 1_700_000_000_000
    /// Requested after 1 h of uptime.
    var stamp: DelayStamp { DelayStamp(atMono: 3_600_000, atWall: T) }

    func eval(mono: Int64, wall: Int64, stamp: DelayStamp? = nil) -> DelayTwoClockEvaluation {
        Delay.evaluate(
            delayMinutes: 5, stamp: stamp ?? self.stamp,
            now: DelayClockReading(mono: mono, wall: wall))
    }

    @Test func bothClocksAgree() {
        let waiting = eval(mono: stamp.atMono + 60_000, wall: T + 60_000)
        #expect(waiting == .init(phase: .waiting, remainingMs: min5 - 60_000, stamp: stamp))
        let open = eval(mono: stamp.atMono + min5 + 1000, wall: T + min5 + 1000)
        #expect(open == .init(phase: .open, remainingMs: Delay.windowMs - 1000, stamp: stamp))
        let closed = eval(mono: stamp.atMono + min5 + Delay.windowMs, wall: T + min5 + Delay.windowMs)
        #expect(closed == .init(phase: .idle, remainingMs: 0, stamp: nil))
    }

    @Test func wallClockForwardNeverOpensEarly() {
        // A day forward, one minute of real time.
        for jump: Int64 in [min5, min5 + 1, min5 + Delay.windowMs / 2, 86_400_000] {
            let r = eval(mono: stamp.atMono + 60_000, wall: T + jump)
            #expect(r.phase != .open, "jump \(jump)")
        }
        // Inside the open band on the wall clock: still waiting, mono's remainder.
        let r = eval(mono: stamp.atMono + 60_000, wall: T + min5 + 1000)
        #expect(r == .init(phase: .waiting, remainingMs: min5 - 60_000, stamp: stamp))
    }

    @Test func wallClockBackRestartsBoth() {
        let now = DelayClockReading(mono: stamp.atMono + min5 + 1000, wall: T - 1)
        let r = Delay.evaluate(delayMinutes: 5, stamp: stamp, now: now)
        #expect(r == .init(phase: .waiting, remainingMs: min5, stamp: DelayStamp(now)))
    }

    @Test func rebootWithSmallUptimeRestarts() {
        // Rebooted; 10 s of uptime, wall honestly past the wait.
        let now = DelayClockReading(mono: 10_000, wall: T + min5 + 1000)
        let r = Delay.evaluate(delayMinutes: 5, stamp: stamp, now: now)
        #expect(r == .init(phase: .waiting, remainingMs: min5, stamp: DelayStamp(now)))
    }

    @Test func rebootWithLargeUptimeOnlyRunsLate() {
        // Requested at uptime 1 h. Two hours later the device rebooted and
        // has been up 1 h 2 min: new uptime ≥ atMono, and the wall clock is
        // set into the open band. nowMono − atMono (2 min) ≤ real elapsed
        // (3 h 2 min): the monotonic clock can only run late after a reboot.
        let r = eval(mono: stamp.atMono + 120_000, wall: T + min5 + 1000)
        #expect(r == .init(phase: .waiting, remainingMs: min5 - 120_000, stamp: stamp))
        // Wall set a day forward instead: past the window, so cleared — never open.
        #expect(eval(mono: stamp.atMono + 120_000, wall: T + 86_400_000).phase == .idle)
    }

    @Test func backupRestoreNeverOpensEarly() {
        // Restored onto a device with less uptime than atMono: restart.
        let low = DelayClockReading(mono: 1000, wall: T + 60_000)
        #expect(
            Delay.evaluate(delayMinutes: 5, stamp: stamp, now: low)
                == .init(phase: .waiting, remainingMs: min5, stamp: DelayStamp(low)))
        // Huge uptime, honest wall clock one minute after the request: the
        // wall clock decides.
        let huge = eval(mono: 30 * 86_400_000, wall: T + 60_000)
        #expect(huge.phase == .idle || huge.phase == .waiting)
        #expect(huge.phase != .open)
        // Uptime lands in the open band, wall says waiting: waiting.
        let band = eval(mono: stamp.atMono + min5 + 1000, wall: T + 60_000)
        #expect(band == .init(phase: .waiting, remainingMs: min5 - 60_000, stamp: stamp))
    }

    @Test func eitherClockPastWindowClears() {
        let r = eval(mono: stamp.atMono + min5 + 1000, wall: T + min5 + Delay.windowMs)
        #expect(r == .init(phase: .idle, remainingMs: 0, stamp: nil))
    }

    @Test func windowsThatCanNeverOverlapClear() {
        // 24 h wait: mono says 23 h left, wall says 2 h left. Wall's window
        // closes long before mono's opens — no countdown to nothing.
        let day: Int64 = 86_400_000, hour: Int64 = 3_600_000
        let s = DelayStamp(atMono: 0, atWall: T)
        let r = Delay.evaluate(
            delayMinutes: 1440, stamp: s, now: .init(mono: hour, wall: T + day - 2 * hour))
        #expect(r == .init(phase: .idle, remainingMs: 0, stamp: nil))
        // Mono waits 5 min more, wall is open for 9 min: they overlap → waiting.
        let ok = Delay.evaluate(
            delayMinutes: 1440, stamp: s, now: .init(mono: day - 5 * 60_000, wall: T + day + 60_000))
        #expect(ok == .init(phase: .waiting, remainingMs: 5 * 60_000, stamp: s))
    }

    @Test func openOnlyWhileBothOpenForTheShorterRemainder() {
        let r = eval(mono: stamp.atMono + min5 + 1000, wall: T + min5 + 5000)
        #expect(r == .init(phase: .open, remainingMs: Delay.windowMs - 5000, stamp: stamp))
    }

    @Test func offAndNoRequest() {
        #expect(
            Delay.evaluate(delayMinutes: 0, stamp: stamp, now: .init(mono: 0, wall: 0))
                == .init(phase: .off, remainingMs: 0, stamp: nil))
        #expect(
            Delay.evaluate(delayMinutes: 5, stamp: nil, now: .init(mono: 0, wall: 0))
                == .init(phase: .idle, remainingMs: 0, stamp: nil))
    }

    // MARK: - gate → delay → PIN

    @Test func decisionOrder() {
        let child = GateContext(managedLockOptions: false, role: .child, hasPin: true)
        let pin = GateContext(managedLockOptions: false, role: .guardian, hasPin: true)
        let none = GateContext(managedLockOptions: false, role: nil, hasPin: false)
        let off = DelayAction.kind(.disableCategory)
        // Gate first: refused stays refused, even while waiting or open.
        #expect(Delay.decide(off, ctx: child, phase: .waiting) == .refused(.childDevice))
        #expect(Delay.decide(.shortenDelay, ctx: child, phase: .open) == .refused(.childDevice))
        // Then the delay, before any PIN prompt.
        #expect(Delay.decide(off, ctx: pin, phase: .idle) == .wait)
        #expect(Delay.decide(.shortenDelay, ctx: pin, phase: .waiting) == .wait)
        #expect(Delay.decide(off, ctx: none, phase: .waiting) == .wait)
        // Then the PIN.
        #expect(Delay.decide(off, ctx: pin, phase: .open) == .pin)
        #expect(Delay.decide(.shortenDelay, ctx: pin, phase: .open) == .pin)
        #expect(Delay.decide(off, ctx: none, phase: .open) == .go)
        // Tightening never waits.
        #expect(Delay.decide(.kind(.enableCategory), ctx: pin, phase: .idle) == .go)
        // The re-check after a correct PIN: the window closed while the
        // sheet was open → held again.
        #expect(Delay.needsWait(off, .idle))
        #expect(!Delay.needsWait(off, .open))
    }

    /// The app's path (RootView.attemptAction, then the PIN sheet): gate
    /// allows with a PIN, the window is open at prompt time and closed by
    /// the time the PIN is entered → held, not performed.
    @Test func windowClosingDuringPinHolds() {
        let pin = GateContext(managedLockOptions: false, role: .guardian, hasPin: true)
        let off = DelayAction.kind(.disableCategory)
        #expect(Delay.decide(off, ctx: pin, phase: .open) == .pin)
        #expect(Delay.afterPin(off, phase: .idle) == .wait)
        #expect(Delay.afterPin(off, phase: .waiting) == .wait)
        #expect(Delay.afterPin(off, phase: .open) == .go)
        #expect(Delay.afterPin(off, phase: .off) == .go)
    }

    /// Joining waits like disabling a category, and only while the wait is on.
    @Test func joiningWaits() {
        let join = DelayAction.kind(Delay.joinHouseholdWaitsAs)
        #expect(Delay.needsWait(join, .idle))
        #expect(Delay.needsWait(join, .waiting))
        #expect(!Delay.needsWait(join, .open))
        #expect(!Delay.needsWait(join, .off))
    }
}
