// Random event sequences through the recovery machine (TunnelRecovery),
// with the invariants checked after every event. Seeded: a failure names
// its seed, and `sequence(seed:)` replays it.
import Foundation
import Testing

@testable import SitrCore

/// Plays the provider: answers reads late, out of order or never, sends
/// answers and failures tagged with current or older list epochs, and
/// checks every invariant after every event.
struct Checker {
    var r = Rig()
    var rng: SplitMix
    var problem: String?
    var steps = 0

    var pendingReads: [Int] = []  // removals the fake provider will still answer
    var withheld: Set<Int> = []  // never answered
    var tokenGeneration: [Int: Int] = [:]
    var tokenKind: [Int: TunnelRecovery.ReadKind?] = [:]  // nil = stale re-read
    var attempts: [Int: Int] = [:]
    var emptyAttemptReads: [Int: Int] = [:]
    var retries: [Int: Int] = [:]
    var staleReads: [Int: Int] = [:]
    var staleAnsweredSince: [Int: Bool] = [:]
    var lastStaleReapply: [Int: TimeInterval] = [:]
    var learnedGeneration: Int?
    var removalTimes: [TimeInterval] = []
    var query = 0

    init(seed: UInt64) { rng = SplitMix(seed: seed) }

    var lastNow: TimeInterval = 0

    mutating func fail(_ what: String) { if problem == nil { problem = "step \(steps) at \(lastNow): \(what)" } }

    static func held(_ m: TunnelRecovery) -> Set<Int> {
        var s = Set<Int>()
        switch m.phase {
        case .debouncing(let t), .pendingRead(_, .some(let t)), .gaveUp(_, .some(let t)): s.insert(t)
        default: break
        }
        if let d = m.inFlight?.deadline { s.insert(d) }
        if let t = m.settingsTimer { s.insert(t) }
        return s
    }

    mutating func step(_ e: Ev) {
        let before = r.m
        let fx = r.send(e)
        observe(e, fx, before: before, after: r.m, now: r.now, live: Set(r.timers.keys))
    }

    /// Checks one fed event; `live`: the timers still pending outside the
    /// machine (nil: not known).
    mutating func observe(_ e: Ev, _ fx: [Fx], before: TunnelRecovery, after m: TunnelRecovery, now: TimeInterval, live: Set<Int>?) {
        steps += 1
        lastNow = now
        let wasStopped = before.phase == .stopped
        let (g0, e0, permit0) = (before.generation, before.epoch, before.forwardPermit)
        let g = m.generation
        if wasStopped, !fx.isEmpty { fail("effects after stopped: \(fx)") }

        // A read's own result counts before what it triggers in the same step.
        if case .readFinished(let token, let found) = e, !wasStopped, tokenGeneration[token] == g0 {
            if case .some(.some(.attempt)) = tokenKind[token], found.isEmpty { emptyAttemptReads[g0, default: 0] += 1 }
            if tokenKind[token] == .some(nil) { lastStaleReapply[g0] = now }
        }
        // 7: a new list epoch (a network change, or a list switch inside one)
        // clears each cache exactly once, at once; a new generation is always
        // a new epoch.
        if g != g0, m.epoch == e0 { fail("new generation without a new epoch") }
        if m.epoch != e0 {
            if fx.filter({ $0 == .clearAnswerCache }).count != 1 || fx.filter({ $0 == .clearTargets }).count != 1 {
                fail("new epoch without exactly one clear of each cache: \(fx)")
            }
        }
        for f in fx {
            switch f {
            case .storeAnswer:
                guard case .forwardAnswered(_, let ee, _) = e, ee == e0, permit0 != nil else { return fail("stored an answer not from the list in use: \(e)") }
            case .replySafeSearch(_, _, true):
                guard case .safeSearchFinished(_, let ee, _) = e, ee == e0, permit0 != nil else { return fail("stored a SafeSearch result not from the list in use: \(e)") }  // 8
            case .removeSettingsAndRead(let token, _):
                removalTimes.append(now)
                // 1: at most 3 removals in any 60 s.
                if removalTimes.filter({ $0 + 60 > now }).count > 3 { fail("more than 3 removals within 60 s") }
                tokenGeneration[token] = g
                pendingReads.append(token)
                switch m.phase {
                case .reading(token, .attempt(let n)):
                    tokenKind[token] = .attempt(n)
                    attempts[g, default: 0] += 1
                    // 4 and 5: the first read of a change, then one more only after an empty read.
                    if n != attempts[g]! - 1 || n > 2 || (n > 0 && emptyAttemptReads[g, default: 0] < n) {
                        fail("attempt \(n) on generation \(g) without the empty reads before it")
                    }
                case .reading(token, .retry(let k)):
                    tokenKind[token] = .retry(k)
                    retries[g, default: 0] += 1
                    if retries[g]! > 5 || k != retries[g]! || attempts[g, default: 0] != 3 { fail("retry \(k) out of order on \(g)") }
                case .forwarding(_, .reading(token)):
                    tokenKind[token] = .some(nil)
                    // 6: once, then again only after an answer sent after the re-apply.
                    if staleReads[g, default: 0] > 0, staleAnsweredSince[g] != true { fail("second stale re-read without an answer since") }
                    staleReads[g, default: 0] += 1
                    staleAnsweredSince[g] = false
                default: fail("removal in phase \(m.phase)")
                }
            default: break
            }
        }

        switch e {
        case .readFinished(let token, _):
            if permit0 == nil || permit0?.upstreams != m.forwardPermit?.upstreams, m.forwardPermit != nil {
                learnedGeneration = tokenGeneration[token]
            }
        case .started(let readGeneration, _):
            if m.forwardPermit != nil { learnedGeneration = readGeneration }
        case .forwardAnswered(_, let ee, let sentAt):
            if ee == e0, permit0 != nil, let at = lastStaleReapply[g0], sentAt >= at { staleAnsweredSince[g0] = true }
        default: break
        }

        // 2 and 3: forwarding only to a non-empty list learned on this generation.
        if let p = m.forwardPermit {
            if p.upstreams.isEmpty { fail("forwarding with no upstreams") }
            if learnedGeneration != g { fail("forwarding to resolvers learned on \(String(describing: learnedGeneration)), now \(g)") }
        }
        // The budget record never holds more than the budget.
        if m.windows.count > TunnelRecovery.windowBudget { fail("\(m.windows.count) windows recorded") }
        // 11: the removal in the phase is the one in flight; waiting for an
        // older removal only while one runs.
        switch m.phase {
        case .reading(let t, _), .forwarding(_, .reading(let t)):
            if m.inFlight?.token != t { fail("phase reads \(t) but in flight is \(String(describing: m.inFlight))") }
        case .pendingRead(_, nil):
            if m.inFlight == nil { fail("waiting for a removal that is not running") }
        default: break
        }
        // 9: every live timer is held by the state and every held timer is live.
        if m.phase != .stopped, let live, live != Self.held(m) { fail("timers \(live.sorted()) but held \(Self.held(m).sorted())") }
    }

