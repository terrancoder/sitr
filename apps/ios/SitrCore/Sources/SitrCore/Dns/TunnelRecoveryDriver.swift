import Foundation

/// Runs the DNS filter's recovery machine (TunnelRecovery) and the parts of
/// the filter that depend on it: the answer cache, the SafeSearch target
/// cache, the snapshot and the in-flight limits. The tunnel supplies its
/// I/O as closures and makes no recovery decision of its own.
///
/// Ordering: every entry point must be called on the tunnel's one serial
/// queue, and every I/O completion comes back through `io.enqueue` (onto
/// that queue) before it touches anything. `feed` reads the clock, calls
/// the machine, runs its effects in order and publishes the status text,
/// all in one queue job, so events are fed one at a time in one order.
///
/// Per packet the queue does the decision (one parse, the snapshot and
/// the answer cache) and the bookkeeping. Reading the settings and
/// building the snapshot run on `io.background`; their results come back
/// as queue jobs, and only the newest request's result is used (a counter
/// each), so a slow older one never overwrites a newer one.
///
/// Queued and paused work (a query waiting for a slot, a retry in its
/// pause) belongs to the network generation it was queued on: it goes to
/// the list in use when its turn comes, even if a re-read switched the
/// list meanwhile, and is dropped only if the network changed. An attempt
/// already sent belongs to its list's epoch (the late-event rule).
///
/// `@unchecked Sendable`: completions capture the driver to hand it back to
/// the queue; no stored property is read or written anywhere else.
public final class TunnelRecoveryDriver: @unchecked Sendable {
    public struct IO {
        /// Runs `work` on the serial queue after what is already queued.
        public var enqueue: (@escaping () -> Void) -> Void
        /// Runs `work` off the queue (settings read, snapshot build).
        public var background: (@escaping () -> Void) -> Void
        /// System uptime (stops during sleep).
        public var now: () -> TimeInterval
        /// Remove the tunnel's DNS settings, read the network's resolvers
        /// for up to `readWait` s, re-apply (two tries). `done(found)`, or
        /// `done(nil)` if the re-apply failed. A second call is ignored.
        public var removeAndRead: (_ readWait: TimeInterval, _ done: @escaping ([String]?) -> Void) -> Void
        /// Calls `fire` after `after` s of awake time unless the returned
        /// cancel ran first.
        public var startTimer: (_ after: TimeInterval, _ fire: @escaping () -> Void) -> (() -> Void)
        /// Forward to exactly these upstreams (DnsEngine.fetch).
        public var send: (_ query: DnsQuery, _ payload: [UInt8], _ upstreams: [String], _ done: @escaping ((response: [UInt8], cacheable: Bool)?) -> Void) -> Void
        /// Both families of a SafeSearch target through these upstreams.
        public var resolveTarget: (_ target: String, _ upstreams: [String], _ done: @escaping ([[UInt8]]) -> Void) -> Void
        /// The App Group settings, and whether they could be read.
        public var readSettings: () -> (settings: TunnelSettings, readable: Bool)
        public var cancelTunnel: (_ reason: String) -> Void
        /// Diagnostics and the status text.
        public var note: (Note) -> Void

        public init(
            enqueue: @escaping (@escaping () -> Void) -> Void, background: @escaping (@escaping () -> Void) -> Void,
            now: @escaping () -> TimeInterval,
            removeAndRead: @escaping (TimeInterval, @escaping ([String]?) -> Void) -> Void,
            startTimer: @escaping (TimeInterval, @escaping () -> Void) -> (() -> Void),
            send: @escaping (DnsQuery, [UInt8], [String], @escaping ((response: [UInt8], cacheable: Bool)?) -> Void) -> Void,
            resolveTarget: @escaping (String, [String], @escaping ([[UInt8]]) -> Void) -> Void,
            readSettings: @escaping () -> (settings: TunnelSettings, readable: Bool),
            cancelTunnel: @escaping (String) -> Void, note: @escaping (Note) -> Void
        ) {
            (self.enqueue, self.background, self.now, self.removeAndRead, self.startTimer) = (enqueue, background, now, removeAndRead, startTimer)
            (self.send, self.resolveTarget, self.readSettings, self.cancelTunnel, self.note) = (send, resolveTarget, readSettings, cancelTunnel, note)
        }
    }

    public enum Note {
        case status(String)
        case diag(TunnelRecovery.Diag)
        case settingsLoaded
        /// What happened to one query; `startedAt` is when it arrived.
        case outcome(DnsQuery?, Outcome, startedAt: TimeInterval)
    }

