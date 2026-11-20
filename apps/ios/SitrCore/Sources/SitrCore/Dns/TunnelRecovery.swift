import Foundation

/// The DNS filter's recovery logic as one pure state machine: network
/// changes, resolver discovery, the unfiltered-window budget, give-up and
/// its capped retries, the stale re-read, forwarding on/off and when the
/// caches are cleared. `handle(event, now)` returns the effects to run, in
/// order; it reads no clock, starts nothing and never waits. `now` is the
/// system uptime (it stops during sleep, as do the provider's timers), so
/// every duration here counts awake time.
///
/// The tunnel feeds every event on its one serial queue and runs the
/// effects before the next event (TunnelRecoveryDriver). Anything that
/// finishes later (a read, a forward, a SafeSearch lookup, a timer) comes
/// back as an event tagged with the token, timer id or list epoch it was
/// started with; a tag the state no longer holds is never acted on as
/// current (the late-event rule).
///
/// Generation: +1 for every new network key. Epoch: +1 whenever the
/// upstream list may change (every new generation, and a stale re-read
/// that switches the list). Forwards and SafeSearch lookups are tagged
/// with the epoch, so an answer from a list no longer in use is never
/// stored, whatever network it belongs to.
///
/// Start-up is window-free only when the path was known before the start
/// read and did not change until `started` (the order the phone shows). A
/// first path update that arrives after `started` counts as a change (as
/// in the provider before this machine): the start read cannot be tied to
/// that network, for example during an on-demand restart in a Wi-Fi to
/// mobile hand-over.
///
/// Unfiltered windows: every `removeSettingsAndRead` removes the tunnel's
/// DNS settings for its read (lookups bypass the filter meanwhile). At most
/// `windowBudget` per `budgetPeriod`, whatever triggers them; a window is
/// recorded only when the removal is emitted, never reserved ahead. Only
/// one removal runs at a time, and each has a deadline: if neither result
/// arrives by then, the tunnel is cancelled (fail closed; on-demand starts
/// it again with its settings).
public struct TunnelRecovery: Sendable {
    // Behaviour the phone runs have shown (keep identical).
    public static let debounce: TimeInterval = 0.3
    public static let readWaits: [TimeInterval] = [0.1, 0.5, 1.5]
    public static let staleReadWait: TimeInterval = 0.5
    public static let retryReadWait: TimeInterval = 1.5
    public static let windowBudget = 3
    public static let budgetPeriod: TimeInterval = 60
    /// Delays before retry 1…5 after giving up on a network that stays
    /// connected (five more tries over 16 minutes); after the fifth fails it
    /// stays failed closed until the network changes. The first is 60 s
    /// because the three attempts just used the whole window budget; the
    /// budget still guards every retry.
    public static let retryDelays: [TimeInterval] = [60, 60, 120, 240, 480]
    /// Removal + read + two re-apply tries may take this long beyond the
    /// read wait before the tunnel is cancelled. The phone measured about
    /// 0.34 s to remove and 0.16 s to re-apply (whole windows 465–571 ms):
    /// 15 s is about 25 times that, so only a call that is stuck reaches it.
    public static let removalBound: TimeInterval = 15
    public static let settingsRetry: TimeInterval = 10

    public enum Event: Equatable, Sendable {
        case pathUpdate(key: String, satisfied: Bool)
        /// Start-up read the resolvers (before any settings were applied)
        /// on `readGeneration` (the value of `generation` read just before
        /// the read) and applied the tunnel's settings.
        case started(readGeneration: Int, found: [String])
        case timer(Int)
        /// The removal with this token finished: settings re-applied.
        case readFinished(token: Int, found: [String])
        /// The re-apply failed twice.
        case reapplyFailed(token: Int)
        /// Tags are those of the attempt that finished (a retry has its own):
        /// the epoch from `forwardPermit` when it was sent, and when.
        case forwardAnswered(query: Int, epoch: Int, sentAt: TimeInterval)
        case forwardFailed(query: Int, epoch: Int, sentAt: TimeInterval, wasRetry: Bool)
        case safeSearchFinished(id: Int, epoch: Int, addresses: [[UInt8]])
        /// The settings as read; not `readable` before the first unlock (the
        /// inputs are then the strict defaults, used only if nothing was
        /// ever read).
        case settingsRead(FilterInputs, readable: Bool)
        case stop
    }