    /// While advancing, a removal started by a timer usually returns before
    /// the next timer (as on the phone, in about half a second).
    var promptChance = 0.0
    var emptyChance = 0.3

    mutating func advance(by dt: TimeInterval) {
        let t = r.now + dt
        var fired = 0
        while problem == nil, fired < 100_000, let next = r.timers.filter({ $0.value <= t }).min(by: { ($0.value, $0.key) < ($1.value, $1.key) }) {
            fired += 1
            r.timers[next.key] = nil
            r.now = max(r.now, next.value)
            step(.timer(next.key))
            if chance(promptChance) { while problem == nil, !pendingReads.isEmpty { answerARead(withholdChance: 0.01, emptyChance: emptyChance) } }
        }
        if fired >= 100_000 { fail("timer storm") }
        r.now = max(r.now, t)
    }

    mutating func pick<T>(_ xs: [T]) -> T { xs[Int.random(in: 0..<xs.count, using: &rng)] }
    mutating func chance(_ p: Double) -> Bool { Double.random(in: 0..<1, using: &rng) < p }

    mutating func someEpoch() -> Int { max(0, r.m.epoch - pick([0, 0, 0, 1, 2])) }

    /// `emptyChance`: how often a read finds nothing (a sign-in network).
    mutating func answerARead(withholdChance: Double, emptyChance: Double) {
        guard !pendingReads.isEmpty else { return }
        let token = pendingReads.remove(at: Int.random(in: 0..<pendingReads.count, using: &rng))
        if chance(withholdChance) {
            withheld.insert(token)
            return
        }
        if chance(0.005) { return step(.reapplyFailed(token: token)) }
        step(.readFinished(token: token, found: chance(emptyChance) ? [] : pick([["1.1.1.1"], ["9.9.9.9"], ["192.168.1.1", "fd00::1"]])))
    }

