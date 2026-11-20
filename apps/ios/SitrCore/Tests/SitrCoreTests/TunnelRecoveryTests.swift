// The DNS filter's recovery state machine (TunnelRecovery): one scenario
// per flow the phone runs exercised, the start-up orders, the removal
// deadline and the late-event rule; plus FilterInputs.
import Foundation
import Testing

@testable import SitrCore

typealias Ev = TunnelRecovery.Event
typealias Fx = TunnelRecovery.Effect

/// Drives the machine with a clock: timers fire in due order, every effect
/// is logged with its time.
struct Rig {
    var m = TunnelRecovery(upstreamTimeout: 2)
    var now: TimeInterval = 0
    var timers: [Int: TimeInterval] = [:]
    var log: [(at: TimeInterval, fx: Fx)] = []
    var removals: [(at: TimeInterval, token: Int, wait: TimeInterval)] = []

    @discardableResult
    mutating func send(_ e: Ev) -> [Fx] {
        let fx = m.handle(e, now: now)
        for f in fx {
            log.append((now, f))
            switch f {
            case .startTimer(let id, let after): timers[id] = now + after
            case .cancelTimer(let id): timers[id] = nil
            case .removeSettingsAndRead(let t, let w): removals.append((now, t, w))
            default: break
            }
        }
        return fx
    }

    /// Moves the clock to `t`, firing every timer due by then in order.
    mutating func advance(to t: TimeInterval) {
        var fired = 0
        while let next = timers.filter({ $0.value <= t }).min(by: { ($0.value, $0.key) < ($1.value, $1.key) }) {
            fired += 1
            precondition(fired < 100_000, "timer storm at \(now)")
            timers[next.key] = nil
            now = max(now, next.value)
            send(.timer(next.key))
        }
        now = max(now, t)
    }

    mutating func finishRead(_ found: [String]) {
        guard let token = removals.last?.token else {
            Issue.record("no removal to finish")
            return
        }
        send(.readFinished(token: token, found: found))
    }

    /// Started on network `key` with `found` read at start.
    static func running(_ key: String = "wifi-a", found: [String] = ["192.168.1.1"]) -> Rig {
        var r = Rig()
        r.send(.pathUpdate(key: key, satisfied: true))
        r.send(.started(readGeneration: r.m.generation, found: found))
        return r
    }

    func count(_ f: Fx, since t: TimeInterval = -1) -> Int { log.filter { $0.at >= t && $0.fx == f }.count }
    var waits: [TimeInterval] { removals.map(\.wait) }
}

@Suite struct TunnelRecoveryStartTests {
    @Test func pathBeforeStartedForwardsWithoutAWindow() {
        var r = Rig.running()
        #expect(r.m.forwardPermit?.upstreams == ["192.168.1.1"])
        r.send(.pathUpdate(key: "wifi-a", satisfied: true))  // repeated update, same key
        r.advance(to: 600)
        #expect(r.removals.isEmpty)
    }

    @Test func startedBeforeAnyPathForwardsThenRelearnsWhenThePathArrives() {
        // The start read cannot be tied to the network the first path update
        // reports (an on-demand restart during a hand-over), so that update
        // is a change: clear, debounce, one read.
        var r = Rig()
        r.send(.started(readGeneration: 0, found: ["192.168.1.1"]))
        #expect(r.m.forwardPermit?.upstreams == ["192.168.1.1"])
        r.now = 1
        let fx = r.send(.pathUpdate(key: "cell", satisfied: true))
        #expect(fx.contains(.clearAnswerCache) && fx.contains(.clearTargets))
        #expect(r.m.forwardPermit == nil)
        r.advance(to: 1.3)
        #expect(r.waits == [0.1])
        r.finishRead(["10.10.10.10"])
        #expect(r.m.forwardPermit?.upstreams == ["10.10.10.10"])
        r.advance(to: 600)
        #expect(r.removals.count == 1)
    }

    @Test func aPathThatFlipsDuringTheStartReadIsRelearned() {
        // A then B then A again before start-up finished: the key matches,
        // but the read may be B's, so it is learned again (one window).
        var r = Rig()
        r.send(.pathUpdate(key: "wifi-a", satisfied: true))
        let readGeneration = r.m.generation
        r.send(.pathUpdate(key: "wifi-b", satisfied: true))
        r.send(.pathUpdate(key: "wifi-a", satisfied: true))
        r.send(.started(readGeneration: readGeneration, found: ["10.0.0.1"]))
        #expect(r.m.forwardPermit == nil)
        r.advance(to: 0.3)
        #expect(r.waits == [0.1])
        r.finishRead(["192.168.1.1"])
        #expect(r.m.forwardPermit?.upstreams == ["192.168.1.1"])
    }

