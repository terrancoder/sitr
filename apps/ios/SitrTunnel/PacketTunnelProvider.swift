/// The opt-in DNS filter: the Android DNS filter (SitrVpnService + TunLoop
/// + DnsForwarder) as an iOS packet tunnel. Only the two synthetic
/// resolver addresses are routed in; blocked names are answered here,
/// SafeSearch hosts (A/AAAA) get a CNAME to the vendor's safe host plus
/// that host's addresses (SVCB/HTTPS/ANY: no data), and every
/// other query is forwarded to the resolvers of the network the device is
/// on. Apple documents this use of a packet tunnel as unsupported
/// (TN3120); App Review 5.4 allows it for content-blocking apps.
///
/// PRIVACY: never log, store or print a looked-up name. RELEASE builds
/// write nothing to disk and log nothing: the diagnostics file, the probe
/// records and the os_log lines below exist only under #if DEBUG (device
/// testing). Diagnostics carry counters, states, resolver addresses,
/// timings and errors only, plus the decision for ProbeNames
/// (SitrCore/Dns/TunnelDiagnostics.swift). The app reads status through
/// NEVPNConnection (status, fetchLastDisconnectError), never a file.
import Network
import NetworkExtension
import SitrCore
import os

final class PacketTunnelProvider: NEPacketTunnelProvider {
    #if DEBUG
    private let log = Logger(subsystem: "com.sitrshield.sitr.tunnel", category: "tunnel")
    #endif
    private let engine = DnsEngine()
    private static let upstreamTimeout: TimeInterval = 2
    private let resolver = UpstreamResolver(transport: PosixDnsTransport(timeout: upstreamTimeout))
    private let targets = SafeSearchTargets()
    private let forwardGate = InFlightGate(limit: 32, queueLimit: 64)
    private let targetGate = InFlightGate(limit: 4, queueLimit: 64)
    private let queue = DispatchQueue(label: "sitr.tunnel")

    // Guarded by `lock`.
    private let lock = NSLock()
    private var bundle: BlocklistBundle?
    private var snapshot = DecisionSnapshot()
    private var safeSearch: SafeSearchMap?  // set with `bundle`
    /// False from a network change until resolvers are confirmed again:
    /// queries needing an upstream are DROPPED, never sent to the previous
    /// network's resolvers.
    private var forwarding = false
    private var diag = TunnelDiagnostics(writer: "tunnel")
    private var dirty = false

    /// Upstream round-trips (ms) in the open interval, capped.
    private var latencies: [Int] = []
    private var intervalPeak: UInt64 = 0
    private var currentPath: Network.NWPath?
    private var pathGeneration = 0
    /// The network change being recovered from, and since when forwarding is off.
    private var openChange: TunnelDiagnostics.PathChange?
    private var offSince: TimeInterval?
    private var rediscovering = false
    /// Attempt limits and the window budget (SitrCore ResolverRediscovery).
    private var discovery = ResolverRediscovery()
    /// Consecutive forward failures on this network (SitrCore UpstreamHealth).
    private var health = UpstreamHealth()
    /// Gave up on this network's resolvers: lookups that need one are
    /// dropped (fail closed) until the next real network change. Reported
    /// to the app through handleAppMessage.
    private var noResolver = false
    /// The path generation on which an upstream last answered, and when
    /// forwarding last resumed: until the first answer on a network, a
    /// timed-out forward is retried once (ForwardRetry).
    private var answeredGeneration: Int?
    private var resumedAt: TimeInterval?
    /// Stale re-read: .infinity once granted, the uptime its re-apply
    /// finished, nil after a forward sent since then was answered (which
    /// allows another one, ResolverRediscovery.answered).
    private var staleReappliedAt: TimeInterval?
    private var failedSinceStale = 0
    /// Diagnostics only (logged when the stale check fires): wall-clock
    /// start of the failure streak, last sleep and wake, wakes this run.
    private var streakStart: Date?
    private var lastSleep: Date?
    private var lastWake: Date?
    private var wakes = 0

