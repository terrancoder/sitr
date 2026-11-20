// TunnelRecoveryDriver against fake I/O: a serial queue that runs one job
// at a time, timers, and removals, forwards and SafeSearch lookups that
// complete late, out of order, twice or never.
import Foundation
import Testing

@testable import SitrCore

/// The tunnel's world, faked. `queue` is the serial queue; completions and
/// timers are due at times and enqueue their work when delivered.
final class FakeWorld {
    var now: TimeInterval = 0
    var queue: [() -> Void] = []
    /// Work handed off the queue; run by `drain` unless `autoBackground` is off.
    var backgroundJobs: [() -> Void] = []
    var autoBackground = true
    var timers: [Int: (due: TimeInterval, fire: () -> Void)] = [:]
    var nextTimer = 0
    var completions: [(due: TimeInterval, run: () -> Void)] = []
    var removals: [(wait: TimeInterval, done: ([String]?) -> Void)] = []
    var sends: [(query: DnsQuery, upstreams: [String], done: ((response: [UInt8], cacheable: Bool)?) -> Void)] = []
    var lookups: [(target: String, done: ([[UInt8]]) -> Void)] = []
    var cancelled: [String] = []
    var notes: [TunnelRecoveryDriver.Note] = []
    var replies: [[UInt8]] = []
    var settings = (settings: TunnelSettings(), readable: true)
    var ioAfterStop = 0
    var stopped = false
    var driver: TunnelRecoveryDriver!

    init() {
        let io = TunnelRecoveryDriver.IO(
            enqueue: { [unowned self] work in queue.append(work) },
            background: { [unowned self] work in backgroundJobs.append(work) },
            now: { [unowned self] in now },
            removeAndRead: { [unowned self] wait, done in
                touch()
                removals.append((wait, done))
            },
            startTimer: { [unowned self] after, fire in
                touch()
                nextTimer += 1
                let id = nextTimer
                timers[id] = (now + after, fire)
                return { [unowned self] in timers[id] = nil }
            },
            send: { [unowned self] q, _, ups, done in
                touch()
                sends.append((q, ups, done))
            },
            resolveTarget: { [unowned self] target, _, done in
                touch()
                lookups.append((target, done))
            },
            readSettings: { [unowned self] in settings },
            cancelTunnel: { [unowned self] reason in
                touch()
                cancelled.append(reason)
            },
            note: { [unowned self] n in notes.append(n) })
        driver = TunnelRecoveryDriver(bundle: Self.bundle, upstreamTimeout: 2, io: io)
    }

    /// Loaded once: verifying the lists' checksums is the slow part.
    static let bundle = try! FilterInputsTests.bundle()

    private func touch() { if stopped { ioAfterStop += 1 } }

    /// True while a queue job runs: the driver may touch its state only then.
    var inJob = false

    /// Runs every queued job, in order, one at a time.
    func drain() {
        repeat {
            while !queue.isEmpty {
                let job = queue.removeFirst()
                inJob = true
                job()
                inJob = false
            }
            if autoBackground { runBackground() }
        } while !queue.isEmpty
    }

    /// Runs the background jobs (all, or the one at `index`), off the queue.
    func runBackground(_ index: Int? = nil) {
        if let index { return backgroundJobs.remove(at: index)() }
        while !backgroundJobs.isEmpty { backgroundJobs.removeFirst()() }
    }

    /// Runs `work` as a queue job, then everything it queued.
    func onQueue(_ work: @escaping (TunnelRecoveryDriver) -> Void) {
        queue.append { [unowned self] in work(driver) }
        drain()
    }

    /// Moves the clock, delivering due timers (each then drains the queue).
    func advance(to t: TimeInterval) {
        while let next = timers.filter({ $0.value.due <= t }).min(by: { ($0.value.due, $0.key) < ($1.value.due, $1.key) }) {
            now = max(now, next.value.due)
            timers[next.key] = nil
            next.value.fire()
            drain()
        }
        now = max(now, t)
    }

    func finishRemoval(_ i: Int, _ found: [String]?) {
        removals[i].done(found)
        drain()
    }

    func answer(_ i: Int) {
        sends[i].done((Self.response(to: sends[i].query), true))
        drain()
    }

    func failSend(_ i: Int) {
        sends[i].done(nil)
        drain()
    }

    static func response(to q: DnsQuery) -> [UInt8] {
        DnsAnswerBuilder.cnameWithAddresses(q, target: "x.example", addresses: [[192, 0, 2, 1]], ttl: 60)
    }

    static func payload(_ name: String, id: UInt16 = 1) -> [UInt8] { DnsMessage.buildQuery(id: id, name: name, qtype: 1) }

