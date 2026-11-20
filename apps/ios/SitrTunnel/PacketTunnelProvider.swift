/// The opt-in DNS filter: the Android DNS filter (SitrVpnService + TunLoop
/// + DnsForwarder) as an iOS packet tunnel. Only the two synthetic
/// resolver addresses are routed in; blocked names are answered here,
/// SafeSearch hosts (A/AAAA) get a CNAME to the vendor's safe host plus
/// that host's addresses (SVCB/HTTPS/ANY: no data), and every
/// other query is forwarded to the resolvers of the network the device is
/// on. Apple documents this use of a packet tunnel as unsupported
/// (TN3120); App Review 5.4 allows it for content-blocking apps.
///
/// Every decision about network changes, resolver discovery, the
/// unfiltered-window budget, forwarding and the caches is SitrCore's
/// TunnelRecovery, run by TunnelRecoveryDriver; this class supplies the
/// I/O (packets, sockets, the system's tunnel settings, timers, the
/// settings file) and the DEBUG diagnostics, and decides nothing.
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

/// `@unchecked Sendable`: every stored property is read and written only on
/// `queue` (the NetworkExtension callbacks hop onto it with `queue.sync` or
/// `queue.async`; tasks hand their results back the same way).
final class PacketTunnelProvider: NEPacketTunnelProvider, @unchecked Sendable {
    #if DEBUG
    private let log = Logger(subsystem: "com.sitrshield.sitr.tunnel", category: "tunnel")
    #endif
    private static let upstreamTimeout: TimeInterval = 2
    private let resolver = UpstreamResolver(transport: PosixDnsTransport(timeout: upstreamTimeout))
    private let queue = DispatchQueue(label: "sitr.tunnel")
    /// DEBUG diagnostics writes, in order, off `queue`.
    private let diagWriter = DispatchQueue(label: "sitr.tunnel.diag")

    // Everything below: only on `queue`.
    private var driver: TunnelRecoveryDriver?
    private var diag = TunnelDiagnostics(writer: "tunnel")
    private var dirty = false
    /// Upstream round-trips (ms) of answered attempts in the open interval,
    /// capped (DEBUG only).
    private var latencies: [Int] = []
    private var intervalPeak: UInt64 = 0
    private var currentPath: Network.NWPath?
    /// The network change being recovered from (diagnostics only).
    private var openChange: TunnelDiagnostics.PathChange?
    private var lastSleep: Date?
    private var lastWake: Date?
    private var wakes = 0
    private var monitor: NWPathMonitor?
    private var pathKey: String?
    private var diagTimer: DispatchSourceTimer?
    /// stopTunnel ran: nothing may be started after it.
    private var stopped = false
    private var startKeyWaiter: CheckedContinuation<Void, Never>?

    private static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    // MARK: - Lifecycle

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        queue.sync {
            #if DEBUG
            // Append to the previous runs' record: reboot and on-demand
            // restarts must not erase their own evidence.
            if let url = TunnelDiagnostics.url("tunnel.json"), let previous = TunnelDiagnostics.read(from: url) { diag = previous }
            #endif
            diag.writer = "tunnel"
            diag.beginRun(at: Date())
            sampleMemory("start")
            setState("starting")
        }
        guard let dir = Bundle.main.url(forResource: "android", withExtension: nil) else {
            return fail("The filter's lists are missing. Reinstall Sitr.", completionHandler)
        }
        switch BlocklistBundle.load(from: dir) {
        case .failure(let e):
            queue.sync { diag.log("lists refused: \(e.message)") }
            return fail("The filter's lists failed their integrity check. Reinstall Sitr.", completionHandler)
        case .success(let b):
            queue.sync {
                diag.listsLoaded = b.sets.keys.sorted()
                diag.listsSkipped = b.skipped
                let d = TunnelRecoveryDriver(bundle: b, upstreamTimeout: Self.upstreamTimeout, io: makeIO())
                driver = d
                d.reloadSettings()
                sampleMemory("lists loaded")
            }
        }

