// TEMPORARY: lives until ResolverRediscovery, SafeSearchTargets and their
// tests are removed. Runs the committed ResolverRediscovery and the new
// TunnelRecovery on the same sequences and shows the same read waits,
// budget delays and give-up points for the flows ResolverRediscovery
// covers; and SafeSearchTargets against TargetCache on the same lookups.
//
// The one intended difference is pinned at the end: when every forward
// keeps failing and the window budget is full, ResolverRediscovery grants a
// stale retry that waits for the budget; the machine grants none and asks
// again on a later failure (no reservation that could outlive a network
// change).
import Foundation
import Testing

@testable import SitrCore

@Suite struct RediscoveryEquivalenceTests {
    /// Network changes at random gaps, each read finishing 0.2 s after its
    /// removal and finding nothing with probability 1/3. Changes come only
    /// after the previous network's reads are done (ResolverRediscovery
    /// does not model a change during a read or a budget wait) and before a
    /// give-up retry is due (it has none).
    @Test func sameReadWaitsBudgetDelaysAndGiveUpsOnRandomSequences() {
        var (delays, giveUps) = (0, 0)
        for seed in UInt64(1)...300 {
            var rng = SplitMix(seed: seed)
            var rr = ResolverRediscovery()
            var r = Rig.running()
            var t: TimeInterval = 1
            for n in 0..<25 {
                let g = n + 100  // ResolverRediscovery's generations: any distinct values
                r.now = t
                r.send(.pathUpdate(key: "net\(n)", satisfied: true))
                var decideAt = t + TunnelRecovery.debounce
                var before = r.removals.count  // an empty read starts the next removal at once
                while true {
                    let step = rr.next(generation: g, now: decideAt)
                    guard case .attempt(let wait, let after) = step else {
                        giveUps += 1
                        #expect(r.m.phase == .gaveUp(retriesDone: 0, timer: r.m.phase.timerId), "seed \(seed)")
                        break
                    }
                    if after > 0 { delays += 1 }
                    r.advance(to: decideAt + after)
                    guard r.removals.count == before + 1, let removal = r.removals.last else {
                        Issue.record("seed \(seed): no removal at \(decideAt + after)")
                        return
                    }
                    #expect(abs(removal.at - (decideAt + after)) < 1e-9 && removal.wait == wait, "seed \(seed): \(removal) vs \(wait) after \(after)")
                    before = r.removals.count
                    r.now = removal.at + 0.2
                    let empty = Int.random(in: 0..<3, using: &rng) == 0
                    r.finishRead(empty ? [] : ["192.168.\(n).1"])
                    if !empty {
                        #expect(r.m.forwardPermit != nil, "seed \(seed)")
                        break
                    }
                    decideAt = r.now
                }
                t = r.now + Double(Int.random(in: 1...250, using: &rng)) / 10  // 0.1 to 25 s later
            }
        }
        #expect(delays > 100 && giveUps > 100, "the sequences must reach budget delays (\(delays)) and give-ups (\(giveUps))")
    }

    @Test func sameStaleRetryOncePerNetworkAndAgainAfterAnAnswer() {
        var rr = ResolverRediscovery()
        var r = TunnelRecoveryStaleTests.rig()  // forwarding, one answer seen, clock 100
        let g = 7
        func stall(from t: TimeInterval) -> Bool {
            let before = r.removals.count
            for i in 0..<9 { TunnelRecoveryStaleTests.fail(&r, at: t + Double(i) * 4) }
            return r.removals.count > before
        }
        #expect(stall(from: 110))
        #expect(rr.staleRetry(generation: g, now: 142) == 0)
        r.now = 142.5
        r.finishRead(["192.168.1.1"])
        #expect(!stall(from: 150))
        #expect(rr.staleRetry(generation: g, now: 182) == nil)  // nothing answered since
        r.send(.forwardAnswered(query: 9, epoch: r.m.epoch, sentAt: 182))
        rr.answered()
        #expect(stall(from: 190))
        #expect(rr.staleRetry(generation: g, now: 222) == 0)
    }