    @Test func startOnAPathNotSatisfiedStillUsesTheStartRead() {
        // As the provider before this machine: the read found resolvers and
        // nothing changed during it, so they are used whatever the status.
        var r = Rig()
        r.send(.pathUpdate(key: "wifi-a requiresConnection", satisfied: false))
        r.send(.started(readGeneration: r.m.generation, found: ["192.168.1.1"]))
        #expect(r.m.forwardPermit?.upstreams == ["192.168.1.1"])
        r.advance(to: 60)
        #expect(r.removals.isEmpty)
        // A later update is a change like any other.
        r.send(.pathUpdate(key: "wifi-a", satisfied: true))
        r.advance(to: 60.3)
        #expect(r.waits == [0.1])
    }

    @Test func noChangeIsRecordedBeforeStartedUnlessAReadFollows() {
        var r = Rig()
        r.send(.pathUpdate(key: "wifi-a", satisfied: true))
        r.send(.started(readGeneration: r.m.generation, found: ["192.168.1.1"]))
        let changes = { r.log.filter { if case .log(.pathChange) = $0.fx { return true } else { return false } }.count }
        #expect(changes() == 0)
        // A change during the start read: one record, for the read that follows.
        var s = Rig()
        s.send(.pathUpdate(key: "wifi-a", satisfied: true))
        let g = s.m.generation
        s.send(.pathUpdate(key: "wifi-b", satisfied: true))
        s.send(.started(readGeneration: g, found: ["192.168.1.1"]))
        #expect(s.log.filter { if case .log(.pathChange) = $0.fx { return true } else { return false } }.count == 1)
        s.advance(to: 0.3)
        #expect(s.removals.count == 1)
    }

    @Test func startWithNoNetworkLearnsWhenOneArrives() {
        var r = Rig()
        r.send(.started(readGeneration: 0, found: []))
        #expect(r.m.phase == .noNetwork)
        r.send(.pathUpdate(key: "wifi-a", satisfied: true))
        r.advance(to: 0.3)
        #expect(r.waits == [0.1])
    }

    @Test func startWithNothingFoundOnAConnectedNetworkLearnsAfterTheDebounce() {
        var r = Rig.running(found: [])
        r.advance(to: 0.29)
        #expect(r.removals.isEmpty)
        r.advance(to: 0.3)
        #expect(r.waits == [0.1])
    }
}

@Suite struct TunnelRecoveryNetworkChangeTests {
    @Test func wifiOffAndOnToTheSameResolverClearsOnceAndOpensOneWindow() {
        var r = Rig.running()
        let old = r.m.epoch
        r.now = 10
        r.send(.pathUpdate(key: "none", satisfied: false))
        #expect(r.m.forwardPermit == nil)
        #expect(r.m.statusText == "no network")
        // An answer to a query sent before the change is not cached.
        #expect(r.send(.forwardAnswered(query: 1, epoch: old, sentAt: 9.9)).isEmpty)
        r.now = 25
        r.send(.pathUpdate(key: "wifi-a2", satisfied: true))  // back, same resolver address
        r.advance(to: 25.3)
        #expect(r.waits == [0.1])
        r.now = 25.8
        r.finishRead(["192.168.1.1"])
        #expect(r.m.forwardPermit?.epoch == r.m.epoch)
        #expect(r.count(.clearAnswerCache, since: 10) == 2)  // one per change
        #expect(r.count(.clearTargets, since: 10) == 2)
        r.advance(to: 600)
        #expect(r.removals.count == 1)
    }

    @Test func wifiToMobileDataAndBackOneWindowEach() {
        var r = Rig.running()
        r.now = 5
        r.send(.pathUpdate(key: "cell", satisfied: true))
        r.advance(to: 5.3)
        r.finishRead(["10.10.10.10"])
        r.now = 40
        r.send(.pathUpdate(key: "wifi-a", satisfied: true))
        r.advance(to: 40.3)
        r.finishRead(["192.168.1.1"])
        #expect(r.removals.map(\.at) == [5.3, 40.3])
        #expect(r.m.forwardPermit?.upstreams == ["192.168.1.1"])
    }