        Task {
            // The first path (or nothing after 1 s), then the generation the
            // start read belongs to: the machine compares it at `started`.
            await waitForFirstPath()
            let readGeneration = queue.sync { driver?.generation ?? 0 }
            // BEFORE the tunnel's DNS settings exist, res_ninit still reports
            // the physical network's resolvers. Finding none (airplane mode,
            // no network yet) is NOT a start failure: the tunnel comes up,
            // drops what needs an upstream and learns them later.
            let found = discover(trigger: "start", method: "res_ninit before settings", read: SystemResolvers.read, filter: SystemResolvers.usable)
            do {
                try await setTunnelNetworkSettings(Self.settings())
            } catch {
                return fail("iOS did not accept the filter's DNS settings (\(error.localizedDescription)).", completionHandler)
            }
            let proceed = queue.sync { () -> Bool in
                guard !stopped, let driver else { return false }
                diag.upstreams = found
                driver.started(readGeneration: readGeneration, found: found)
                observeSettingsChanges()
                #if DEBUG
                startDiagTimer()
                #endif
                sampleMemory("settings applied")
                return true
            }
            guard proceed else {
                return completionHandler(NSError(domain: "SitrTunnel", code: 3, userInfo: [NSLocalizedDescriptionKey: "Stopped while starting."]))
            }
            readLoop()
            completionHandler(nil)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        let name = Self.describe(reason)
        queue.sync {
            stopped = true
            monitor?.cancel()
            monitor = nil
            diagTimer?.cancel()
            diagTimer = nil
            driver?.stop()
            startKeyWaiter?.resume()
            startKeyWaiter = nil
            diag.closeInterval(at: Date(), latencies: latencies, peakFootprint: intervalPeak)
            diag.endRun(at: Date(), reason: name)
            setState("stopped (\(name))")
        }
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
        completionHandler()
    }

    /// Only remembered for the stall log line; no event per sleep/wake (the
    /// machine's clock is the uptime, which stops during sleep).
    override func sleep(completionHandler: @escaping () -> Void) {
        queue.async { self.lastSleep = Date() }
        completionHandler()
    }

    override func wake() {
        queue.async { (self.lastWake, self.wakes) = (Date(), self.wakes + 1) }
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
        completionHandler?(Data([queue.sync { driver?.noResolver ?? false } ? 1 : 0]))
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

    // MARK: - The driver's I/O

    private func makeIO() -> TunnelRecoveryDriver.IO {
        let resolver = self.resolver
        return TunnelRecoveryDriver.IO(
            enqueue: { [queue] work in queue.async(execute: work) },
            background: { work in DispatchQueue.global(qos: .utility).async(execute: work) },
            now: { Self.now },
            removeAndRead: { [weak self] wait, done in
                guard let self else { return }
                Task {
                    let r = await self.learnResolvers(readWait: wait)
                    done(r.applied ? r.found : nil)
                }
            },
            startTimer: { [queue] after, fire in
                let item = DispatchWorkItem(block: fire)
                queue.asyncAfter(deadline: .now() + after, execute: item)
                return { item.cancel() }
            },
            send: { query, payload, upstreams, done in
                Task { done(await DnsEngine.fetch(query, payload: payload, via: resolver, to: upstreams)) }
            },
            resolveTarget: { target, upstreams, done in
                Task { done(await TargetCache.resolve(target, via: resolver, to: upstreams)) }
            },
            readSettings: {
                let defaults = UserDefaults(suiteName: "group.com.sitrshield.sitr") ?? .standard
                return (TunnelSettings(defaults: defaults), tunnelSettingsReadable(defaults))
            },
            cancelTunnel: { [weak self] reason in
                guard let self else { return }
                diag.lastError = reason
                // Off `queue`: NetworkExtension may call stopTunnel (which
                // does queue.sync) from inside this call.
                let error = NSError(domain: "SitrTunnel", code: 2, userInfo: [NSLocalizedDescriptionKey: reason])
                DispatchQueue.global().async { self.cancelTunnelWithError(error) }
            },
            note: { [weak self] note in self?.record(note) })
    }

    // MARK: - Packets

    private func readLoop() {
        packetFlow.readPackets { [weak self] packets, _ in
            guard let self else { return }
            queue.async {
                for packet in packets { self.handle([UInt8](packet)) }
            }
            self.readLoop()
        }
    }

    private func write(_ bytes: [UInt8]) {
        let family = IpPacket.ipVersion(bytes) == 6 ? AF_INET6 : AF_INET
        packetFlow.writePackets([Data(bytes)], withProtocols: [NSNumber(value: family)])
    }

    /// On `queue`.
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
        guard datagram.dstPort == 53, let driver else { return count { $0.dropped += 1 } }
        count { $0.seen += 1 }
        driver.query(datagram.payload) { [weak self] bytes in self?.write(IpPacket.buildUdpReply(datagram, payload: bytes)) }
    }