    public enum Outcome: Equatable {
        case dropped, blocked, safeSearchNoData, cacheHit
        /// The DoH canary (use-application-dns.net) answered NODATA.
        case canary
        /// No forwarding: the current network's resolvers are not known.
        case droppedUnconfirmed
        case overloaded
        case droppedChangedWhileQueued
        case forwarded(rcode: Int, retried: Bool, rttMs: Int)
        case failed(retried: Bool, timedOut: Bool, sentBeforeChange: Bool)
        case safeSearch(resolved: Int)
    }

    // In-flight limits (Android: 32 forward + 4 target workers, queue 64).
    static let forwardLimit = 32, targetLimit = 4, queueLimit = 64

    private struct Query {
        let query: DnsQuery
        let payload: [UInt8]
        let reply: ([UInt8]) -> Void
        let startedAt: TimeInterval
        /// The network it was queued on: it is sent only while this lasts.
        let generation: Int
        var epoch: Int
        var sentAt: TimeInterval = 0
        var retried = false
        var target: SafeSearchMap.Rule?
    }

    private(set) var machine: TunnelRecovery
    private let engine = DnsEngine()
    private var targets = TargetCache()
    private let bundle: BlocklistBundle
    private var snapshot = DecisionSnapshot()
    /// The first snapshot is built inline (at start, before any packet).
    private var snapshotReady = false
    private var settingsRequest = 0, snapshotRequest = 0
    private let io: IO
    private let upstreamTimeout: TimeInterval

    private var machineTimers: [Int: () -> Void] = [:]
    /// Removals not yet answered. The machine would ignore a second answer
    /// anyway (it holds a token only until the first), but this keeps the
    /// driver's contract that each removal yields exactly one result event.
    private var outstandingRemovals: Set<Int> = []
    private var queries: [Int: Query] = [:]
    private var queryTimers: [Int: () -> Void] = [:]
    private var forwardsRunning = 0, targetsRunning = 0
    private var forwardQueue: [Int] = [], targetQueue: [Int] = []
    private var nextQuery = 1
    private var lastStatus: String?
    /// Tests: every event with its effects, as fed.
    var observer: ((TunnelRecovery.Event, [TunnelRecovery.Effect], TunnelRecovery, TunnelRecovery) -> Void)?
    private var feeding = false
    /// Tests turn this off to exercise the Release path of a re-entrant feed.
    var trapReentry = true

    public init(bundle: BlocklistBundle, upstreamTimeout: TimeInterval, io: IO) {
        self.bundle = bundle
        self.upstreamTimeout = upstreamTimeout
        self.io = io
        machine = TunnelRecovery(upstreamTimeout: upstreamTimeout)
    }

    // MARK: - Entry points (on the queue)

    public var generation: Int { machine.generation }
    public var noResolver: Bool { machine.noResolver }

    public func pathUpdate(key: String, satisfied: Bool) { feed(.pathUpdate(key: key, satisfied: satisfied)) }

    /// Start-up read `found` (before any settings) on `readGeneration`.
    public func started(readGeneration: Int, found: [String]) { feed(.started(readGeneration: readGeneration, found: found)) }

    /// At start (inline, so the first snapshot is in place before any
    /// packet) and on the app's settings notification (off the queue).
    public func reloadSettings() {
        let (io, bundle) = (self.io, self.bundle)
        let read = { () -> (FilterInputs, Bool) in
            let (settings, readable) = io.readSettings()
            return (bundle.filterInputs(settings), readable)
        }
        if !snapshotReady {
            let (inputs, readable) = read()
            feed(.settingsRead(inputs, readable: readable))
            return
        }
        settingsRequest += 1
        let n = settingsRequest
        io.background {
            let (inputs, readable) = read()
            io.enqueue { [self] in
                guard n == settingsRequest else { return }  // a newer read was asked for
                feed(.settingsRead(inputs, readable: readable))
            }
        }
    }

    public func stop() {
        feed(.stop)
        for cancel in queryTimers.values { cancel() }
        queryTimers.removeAll()
        (forwardQueue, targetQueue) = ([], [])
    }

