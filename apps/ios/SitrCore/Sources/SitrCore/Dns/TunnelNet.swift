/// Socket-level pieces of the DNS filter (packet tunnel) that do
/// not need NetworkExtension: resolver discovery, the POSIX upstream
/// transport, SafeSearch target resolution and the in-flight bound.
import CResolv
import Darwin
import Foundation

// MARK: - Resolver discovery

/// The system's current DNS servers. There is no supported iOS API for
/// "the network's resolvers"; libresolv's res_ninit is the closest, and
/// while the tunnel's DNS settings are applied it reports the tunnel's own
/// server (which `usable` removes). At most 3 servers (MAXNS).
public enum SystemResolvers {
    public static func read() -> [String] {
        let slot = Int(NI_MAXHOST)
        var buffer = [CChar](repeating: 0, count: slot * 8)
        let n = sitr_system_resolvers(&buffer, Int32(slot), 8)
        guard n > 0 else { return [] }
        return (0..<Int(n)).map { i in
            buffer.withUnsafeBufferPointer { String(cString: $0.baseAddress! + i * slot) }
        }
    }

    /// Drops the tunnel's own addresses and repeats, keeping order and any
    /// IPv6 %scope (link-local Wi-Fi resolvers are useless without it).
    public static func usable(_ raw: [String]) -> [String] {
        var seen = Set<String>()
        return raw.filter { !DnsTunnel.syntheticResolvers.contains($0) && seen.insert($0).inserted }
    }
}

// MARK: - Upstream transport

/// Connected sockets to the upstream resolver. The tunnel routes only the
/// two synthetic /32 and /128 addresses, so a socket to a real resolver
/// address leaves on the physical interface without any binding.
public struct PosixDnsTransport: DnsUpstreamTransport {
    let timeout: TimeInterval
    let port: String

    public init(timeout: TimeInterval = 2, port: UInt16 = 53) {
        self.timeout = timeout
        self.port = String(port)
    }

    public func udp(_ query: [UInt8], to upstream: String) async throws -> AsyncThrowingStream<[UInt8], Error> {
        let (fd, connectErrno) = try Self.connectedSocket(upstream, port, SOCK_DGRAM)
        guard connectErrno == 0, send(fd, query, query.count, 0) == query.count else {
            close(fd)
            throw SitrError("udp send failed: errno \(connectErrno == 0 ? errno : connectErrno)")
        }
        let timeout = self.timeout
        return AsyncThrowingStream { continuation in
            let queue = DispatchQueue(label: "sitr.dns.udp")
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setEventHandler {
                // One byte over the cap, so an oversized (cut) reply is seen as such.
                var buf = [UInt8](repeating: 0, count: UpstreamResolver.maxReplyBytes + 1)
                let n = recv(fd, &buf, buf.count, MSG_DONTWAIT)
                if n > 0 {
                    continuation.yield(Array(buf[0..<n]))
                } else if n < 0 && errno != EAGAIN && errno != EINTR {
                    source.cancel()  // e.g. ECONNREFUSED: unreachable
                }
            }
            source.setCancelHandler {
                close(fd)
                continuation.finish()
            }
            queue.asyncAfter(deadline: .now() + timeout) { source.cancel() }
            continuation.onTermination = { _ in queue.async { source.cancel() } }
            source.resume()
        }
    }