    // MARK: - Settings

    /// The app posts this after every SettingsStore.persist (UI changes and
    /// household sync, foreground or background); reloads apply in order
    /// on `queue`, and one that changes nothing the snapshot reads keeps
    /// the cache (TunnelRecovery).
    private func observeSettingsChanges() {
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), observer,
            { _, observer, _, _, _ in
                guard let observer else { return }
                let provider = Unmanaged<PacketTunnelProvider>.fromOpaque(observer).takeUnretainedValue()
                provider.queue.async { provider.driver?.reloadSettings() }
            },
            tunnelSettingsChangedNotification as CFString, nil, .deliverImmediately)
    }

    // MARK: - Resolver discovery

    /// Reads resolvers with `read`, records the attempt, returns `filter`ed.
    /// Any thread.
    private func discover(trigger: String, method: String, read: () -> [String], filter: ([String]) -> [String]) -> [String] {
        let t0 = Self.now
        let raw = read()
        let usable = filter(raw)
        let attempt = TunnelDiagnostics.Discovery(
            at: Date(), trigger: trigger, method: method, raw: raw, usable: usable, ms: Int((Self.now - t0) * 1000))
        queue.async {
            self.diag.record(attempt)
            self.dirty = true
        }
        #if DEBUG
        log.info("discovery \(trigger, privacy: .public)/\(method, privacy: .public): raw \(raw, privacy: .public) usable \(usable, privacy: .public)")
        #endif
        return usable
    }

    /// THE one place that learns a network's resolvers while the tunnel is
    /// up (kept isolated so a better method can replace it). Public API
    /// only: while our DNS settings are applied, res_ninit reports only our
    /// own server, so the settings are removed, res_ninit read, and the
    /// settings re-applied. Lookups in that window BYPASS the filter (the
    /// provider never sees them, so they cannot be held). Kept short: the
    /// settings object is built first, the read is a ~1 ms in-process call
    /// made the moment removal completes (re-read every 20 ms for up to
    /// `readWait` seconds if the system has not switched over yet), and the
    /// re-apply follows at once. When and how often is TunnelRecovery's
    /// decision; a re-apply that fails twice is reported, and the machine
    /// cancels the tunnel (on-demand restarts it with its settings).
    private func learnResolvers(readWait: TimeInterval) async -> (found: [String], applied: Bool) {
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
            let message = "remove settings failed: \(error.localizedDescription)"
            queue.async { self.diag.lastError = message }
        }
        let reapplyAt = Self.now
        // Never forward without our DNS settings in place: two tries.
        var applied = false
        for _ in 0..<2 where !applied {
            do {
                try await setTunnelNetworkSettings(ours)
                applied = true
            } catch {
                let message = "re-apply settings failed: \(error.localizedDescription)"
                queue.async { self.diag.lastError = message }
            }
        }
        reasserting = false
        // Upper bound: from asking for removal to the re-apply completing.
        let end = Self.now
        let ms = Int((end - t0) * 1000)
        let (removeMs, reapplyMs) = (Int((removedAt - t0) * 1000), Int((end - reapplyAt) * 1000))
        queue.async {
            if var change = self.openChange {
                change.unfilteredMs = (change.unfilteredMs ?? 0) + ms
                self.openChange = change
            }
            self.diag.log("unfiltered window \(ms) ms (remove \(removeMs) + read \(readMs) + re-apply \(reapplyMs))")
            self.dirty = true
        }
        return (found, applied)
    }

    /// Starts the monitor (on `queue`, never after stopTunnel) and returns
    /// at its first path, or after 1 s.
    private func waitForFirstPath() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            queue.async { [self] in
                guard !stopped else { return c.resume() }
                startKeyWaiter = c
                startPathMonitor()
                queue.asyncAfter(deadline: .now() + 1) { [self] in
                    startKeyWaiter?.resume()
                    startKeyWaiter = nil
                }
            }
        }
    }

    /// The network key (SitrCore NetworkKey): status, the primary physical
    /// interface (name and type) and the gateways. The tunnel's own
    /// interface (utun = .other) is excluded by the monitor, so applying
    /// our settings cannot change the key.
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

    /// On `queue`: every update goes to the machine (it ignores an unchanged
    /// key, and before `started` it only records the network).
    private func pathChanged(_ path: Network.NWPath) {
        let interfaces = Self.physical(path).map { (name: $0.name, type: Self.typeName($0.type)) }
        let key = NetworkKey.make(status: "\(path.status)", interfaces: interfaces, gateways: path.gateways.map { "\($0)" })
        guard key != pathKey, !stopped else { return }
        pathKey = key
        currentPath = path
        if let waiter = startKeyWaiter {
            startKeyWaiter = nil
            waiter.resume()
        }
        driver?.pathUpdate(key: key, satisfied: path.status == .satisfied)
    }

    // MARK: - Diagnostics (on `queue`)

    private func record(_ note: TunnelRecoveryDriver.Note) {
        switch note {
        case .status(let s): setState(s)
        case .settingsLoaded:
            diag.log("settings loaded")
            dirty = true
        case .diag(let d): record(d)
        case .outcome(let query, let outcome, let startedAt): record(query, outcome, startedAt)
        }
    }

    private func record(_ d: TunnelRecovery.Diag) {
        switch d {
        case .pathChange:
            guard let path = currentPath else { return }
            let interfaces = Self.physical(path).map { "\($0.name) \(Self.typeName($0.type))" }
            if let open = openChange { diag.record(open) }  // superseded before it resolved
            openChange = TunnelDiagnostics.PathChange(
                at: Date(), status: "\(path.status)", interfaces: interfaces, gateways: path.gateways.map { "\($0)" }.sorted())
            diag.log("path: \(path.status) via \(interfaces)")
        case .resolved(let upstreams, let offFor):
            diag.upstreams = upstreams
            if var change = openChange {
                change.method = "remove/re-apply"
                change.upstreams = upstreams
                change.forwardingOffMs = offFor.map { Int($0 * 1000) }
                diag.record(change)
                openChange = nil
            }
        case .firstAnswer(let after): diag.recordFirstAnswer(ms: Int(after * 1000))
        case .gaveUp: diag.lastError = "no network resolvers found after \(TunnelRecovery.readWaits.count) attempts"
        case .staleReRead(let failures):
            func at(_ d: Date?) -> String { d.map { "\($0)" } ?? "none" }
            diag.log("every forward failing: \(failures) failures, last wake \(at(lastWake)), last sleep \(at(lastSleep)), \(wakes) wakes this run")
        case .staleAnswered(let after): diag.log("first answer after stale re-read: \(Int(after * 1000)) ms after re-apply")
        case .failure: break  // recorded with the query's outcome
        }
        dirty = true
    }

    private func record(_ query: DnsQuery?, _ outcome: TunnelRecoveryDriver.Outcome, _ startedAt: TimeInterval) {
        func probe(_ what: String) {
            #if DEBUG
            if let query { diag.probe(query.qname, qtype: query.qtype, decision: what, ms: Int((Self.now - startedAt) * 1000)) }
            #endif
        }
        switch outcome {
        case .dropped: count { $0.dropped += 1 }
        case .blocked:
            count { $0.blocked += 1 }
            probe("block")
        case .safeSearchNoData:
            count { $0.rewritten += 1 }
            probe("safesearch nodata")
        case .cacheHit:
            count { $0.cacheHits += 1 }
            probe("cache")
        case .canary:
            count { $0.cacheHits += 1 }  // where the record counted it before
            probe("doh canary nodata")
        case .droppedUnconfirmed:
            diag.counters.dropped += 1
            openChange?.droppedWhileOff += 1
            dirty = true
            probe("dropped: resolvers unconfirmed")
        case .overloaded:
            count { $0.overloaded += 1 }
            probe("dropped: overloaded")
        case .droppedChangedWhileQueued:
            count { $0.dropped += 1 }
            probe("dropped: network changed while queued")
        case .forwarded(let rcode, let retried, let rttMs):
            #if DEBUG
            if latencies.count < 5000 { latencies.append(rttMs) }
            #endif
            count { $0.forwarded += 1 }
            probe("forward rcode \(rcode)\(retried ? " (retried)" : "")")
        case .failed(let retried, let timedOut, let sentBeforeChange):
            var queryHash: Int?
            #if DEBUG
            if let query {
                var hasher = Hasher()  // per-run random seed: never a name, only "same lookup?"
                hasher.combine(query.qname)
                hasher.combine(query.qtype)
                queryHash = hasher.finalize()
            }
            #endif
            diag.recordFailure(sentBeforeChange: sentBeforeChange, open: &openChange, timedOut: timedOut, queryHash: queryHash)
            dirty = true
            probe("forward failed\(retried ? " (retried)" : "")")
        case .safeSearch(let resolved):
            count { $0.rewritten += 1 }
            probe("safesearch (\(resolved == 0 ? "fallback" : "\(resolved) resolved"))")
        }
    }

    private func count(_ change: (inout TunnelDiagnostics.Counters) -> Void) {
        change(&diag.counters)
        dirty = true
    }

    private func setState(_ state: String) {
        diag.state = state
        diag.log("state: \(state)")
        dirty = true
        #if DEBUG
        log.info("state \(state, privacy: .public)")
        #endif
        flushDiagnostics()
    }

    /// Any thread.
    private func fail(_ message: String, _ completion: (Error?) -> Void) {
        queue.sync {
            diag.lastError = message
            setState("failed: \(message)")
        }
        completion(NSError(domain: "SitrTunnel", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
    }

    private func sampleMemory(_ label: String) {
        let m = MemorySample.now()
        diag.sample(m)
        intervalPeak = max(intervalPeak, m.footprintBytes)
        if !label.isEmpty {
            diag.log("memory (\(label)): footprint \(m.footprintBytes / 1024) KiB, available \(m.availableBytes.map { "\($0 / 1024) KiB" } ?? "n/a")")
        }
        dirty = true
    }

    /// Every 30 s: memory sample and a write if anything changed; every
    /// `intervalSeconds`, an interval record (counts, latency, memory),
    /// which is also the heartbeat.
    private func startDiagTimer() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 30, repeating: 30)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            sampleMemory("")
            let start = diag.intervalStart ?? Date()
            if Date().timeIntervalSince(start) >= Double(TunnelDiagnostics.intervalSeconds) {
                diag.closeInterval(at: Date(), latencies: latencies, peakFootprint: intervalPeak)
                latencies.removeAll(keepingCapacity: true)
                intervalPeak = 0
            }
            flushDiagnostics(onlyIfDirty: true)
        }
        t.resume()
        diagTimer = t
    }

    /// The only disk write in the provider, and DEBUG only: a copy taken on
    /// `queue`, written in order on `diagWriter`.
    private func flushDiagnostics(onlyIfDirty: Bool = false) {
        #if DEBUG
        if onlyIfDirty && !dirty { return }
        dirty = false
        let copy = diag
        diagWriter.async { if let url = TunnelDiagnostics.url("tunnel.json") { copy.write(to: url) } }
        #endif
    }
}