    // Touched only on `queue`.
    private var monitor: NWPathMonitor?
    private var pathKey: String?
    private var pendingRediscovery: DispatchWorkItem?
    private var diagTimer: DispatchSourceTimer?
    /// stopTunnel ran: nothing may be started after it.
    private var stopped = false
    /// startTunnel finished: path changes now trigger rediscovery (before,
    /// start-up compares the network with its own snapshot).
    private var started = false
    private var startKeyWaiter: CheckedContinuation<String?, Never>?
    private var reloadRetryPending = false

    private static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    // MARK: - Lifecycle

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        locked {
            #if DEBUG
            // Append to the previous runs' record: reboot and on-demand
            // restarts must not erase their own evidence.
            if let url = TunnelDiagnostics.url("tunnel.json"), let previous = TunnelDiagnostics.read(from: url) { diag = previous }
            #endif
            diag.writer = "tunnel"
            diag.beginRun(at: Date())
        }
        sampleMemory("start")
        setState("starting")
        guard let dir = Bundle.main.url(forResource: "android", withExtension: nil) else {
            return fail("The filter's lists are missing. Reinstall Sitr.", completionHandler)
        }
        switch BlocklistBundle.load(from: dir) {
        case .failure(let e):
            locked { diag.log("lists refused: \(e.message)") }
            return fail("The filter's lists failed their integrity check. Reinstall Sitr.", completionHandler)
        case .success(let b):
            locked {
                bundle = b
                diag.listsLoaded = b.sets.keys.sorted()
                diag.listsSkipped = b.skipped
            }
            queue.sync { reloadSettingsOnQueue(reason: "start") }
        }
        sampleMemory("lists loaded")

        Task {
            // The network BEFORE discovery: a change while starting is
            // caught by comparing with this once start-up is done.
            let startKey = await firstPathKey()
            // BEFORE the tunnel's DNS settings exist, res_ninit still reports
            // the physical network's resolvers. Finding none (airplane mode,
            // no network yet) is NOT a start failure: the tunnel comes up,
            // drops what needs an upstream and keeps trying (rediscover).
            let found = discover(trigger: "start", method: "res_ninit before settings", read: SystemResolvers.read, filter: SystemResolvers.usable)
            await apply(upstreams: found)
            do {
                try await setTunnelNetworkSettings(Self.settings())
            } catch {
                return fail("iOS did not accept the filter's DNS settings (\(error.localizedDescription)).", completionHandler)
            }
            let proceed = queue.sync { () -> Bool in
                guard !stopped else { return false }
                started = true
                return true
            }
            guard proceed else {
                return completionHandler(NSError(domain: "SitrTunnel", code: 3, userInfo: [NSLocalizedDescriptionKey: "Stopped while starting."]))
            }
            locked {
                forwarding = !found.isEmpty
                resumedAt = Self.now
            }
            setState(found.isEmpty ? "running (no upstream yet)" : "running")
            observeSettingsChanges()
            #if DEBUG
            queue.async { if !self.stopped { self.startDiagTimer() } }
            #endif
            sampleMemory("settings applied")
            readLoop()
            completionHandler(nil)
            // A network change during start-up, or no resolvers found at
            // start: learn them now, under the usual limits.
            queue.async { [weak self] in
                guard let self, !self.stopped, self.pathKey != startKey || found.isEmpty else { return }
                self.networkChanged()
            }
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        queue.sync {
            stopped = true
            monitor?.cancel()
            monitor = nil
            diagTimer?.cancel()
            diagTimer = nil
            pendingRediscovery?.cancel()
            startKeyWaiter?.resume(returning: nil)
            startKeyWaiter = nil
        }
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
        let name = Self.describe(reason)
        locked {
            diag.closeInterval(at: Date(), latencies: latencies, peakFootprint: intervalPeak)
            diag.endRun(at: Date(), reason: name)
        }
        setState("stopped (\(name))")
        completionHandler()
    }

    /// Only remembered for the stale-check event; no event per sleep/wake.
    override func sleep(completionHandler: @escaping () -> Void) {
        locked { lastSleep = Date() }
        completionHandler()
    }

    override func wake() {
        locked { (lastWake, wakes) = (Date(), wakes + 1) }
    }