    /// One DNS query from the tunnel; `reply` gets the DNS answer bytes.
    public func query(_ payload: [UInt8], reply: @escaping ([UInt8]) -> Void) {
        let now = io.now()
        let (decision, query, kind) = engine.classify(payload: payload, snapshot: snapshot, safeSearch: bundle.safeSearch, now: now)
        switch decision {
        case .drop:
            io.note(.outcome(nil, .dropped, startedAt: now))
        case .answer(let bytes):
            reply(bytes)
            let outcome: Outcome
            switch kind {
            case .blocked: outcome = .blocked
            case .safeSearchNoData: outcome = .safeSearchNoData
            case .canary: outcome = .canary
            case .cached, nil: outcome = .cacheHit
            }
            io.note(.outcome(query, outcome, startedAt: now))
        case .forward(let q):
            guard let permit = machine.forwardPermit else { return io.note(.outcome(q, .droppedUnconfirmed, startedAt: now)) }
            admit(Query(query: q, payload: payload, reply: reply, startedAt: now, generation: machine.generation, epoch: permit.epoch), target: false)
        case .rewrite(let q, let rule):
            guard let permit = machine.forwardPermit else {
                // Not forwarding: the compiled-in fallback.
                reply(engine.rewriteAnswer(q, rule: rule, resolved: []))
                return io.note(.outcome(q, .safeSearch(resolved: 0), startedAt: now))
            }
            if let hit = targets.addresses(for: rule.target, now: now) {
                reply(engine.rewriteAnswer(q, rule: rule, resolved: hit))
                return io.note(.outcome(q, .safeSearch(resolved: hit.count), startedAt: now))
            }
            admit(Query(query: q, payload: payload, reply: reply, startedAt: now, generation: machine.generation, epoch: permit.epoch, target: rule), target: true)
        }
    }

    // MARK: - Machine

    /// Callers that read query effects from the result (the query
    /// handlers) always run as their own queue job, never inside a feed.
    @discardableResult
    private func feed(_ event: TunnelRecovery.Event) -> [TunnelRecovery.Effect] {
        if feeding {
            // A bug: Debug traps. Release (and the test of this path) queues
            // it: never run inside the current event, never lost.
            if trapReentry { assertionFailure("events are fed one at a time") }
            io.enqueue { [self] in feed(event) }
            return []
        }
        feeding = true
        defer { feeding = false }
        let fx: [TunnelRecovery.Effect]
        if let observer {  // tests only: the machine is copied just then
            let before = machine
            fx = machine.handle(event, now: io.now())
            observer(event, fx, before, machine)
        } else {
            fx = machine.handle(event, now: io.now())
        }
        for f in fx { run(f) }
        let status = machine.statusText
        if status != lastStatus {
            lastStatus = status
            io.note(.status(status))
        }
        return fx
    }

    /// Runs one effect. storeAnswer, retryForward and replySafeSearch belong
    /// to one query: its handler reads them from the returned list.
    private func run(_ f: TunnelRecovery.Effect) {
        switch f {
        case .removeSettingsAndRead(let token, let wait):
            outstandingRemovals.insert(token)
            io.removeAndRead(wait) { [self] found in
                io.enqueue { [self] in
                    guard outstandingRemovals.remove(token) != nil else { return }  // answered once already
                    feed(found.map { .readFinished(token: token, found: $0) } ?? .reapplyFailed(token: token))
                }
            }
        case .startTimer(let id, let after):
            machineTimers[id] = io.startTimer(after) { [self] in
                io.enqueue { [self] in
                    guard machineTimers.removeValue(forKey: id) != nil else { return }  // cancelled meanwhile
                    feed(.timer(id))
                }
            }
        case .cancelTimer(let id):
            machineTimers.removeValue(forKey: id)?()
        case .clearAnswerCache: engine.cache.clear()
        case .clearTargets: targets.clear()
        case .rebuildSnapshot(let inputs):
            snapshotRequest += 1
            if !snapshotReady {
                snapshot = bundle.snapshot(inputs)
                snapshotReady = true
                io.note(.settingsLoaded)
                return
            }
            let (n, bundle, io) = (snapshotRequest, self.bundle, self.io)
            io.background {
                let built = bundle.snapshot(inputs)
                io.enqueue { [self] in
                    guard n == snapshotRequest else { return }  // a newer build was asked for
                    snapshot = built
                    engine.cache.clear()  // answers kept under the old snapshot
                    io.note(.settingsLoaded)
                }
            }
        case .readSettings: io.enqueue { [self] in reloadSettings() }  // its own event, after this one
        case .cancelTunnel(let reason): io.cancelTunnel(reason)
        case .log(let d): io.note(.diag(d))
        case .storeAnswer, .retryForward, .replySafeSearch: break
        }
    }

    // MARK: - Queries

    private func admit(_ q: Query, target: Bool) {
        let id = nextQuery
        nextQuery += 1
        queries[id] = q
        if (target ? targetsRunning : forwardsRunning) < (target ? Self.targetLimit : Self.forwardLimit) {
            if target { targetsRunning += 1 } else { forwardsRunning += 1 }
            send(id)
        } else if (target ? targetQueue.count : forwardQueue.count) < Self.queueLimit {
            if target { targetQueue.append(id) } else { forwardQueue.append(id) }
        } else {
            queries[id] = nil
            io.note(.outcome(q.query, .overloaded, startedAt: q.startedAt))
        }
    }