    @Test func aBurstOfUpdatesIsOneChangeAfterTheDebounce() {
        var r = Rig.running()
        r.now = 1
        for (i, k) in ["x", "y", "z"].enumerated() {
            r.now = 1 + Double(i) * 0.1
            r.send(.pathUpdate(key: k, satisfied: true))
        }
        r.advance(to: 1.49)
        #expect(r.removals.isEmpty)
        r.advance(to: 1.5)
        #expect(r.removals.count == 1)
    }

    @Test func aFourthChangeInAMinuteWaitsForTheBudgetAndAFifthDoesNotWaitLonger() {
        var r = Rig.running()
        for (i, t) in [0.0, 15, 30].enumerated() {
            r.now = t
            r.send(.pathUpdate(key: "n\(i)", satisfied: true))
            r.advance(to: t + 0.3)
            r.finishRead(["192.168.1.1"])
        }
        r.now = 45
        r.send(.pathUpdate(key: "n3", satisfied: true))
        r.advance(to: 50)
        #expect(r.removals.count == 3)
        #expect(r.m.statusText == "rediscovering")
        r.send(.pathUpdate(key: "n4", satisfied: true))  // during the budget wait
        r.advance(to: 60.29)
        #expect(r.removals.count == 3)
        r.advance(to: 60.3)
        #expect(r.removals.map(\.at) == [0.3, 15.3, 30.3, 60.3])
    }

    @Test func aChangeDuringAReadWaitsForThatRemovalThenReadsTheNewNetwork() {
        var r = Rig.running()
        r.now = 1
        r.send(.pathUpdate(key: "b", satisfied: true))
        r.advance(to: 1.3)
        let first = r.removals[0].token
        r.now = 1.35
        r.send(.pathUpdate(key: "c", satisfied: true))
        r.advance(to: 2)
        #expect(r.removals.count == 1)  // never two removals at once
        r.send(.readFinished(token: first, found: ["10.0.0.1"]))  // b's list: discarded
        #expect(r.m.forwardPermit == nil)
        #expect(r.removals.count == 2)
        r.finishRead(["172.16.0.1"])
        #expect(r.m.forwardPermit?.upstreams == ["172.16.0.1"])
    }
}

@Suite struct TunnelRecoveryNoResolverTests {
    @Test func threeReadsThenFiveCappedRetriesThenFailedClosed() {
        var r = Rig.running()
        r.send(.pathUpdate(key: "portal", satisfied: true))
        r.advance(to: 0.3)
        // Each read takes its wait plus about half a second, as on the phone.
        for end in [1.0, 2.0, 4.0] {
            r.now = end
            r.finishRead([])
        }
        #expect(r.waits == [0.1, 0.5, 1.5])
        #expect(r.removals.map(\.at) == [0.3, 1.0, 2.0])
        #expect(r.m.noResolver)
        // Gave up at 4: retries 60, 60, 120, 240, 480 s after the read before
        // them finished (each takes 2 s); the first is past the budget (60.3).
        let expected: [TimeInterval] = [64, 126, 248, 490, 972]
        for t in expected {
            r.advance(to: t)
            r.now = t + 2
            r.finishRead([])
        }
        let retries = r.removals.dropFirst(3)
        #expect(retries.map(\.wait) == [1.5, 1.5, 1.5, 1.5, 1.5])
        #expect(retries.map(\.at) == expected)
        r.advance(to: 100_000)
        #expect(r.removals.count == 8)
        #expect(r.m.phase == .gaveUp(retriesDone: 5, timer: nil))
        #expect(r.m.forwardPermit == nil)
        // A new network starts over.
        r.send(.pathUpdate(key: "home", satisfied: true))
        r.advance(to: 100_000.3)
        #expect(r.removals.last?.wait == 0.1)
        #expect(!r.m.noResolver)
    }

    @Test func aRetryThatFindsTheResolversResumesForwarding() {
        var r = Rig.running()
        r.send(.pathUpdate(key: "slow-dhcp", satisfied: true))
        r.advance(to: 0.3)
        for _ in 0..<3 { r.finishRead([]) }
        r.advance(to: 60.3)
        r.finishRead(["192.168.7.1"])
        #expect(r.m.forwardPermit?.upstreams == ["192.168.7.1"])
        #expect(!r.m.noResolver)
        r.advance(to: 10_000)
        #expect(r.removals.count == 4)
    }
}