    func ask(_ name: String) { onQueue { [unowned self] d in d.query(Self.payload(name)) { [unowned self] in replies.append($0) } } }

    var statuses: [String] { notes.compactMap { if case .status(let s) = $0 { return s } else { return nil } } }

    /// Started on network "wifi-a" with `found`.
    static func running(found: [String] = ["192.168.1.1"]) -> FakeWorld {
        let w = FakeWorld()
        w.onQueue { d in
            d.reloadSettings()
            d.pathUpdate(key: "wifi-a", satisfied: true)
            d.started(readGeneration: d.generation, found: found)
        }
        return w
    }
}

@Suite struct TunnelRecoveryDriverTests {
    @Test func anAnswerOnTheListInUseIsCachedAndServedFromTheCache() {
        let w = FakeWorld.running()
        w.ask("example.com")
        #expect(w.sends.count == 1 && w.sends[0].upstreams == ["192.168.1.1"])
        w.answer(0)
        #expect(w.replies.count == 1)
        w.ask("example.com")
        #expect(w.sends.count == 1)  // the cache answered
        #expect(w.replies.count == 2)
    }

    @Test func aLateAnswerFromBeforeANetworkChangeIsRepliedButNotCached() {
        let w = FakeWorld.running()
        w.ask("example.com")
        w.now = 1
        w.onQueue { $0.pathUpdate(key: "wifi-b", satisfied: true) }
        w.advance(to: 1.3)
        w.finishRemoval(0, ["192.168.1.1"])  // another LAN, same resolver address
        w.answer(0)  // the old attempt answers late
        #expect(w.replies.count == 1)
        w.ask("example.com")
        #expect(w.sends.count == 2)  // not served from the cache
    }

    @Test func aLateSafeSearchResultFromAnOldListGetsTheFallbackAndIsNotKept() throws {
        let w = FakeWorld.running()
        let rule = try #require(try FilterInputsTests.bundle().safeSearch.rule(for: "www.google.com"))
        w.ask("www.google.com")
        #expect(w.lookups.count == 1)
        w.now = 1
        w.onQueue { $0.pathUpdate(key: "wifi-b", satisfied: true) }
        w.advance(to: 1.3)
        w.finishRemoval(0, ["10.0.0.1"])
        w.lookups[0].done([[9, 9, 9, 9]])
        w.drain()
        let q = try #require(DnsMessage.parseQuery(FakeWorld.payload("www.google.com")))
        #expect(w.replies.last == DnsEngine().rewriteAnswer(q, rule: rule, resolved: []))
        w.ask("www.google.com")
        #expect(w.lookups.count == 2)  // nothing was kept
    }

    @Test func aRemovalAnsweredTwiceIsFedOnce() {
        let w = FakeWorld.running()
        var reads = 0
        w.driver.observer = { e, _, _, _ in if case .readFinished = e { reads += 1 } }
        w.onQueue { $0.pathUpdate(key: "wifi-b", satisfied: true) }
        w.advance(to: 0.3)
        w.finishRemoval(0, ["10.0.0.1"])
        w.finishRemoval(0, ["10.0.0.2"])
        #expect(reads == 1)
        w.ask("example.com")
        #expect(w.sends.last?.upstreams == ["10.0.0.1"])
    }

    @Test func aRemovalThatNeverReturnsCancelsTheTunnelAndNothingRunsAfter() {
        let w = FakeWorld.running()
        w.onQueue { $0.pathUpdate(key: "wifi-b", satisfied: true) }
        w.advance(to: 0.3)
        w.advance(to: 15.4)
        #expect(w.cancelled.count == 1)
        #expect(w.statuses.last?.hasPrefix("failed: ") == true)
        w.stopped = true
        w.finishRemoval(0, ["10.0.0.1"])
        w.ask("example.com")
        w.onQueue { $0.pathUpdate(key: "wifi-c", satisfied: true) }
        w.advance(to: 1000)
        #expect(w.ioAfterStop == 0)
    }

    @Test func aTimeoutBeforeAnyAnswerIsRetriedOnceInTheSameSlot() {
        let w = FakeWorld.running()
        w.ask("example.com")
        w.now = 2
        w.failSend(0)
        #expect(w.sends.count == 1)
        w.advance(to: 2.3)
        #expect(w.sends.count == 2)
        w.answer(1)
        #expect(w.replies.count == 1)
        let retried = w.notes.contains { if case .outcome(_, .forwarded(_, true, _), _) = $0 { return true } else { return false } }
        #expect(retried)
    }