    /// A slot was freed: the next waiting query takes it, if its list is
    /// still the one in use.
    private func slotFreed(target: Bool) {
        while let id = target ? targetQueue.first : forwardQueue.first {
            if target { targetQueue.removeFirst() } else { forwardQueue.removeFirst() }
            guard let q = queries[id] else { continue }
            if machine.generation == q.generation, machine.forwardPermit != nil { return send(id) }
            drop(id)
        }
        if target { targetsRunning -= 1 } else { forwardsRunning -= 1 }
    }

    /// A waiting query whose network is gone (or forwarding is off):
    /// dropped (SafeSearch: the compiled-in fallback).
    private func drop(_ id: Int) {
        guard let q = queries.removeValue(forKey: id) else { return }
        if let rule = q.target {
            q.reply(engine.rewriteAnswer(q.query, rule: rule, resolved: []))
            io.note(.outcome(q.query, .safeSearch(resolved: 0), startedAt: q.startedAt))
        } else {
            io.note(.outcome(q.query, .droppedChangedWhileQueued, startedAt: q.startedAt))
        }
    }

    /// Sends (or resends) query `id` to the list in use, tagged with its
    /// epoch. Called only with a slot held.
    private func send(_ id: Int) {
        guard var q = queries[id], let permit = machine.forwardPermit else {
            let target = queries[id]?.target != nil
            drop(id)
            return slotFreed(target: target)
        }
        (q.epoch, q.sentAt) = (permit.epoch, io.now())
        queries[id] = q
        if let rule = q.target {
            io.resolveTarget(rule.target, permit.upstreams) { [self] addresses in
                io.enqueue { [self] in targetDone(id, addresses) }
            }
        } else {
            io.send(q.query, q.payload, permit.upstreams) { [self] result in
                io.enqueue { [self] in forwardDone(id, result) }
            }
        }
    }

    private func targetDone(_ id: Int, _ addresses: [[UInt8]]) {
        guard let q = queries.removeValue(forKey: id), let rule = q.target else { return }
        let fx = feed(.safeSearchFinished(id: id, epoch: q.epoch, addresses: addresses))
        var resolved: [[UInt8]] = []
        for case .replySafeSearch(id, let a, let store) in fx {
            resolved = a
            if store { targets.store(rule.target, a, now: io.now()) }
        }
        q.reply(engine.rewriteAnswer(q.query, rule: rule, resolved: resolved))
        io.note(.outcome(q.query, .safeSearch(resolved: resolved.count), startedAt: q.startedAt))
        slotFreed(target: true)
    }

    private func forwardDone(_ id: Int, _ result: (response: [UInt8], cacheable: Bool)?) {
        guard var q = queries[id] else { return }
        let now = io.now()
        if let result {
            queries[id] = nil
            let fx = feed(.forwardAnswered(query: id, epoch: q.epoch, sentAt: q.sentAt))
            if result.cacheable, fx.contains(.storeAnswer(query: id)) { engine.remember(q.query, result.response, now: now) }
            q.reply(result.response)
            let outcome = Outcome.forwarded(rcode: DnsMessage.rcode(result.response), retried: q.retried, rttMs: Int((now - q.sentAt) * 1000))
            io.note(.outcome(q.query, outcome, startedAt: q.startedAt))
            return slotFreed(target: false)
        }
        let fx = feed(.forwardFailed(query: id, epoch: q.epoch, sentAt: q.sentAt, wasRetry: q.retried))
        for case .retryForward(id, let after, let generation) in fx {
            // The slot is kept through the pause, as before.
            q.retried = true
            queries[id] = q
            queryTimers[id] = io.startTimer(after) { [self] in
                io.enqueue { [self] in
                    guard queryTimers.removeValue(forKey: id) != nil else { return }
                    if machine.generation == generation, machine.forwardPermit != nil { return send(id) }
                    finalFailure(id, timedOut: false)  // the network changed during the pause
                }
            }
            return
        }
        finalFailure(id, timedOut: now - q.sentAt >= upstreamTimeout * 0.9)
    }

    private func finalFailure(_ id: Int, timedOut: Bool) {
        guard let q = queries.removeValue(forKey: id) else { return }
        let outcome = Outcome.failed(retried: q.retried, timedOut: timedOut, sentBeforeChange: q.epoch != machine.epoch)
        io.note(.outcome(q.query, outcome, startedAt: q.startedAt))
        slotFreed(target: false)
    }
}