    public func tcp(_ query: [UInt8], to upstream: String) async throws -> [UInt8] {
        let (port, timeout) = (self.port, self.timeout)
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result { try Self.tcpExchange(query, upstream, port, timeout) })
            }
        }
    }

    /// Blocking RFC 7766 exchange with one deadline for the whole thing.
    static func tcpExchange(_ query: [UInt8], _ upstream: String, _ port: String, _ timeout: TimeInterval) throws -> [UInt8] {
        let (fd, connectErrno) = try connectedSocket(upstream, port, SOCK_STREAM)
        defer { close(fd) }
        let deadline = Date().addingTimeInterval(timeout)
        func wait(_ events: Int16) throws {
            var p = pollfd(fd: fd, events: events, revents: 0)
            let ms = Int32(max(0, deadline.timeIntervalSinceNow * 1000))
            guard ms > 0, poll(&p, 1, ms) == 1 else { throw SitrError("tcp timeout") }
        }
        if connectErrno != 0 {
            guard connectErrno == EINPROGRESS else { throw SitrError("tcp connect failed: errno \(connectErrno)") }
            try wait(Int16(POLLOUT))
            var err: Int32 = 0
            var len = socklen_t(MemoryLayout<Int32>.size)
            getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
            guard err == 0 else { throw SitrError("tcp connect failed: errno \(err)") }
        }
        var out = [UInt8(query.count >> 8 & 0xff), UInt8(query.count & 0xff)] + query
        while !out.isEmpty {
            try wait(Int16(POLLOUT))
            let n = send(fd, out, out.count, 0)
            guard n > 0 else { throw SitrError("tcp send failed") }
            out.removeFirst(n)
        }
        func read(_ count: Int) throws -> [UInt8] {
            var got: [UInt8] = []
            var buf = [UInt8](repeating: 0, count: count)
            while got.count < count {
                try wait(Int16(POLLIN))
                let n = recv(fd, &buf, count - got.count, 0)
                guard n > 0 else { throw SitrError("tcp closed early") }
                got += buf[0..<n]
            }
            return got
        }
        let header = try read(2)
        return try read(Int(header[0]) << 8 | Int(header[1]))
    }

    /// A socket of `type` connected to the numeric `host` (IPv6 %scope
    /// honoured) and connect's errno (0 on success). TCP sockets are
    /// non-blocking, so their connect reports EINPROGRESS.
    static func connectedSocket(_ host: String, _ port: String, _ type: Int32) throws -> (fd: Int32, connectErrno: Int32) {
        var hints = addrinfo()
        hints.ai_flags = AI_NUMERICHOST | AI_NUMERICSERV
        hints.ai_socktype = type
        var info: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, port, &hints, &info) == 0, let ai = info else {
            throw SitrError("not a numeric address")
        }
        defer { freeaddrinfo(info) }
        let fd = Darwin.socket(ai.pointee.ai_family, type, 0)
        guard fd >= 0 else { throw SitrError("socket failed: errno \(errno)") }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        if type == SOCK_STREAM { _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) }
        let rc = Darwin.connect(fd, ai.pointee.ai_addr, ai.pointee.ai_addrlen)
        return (fd, rc == 0 ? 0 : errno)
    }
}

// MARK: - SafeSearch targets

extension DnsMessage {
    /// A standard recursive query for one name.
    public static func buildQuery(id: UInt16, name: String, qtype: Int) -> [UInt8] {
        var q: [UInt8] = [UInt8(id >> 8), UInt8(id & 0xff), 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]
        q += encodeName(name)
        q += [UInt8(qtype >> 8), UInt8(qtype & 0xff), 0, UInt8(classIN)]
        return q
    }

    /// The A (4-byte) and AAAA (16-byte) rdata of every answer record, in
    /// order; [] for anything unparseable. Compression pointers are skipped,
    /// never followed.
    public static func addresses(in reply: [UInt8]) -> [[UInt8]] {
        if reply.count < 12 { return [] }
        var p = 12
        func skipName() -> Bool {
            while p < reply.count {
                let len = Int(reply[p])
                if len == 0 { p += 1; return true }
                if len & 0xc0 == 0xc0 { p += 2; return p <= reply.count }
                p += 1 + len
            }
            return false
        }
        for _ in 0..<u16(reply, 4) {
            if !skipName() || p + 4 > reply.count { return [] }
            p += 4
        }
        var out: [[UInt8]] = []
        for _ in 0..<u16(reply, 6) {
            if !skipName() || p + 10 > reply.count { return out }
            let type = u16(reply, p)
            let length = u16(reply, p + 8)
            p += 10
            if p + length > reply.count { return out }
            if (type == typeA && length == 4) || (type == typeAAAA && length == 16) {
                out.append(Array(reply[p..<(p + length)]))
            }
            p += length
        }
        return out
    }
}

/// SafeSearch target addresses (A and AAAA) resolved through the
/// network's own resolvers — outside the tunnel, never via getaddrinfo,
/// whose system resolver IS this tunnel — kept for 5 minutes when non-empty
/// (Android DnsForwarder.targetCache). A plain value used on the tunnel's
/// serial queue (TunnelRecoveryDriver): the recovery machine says when a
/// result may be stored and when the cache is cleared.
public struct TargetCache: Sendable {
    public static let lifetime: TimeInterval = 300
    private var entries: [String: (addresses: [[UInt8]], expiresAt: TimeInterval)] = [:]

    public init() {}

    public func addresses(for target: String, now: TimeInterval) -> [[UInt8]]? {
        guard let hit = entries[target], hit.expiresAt > now else { return nil }
        return hit.addresses
    }

    public mutating func store(_ target: String, _ addresses: [[UInt8]], now: TimeInterval) {
        if !addresses.isEmpty { entries[target] = (addresses, now + Self.lifetime) }
    }

    public mutating func clear() { entries.removeAll() }

    /// Both families of `target` through `upstreams`; caches nothing.
    public static func resolve(_ target: String, via resolver: UpstreamResolver, to upstreams: [String]) async -> [[UInt8]] {
        async let v4 = lookup(target, DnsMessage.typeA, resolver, upstreams)
        async let v6 = lookup(target, DnsMessage.typeAAAA, resolver, upstreams)
        return await v4 + v6
    }