    @Test func overloadAndAQueueThatOutlivesItsList() {
        let w = FakeWorld.running()
        for i in 0..<(32 + 64 + 1) { w.ask("n\(i).example") }
        #expect(w.sends.count == 32)
        let overloaded = w.notes.filter { if case .outcome(_, .overloaded, _) = $0 { return true } else { return false } }
        #expect(overloaded.count == 1)
        // The network changes: the queued ones are dropped as their slots free.
        w.onQueue { $0.pathUpdate(key: "wifi-b", satisfied: true) }
        w.answer(0)
        let dropped = w.notes.filter { if case .outcome(_, .droppedChangedWhileQueued, _) = $0 { return true } else { return false } }
        #expect(dropped.count == 64)
        #expect(w.sends.count == 32)
    }

    @Test func aQueuedQueryIsNotSentToTheNextNetworksList() {
        let w = FakeWorld.running()
        for i in 0..<(32 + 1) { w.ask("n\(i).example") }
        w.now = 1
        w.onQueue { $0.pathUpdate(key: "wifi-b", satisfied: true) }
        w.advance(to: 1.3)
        w.finishRemoval(0, ["10.0.0.1"])  // forwarding again, another list
        w.answer(0)  // a slot frees: the waiting query belonged to the old list
        #expect(w.sends.count == 32)
        let dropped = w.notes.contains { if case .outcome(_, .droppedChangedWhileQueued, _) = $0 { return true } else { return false } }
        #expect(dropped)
    }

    /// Forwarding, one answer seen, then every forward timing out for 32 s:
    /// the stale re-read is running (removal 0) when this returns.
    static func stalled() -> FakeWorld {
        let w = FakeWorld.running()
        w.ask("first.example")
        w.answer(0)  // answered on this network: timeouts are final from now on
        for i in 0..<9 {  // every forward times out for 32 s: the stale re-read starts
            w.now = 10 + Double(i) * 4
            w.ask("t\(i).example")
            w.now += 2
            w.failSend(w.sends.count - 1)
        }
        #expect(w.removals.count == 1)
        return w
    }

    @Test func aRetryDueAfterTheListSwitchedGoesToTheNewList() {
        let w = Self.stalled()
        w.ask("fast.example")
        w.now += 0.05
        w.failSend(w.sends.count - 1)  // a send error at once: retried after 0.3 s
        let sends = w.sends.count
        w.finishRemoval(0, ["192.168.1.254"])  // the list switches during the pause
        w.advance(to: w.now + 0.3)
        #expect(w.sends.count == sends + 1)
        #expect(w.sends.last?.upstreams == ["192.168.1.254"])
    }

    @Test func aRetryDueAfterANetworkChangeIsNotSent() {
        let w = FakeWorld.running()
        w.ask("first.example")
        w.answer(0)
        w.ask("fast.example")
        w.now = 1
        w.failSend(1)  // retried after 0.3 s
        w.now = 1.1
        w.onQueue { $0.pathUpdate(key: "wifi-b", satisfied: true) }
        w.advance(to: 1.4)
        #expect(w.sends.count == 2)
        let failed = w.notes.contains { if case .outcome(_, .failed, _) = $0 { return true } else { return false } }
        #expect(failed)
    }

    @Test func aQueuedQueryGoesToTheNewListAfterAListSwitch() {
        let w = Self.stalled()
        for i in 0..<(32 + 1) { w.ask("q\(i).example") }
        #expect(w.sends.count == 10 + 32)
        w.finishRemoval(0, ["192.168.1.254"])  // same network, another list
        w.answer(10)  // a slot frees
        #expect(w.sends.count == 10 + 33)
        #expect(w.sends.last?.upstreams == ["192.168.1.254"])
    }

    @Test func aSlowOlderSnapshotBuildNeverOverwritesANewerOne() {
        let w = FakeWorld.running()
        w.autoBackground = false
        w.settings = (TunnelSettings(userBlock: ["x.example"]), true)
        w.onQueue { $0.reloadSettings() }
        w.runBackground(0)  // read A
        w.drain()  // feeds A: build A pending
        w.settings = (TunnelSettings(userBlock: ["y.example"]), true)
        w.onQueue { $0.reloadSettings() }
        w.runBackground(1)  // read B (build A is job 0)
        w.drain()  // feeds B: build B pending
        #expect(w.backgroundJobs.count == 2)
        w.runBackground(1)  // build B lands first
        w.drain()
        w.runBackground(0)  // then the older build A
        w.drain()
        w.ask("y.example")
        #expect(w.sends.isEmpty)  // blocked by B
        w.ask("x.example")
        #expect(w.sends.count == 1)  // A's block is not in force
    }