@Suite struct TunnelRecoveryStaleTests {
    /// Forwarding on, one answer seen (so timeouts are final), clock at `t`.
    static func rig() -> Rig {
        var r = Rig.running()
        r.now = 100
        r.send(.forwardAnswered(query: 0, epoch: r.m.epoch, sentAt: 99))
        return r
    }

    static func fail(_ r: inout Rig, at t: TimeInterval) {
        r.now = t
        r.send(.forwardFailed(query: 1, epoch: r.m.epoch, sentAt: t - 2, wasRetry: false))
    }

    @Test func eightFailuresOverThirtySecondsGiveOneReReadThatKeepsForwarding() {
        var r = Self.rig()
        for i in 0..<7 { Self.fail(&r, at: 110 + Double(i)) }
        Self.fail(&r, at: 139)
        #expect(r.removals.isEmpty)  // 8 failures but only 29 s
        Self.fail(&r, at: 140)
        #expect(r.waits == [0.5])
        #expect(r.m.forwardPermit?.upstreams == ["192.168.1.1"])  // old list meanwhile
        #expect(r.m.statusText == "rediscovering (every forward failing)")
        r.now = 140.5
        r.finishRead(["192.168.1.1"])
        #expect(r.m.statusText == "running")
        for i in 0..<20 { Self.fail(&r, at: 141 + Double(i) * 3) }
        #expect(r.removals.count == 1)  // no answer since the re-read
        // An answer to an attempt sent before the re-apply does not count.
        r.send(.forwardAnswered(query: 2, epoch: r.m.epoch, sentAt: 140.4))
        for i in 0..<12 { Self.fail(&r, at: 210 + Double(i) * 3) }
        #expect(r.removals.count == 1)
        // One sent after it does.
        r.send(.forwardAnswered(query: 3, epoch: r.m.epoch, sentAt: 242))
        for i in 0..<12 { Self.fail(&r, at: 250 + Double(i) * 3) }
        #expect(r.removals.count == 2)
    }

    @Test func aReReadThatFindsANewListSwitchesAndClearsOnce() {
        var r = Self.rig()
        for i in 0..<8 { Self.fail(&r, at: 110 + Double(i) * 5) }
        let (cache, targets) = (r.count(.clearAnswerCache), r.count(.clearTargets))
        r.finishRead(["192.168.1.254"])
        #expect(r.m.forwardPermit?.upstreams == ["192.168.1.254"])
        #expect(r.count(.clearAnswerCache) == cache + 1)
        #expect(r.count(.clearTargets) == targets + 1)
    }

    @Test func afterAListSwitchLateAnswersToTheOldListAreNotStored() {
        var r = Self.rig()
        let old = r.m.epoch
        let generation = r.m.generation
        for i in 0..<8 { Self.fail(&r, at: 110 + Double(i) * 5) }
        r.now = 145.5
        r.finishRead(["192.168.1.254"])  // same network, another list
        #expect(r.m.generation == generation && r.m.epoch == old + 1)
        // A forward and a SafeSearch lookup sent to the old list during the re-read.
        #expect(r.send(.forwardAnswered(query: 5, epoch: old, sentAt: 145.2)).isEmpty)
        #expect(r.send(.safeSearchFinished(id: 6, epoch: old, addresses: [[9, 9, 9, 9]])) == [.replySafeSearch(id: 6, addresses: [], store: false)])
        // Old-list failures do not count towards the new list's stall check.
        for i in 0..<20 {
            r.now = 150 + Double(i) * 3
            r.send(.forwardFailed(query: 7, epoch: old, sentAt: r.now - 2, wasRetry: true))
        }
        #expect(r.removals.count == 1)
        // The new list's answers are stored (this one also allows another
        // re-read, sent after the re-apply).
        r.now = 211
        #expect(r.send(.forwardAnswered(query: 8, epoch: r.m.epoch, sentAt: 210)).contains(.storeAnswer(query: 8)))
        // Late old-list failures still say nothing about the new list.
        for i in 0..<20 {
            r.now = 212 + Double(i) * 3
            r.send(.forwardFailed(query: 9, epoch: old, sentAt: r.now - 2, wasRetry: true))
        }
        #expect(r.removals.count == 1)
    }