    static func lookup(_ name: String, _ qtype: Int, _ resolver: UpstreamResolver, _ upstreams: [String]) async -> [[UInt8]] {
        let query = DnsMessage.buildQuery(id: .random(in: 0...UInt16.max), name: name, qtype: qtype)
        let question = Array(query[12...])
        guard let reply = await resolver.forward(query, accept: { DnsMessage.isReplyTo(query, question: question, reply: $0) }, to: upstreams)
        else { return [] }
        return DnsMessage.addresses(in: reply)
    }
}

/// The old actor (its tests; TargetCache replaces it in the tunnel):
/// resolves through the list `UpstreamResolver.setUpstreams` holds and
/// caches non-empty results for 5 minutes.
actor SafeSearchTargets {
    public static let lifetime: TimeInterval = 300
    private var cache: [String: (addresses: [[UInt8]], expiresAt: TimeInterval)] = [:]

    public init() {}

    public func addresses(for target: String, via resolver: UpstreamResolver, now: TimeInterval) async -> [[UInt8]] {
        if let hit = cache[target], hit.expiresAt > now { return hit.addresses }
        async let v4 = Self.lookup(target, DnsMessage.typeA, resolver)
        async let v6 = Self.lookup(target, DnsMessage.typeAAAA, resolver)
        let all = await v4 + v6
        if !all.isEmpty { cache[target] = (all, now + Self.lifetime) }
        return all
    }

    public func clear() { cache.removeAll() }

    static func lookup(_ name: String, _ qtype: Int, _ resolver: UpstreamResolver) async -> [[UInt8]] {
        let query = DnsMessage.buildQuery(id: .random(in: 0...UInt16.max), name: name, qtype: qtype)
        let question = Array(query[12...])
        guard let reply = await resolver.forward(query, accept: { DnsMessage.isReplyTo(query, question: question, reply: $0) })
        else { return [] }
        return DnsMessage.addresses(in: reply)
    }
}

// MARK: - Concurrency bound

/// At most `limit` holders, `queueLimit` waiters; beyond that `enter`
/// returns false at once and the caller drops the query (Android: 32
/// forward workers + queue 64; 4 target workers).
public actor InFlightGate {
    private let limit: Int
    private let queueLimit: Int
    private var running = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init(limit: Int, queueLimit: Int) {
        self.limit = limit
        self.queueLimit = queueLimit
    }

    public func enter() async -> Bool {
        if running < limit {
            running += 1
            return true
        }
        if waiters.count >= queueLimit { return false }
        await withCheckedContinuation { waiters.append($0) }
        return true  // the slot was handed over by `leave`
    }

    public func leave() {
        if waiters.isEmpty {
            running -= 1
        } else {
            waiters.removeFirst().resume()
        }
    }
}

// MARK: - Forward retry

/// Whether a forward that got no answer is tried once more. Only while
/// forwarding is on (the current network's resolvers are known), and only
/// when the failure says nothing about the current upstream: the network
/// changed while the query was in flight (it went to the previous
/// network's resolver), or it failed fast (a send error, not a timeout),
/// e.g. the route not yet usable just after the settings were re-applied.
/// A timeout is also retried once while no upstream has answered at all on
/// this network yet: right after joining, the first packets can be lost
/// before the link is fully usable, which says nothing about the resolver.
public enum ForwardRetry {
    public static func shouldRetry(
        sentGeneration: Int, generation: Int, forwarding: Bool, elapsed: TimeInterval, timeout: TimeInterval,
        answeredOnThisNetwork: Bool = true
    ) -> Bool {
        forwarding && (sentGeneration != generation || elapsed < timeout / 4 || !answeredOnThisNetwork)
    }
}

// MARK: - Network identity

/// Whether the network really changed, as a key: the path status, the
/// PRIMARY physical interface (the first of NWPath.availableInterfaces,
/// name and type) and the path's gateways. A secondary interface coming
/// and going (mobile data while on Wi-Fi) does not change it: the
/// resolver in use did not change, and every rediscovery costs an
/// unfiltered window.
public enum NetworkKey {
    public static func make(status: String, interfaces: [(name: String, type: String)], gateways: [String]) -> String {
        let primary = interfaces.first.map { "\($0.name) \($0.type)" } ?? "none"
        return "\(status) | \(primary) | \(gateways.sorted().joined(separator: ","))"
    }
}

// MARK: - Rediscovery limits