    @Test func theIntendedDifferenceAStaleRetryNeverWaitsForTheBudget() {
        var rr = ResolverRediscovery()
        for g in 1...3 { _ = rr.next(generation: g, now: Double(g)) }
        #expect(rr.staleRetry(generation: 3, now: 4) == 57)  // committed: waits
        var r = Rig.running()
        for (i, t) in [1.0, 2, 3].enumerated() {
            r.now = t
            r.send(.pathUpdate(key: "n\(i)", satisfied: true))
            r.advance(to: t + 0.3)
            r.finishRead(["192.168.1.1"])
        }
        r.now = 3.5
        r.send(.forwardAnswered(query: 0, epoch: r.m.epoch, sentAt: 3.4))
        for i in 0..<9 { TunnelRecoveryStaleTests.fail(&r, at: 4 + Double(i) * 4) }  // stall from 4 to 36
        #expect(r.removals.count == 3)  // machine: no grant, nothing reserved
        #expect(r.timers.isEmpty)
        TunnelRecoveryStaleTests.fail(&r, at: 61.4)  // a window is free from 61.3
        #expect(r.removals.count == 4)
    }
}

/// Answers A with 1.2.3.4 (or nothing for names starting "none"), AAAA
/// with no data; counts the UDP exchanges.
private final class TargetTransport: DnsUpstreamTransport, @unchecked Sendable {
    let lock = NSLock()
    var calls = 0
    func udp(_ query: [UInt8], to upstream: String) async throws -> AsyncThrowingStream<[UInt8], Error> {
        lock.withLock { calls += 1 }
        let q = DnsMessage.parseQuery(query)!
        let reply = q.qtype == DnsMessage.typeA && !q.qname.hasPrefix("none")
            ? DnsAnswerBuilder.cnameWithAddresses(q, target: q.qname, addresses: [[1, 2, 3, 4]], ttl: 60)
            : DnsAnswerBuilder.nodata(q)
        return AsyncThrowingStream { $0.yield(reply); $0.finish() }
    }
    func tcp(_ query: [UInt8], to upstream: String) async throws -> [UInt8] { throw SitrError("no tcp") }
}

@Suite struct TargetCacheEquivalenceTests {
    /// The same lookups at random times through both: the same addresses
    /// and the same number of exchanges (hits within 5 minutes, empty
    /// results not kept), and a clear forgets in both.
    @Test func sameAddressesAndLookupsAsSafeSearchTargets() async {
        var rng = SplitMix(seed: 7)
        let (oldT, newT) = (TargetTransport(), TargetTransport())
        let oldR = UpstreamResolver(transport: oldT), newR = UpstreamResolver(transport: newT)
        await oldR.setUpstreams(["192.0.2.1"])
        let old = SafeSearchTargets()
        var cache = TargetCache()
        var now: TimeInterval = 0
        for _ in 0..<400 {
            now += [0, 1, 60, 200, 301][Int.random(in: 0...4, using: &rng)]
            let target = ["forcesafesearch.google.com", "strict.bing.com", "none.example"][Int.random(in: 0...2, using: &rng)]
            if Int.random(in: 0..<20, using: &rng) == 0 {
                await old.clear()
                cache.clear()
            }
            let a = await old.addresses(for: target, via: oldR, now: now)
            var b: [[UInt8]]
            if let hit = cache.addresses(for: target, now: now) {
                b = hit
            } else {
                b = await TargetCache.resolve(target, via: newR, to: ["192.0.2.1"])
                cache.store(target, b, now: now)
            }
            #expect(a == b)
            #expect(oldT.calls == newT.calls)
        }
    }
}

extension TunnelRecovery.Phase {
    var timerId: Int? {
        switch self {
        case .debouncing(let t): return t
        case .pendingRead(_, let t), .gaveUp(_, let t): return t
        default: return nil
        }
    }
}