    public enum Effect: Equatable, Sendable {
        /// Remove the settings, read the resolvers for up to `readWait`,
        /// re-apply (two tries); answer with readFinished or reapplyFailed.
        case removeSettingsAndRead(token: Int, readWait: TimeInterval)
        case startTimer(id: Int, after: TimeInterval)
        case cancelTimer(Int)
        case clearAnswerCache
        case clearTargets
        /// Put this answered query's reply in the answer cache.
        case storeAnswer(query: Int)
        /// Send the query again after `after` s if the network is still
        /// `generation` and forwarding is on then, to the list in use (a
        /// list switched meanwhile on the same network is used); the new
        /// attempt is tagged with that list's epoch.
        case retryForward(query: Int, after: TimeInterval, generation: Int)
        /// [] = the compiled-in fallback; `store` = keep in the targets cache.
        case replySafeSearch(id: Int, addresses: [[UInt8]], store: Bool)
        case rebuildSnapshot(FilterInputs)
        case readSettings
        case cancelTunnel(reason: String)
        case log(Diag)
    }

    /// Diagnostics only (the provider's DEBUG record).
    public enum Diag: Equatable, Sendable {
        case pathChange(satisfied: Bool)
        case resolved(upstreams: [String], forwardingOffFor: TimeInterval?)
        case firstAnswer(after: TimeInterval)
        case gaveUp
        case staleReRead(failures: Int)
        case staleAnswered(after: TimeInterval)
        case failure(sentBeforeChange: Bool)
    }

    public enum ReadKind: Equatable, Sendable {
        case attempt(Int)  // 0, 1, 2 after a change
        case retry(Int)  // 1…5 after giving up
    }

    /// Never empty.
    public struct Upstreams: Equatable, Sendable {
        public let list: [String]
        init?(_ list: [String]) {
            if list.isEmpty { return nil }
            self.list = list
        }
    }

    public enum Stale: Equatable, Sendable {
        /// The re-read may run when every forward keeps failing.
        case armed
        /// Ran; armed again by an answer to an attempt sent at or after this.
        case used(reappliedAt: TimeInterval)
        /// Running (forwarding goes on to the old list meanwhile).
        case reading(token: Int)
    }

    public enum Phase: Equatable, Sendable {
        case starting
        case noNetwork
        case debouncing(timer: Int)
        /// Wants to read: `timer` waits for the window budget; nil waits
        /// for an older removal still running.
        case pendingRead(ReadKind, timer: Int?)
        case reading(token: Int, ReadKind)
        case forwarding(Upstreams, Stale)
        /// `timer` nil: the five retries are used, failed closed until the
        /// network changes.
        case gaveUp(retriesDone: Int, timer: Int?)
        case stopped
    }

    struct Removal: Equatable, Sendable {
        let token: Int
        let deadline: Int
    }

    public private(set) var phase: Phase = .starting
    /// +1 for every new network key.
    public private(set) var generation = 0
    /// +1 whenever the upstream list may change (see the type's doc).
    public private(set) var epoch = 0
    private(set) var pathKey: String?
    private(set) var satisfied = false
    /// The removal still running (for this network or an older one).
    private(set) var inFlight: Removal?
    /// Start times of removals within the last `budgetPeriod`.
    private(set) var windows: [TimeInterval] = []
    /// Failures of the list in use, keyed by epoch.
    private var health = UpstreamHealth()
    /// An attempt was answered on this network (ForwardRetry: until then a
    /// timeout may be the link, not the resolver). Per generation, not per
    /// epoch: a stale re-read does not make the link new.
    private var answered = false
    private var resumedAt: TimeInterval?
    private var offSince: TimeInterval?
    private var inputs: FilterInputs?
    private(set) var settingsTimer: Int?
    /// Why the machine cancelled the tunnel, if it did.
    public private(set) var failure: String?
    private var nextId = 1
    private let upstreamTimeout: TimeInterval