/// How often the tunnel may remove its settings to re-read the network's
/// resolvers (each time is an unfiltered window). Per network (path
/// generation): at most `readWaits.count` attempts, each giving the system
/// longer to switch over; after that the tunnel gives up on this network
/// and fails closed until the next real change. Plus one extra attempt
/// when every forward keeps failing (`staleRetry`), given again on the
/// same network only after a forward was answered since the last one
/// (`answered`): a resolver that never answers gets one. Across all
/// networks: at most `windowBudget` windows per `budgetPeriod`, whatever
/// triggers them, so no loop (for example path updates caused by the
/// tunnel's own settings) can open windows faster than that.
public struct ResolverRediscovery: Sendable {
    // Read from TunnelRecovery, which replaced this type, so the two
    // cannot drift until this one is removed.
    public static let readWaits = TunnelRecovery.readWaits
    public static let windowBudget = TunnelRecovery.windowBudget
    public static let budgetPeriod = TunnelRecovery.budgetPeriod

    public enum Step: Equatable, Sendable {
        /// Remove the settings `after` seconds from now and poll the
        /// resolvers for up to `readWait` seconds.
        case attempt(readWait: TimeInterval, after: TimeInterval)
        /// No attempts left for this network.
        case giveUp
    }

    private var generation: Int?
    private var attempts = 0
    private var staleUsed = false
    private var windows: [TimeInterval] = []

    public init() {}

    public mutating func next(generation g: Int, now: TimeInterval) -> Step {
        reset(g)
        guard attempts < Self.readWaits.count else { return .giveUp }
        let wait = Self.readWaits[attempts]
        attempts += 1
        return .attempt(readWait: wait, after: reserveWindow(now))
    }

    /// The extra rediscovery for this network, or nil if used and no
    /// forward was answered since. Returns the delay before it may start.
    public mutating func staleRetry(generation g: Int, now: TimeInterval) -> TimeInterval? {
        reset(g)
        guard !staleUsed else { return nil }
        staleUsed = true
        return reserveWindow(now)
    }

    /// A forward sent after the last stale re-read was answered: the
    /// stale retry may be given again on this network.
    public mutating func answered() { staleUsed = false }

    private mutating func reset(_ g: Int) {
        guard g != generation else { return }
        (generation, attempts, staleUsed) = (g, 0, false)
    }

    private mutating func reserveWindow(_ now: TimeInterval) -> TimeInterval {
        windows.removeAll { $0 <= now - Self.budgetPeriod }
        var start = now
        if windows.count >= Self.windowBudget {
            start = max(now, windows[windows.count - Self.windowBudget] + Self.budgetPeriod)
        }
        windows.append(start)
        return start - now
    }
}

/// Every forward failing on an unchanged network: at least `minFailures`
/// failures over at least `minDuration` seconds with no success between
/// them means the resolver list is probably stale.
public struct UpstreamHealth: Sendable {
    public static let minFailures = 8
    public static let minDuration: TimeInterval = 30
    private var generation: Int?
    private var firstFailure: TimeInterval?
    public private(set) var failures = 0

    public init() {}

    public mutating func success() { (firstFailure, failures) = (nil, 0) }

    /// Records a failure; true when the list should be re-learned.
    public mutating func failure(generation g: Int, now: TimeInterval) -> Bool {
        if g != generation { (generation, firstFailure, failures) = (g, nil, 0) }
        failures += 1
        let first = firstFailure ?? now
        firstFailure = first
        return failures >= Self.minFailures && now - first >= Self.minDuration
    }
}

// MARK: - App-side status refresh

/// At most one DNS-filter status refresh at a time: a request made while
/// one runs is folded into a single follow-up run, never a parallel one.
public struct CoalescedRefresh: Sendable {
    private var running = false
    private var again = false

    public init() {}

    /// True: start a refresh now. False: one is running and will run once more.
    public mutating func begin() -> Bool {
        if running {
            again = true
            return false
        }
        running = true
        return true
    }

    /// Call when a run finishes. True: run once more (requested meanwhile).
    public mutating func finish() -> Bool {
        if again {
            again = false
            return true
        }
        running = false
        return false
    }
}

// MARK: - Safari rules bookkeeping (app side)

/// What Safari holds after one apply, recorded WHATEVER the settings are by
/// then: a result discarded because the settings changed meanwhile still
/// changed Safari, and forgetting that let a later run skip a needed reload
/// (Safari kept a reverted, looser list while status said "enforced").
public enum SafariHeld {
    public enum Outcome: Sendable { case applied(checksum: String), pendingReload, failed }

    /// The checksum Safari now holds: the new one when applied, unknown
    /// (nil) when written but not reloaded, unchanged when nothing changed.
    public static func after(_ outcome: Outcome, before: String?) -> String? {
        switch outcome {
        case .applied(let checksum): return checksum
        case .pendingReload: return nil
        case .failed: return before
        }
    }

    /// A reload is needed unless Safari provably holds the expected rules.
    public static func needsReload(expected: String?, held: String?) -> Bool {
        guard let expected, let held else { return true }
        return expected != held
    }
}