    @Test func aReReadThatFindsTheSameResolversInAnotherOrderDoesNotClear() {
        var r = Rig.running(found: ["192.168.1.1", "192.168.1.2"])
        r.now = 100
        r.send(.forwardAnswered(query: 0, epoch: r.m.epoch, sentAt: 99))
        for i in 0..<8 { Self.fail(&r, at: 110 + Double(i) * 5) }
        let (cache, epoch) = (r.count(.clearAnswerCache), r.m.epoch)
        r.finishRead(["192.168.1.2", "192.168.1.1"])
        #expect(r.m.forwardPermit?.upstreams == ["192.168.1.2", "192.168.1.1"])  // the new order is used
        #expect(r.count(.clearAnswerCache) == cache)
        #expect(r.m.epoch == epoch)
    }

    @Test func withTheBudgetFullTheReReadIsNotReservedButAskedAgainLater() {
        var r = Rig.running()
        for (i, t) in [0.0, 10, 20].enumerated() {
            r.now = t
            r.send(.pathUpdate(key: "n\(i)", satisfied: true))
            r.advance(to: t + 0.3)
            r.finishRead(["192.168.1.1"])
        }
        r.now = 21
        r.send(.forwardAnswered(query: 0, epoch: r.m.epoch, sentAt: 21))
        for i in 0..<8 { Self.fail(&r, at: 22 + Double(i) * 5) }  // stale at 57: budget full until 60.3
        #expect(r.removals.count == 3)
        #expect(r.m.phase == .forwarding(TunnelRecovery.Upstreams(["192.168.1.1"])!, .armed))
        Self.fail(&r, at: 61)
        #expect(r.removals.count == 4)
        #expect(r.removals.last?.wait == 0.5)
    }

    @Test func sleepDoesNotCountTowardsTheThirtySeconds() {
        // Uptime stops during sleep: 8 failures spread over 7 s of uptime are
        // not a stall, however long the phone slept between them.
        var r = Self.rig()
        for i in 0..<8 { Self.fail(&r, at: 110 + Double(i)) }
        #expect(r.removals.isEmpty)
        Self.fail(&r, at: 141)
        #expect(r.removals.count == 1)
    }
}

@Suite struct TunnelRecoveryLateEventTests {
    @Test func eventsFromAnOlderNetworkAreNeverTakenAsCurrent() {
        var r = Rig.running()
        let old = r.m.epoch
        r.now = 5
        r.send(.forwardAnswered(query: 0, epoch: old, sentAt: 4))
        r.send(.pathUpdate(key: "b", satisfied: true))
        r.advance(to: 5.3)
        r.finishRead(["10.0.0.1"])
        // Late answer and failures from network a.
        #expect(r.send(.forwardAnswered(query: 1, epoch: old, sentAt: 4.9)).isEmpty)
        for i in 0..<20 {
            r.now = 6 + Double(i) * 3
            let fx = r.send(.forwardFailed(query: 2, epoch: old, sentAt: 4.9, wasRetry: true))
            #expect(fx == [.log(.failure(sentBeforeChange: true))])
        }
        #expect(r.removals.count == 1)  // never counted towards b's stall check
        // A SafeSearch lookup that spans the change: fallback, nothing stored.
        #expect(r.send(.safeSearchFinished(id: 7, epoch: old, addresses: [[1, 2, 3, 4]])) == [.replySafeSearch(id: 7, addresses: [], store: false)])
        #expect(r.send(.safeSearchFinished(id: 8, epoch: r.m.epoch, addresses: [[5, 6, 7, 8]])) == [.replySafeSearch(id: 8, addresses: [[5, 6, 7, 8]], store: true)])
    }

    @Test func anAttemptRetriedOnTheNewNetworkCountsAsTheNewNetworks() {
        var r = Rig.running()
        let old = r.m.epoch
        r.now = 5
        r.send(.pathUpdate(key: "b", satisfied: true))
        r.advance(to: 5.3)
        r.finishRead(["10.0.0.1"])
        // Sent on a, failed after the change: retried at once on b.
        #expect(r.send(.forwardFailed(query: 3, epoch: old, sentAt: 4, wasRetry: false)) == [.retryForward(query: 3, after: 0, generation: r.m.generation)])
        let fx = r.send(.forwardAnswered(query: 3, epoch: r.m.epoch, sentAt: 5.31))
        #expect(fx.contains(.storeAnswer(query: 3)))
        #expect(fx.contains { if case .log(.firstAnswer) = $0 { return true } else { return false } })
    }