    public init(upstreamTimeout: TimeInterval) { self.upstreamTimeout = upstreamTimeout }

    // MARK: - Queries (on the same queue as `handle`)

    /// Forward now, to these, tagging the attempt with this epoch.
    public var forwardPermit: (epoch: Int, upstreams: [String])? {
        if case .forwarding(let u, _) = phase { return (epoch, u.list) }
        return nil
    }

    /// This network's resolvers could not be read (the app's status byte).
    public var noResolver: Bool {
        switch phase {
        case .gaveUp, .pendingRead(.retry, _), .reading(_, .retry): return true
        default: return false
        }
    }

    public var statusText: String {
        switch phase {
        case .starting: return "starting"
        case .noNetwork: return "no network"
        case .debouncing, .pendingRead(.attempt, _), .reading(_, .attempt): return "rediscovering"
        case .forwarding(_, .reading): return "rediscovering (every forward failing)"
        case .forwarding: return "running"
        case .gaveUp, .pendingRead(.retry, _), .reading(_, .retry):
            return "no upstream: this network's DNS server could not be read"
        case .stopped: return failure.map { "failed: \($0)" } ?? "stopped"
        }
    }

    /// Whether a window may open now without waiting (reserves nothing).
    public func windowFreeNow(_ now: TimeInterval) -> Bool {
        windows.filter { $0 + Self.budgetPeriod > now }.count < Self.windowBudget
    }

    // MARK: - Transitions

    public mutating func handle(_ event: Event, now: TimeInterval) -> [Effect] {
        if phase == .stopped { return [] }
        var fx: [Effect] = []
        switch event {
        case .pathUpdate(let key, let sat): pathUpdate(key, sat, now, &fx)
        case .started(let g, let found): started(g, found, now, &fx)
        case .timer(let id): timer(id, now, &fx)
        case .readFinished(let token, let found): readFinished(token, found, now, &fx)
        case .reapplyFailed(let token):
            if inFlight?.token == token { stop("iOS did not restore the filter's DNS settings after a network change.", &fx) }
        case .forwardAnswered(let q, let e, let sentAt): answered(q, e, sentAt, now, &fx)
        case .forwardFailed(let q, let e, let sentAt, let wasRetry): failed(q, e, sentAt, wasRetry, now, &fx)
        case .safeSearchFinished(let id, let e, let addresses):
            if e == epoch, forwardPermit != nil {
                fx.append(.replySafeSearch(id: id, addresses: addresses, store: !addresses.isEmpty))
            } else {
                fx.append(.replySafeSearch(id: id, addresses: [], store: false))  // not the list in use
            }
        case .settingsRead(let read, let readable): settingsRead(read, readable, &fx)
        case .stop: stop(nil, &fx)
        }
        return fx
    }

    private mutating func pathUpdate(_ key: String, _ sat: Bool, _ now: TimeInterval, _ fx: inout [Effect]) {
        guard key != pathKey else { return }  // NetworkKey: not a real change
        if case .forwarding = phase { offSince = now }
        (pathKey, satisfied) = (key, sat)
        generation += 1
        epoch += 1
        answered = false
        resumedAt = nil
        leavePhase(&fx)
        fx += [.clearAnswerCache, .clearTargets]
        // Before `started` nothing was removed: no change record yet
        // (`started` opens one if a read will follow).
        if phase == .starting { return }  // `started` decides
        fx.append(.log(.pathChange(satisfied: sat)))
        if sat {
            let t = newId()
            phase = .debouncing(timer: t)
            fx.append(.startTimer(id: t, after: Self.debounce))
        } else {
            phase = .noNetwork
        }
    }