    /// Mode by seed: 0 mixed, 1 a dead upstream (failures), 2 a sign-in
    /// network (reads find nothing), 3 a flapping network.
    mutating func run(events: Int, mode: Int) {
        let keys = [("wifi-a", true), ("wifi-b", true), ("cell", true), ("none", false), ("portal", true), ("wifi-a2", true)]
        let pathChance = [0.08, 0.01, 0.002, 0.35][mode]
        let failChance = [0.35, 0.7, 0.2, 0.3][mode]
        emptyChance = [0.3, 0.05, 0.97, 0.3][mode]
        promptChance = 0.9
        // Start-up in any order: path updates before, during and after the start read.
        var readGeneration = 0
        for _ in 0..<Int.random(in: 0...3, using: &rng) {
            if chance(0.5) { readGeneration = r.m.generation }
            let (k, s) = pick(keys)
            step(.pathUpdate(key: k, satisfied: s))
        }
        if mode == 2 { step(.pathUpdate(key: "portal-start", satisfied: true)) }
        if chance(0.7) { readGeneration = r.m.generation }
        step(.started(readGeneration: readGeneration, found: mode == 2 ? [] : pick([[], ["192.168.1.1"]])))
        for _ in 0..<events where problem == nil {
            // Most removals return quickly; some late, out of order, or never.
            if chance(0.85) { while problem == nil, !pendingReads.isEmpty { answerARead(withholdChance: 0.01, emptyChance: emptyChance) } }
            advance(by: pick([0, 0.05, 0.2, 0.3, 1, 3, 5, 10, 31, 70]))
            query += 1
            let roll = Double.random(in: 0..<1, using: &rng)
            if roll < pathChance {
                let (k, s) = pick(keys)
                step(.pathUpdate(key: k, satisfied: s))
            } else if roll < pathChance + failChance {
                step(.forwardFailed(query: query, epoch: someEpoch(), sentAt: r.now - pick([0.01, 1, 2, 3]), wasRetry: chance(0.5)))
            } else {
                switch Double.random(in: 0..<1, using: &rng) {
                case ..<0.15: answerARead(withholdChance: 0.01, emptyChance: emptyChance)
                case ..<0.65: step(.forwardAnswered(query: query, epoch: someEpoch(), sentAt: r.now - pick([0, 0.5, 2, 40])))
                case ..<0.80: step(.safeSearchFinished(id: query, epoch: someEpoch(), addresses: pick([[], [[1, 2, 3, 4]]])))
                case ..<0.997:
                    let i = FilterInputs(lists: ["adult"], householdAllow: [], householdBlock: [], userAllow: [], userBlock: chance(0.5) ? [] : ["x.example"])
                    step(.settingsRead(i, readable: chance(0.7)))
                default: step(.stop)
                }
            }
        }
        // 10: liveness without trusting the provider. From here no new event
        // but timers and, for half the removals, a result; the machine must
        // still settle in a resting phase (or have stopped itself).
        var rounds = 0
        while problem == nil, rounds < 200, !(r.timers.isEmpty && pendingReads.isEmpty) {
            rounds += 1
            promptChance = 0
            while problem == nil, !pendingReads.isEmpty { answerARead(withholdChance: 0.5, emptyChance: 0.5) }
            advance(by: 1000)
        }
        switch r.m.phase {
        case .forwarding(_, .armed), .forwarding(_, .used), .noNetwork, .gaveUp(_, nil), .stopped: break
        default: fail("did not settle: \(r.m.phase)")
        }
    }
}

@Suite struct TunnelRecoveryPropertyTests {
    static func sequence(seed: UInt64, events: Int = 300) -> Checker {
        var c = Checker(seed: seed)
        c.run(events: events, mode: Int(seed % 4))
        return c
    }

    @Test func invariantsHoldOverRandomSequences() {
        var reached: [String: Int] = [:]
        for seed in UInt64(1)...2000 {
            let c = Self.sequence(seed: seed)
            if let p = c.problem {
                Issue.record("seed \(seed): \(p)")
                return
            }
            if c.retries.values.contains(5) { reached["five retries", default: 0] += 1 }
            if c.staleReads.values.contains(where: { $0 >= 2 }) { reached["two stale re-reads on one network", default: 0] += 1 }
            if c.removalTimes.count > 3 { reached["more than three removals", default: 0] += 1 }
            if c.r.log.contains(where: { if case .cancelTunnel = $0.fx { return true } else { return false } }) { reached["cancelled", default: 0] += 1 }
            if c.r.log.contains(where: { if case .storeAnswer = $0.fx { return true } else { return false } }) { reached["stored answers", default: 0] += 1 }
            if case .forwarding = c.r.m.phase { reached["ended forwarding", default: 0] += 1 }
        }
        // The sequences must reach every flow, or a passing run proves little.
        for flow in ["five retries", "two stale re-reads on one network", "more than three removals", "cancelled", "stored answers", "ended forwarding"] {
            #expect(reached[flow, default: 0] >= 50, "\(flow): \(reached[flow, default: 0]) of 2000")
        }
    }
}