    @Test func aTimeoutBeforeAnyAnswerOnThisNetworkIsRetriedOnceAfterAPause() {
        var r = Rig.running()
        r.now = 3
        #expect(r.send(.forwardFailed(query: 1, epoch: r.m.epoch, sentAt: 1, wasRetry: false)) == [.retryForward(query: 1, after: 0.3, generation: r.m.generation)])
        #expect(r.send(.forwardFailed(query: 1, epoch: r.m.epoch, sentAt: 1, wasRetry: true)) == [.log(.failure(sentBeforeChange: false))])
    }

    @Test func staleTokensAndTimersChangeNothing() {
        var r = Rig.running()
        r.send(.pathUpdate(key: "b", satisfied: true))
        let before = r.m
        #expect(r.send(.readFinished(token: 999, found: ["6.6.6.6"])).isEmpty)
        #expect(r.send(.timer(999)).isEmpty)
        #expect(r.send(.reapplyFailed(token: 999)).isEmpty)
        #expect(r.m.phase == before.phase)
    }

    @Test func aFailedReapplyCancelsTheTunnelAndNothingRunsAfter() {
        var r = Rig.running()
        r.send(.pathUpdate(key: "b", satisfied: true))
        r.advance(to: 0.3)
        let fx = r.send(.reapplyFailed(token: r.removals[0].token))
        #expect(fx.contains { if case .cancelTunnel = $0 { return true } else { return false } })
        #expect(r.m.phase == .stopped)
        #expect(r.send(.pathUpdate(key: "c", satisfied: true)).isEmpty)
        #expect(r.send(.readFinished(token: r.removals[0].token, found: ["1.1.1.1"])).isEmpty)
    }

    @Test func stopCancelsEveryTimerItHolds() {
        var r = Rig.running()
        r.send(.settingsRead(TunnelRecoverySettingsTests.strict, readable: false))
        r.send(.pathUpdate(key: "b", satisfied: true))
        r.send(.stop)
        #expect(r.timers.isEmpty)
        #expect(r.m.phase == .stopped)
    }
}

@Suite struct TunnelRecoveryDeadlineTests {
    @Test func aRemovalThatNeverReturnsCancelsTheTunnelAtItsDeadline() {
        var r = Rig.running()
        r.send(.pathUpdate(key: "b", satisfied: true))
        r.advance(to: 0.3)  // removal, read wait 0.1
        // Network changes meanwhile do not start a second removal.
        r.now = 5
        r.send(.pathUpdate(key: "c", satisfied: true))
        r.advance(to: 15.39)
        #expect(r.removals.count == 1)
        #expect(r.m.phase != .stopped)
        r.advance(to: 15.4)  // 0.3 + 0.1 + 15
        #expect(r.m.phase == .stopped)
        #expect(r.log.contains { if case .cancelTunnel = $0.fx { return true } else { return false } })
        #expect(r.timers.isEmpty)
    }

    @Test func aRemovalThatReturnsCancelsItsDeadline() {
        var r = Rig.running()
        r.send(.pathUpdate(key: "b", satisfied: true))
        r.advance(to: 0.3)
        r.finishRead(["10.0.0.1"])
        r.advance(to: 1000)
        #expect(r.m.phase != .stopped)
    }

    @Test func aStaleReReadThatNeverReturnsAlsoHasADeadline() {
        var r = TunnelRecoveryStaleTests.rig()
        for i in 0..<8 { TunnelRecoveryStaleTests.fail(&r, at: 110 + Double(i) * 5) }
        #expect(r.removals.count == 1)
        r.advance(to: 145 + 0.5 + 15)
        #expect(r.m.phase == .stopped)
    }
}

@Suite struct TunnelRecoverySettingsTests {
    static let strict = FilterInputs(lists: ["adult", "gambling", "dating"], householdAllow: [], householdBlock: [], userAllow: [], userBlock: [])
    static let mine = FilterInputs(lists: ["adult", "gambling"], householdAllow: [], householdBlock: ["x.example"], userAllow: [], userBlock: ["y.example"])