    private mutating func started(_ readGeneration: Int, _ found: [String], _ now: TimeInterval, _ fx: inout [Effect]) {
        guard phase == .starting else { return }
        // The start read is used whatever the path status says (as in the
        // provider before this machine): a later path update is a change
        // like any other.
        if let u = Upstreams(found), readGeneration == generation {
            phase = .forwarding(u, .armed)
            resumedAt = now
            fx.append(.log(.resolved(upstreams: u.list, forwardingOffFor: nil)))
        } else if pathKey != nil, satisfied {
            // A change during the start read, or nothing found: learn them
            // now, under the usual limits (a change record opens here).
            let t = newId()
            phase = .debouncing(timer: t)
            fx += [.log(.pathChange(satisfied: true)), .startTimer(id: t, after: Self.debounce)]
        } else {
            phase = .noNetwork
        }
    }

    private mutating func timer(_ id: Int, _ now: TimeInterval, _ fx: inout [Effect]) {
        if id == inFlight?.deadline {
            return stop("iOS did not finish changing the filter's DNS settings in time.", &fx)
        }
        if id == settingsTimer {
            settingsTimer = nil
            fx.append(.readSettings)
            return
        }
        switch phase {
        case .debouncing(id): tryRead(.attempt(0), now, &fx)
        case .pendingRead(let kind, id): tryRead(kind, now, &fx)
        case .gaveUp(let done, id): tryRead(.retry(done + 1), now, &fx)
        default: break  // not held: a timer of a phase already left
        }
    }

    private mutating func readFinished(_ token: Int, _ found: [String], _ now: TimeInterval, _ fx: inout [Effect]) {
        guard let removal = inFlight, removal.token == token else { return }
        inFlight = nil
        fx.append(.cancelTimer(removal.deadline))
        switch phase {
        case .reading(token, let kind):
            if let u = Upstreams(found) {
                phase = .forwarding(u, .armed)
                fx.append(.log(.resolved(upstreams: u.list, forwardingOffFor: offSince.map { now - $0 })))
                (resumedAt, offSince) = (now, nil)
                return
            }
            switch kind {
            case .attempt(let n) where n < Self.readWaits.count - 1: tryRead(.attempt(n + 1), now, &fx)
            case .attempt:
                fx.append(.log(.gaveUp))
                giveUp(retriesDone: 0, &fx)
            case .retry(let r): giveUp(retriesDone: r, &fx)
            }
        case .forwarding(let old, .reading(token)):
            var u = old
            if let new = Upstreams(found) {
                health.success()
                if Set(new.list) != Set(old.list) {
                    // Another list: answers and lookups still in flight to
                    // the old one carry the old epoch and are not stored.
                    epoch += 1
                    fx += [.clearAnswerCache, .clearTargets, .log(.resolved(upstreams: new.list, forwardingOffFor: nil))]
                }
                u = new  // the same resolvers in a new order: no clear
            }
            phase = .forwarding(u, .used(reappliedAt: now))
        case .pendingRead(let kind, nil):
            tryRead(kind, now, &fx)  // the older removal has returned
        default:
            break  // superseded by a network change: the list is not this network's
        }
    }

    private mutating func answered(_ q: Int, _ e: Int, _ sentAt: TimeInterval, _ now: TimeInterval, _ fx: inout [Effect]) {
        guard e == epoch, case .forwarding(let u, let stale) = phase else { return }  // reply only
        fx.append(.storeAnswer(query: q))
        health.success()
        if !answered {
            answered = true
            if let resumedAt { fx.append(.log(.firstAnswer(after: now - resumedAt))) }
        }
        if case .used(let at) = stale, sentAt >= at {
            phase = .forwarding(u, .armed)
            fx.append(.log(.staleAnswered(after: now - at)))
        }
    }