    @Test func aSlowOlderSettingsReadIsNotFedAfterANewerOne() {
        let w = FakeWorld.running()
        w.autoBackground = false
        w.settings = (TunnelSettings(userBlock: ["x.example"]), true)
        w.onQueue { $0.reloadSettings() }  // read A pending
        w.settings = (TunnelSettings(userBlock: ["y.example"]), true)
        w.onQueue { $0.reloadSettings() }  // read B pending
        w.runBackground(1)  // B (reads y) lands first
        w.drain()
        w.settings = (TunnelSettings(userBlock: ["x.example"]), true)
        w.runBackground(0)  // A reads now and lands late: not fed
        w.drain()
        w.runBackground()
        w.drain()
        w.ask("y.example")
        #expect(w.sends.isEmpty)
    }

    @Test func unreadableSettingsAreReadAgainAndTheStatusIsPublishedOnChange() {
        let w = FakeWorld()
        w.settings = (TunnelSettings(userBlock: ["x.example"]), false)
        w.onQueue { $0.reloadSettings() }
        let loads = { w.notes.filter { if case .settingsLoaded = $0 { return true } else { return false } }.count }
        #expect(loads() == 1)
        w.settings = (TunnelSettings(userBlock: ["y.example"]), true)
        w.advance(to: 10)
        #expect(loads() == 2)
        #expect(w.statuses == ["starting"])
        w.onQueue { d in
            d.pathUpdate(key: "wifi-a", satisfied: true)
            d.started(readGeneration: d.generation, found: ["192.168.1.1"])
        }
        #expect(w.statuses == ["starting", "running"])
    }

    @Test func aReentrantEventIsQueuedNotRunInsideNotLost() {
        let w = FakeWorld.running()
        w.driver.trapReentry = false
        var depth = 0, maxDepth = 0, seen: [String] = []
        var once = true
        w.driver.observer = { e, _, _, _ in
            depth += 1
            maxDepth = max(maxDepth, depth)
            if case .pathUpdate(let k, _) = e { seen.append(k) }
            if once {
                once = false
                w.driver.pathUpdate(key: "inner", satisfied: true)  // re-entrant
            }
            depth -= 1
        }
        w.onQueue { $0.pathUpdate(key: "outer", satisfied: true) }
        #expect(seen == ["outer", "inner"])  // after, in order
        #expect(maxDepth == 1)  // never inside
        #expect(w.driver.machine.generation == 3)
    }

    // MARK: - Random