    @Test func unreadableSettingsUseTheStrictDefaultsOnlyIfNothingWasReadAndAreReadAgainEveryTenSeconds() throws {
        var r = Rig.running()
        let fx = r.send(.settingsRead(Self.strict, readable: false))
        #expect(fx.contains(.rebuildSnapshot(Self.strict)))
        r.send(.settingsRead(Self.strict, readable: false))  // one retry chain only
        #expect(r.timers.count == 1)
        r.advance(to: 10)
        #expect(r.log.last?.fx == .readSettings)
        // Readable: rebuilt, and the retry chain ends.
        r.send(.settingsRead(Self.strict, readable: false))  // a new chain
        let pending = try #require(r.m.settingsTimer)
        #expect(r.send(.settingsRead(Self.mine, readable: true)) == [.cancelTimer(pending), .rebuildSnapshot(Self.mine), .clearAnswerCache])
        #expect(r.timers.isEmpty)
        // Unreadable again later (a protected-data moment): the last good
        // settings stay; only the retry chain starts.
        let again = r.send(.settingsRead(Self.strict, readable: false))
        #expect(again.count == 1)
        if case .startTimer = again.first {} else { Issue.record("expected only the retry timer: \(again)") }
    }

    @Test func onlyAChangedInputRebuildsAndClears() {
        var r = Rig.running()
        r.send(.settingsRead(Self.mine, readable: true))
        #expect(r.send(.settingsRead(Self.mine, readable: true)).isEmpty)
        var other = Self.mine
        other.userBlock = ["z.example"]
        #expect(r.send(.settingsRead(other, readable: true)) == [.rebuildSnapshot(other), .clearAnswerCache])
    }
}

@Suite struct FilterInputsTests {
    static func bundle() throws -> BlocklistBundle {
        try BlocklistBundle.load(from: fixturesDir.deletingLastPathComponent().appendingPathComponent("blocklists/android")).get()
    }

    @Test func changesTheSnapshotCannotSeeGiveEqualInputs() throws {
        let b = try Self.bundle()
        let a = HouseholdState(rev: 1, updatedAt: 1, updatedBy: "d1", allowDomains: ["a.example"], devices: ["d1"])
        var h = a
        (h.rev, h.updatedAt, h.updatedBy, h.devices, h.childLockOptions) = (2, 2, "d2", ["d1", "d2"], false)
        h.pin = PinRecord(iterations: 1, saltB64: "c2FsdA==", hashB64: "aGFzaA==")
        let base = b.filterInputs(TunnelSettings(household: a))
        #expect(b.filterInputs(TunnelSettings(household: h)) == base)  // rev, devices, PIN
        // A category id with no list, a media site with no media list, an
        // opt-in id that does not exist, the same domains in another order.
        #expect(b.filterInputs(TunnelSettings(disabledCategories: ["sitr_unknown"], mediaOff: ["nosuchsite"], optionalOn: ["nosuchlist"], household: a)) == base)
        #expect(b.filterInputs(TunnelSettings(userBlock: ["p.example", "q.example"])) == b.filterInputs(TunnelSettings(userBlock: ["q.example", "p.example"])))
        // Joined: the device's own categories do not matter.
        #expect(b.filterInputs(TunnelSettings(disabledCategories: ["sitr_dating"], household: a)) == base)
    }

    @Test func changesTheSnapshotCanSeeGiveDifferentInputs() throws {
        let b = try Self.bundle()
        let a = HouseholdState(rev: 1, updatedAt: 1, updatedBy: "d1", allowDomains: ["a.example"])
        let base = b.filterInputs(TunnelSettings(household: a))
        var h = a
        h.allowDomains = ["a.example", "b.example"]
        #expect(b.filterInputs(TunnelSettings(household: h)) != base)
        h = a
        h.disabledCategories = ["sitr_gambling"]
        #expect(b.filterInputs(TunnelSettings(household: h)) != base)
        #expect(b.filterInputs(TunnelSettings(optionalOn: ["violence"])) != b.filterInputs(TunnelSettings()))
        #expect(b.filterInputs(TunnelSettings(disabledCategories: ["sitr_dating"])) != b.filterInputs(TunnelSettings()))
        let media = b.sets.keys.first { $0.hasSuffix("-media") }.map { String($0.dropLast("-media".count)) }
        if let media { #expect(b.filterInputs(TunnelSettings(mediaOff: [media])) != b.filterInputs(TunnelSettings())) }
    }
}