    private mutating func failed(_ q: Int, _ e: Int, _ sentAt: TimeInterval, _ wasRetry: Bool, _ now: TimeInterval, _ fx: inout [Effect]) {
        if !wasRetry,
            ForwardRetry.shouldRetry(
                sentGeneration: e, generation: epoch, forwarding: forwardPermit != nil,
                elapsed: now - sentAt, timeout: upstreamTimeout, answeredOnThisNetwork: answered)
        {
            fx.append(.retryForward(query: q, after: e == epoch ? 0.3 : 0, generation: generation))
            return
        }
        fx.append(.log(.failure(sentBeforeChange: e != epoch)))
        guard e == epoch else { return }  // says nothing about the list in use
        let stale = health.failure(generation: epoch, now: now)
        guard stale, case .forwarding(let u, .armed) = phase, inFlight == nil, windowFreeNow(now) else { return }
        // No re-read that waits for the budget: a later failure asks again.
        let token = startRemoval(readWait: Self.staleReadWait, now, &fx)
        phase = .forwarding(u, .reading(token: token))
        fx.append(.log(.staleReRead(failures: health.failures)))
    }

    private mutating func settingsRead(_ i: FilterInputs, _ readable: Bool, _ fx: inout [Effect]) {
        if readable {
            if let t = settingsTimer {
                fx.append(.cancelTimer(t))
                settingsTimer = nil
            }
        } else {
            if settingsTimer == nil {
                let t = newId()
                settingsTimer = t
                fx.append(.startTimer(id: t, after: Self.settingsRetry))
            }
            if inputs != nil { return }  // keep the last good settings; defaults only if none
        }
        guard i != inputs else { return }
        inputs = i
        fx += [.rebuildSnapshot(i), .clearAnswerCache]
    }

    // MARK: - Helpers

    private mutating func tryRead(_ kind: ReadKind, _ now: TimeInterval, _ fx: inout [Effect]) {
        if inFlight != nil {
            phase = .pendingRead(kind, timer: nil)
            return
        }
        // Same expression as the wait below, so a budget timer that fires at
        // `start + period` always finds that window expired.
        windows.removeAll { $0 + Self.budgetPeriod <= now }
        if windows.count >= Self.windowBudget {
            let t = newId()
            phase = .pendingRead(kind, timer: t)
            fx.append(.startTimer(id: t, after: windows[windows.count - Self.windowBudget] + Self.budgetPeriod - now))
            return
        }
        let wait: TimeInterval
        switch kind {
        case .attempt(let n): wait = Self.readWaits[n]
        case .retry: wait = Self.retryReadWait
        }
        let token = startRemoval(readWait: wait, now, &fx)
        phase = .reading(token: token, kind)
    }

    private mutating func startRemoval(readWait: TimeInterval, _ now: TimeInterval, _ fx: inout [Effect]) -> Int {
        windows.removeAll { $0 + Self.budgetPeriod <= now }
        windows.append(now)
        let removal = Removal(token: newId(), deadline: newId())
        inFlight = removal
        fx += [
            .removeSettingsAndRead(token: removal.token, readWait: readWait),
            .startTimer(id: removal.deadline, after: readWait + Self.removalBound),
        ]
        return removal.token
    }

    private mutating func giveUp(retriesDone r: Int, _ fx: inout [Effect]) {
        guard r < Self.retryDelays.count else {
            phase = .gaveUp(retriesDone: r, timer: nil)
            return
        }
        let t = newId()
        phase = .gaveUp(retriesDone: r, timer: t)
        fx.append(.startTimer(id: t, after: Self.retryDelays[r]))
    }

    /// Cancels the timer the current phase holds (the removal's deadline
    /// is the removal's, not the phase's: it stays until the removal ends).
    private mutating func leavePhase(_ fx: inout [Effect]) {
        switch phase {
        case .debouncing(let t), .pendingRead(_, .some(let t)), .gaveUp(_, .some(let t)): fx.append(.cancelTimer(t))
        default: break
        }
    }

    private mutating func stop(_ reason: String?, _ fx: inout [Effect]) {
        leavePhase(&fx)
        if let d = inFlight?.deadline { fx.append(.cancelTimer(d)) }
        if let s = settingsTimer { fx.append(.cancelTimer(s)) }
        (inFlight, settingsTimer) = (nil, nil)
        phase = .stopped
        if let reason {
            failure = reason
            fx.append(.cancelTunnel(reason: reason))
        }
    }

    private mutating func newId() -> Int {
        defer { nextId += 1 }
        return nextId
    }
}