    /// Random order, random times, sometimes never; the machine's invariants
    /// checked on every event the driver feeds, plus the driver's own.
    static func randomRun(seed: UInt64) -> (problem: String?, reached: Set<String>) {
        var rng = SplitMix(seed: seed)
        func chance(_ p: Double) -> Bool { Double.random(in: 0..<1, using: &rng) < p }
        let w = FakeWorld()
        w.autoBackground = false
        var checker = Checker(seed: seed)
        var fed: [Int: Int] = [:]  // removal token -> results fed
        var removalTokens: [Int] = []
        var reached: Set<String> = []
        var inFeed = false
        w.driver.observer = { e, fx, before, after in
            if !w.inJob { checker.fail("event fed outside the serial queue: \(e)") }
            if inFeed { checker.fail("re-entrant feed") }
            inFeed = true
            defer { inFeed = false }
            checker.observe(e, fx, before: before, after: after, now: w.now, live: nil)
            switch e {
            case .readFinished(let t, _), .reapplyFailed(let t):
                fed[t, default: 0] += 1
                if fed[t]! > 1 { checker.fail("removal \(t) fed twice") }
            default: break
            }
            for case .removeSettingsAndRead(let t, _) in fx { removalTokens.append(t) }
            for f in fx {
                if case .storeAnswer = f { reached.insert("stored") }
                if case .cancelTunnel = f { reached.insert("cancelled") }
            }
            if after.epoch != before.epoch, after.generation == before.generation { reached.insert("list switch") }
        }
        let keys = [("wifi-a", true), ("wifi-b", true), ("cell", true), ("none", false)]
        var deliveredRemovals = 0, deliveredSends = 0, deliveredLookups = 0
        var neverRemovals: Set<Int> = []
        let failRate = seed % 3 == 0 ? 0.95 : 0.5  // every third run: a dead upstream
        w.onQueue { d in
            d.reloadSettings()
            if Bool.random(using: &rng) { d.pathUpdate(key: "wifi-a", satisfied: true) }
        }
        let readGeneration = w.driver.generation
        w.onQueue { d in d.started(readGeneration: readGeneration, found: ["192.168.1.1"]) }
        for step in 0..<400 where checker.problem == nil {
            // Deliver some outstanding I/O, in random order, possibly late.
            var pending: [() -> Void] = []
            for i in deliveredRemovals..<w.removals.count where !neverRemovals.contains(i) {
                if chance(0.02) { neverRemovals.insert(i); continue }
                pending.append { w.removals[i].done(chance(0.01) ? nil : (chance(0.4) ? [] : [["1.1.1.1"], ["9.9.9.9"]][Int.random(in: 0...1, using: &rng)])) }
            }
            deliveredRemovals = w.removals.count
            for i in deliveredSends..<w.sends.count {
                pending.append {
                    if chance(failRate) { w.sends[i].done(nil) } else { w.sends[i].done((FakeWorld.response(to: w.sends[i].query), true)) }
                }
            }
            deliveredSends = w.sends.count
            for i in deliveredLookups..<w.lookups.count { pending.append { w.lookups[i].done(chance(0.5) ? [[1, 2, 3, 4]] : []) } }
            deliveredLookups = w.lookups.count
            while !w.backgroundJobs.isEmpty, chance(0.7) {  // settings reads and builds land in any order
                let i = Int.random(in: 0..<w.backgroundJobs.count, using: &rng)
                pending.append { if i < w.backgroundJobs.count { w.runBackground(i) } }
                break
            }
            pending.shuffle(using: &rng)
            for p in pending {
                p()
                if chance(0.3) { w.drain() }  // completions interleave with queue jobs
                if chance(0.2) { w.advance(to: w.now + [0.01, 0.3, 2][Int.random(in: 0...2, using: &rng)]) }
            }
            w.drain()
            w.advance(to: w.now + [0.05, 0.3, 1, 5, 31, 70][Int.random(in: 0...5, using: &rng)])
            switch Double.random(in: 0..<1, using: &rng) {
            case ..<0.08:
                let (k, s) = keys[Int.random(in: 0..<keys.count, using: &rng)]
                w.onQueue { $0.pathUpdate(key: k, satisfied: s) }
            case ..<0.7: w.ask(["example.com", "a.example", "www.google.com"][Int.random(in: 0...2, using: &rng)] + (chance(0.5) ? "" : "\(step)"))
            case ..<0.75:
                w.settings = (TunnelSettings(userBlock: chance(0.5) ? [] : ["x.example"]), chance(0.8))
                w.onQueue { $0.reloadSettings() }
            case ..<0.752:
                w.onQueue { $0.stop() }
            default: break
            }
            if w.driver.machine.phase == .stopped { w.stopped = true }
            if w.stopped, w.ioAfterStop > 0 { checker.fail("I/O after stopped") }
        }
        // Liveness: deliver everything still answerable; never-removals stay unanswered.
        for _ in 0..<50 where checker.problem == nil {
            for i in deliveredRemovals..<w.removals.count { w.removals[i].done(chance(0.5) ? [] : ["1.1.1.1"]) }
            deliveredRemovals = w.removals.count
            for i in deliveredSends..<w.sends.count { w.sends[i].done(nil) }
            deliveredSends = w.sends.count
            for i in deliveredLookups..<w.lookups.count { w.lookups[i].done([]) }
            deliveredLookups = w.lookups.count
            w.runBackground()
            w.drain()
            w.advance(to: w.now + 1000)
        }
        if w.driver.machine.phase == .stopped { w.stopped = true }
        if w.stopped, w.ioAfterStop > 0 { checker.fail("I/O after stopped") }
        // Every removal: exactly one result fed, or the tunnel stopped.
        for t in removalTokens where fed[t, default: 0] != 1 && w.driver.machine.phase != .stopped {
            checker.fail("removal \(t) got \(fed[t, default: 0]) results and the tunnel did not stop")
        }
        switch w.driver.machine.phase {
        case .forwarding(_, .armed), .forwarding(_, .used), .noNetwork, .gaveUp(_, nil), .stopped: break
        default: checker.fail("did not settle: \(w.driver.machine.phase)")
        }
        if !neverRemovals.isEmpty { reached.insert("never") }
        return (checker.problem, reached)
    }

    @Test func invariantsHoldEndToEndWithFakeIO() {
        var reached: [String: Int] = [:]
        for seed in UInt64(1)...500 {
            let (problem, r) = Self.randomRun(seed: seed)
            if let problem {
                Issue.record("seed \(seed): \(problem)")
                return
            }
            for k in r { reached[k, default: 0] += 1 }
        }
        for flow in ["stored", "cancelled", "list switch", "never"] {
            #expect(reached[flow, default: 0] >= 10, "\(flow): \(reached[flow, default: 0]) of 500")
        }
    }
}