    static func describe(_ reason: NEProviderStopReason) -> String {
        switch reason {
        case .none: return "none"
        case .userInitiated: return "userInitiated"
        case .providerFailed: return "providerFailed"
        case .noNetworkAvailable: return "noNetworkAvailable"
        case .unrecoverableNetworkChange: return "unrecoverableNetworkChange"
        case .providerDisabled: return "providerDisabled"
        case .authenticationCanceled: return "authenticationCanceled"
        case .configurationFailed: return "configurationFailed"
        case .idleTimeout: return "idleTimeout"
        case .configurationDisabled: return "configurationDisabled"
        case .configurationRemoved: return "configurationRemoved"
        case .superceded: return "superceded (another VPN)"
        case .userLogout: return "userLogout"
        case .userSwitch: return "userSwitch"
        case .connectionFailed: return "connectionFailed"
        case .sleep: return "sleep"
        case .appUpdate: return "appUpdate"
        case .internalError: return "internalError"
        @unknown default: return "unknown \(reason.rawValue)"
        }
    }

    /// The app's status query: one byte, 1 = this network's resolvers could
    /// not be read (lookups that need one are dropped), 0 = otherwise.
    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        completionHandler?(Data([locked { noResolver } ? 1 : 0]))
    }

    /// Only the synthetic resolvers are routed; their addresses are the DNS
    /// servers and the default resolver for every domain (matchDomains [""],
    /// without which a split tunnel's DNS is not the default resolver).
    static func settings() -> NEPacketTunnelNetworkSettings {
        let s = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: DnsTunnel.resolverV4)
        let v4 = NEIPv4Settings(addresses: [DnsTunnel.tunnelV4], subnetMasks: ["255.255.255.255"])
        v4.includedRoutes = [NEIPv4Route(destinationAddress: DnsTunnel.resolverV4, subnetMask: "255.255.255.255")]
        s.ipv4Settings = v4
        let v6 = NEIPv6Settings(addresses: [DnsTunnel.tunnelV6], networkPrefixLengths: [128])
        v6.includedRoutes = [NEIPv6Route(destinationAddress: DnsTunnel.resolverV6, networkPrefixLength: 128)]
        s.ipv6Settings = v6
        let dns = NEDNSSettings(servers: [DnsTunnel.resolverV4, DnsTunnel.resolverV6])
        dns.matchDomains = [""]
        s.dnsSettings = dns
        s.mtu = NSNumber(value: DnsTunnel.mtu)
        return s
    }

    // MARK: - Packets

    private func readLoop() {
        packetFlow.readPackets { [weak self] packets, _ in
            guard let self else { return }
            for packet in packets { self.handle([UInt8](packet)) }
            self.readLoop()
        }
    }

    private func write(_ bytes: [UInt8]) {
        let family = IpPacket.ipVersion(bytes) == 6 ? AF_INET6 : AF_INET
        packetFlow.writePackets([Data(bytes)], withProtocols: [NSNumber(value: family)])
    }

    private func handle(_ packet: [UInt8]) {
        guard let datagram = IpPacket.parseUdp(packet) else {
            if let rst = TcpReset.buildRstFor(packet) {
                write(rst)
                count { $0.tcpReset += 1 }
            } else {
                count { $0.dropped += 1 }
            }
            return
        }
        guard datagram.dstPort == 53 else { return count { $0.dropped += 1 } }
        let started = Self.now
        let (snap, loadedMap) = locked { (snapshot, safeSearch) }
        guard let map = loadedMap else { return count { $0.dropped += 1 } }
        let decision = engine.decide(payload: datagram.payload, snapshot: snap, safeSearch: map, now: started)
        count { $0.seen += 1 }
        func reply(_ bytes: [UInt8]) { write(IpPacket.buildUdpReply(datagram, payload: bytes)) }
        func probe(_ query: DnsQuery, _ what: String) {
            #if DEBUG
            let ms = Int((Self.now - started) * 1000)
            locked { diag.probe(query.qname, qtype: query.qtype, decision: what, ms: ms) }
            #endif
        }

        switch decision {
        case .drop:
            count { $0.dropped += 1 }
        case .answer(let bytes):
            reply(bytes)
            guard let query = DnsMessage.parseQuery(datagram.payload) else { return }
            switch NameAction.of(query.qname, snapshot: snap, safeSearch: map) {
            case .block:
                count { $0.blocked += 1 }
                probe(query, "block")
            case .rewrite:
                count { $0.rewritten += 1 }
                probe(query, "safesearch nodata")
            case .forward:
                count { $0.cacheHits += 1 }
                probe(query, "cache")
            }
        case .forward(let query):
            guard let decidedGeneration = locked({ forwarding ? pathGeneration : nil }) else {
                locked {
                    diag.counters.dropped += 1
                    openChange?.droppedWhileOff += 1
                    dirty = true
                }
                return probe(query, "dropped: resolvers unconfirmed")
            }
            Task {
                guard await forwardGate.enter() else {
                    count { $0.overloaded += 1 }
                    return probe(query, "dropped: overloaded")
                }
                // Re-checked after the wait for a slot: the network may have
                // changed meanwhile, and its resolvers are not the old ones.
                guard locked({ forwarding && pathGeneration == decidedGeneration }) else {
                    await forwardGate.leave()
                    count { $0.dropped += 1 }
                    return probe(query, "dropped: network changed while queued")
                }
                let (sent, sentGeneration) = (Self.now, decidedGeneration)
                var attemptStart = sent
                var answer = await engine.forward(query, payload: datagram.payload, via: resolver, now: { Self.now })
                let rtt = Int((Self.now - sent) * 1000)
                var retried = false
                if answer == nil {
                    let (retry, changed) = locked { () -> (Bool, Bool) in
                        let retry = ForwardRetry.shouldRetry(
                            sentGeneration: sentGeneration, generation: pathGeneration, forwarding: forwarding,
                            elapsed: Self.now - sent, timeout: Self.upstreamTimeout,
                            answeredOnThisNetwork: answeredGeneration == pathGeneration)
                        return (retry, sentGeneration != pathGeneration)
                    }
                    if retry {
                        let retryGeneration = locked { pathGeneration }
                        if !changed { try? await Task.sleep(nanoseconds: 300_000_000) }
                        // The network may have changed during the sleep: never
                        // retry to resolvers that are not the current network's.
                        if locked({ forwarding && pathGeneration == retryGeneration }) {
                            retried = true
                            attemptStart = Self.now
                            answer = await engine.forward(query, payload: datagram.payload, via: resolver, now: { Self.now })
                        }
                    }
                }
                await forwardGate.leave()
                locked { if latencies.count < 5000 { latencies.append(rtt) } }
                if let answer {
                    locked {
                        health.success()
                        if sentGeneration == pathGeneration, answeredGeneration != pathGeneration {
                            answeredGeneration = pathGeneration
                            if let resumedAt { diag.recordFirstAnswer(ms: Int((Self.now - resumedAt) * 1000)) }
                        }
                        if sentGeneration == pathGeneration, let at = staleReappliedAt, sent >= at {
                            discovery.answered()
                            staleReappliedAt = nil
                            diag.log("first answer after stale re-read: \(Int((Self.now - at) * 1000)) ms after re-apply, \(failedSinceStale) failed between")
                        }
                    }
                    reply(answer)
                    count { $0.forwarded += 1 }
                    probe(query, "forward rcode \(DnsMessage.rcode(answer))\(retried ? " (retried)" : "")")
                } else {
                    // Timeout vs immediate send error, judged on the last try.
                    let timedOut = Self.now - attemptStart >= Self.upstreamTimeout * 0.9
                    var queryHash: Int?
                    #if DEBUG
                    var hasher = Hasher()  // per-run random seed: never a name, only "same lookup?"
                    hasher.combine(query.qname)
                    hasher.combine(query.qtype)
                    queryHash = hasher.finalize()
                    #endif
                    locked {
                        var open = openChange
                        diag.recordFailure(
                            sentBeforeChange: sentGeneration != pathGeneration, open: &open, timedOut: timedOut, queryHash: queryHash)
                        openChange = open
                        dirty = true
                    }
                    probe(query, "forward failed\(retried ? " (retried)" : "")")
                    staleCheck(generation: sentGeneration)
                }
            }
        case .rewrite(let query, let rule):
            Task {
                guard await targetGate.enter() else {
                    count { $0.overloaded += 1 }
                    return probe(query, "dropped: overloaded")
                }
                // Forwarding off: the resolver may still hold the previous
                // network's upstreams, so answer from the compiled-in fallback.
                let resolved = locked({ forwarding }) ? await targets.addresses(for: rule.target, via: resolver, now: Self.now) : []
                await targetGate.leave()
                reply(engine.rewriteAnswer(query, rule: rule, resolved: resolved))
                count { $0.rewritten += 1 }
                probe(query, "safesearch -> \(rule.target) (\(resolved.isEmpty ? "fallback" : "\(resolved.count) resolved"))")
            }
        }
    }

    // MARK: - Settings

    /// Rebuilds the snapshot from the App Group settings: at start and on the
    /// app's Darwin notification (every SettingsStore.persist: UI changes
    /// and household sync, foreground or background). Serialised on
    /// `queue`, so reloads apply in order. Until the first unlock after a
    /// reboot the settings cannot be read; the snapshot then holds the
    /// strict defaults (adult, gambling, dating) and ONE retry chain
    /// re-reads them every 10 s until they can be read.
    private func reloadSettings(reason: String) {
        queue.async { [weak self] in self?.reloadSettingsOnQueue(reason: reason) }
    }

    private func reloadSettingsOnQueue(reason: String) {
        let defaults = UserDefaults(suiteName: "group.com.sitrshield.sitr") ?? .standard
        if !tunnelSettingsReadable(defaults), !reloadRetryPending {
            reloadRetryPending = true
            queue.asyncAfter(deadline: .now() + 10) { [weak self] in
                guard let self, !self.stopped else { return }
                self.reloadRetryPending = false
                self.reloadSettingsOnQueue(reason: "retry: settings unreadable")
            }
        }
        let settings = TunnelSettings(defaults: defaults)
        locked {
            guard let bundle else { return }
            snapshot = bundle.snapshot(settings)
            safeSearch = bundle.safeSearch
            diag.log("settings loaded (\(reason))")
            dirty = true
        }
        engine.cache.clear()
    }

    private func observeSettingsChanges() {
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), observer,
            { _, observer, _, _, _ in
                guard let observer else { return }
                Unmanaged<PacketTunnelProvider>.fromOpaque(observer).takeUnretainedValue().reloadSettings(reason: "darwin notification")
            },
            tunnelSettingsChangedNotification as CFString, nil, .deliverImmediately)
    }

    // MARK: - Resolver discovery

    /// Reads resolvers with `read`, records the attempt, returns `filter`ed.
    private func discover(trigger: String, method: String, read: () -> [String], filter: ([String]) -> [String]) -> [String] {
        let t0 = Self.now
        let raw = read()
        let usable = filter(raw)
        let attempt = TunnelDiagnostics.Discovery(
            at: Date(), trigger: trigger, method: method, raw: raw, usable: usable, ms: Int((Self.now - t0) * 1000))
        locked {
            diag.record(attempt)
            dirty = true
        }
        #if DEBUG
        log.info("discovery \(trigger, privacy: .public)/\(method, privacy: .public): raw \(raw, privacy: .public) usable \(usable, privacy: .public)")
        #endif
        return usable
    }

    private func apply(upstreams: [String]) async {
        if await resolver.setUpstreams(upstreams) {
            engine.cache.clear()
            await targets.clear()
        }
        locked {
            diag.upstreams = upstreams
            dirty = true
        }
    }

    /// THE one place that learns a network's resolvers while the tunnel is
    /// up (kept isolated so a better method can replace it). Public API
    /// only: while our DNS settings are applied, res_ninit reports only our
    /// own server, so the settings are removed, res_ninit read, and the
    /// settings re-applied. Lookups in that window BYPASS the filter (the
    /// provider never sees them, so they cannot be held); its length is
    /// returned as `unfilteredMs`. Kept short: the settings object is built
    /// first, the read is a ~1 ms in-process call made the moment removal
    /// completes (re-read every 20 ms for up to `readWait` seconds if the
    /// system has not switched over yet), and the re-apply follows at once.
    /// How often this may run is ResolverRediscovery's decision.
    private func learnResolvers(readWait: TimeInterval) async -> (method: String, found: [String], unfilteredMs: Int?) {
        let ours = Self.settings()
        let t0 = Self.now
        var found: [String] = []
        var removedAt = t0
        var readMs = 0
        reasserting = true
        do {
            try await setTunnelNetworkSettings(nil)
            removedAt = Self.now
            while true {
                found = discover(trigger: "path change", method: "res_ninit with settings removed", read: SystemResolvers.read, filter: SystemResolvers.usable)
                if !found.isEmpty || Self.now - removedAt >= readWait { break }
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
            readMs = Int((Self.now - removedAt) * 1000)
        } catch {
            locked { diag.lastError = "remove settings failed: \(error.localizedDescription)" }
        }
        let reapplyAt = Self.now
        // Never forward without our DNS settings in place: two tries, then
        // stop with an error (on-demand restarts the tunnel with settings).
        var applied = false
        for _ in 0..<2 where !applied {
            do {
                try await setTunnelNetworkSettings(ours)
                applied = true
            } catch {
                locked { diag.lastError = "re-apply settings failed: \(error.localizedDescription)" }
            }
        }
        reasserting = false
        if !applied {
            setState("failed: settings could not be re-applied")
            cancelTunnelWithError(NSError(domain: "SitrTunnel", code: 2, userInfo: [NSLocalizedDescriptionKey: "iOS did not restore the filter's DNS settings after a network change."]))
            return ("settings re-apply failed", [], Int((Self.now - t0) * 1000))
        }
        // Upper bound: from asking for removal to the re-apply completing.
        let end = Self.now
        let ms = Int((end - t0) * 1000)
        locked {
            diag.log(
                "unfiltered window \(ms) ms (remove \(Int((removedAt - t0) * 1000)) + read \(readMs) + re-apply \(Int((end - reapplyAt) * 1000)))")
        }
        return ("remove/re-apply", found, ms)
    }

    /// The first path the monitor reports, or nil after 1 s. Starts the
    /// monitor (on `queue`, never after stopTunnel).
    private func firstPathKey() async -> String? {
        await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            queue.async { [self] in
                guard !stopped else { return c.resume(returning: nil) }
                startKeyWaiter = c
                startPathMonitor()
                queue.asyncAfter(deadline: .now() + 1) { [weak self] in
                    self?.startKeyWaiter?.resume(returning: nil)
                    self?.startKeyWaiter = nil
                }
            }
        }
    }

    /// Re-discovers only when the network really changed: status, the
    /// primary physical interface (name and type) or the gateways
    /// (SitrCore NetworkKey). The tunnel's own interface (utun = .other) is
    /// excluded by the monitor, so applying our settings cannot change the
    /// key; the window budget in ResolverRediscovery bounds any loop anyway.
    /// Debounced by 0.3 s, only to coalesce the burst of updates one change
    /// produces; the debounce adds to the dropped-lookup time, not to the
    /// unfiltered window.
    private func startPathMonitor() {
        let m = NWPathMonitor(prohibitedInterfaceTypes: [.other])
        m.pathUpdateHandler = { [weak self] path in self?.pathChanged(path) }
        m.start(queue: queue)
        monitor = m
    }

    private static func physical(_ path: Network.NWPath) -> [NWInterface] {
        var seen = Set<String>()  // one entry per interface (iOS lists en0 per address family)
        return path.availableInterfaces.filter { $0.type != .other && $0.type != .loopback && seen.insert($0.name).inserted }
    }

    private static func typeName(_ t: NWInterface.InterfaceType) -> String {
        switch t {
        case .wifi: return "wifi"
        case .cellular: return "cellular"
        case .wiredEthernet: return "wired"
        case .loopback: return "loopback"
        case .other: return "other"
        @unknown default: return "unknown"
        }
    }

    /// On `queue`.
    private func pathChanged(_ path: Network.NWPath) {
        let interfaces = Self.physical(path).map { (name: $0.name, type: Self.typeName($0.type)) }
        let key = NetworkKey.make(status: "\(path.status)", interfaces: interfaces, gateways: path.gateways.map { "\($0)" })
        guard key != pathKey else { return }
        pathKey = key
        locked {
            currentPath = path
            pathGeneration += 1
        }
        if let waiter = startKeyWaiter {
            startKeyWaiter = nil
            waiter.resume(returning: key)
        }
        guard started, !stopped else { return }
        networkChanged()
    }

    /// On `queue`: forwarding off until the current network's resolvers are
    /// learned; rediscovery after the debounce.
    private func networkChanged() {
        guard let path = locked({ currentPath }) else { return }
        let interfaces = Self.physical(path).map { "\($0.name) \(Self.typeName($0.type))" }
        let change = TunnelDiagnostics.PathChange(
            at: Date(), status: "\(path.status)", interfaces: interfaces, gateways: path.gateways.map { "\($0)" }.sorted())
        locked {
            if let open = openChange { diag.record(open) }  // superseded before it resolved
            forwarding = false
            noResolver = false
            staleReappliedAt = nil  // that re-read was for the previous network
            openChange = change
            offSince = offSince ?? Self.now
            diag.log("path: \(path.status) via \(interfaces)")
            dirty = true
        }
        pendingRediscovery?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.stopped else { return }
            if path.status != .satisfied {
                Task { await self.apply(upstreams: []) }
                if self.locked({ self.diag.state }) != "no network" { self.setState("no network") }
                return
            }
            Task { await self.rediscover() }
        }
        pendingRediscovery = work
        queue.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    /// One locked test-and-set: only one rediscovery runs at a time.
    private func beginRediscovery() -> Bool {
        locked {
            if rediscovering { return false }
            rediscovering = true
            return true
        }
    }

    /// Ends the running rediscovery only if no network change arrived since
    /// `generation`; otherwise the caller goes round again (a rediscover()
    /// started meanwhile returned at once, so nobody else would).
    private func endRediscovery(ifCurrent generation: Int) -> Bool {
        locked {
            guard generation == pathGeneration else { return false }
            rediscovering = false
            return true
        }
    }

    /// The rule: after a network change, forward again only once the NEW
    /// network's resolvers are found; until then queries needing an
    /// upstream are dropped (clients retry). At most three attempts per
    /// network, each with a longer read (ResolverRediscovery); after the
    /// third finds nothing the tunnel stops removing its settings, keeps
    /// dropping those queries (blocked and SafeSearch answers are still
    /// served) and reports "no resolver" to the app until the next real
    /// network change. The tunnel stays up, so on-demand never loops.
    private func rediscover() async {
        guard beginRediscovery() else { return }
        while true {
            let (generation, path, step) = locked { (pathGeneration, currentPath, discovery.next(generation: pathGeneration, now: Self.now)) }
            guard path?.status == .satisfied else {
                if endRediscovery(ifCurrent: generation) { return }
                continue
            }
            guard case .attempt(let readWait, let after) = step else {
                locked {
                    if generation == pathGeneration { noResolver = true }
                    diag.lastError = "no network resolvers found after \(ResolverRediscovery.readWaits.count) attempts"
                }
                setState("no upstream: this network's DNS server could not be read")
                if endRediscovery(ifCurrent: generation) { return }
                continue
            }
            setState("rediscovering")
            if after > 0 {
                try? await Task.sleep(nanoseconds: UInt64(after * 1_000_000_000))
                if locked({ generation != pathGeneration }) { continue }
            }
            let result = await learnResolvers(readWait: readWait)
            if result.method == "settings re-apply failed" {
                _ = endRediscovery(ifCurrent: locked { pathGeneration })
                return  // the tunnel is being cancelled
            }
            locked {
                let sofar = openChange?.unfilteredMs
                openChange?.unfilteredMs = Self.add(sofar, result.unfilteredMs)
            }
            guard !result.found.isEmpty else { continue }  // next attempt, or give up
            await apply(upstreams: result.found)
            let applied = locked { () -> Bool in
                guard generation == pathGeneration else { return false }  // moved on during apply
                if var change = openChange {
                    change.method = result.method
                    change.upstreams = result.found
                    change.forwardingOffMs = offSince.map { Int((Self.now - $0) * 1000) }
                    diag.record(change)
                }
                openChange = nil
                offSince = nil
                forwarding = true
                noResolver = false
                resumedAt = Self.now
                return true
            }
            guard applied else { continue }
            setState("running")
            if endRediscovery(ifCurrent: generation) { return }
        }
    }

    /// Every forward on this network keeps failing (UpstreamHealth): the
    /// resolver list is probably stale. One re-read (it costs a window),
    /// again on the same network only after a forward sent since the last
    /// re-read was answered, so a dead resolver gets one; if it finds
    /// nothing the old list is kept.
    private func staleCheck(generation: Int) {
        let delay = locked { () -> TimeInterval? in
            let stale = health.failure(generation: generation, now: Self.now)
            if health.failures == 1 { streakStart = Date() }
            failedSinceStale += 1
            guard stale, generation == pathGeneration, forwarding,
                  let delay = discovery.staleRetry(generation: generation, now: Self.now) else { return nil }
            staleReappliedAt = .infinity
            func at(_ d: Date?) -> String { d.map { "\($0)" } ?? "none" }
            diag.log(
                "every forward failing: \(health.failures) failures since \(at(streakStart)), last wake \(at(lastWake)), last sleep \(at(lastSleep)), \(wakes) wakes this run")
            return delay
        }
        guard let delay else { return }
        Task {
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard locked({ generation == pathGeneration }), beginRediscovery() else { return }
            setState("rediscovering (every forward failing)")
            let result = await learnResolvers(readWait: ResolverRediscovery.readWaits[1])
            if result.method == "settings re-apply failed" { return }
            locked { (staleReappliedAt, failedSinceStale) = (Self.now, 0) }
            if !result.found.isEmpty, locked({ generation == pathGeneration }) {
                await apply(upstreams: result.found)
                locked { health.success() }
            }
            setState("running")
            if !endRediscovery(ifCurrent: generation) {
                locked { rediscovering = false }
                await rediscover()  // the network changed meanwhile
            }
        }
    }

    private static func add(_ a: Int?, _ b: Int?) -> Int? { a == nil && b == nil ? nil : (a ?? 0) + (b ?? 0) }

    // MARK: - Diagnostics

    private func locked<T>(_ body: () -> T) -> T { lock.withLock(body) }

    private func count(_ change: (inout TunnelDiagnostics.Counters) -> Void) {
        locked {
            change(&diag.counters)
            dirty = true
        }
    }

    private func setState(_ state: String) {
        locked {
            diag.state = state
            diag.log("state: \(state)")
            dirty = true
        }
        #if DEBUG
        log.info("state \(state, privacy: .public)")
        #endif
        flushDiagnostics()
    }

    private func fail(_ message: String, _ completion: (Error?) -> Void) {
        locked { diag.lastError = message }
        setState("failed: \(message)")
        completion(NSError(domain: "SitrTunnel", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
    }

    private func sampleMemory(_ label: String) {
        let m = MemorySample.now()
        locked {
            diag.sample(m)
            intervalPeak = max(intervalPeak, m.footprintBytes)
            if !label.isEmpty {
                diag.log("memory (\(label)): footprint \(m.footprintBytes / 1024) KiB, available \(m.availableBytes.map { "\($0 / 1024) KiB" } ?? "n/a")")
            }
            dirty = true
        }
    }

    /// Every 30 s: memory sample and a write if anything changed; every
    /// `intervalSeconds`, an interval record (counts, latency, memory),
    /// which is also the heartbeat.
    private func startDiagTimer() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 30, repeating: 30)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            self.sampleMemory("")
            self.locked {
                let start = self.diag.intervalStart ?? Date()
                guard Date().timeIntervalSince(start) >= Double(TunnelDiagnostics.intervalSeconds) else { return }
                self.diag.closeInterval(at: Date(), latencies: self.latencies, peakFootprint: self.intervalPeak)
                self.latencies.removeAll(keepingCapacity: true)
                self.intervalPeak = 0
            }
            self.flushDiagnostics(onlyIfDirty: true)
        }
        t.resume()
        diagTimer = t
    }

    /// The only disk write in the provider, and DEBUG only.
    private func flushDiagnostics(onlyIfDirty: Bool = false) {
        #if DEBUG
        let copy: TunnelDiagnostics? = locked {
            if onlyIfDirty && !dirty { return nil }
            dirty = false
            return diag
        }
        if let copy, let url = TunnelDiagnostics.url("tunnel.json") { copy.write(to: url) }
        #endif
    }
}
