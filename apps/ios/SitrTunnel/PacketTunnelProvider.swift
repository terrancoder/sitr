/// DEBUG-ONLY feasibility prototype: the Android DNS filter (SitrVpnService
/// + TunLoop + DnsForwarder) as an iOS packet tunnel. Only the two
/// synthetic resolver addresses are routed in; blocked names are answered
/// here, SafeSearch hosts get the vendor's "force safe" addresses, and every
/// other query is forwarded to the resolvers of the network the phone is
/// on. Apple documents this use as unsupported (TN3120); this target exists
/// to measure how well it works, and is never embedded in Release.
///
/// PRIVACY: never log, store or print a looked-up name. Diagnostics carry
/// counters, states, resolver addresses, timings and errors only, plus the
/// decision for ProbeNames (SitrCore/Dns/TunnelDiagnostics.swift).
import Network
import NetworkExtension
import SitrCore
import os

final class PacketTunnelProvider: NEPacketTunnelProvider {
    private let log = Logger(subsystem: "com.sitrshield.sitr.tunnel", category: "tunnel")
    private let engine = DnsEngine()
    private let resolver = UpstreamResolver(transport: PosixDnsTransport())
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

    private var monitor: NWPathMonitor?
    private var pathKey: String?
    private var pendingRediscovery: DispatchWorkItem?
    private var diagTimer: DispatchSourceTimer?
    private var rediscovering = false

    private static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    // MARK: - Lifecycle

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        diag.startedAt = Date()
        setState("starting")
        guard let dir = Bundle.main.url(forResource: "android", withExtension: nil) else {
            return fail("bundled lists missing", completionHandler)
        }
        switch BlocklistBundle.load(from: dir) {
        case .failure(let e):
            return fail("refusing to start: \(e.message)", completionHandler)
        case .success(let b):
            locked {
                bundle = b
                diag.listsLoaded = b.sets.keys.sorted()
                diag.listsSkipped = b.skipped
            }
            reloadSettings(reason: "start")
        }

        // Discovery 1: BEFORE the tunnel's DNS settings exist, the system
        // resolver configuration is still the physical network's.
        let found = discover(trigger: "start", method: "res_ninit before settings")
        guard !found.isEmpty else {
            return fail("no network resolvers found at start", completionHandler)
        }

        Task {
            await apply(upstreams: found)
            do {
                try await setTunnelNetworkSettings(Self.settings())
            } catch {
                return fail("setTunnelNetworkSettings failed: \(error.localizedDescription)", completionHandler)
            }
            // Observation only: what res_ninit reports once our DNS is applied.
            _ = discover(trigger: "start", method: "res_ninit after settings (observation)")
            locked { forwarding = true }
            setState("running")
            observeSettingsChanges()
            startPathMonitor()
            startDiagTimer()
            readLoop()
            completionHandler(nil)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        monitor?.cancel()
        diagTimer?.cancel()
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
        setState("stopped (reason \(reason.rawValue))")
        flushDiagnostics()
        completionHandler()
    }

    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        reloadSettings(reason: "app message")
        completionHandler?(nil)
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
        s.mtu = 1500
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
            let ms = Int((Self.now - started) * 1000)
            locked { diag.probe(query.qname, qtype: query.qtype, decision: what, ms: ms) }
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
            guard locked({ forwarding }) else {
                count { $0.dropped += 1 }
                return probe(query, "dropped: resolvers unconfirmed")
            }
            Task {
                guard await forwardGate.enter() else {
                    count { $0.overloaded += 1 }
                    return probe(query, "dropped: overloaded")
                }
                let answer = await engine.forward(query, payload: datagram.payload, via: resolver, now: { Self.now })
                await forwardGate.leave()
                if let answer {
                    reply(answer)
                    count { $0.forwarded += 1 }
                    probe(query, "forward rcode \(DnsMessage.rcode(answer))")
                } else {
                    count { $0.failed += 1 }
                    probe(query, "forward failed")
                }
            }
        case .rewrite(let query, let rule):
            Task {
                guard await targetGate.enter() else {
                    count { $0.overloaded += 1 }
                    return probe(query, "dropped: overloaded")
                }
                let resolved = await targets.addresses(for: rule.target, via: resolver, now: Self.now)
                await targetGate.leave()
                reply(engine.rewriteAnswer(query, rule: rule, resolved: resolved))
                count { $0.rewritten += 1 }
                probe(query, "safesearch -> \(rule.target) (\(resolved.isEmpty ? "fallback" : "\(resolved.count) resolved"))")
            }
        }
    }

    // MARK: - Settings

    private func reloadSettings(reason: String) {
        let settings = TunnelSettings(defaults: UserDefaults(suiteName: "group.com.sitrshield.sitr") ?? .standard)
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

    /// Reads the system resolvers, records the attempt, returns the usable ones.
    private func discover(trigger: String, method: String) -> [String] {
        let t0 = Self.now
        let raw = SystemResolvers.read()
        let usable = SystemResolvers.usable(raw)
        let attempt = TunnelDiagnostics.Discovery(
            at: Date(), trigger: trigger, method: method, raw: raw, usable: usable, ms: Int((Self.now - t0) * 1000))
        locked {
            diag.record(attempt)
            dirty = true
        }
        log.info("discovery \(trigger, privacy: .public)/\(method, privacy: .public): raw \(raw, privacy: .public) usable \(usable, privacy: .public)")
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

    /// Re-discovers only when the physical interface set changes (applying
    /// our own settings also fires path updates; utun/other are ignored),
    /// debounced by 1 s.
    private func startPathMonitor() {
        let m = NWPathMonitor(prohibitedInterfaceTypes: [.other])
        m.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let interfaces = path.availableInterfaces.filter { $0.type != .other }.map(\.name).sorted()
            let key = "\(path.status) \(interfaces) \(path.gateways.map { "\($0)" }.sorted())"
            guard key != self.pathKey else { return }
            let first = self.pathKey == nil
            self.pathKey = key
            if first { return }
            self.locked {
                self.forwarding = false
                self.diag.log("path changed: \(path.status) via \(interfaces)")
                self.dirty = true
            }
            self.pendingRediscovery?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                if path.status != .satisfied {
                    self.setState("no network")
                    return
                }
                Task { await self.rediscover() }
            }
            self.pendingRediscovery = work
            self.queue.asyncAfter(deadline: .now() + 1, execute: work)
        }
        m.start(queue: queue)
        monitor = m
    }

    /// The rule: after a network change, forward again only once the NEW
    /// network's resolvers are confirmed; if none can be found, cancel the
    /// tunnel with an error (VPN shows disconnected, last error says why).
    private func rediscover() async {
        guard !locked({ rediscovering }) else { return }
        locked { rediscovering = true }
        defer { locked { rediscovering = false } }
        setState("rediscovering")

        // 2a. Plain re-read with our settings in place.
        var found = discover(trigger: "path change", method: "res_ninit with tunnel settings")
        // 2b. Remove our settings briefly so the system shows the physical
        // network's resolvers, then put them back. Unfiltered window: the
        // time between the two calls (recorded in the event log).
        if found.isEmpty {
            let t0 = Self.now
            reasserting = true
            do {
                try await setTunnelNetworkSettings(nil)
                found = discover(trigger: "path change", method: "res_ninit with settings removed")
                try await setTunnelNetworkSettings(Self.settings())
            } catch {
                locked { diag.lastError = "re-apply settings failed: \(error.localizedDescription)" }
            }
            reasserting = false
            locked { diag.log("settings removed for \(Int((Self.now - t0) * 1000)) ms during rediscovery") }
        }
        guard !found.isEmpty else {
            let message = "no network resolvers found after network change"
            setState("failed: \(message)")
            locked { diag.lastError = message }
            flushDiagnostics()
            cancelTunnelWithError(NSError(domain: "SitrTunnel", code: 2, userInfo: [NSLocalizedDescriptionKey: message]))
            return
        }
        await apply(upstreams: found)
        locked { forwarding = true }
        setState("running")
    }

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
        log.info("state \(state, privacy: .public)")
        flushDiagnostics()
    }

    private func fail(_ message: String, _ completion: (Error?) -> Void) {
        locked { diag.lastError = message }
        setState("failed: \(message)")
        completion(NSError(domain: "SitrTunnel", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
    }

    private func startDiagTimer() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 2, repeating: 2)
        t.setEventHandler { [weak self] in self?.flushDiagnostics(onlyIfDirty: true) }
        t.resume()
        diagTimer = t
    }

    private func flushDiagnostics(onlyIfDirty: Bool = false) {
        let copy: TunnelDiagnostics? = locked {
            if onlyIfDirty && !dirty { return nil }
            dirty = false
            return diag
        }
        if let copy, let url = TunnelDiagnostics.url("tunnel.json") { copy.write(to: url) }
    }
}
