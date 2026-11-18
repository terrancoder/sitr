/// Per-query decision and upstream logic, socket-free. Ports of the
/// portable parts of DnsForwarder.kt, DnsCache.kt and UpstreamResolver.kt.
///
/// Packet flow in a tunnel extension:
///   IpPacket.parseUdp(packet) (dstPort 53) → DnsEngine.decide(payload:…)
///     .drop                  → nothing
///     .answer(bytes)         → IpPacket.buildUdpReply(datagram, payload: bytes)
///     .forward(query)        → await engine.forward(query, payload:, via: resolver) → reply
///     .rewrite(query, rule)  → resolve rule.target, then
///                              engine.rewriteAnswer(query, rule:, resolved:) → reply
///   non-UDP packet → TcpReset.buildRstFor(packet) ?? drop
import Foundation

/// Raw answer cache keyed by (qname, qtype), fixed 60 s lifetime, LRU at
/// `maxEntries`. A hit returns a copy with only the DNS ID patched. Store
/// only replies that passed `DnsMessage.isReplyTo`: an entry is served to
/// every later client. A record whose own TTL is shorter is served past it
/// (same documented gap as Android).
public final class DnsCache: @unchecked Sendable {  // state guarded by `lock`
    private struct Entry {
        let bytes: [UInt8]
        let expiresAt: TimeInterval
        var lastUsed: UInt64
    }

    private let maxEntries: Int
    private let ttl: TimeInterval = 60
    private var map: [String: Entry] = [:]
    private var clock: UInt64 = 0
    private let lock = NSLock()

    public init(maxEntries: Int = 1024) { self.maxEntries = maxEntries }

    /// `now` in seconds (any monotonic or wall clock, used consistently).
    public func get(_ qname: String, _ qtype: Int, id: Int, now: TimeInterval) -> [UInt8]? {
        lock.lock()
        defer { lock.unlock() }
        let key = "\(qname)|\(qtype)"
        guard var entry = map[key] else { return nil }
        if entry.expiresAt < now {
            map[key] = nil
            return nil
        }
        if entry.bytes.count < 2 { return nil }  // never index a reply we cannot re-id
        clock += 1
        entry.lastUsed = clock
        map[key] = entry
        var copy = entry.bytes
        copy[0] = UInt8(truncatingIfNeeded: id >> 8)
        copy[1] = UInt8(truncatingIfNeeded: id)
        return copy
    }

    public func put(_ qname: String, _ qtype: Int, _ response: [UInt8], now: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        clock += 1
        map["\(qname)|\(qtype)"] = Entry(bytes: response, expiresAt: now + ttl, lastUsed: clock)
        if map.count > maxEntries, let eldest = map.min(by: { $0.value.lastUsed < $1.value.lastUsed })?.key {
            // ponytail: O(n) eviction scan on a full cache (n = 1024, only on
            // inserts); a linked list makes it O(1) if profiles show it.
            map[eldest] = nil
        }
    }

    public func clear() {
        lock.lock()
        map.removeAll()
        lock.unlock()
    }
}

/// What to do with one DNS payload from the tunnel.
public enum DnsDecision: Equatable, Sendable {
    /// Unreadable, not class IN: send nothing.
    case drop
    /// Reply with these DNS bytes now.
    case answer([UInt8])
    /// Ask the network's resolvers (`DnsEngine.forward`).
    case forward(DnsQuery)
    /// A/AAAA for a SafeSearch host: resolve `rule.target`, then reply with
    /// `DnsEngine.rewriteAnswer`.
    case rewrite(DnsQuery, SafeSearchMap.Rule)
}

public final class DnsEngine: Sendable {
    /// support.mozilla.org/kb/canary-domain-use-application-dnsnet
    static let dohCanary = "use-application-dns.net"

    public let cache: DnsCache

    public init(cache: DnsCache = DnsCache()) { self.cache = cache }

    /// DnsForwarder.handle's decision order:
    ///  1. unparseable or non-IN → drop
    ///  2. the DoH canary → NODATA (Firefox then leaves its own DoH off)
    ///  3. the ladder → blocked answer
    ///  4. SafeSearch host → HTTPS (65) NODATA; A/AAAA rewrite; any other
    ///     type forwarded WITHOUT a cache read (as Kotlin's forwardRaw)
    ///  5. cache hit → answer; else forward
    public func decide(
        payload: [UInt8], snapshot: DecisionSnapshot, safeSearch: SafeSearchMap, now: TimeInterval
    ) -> DnsDecision {
        guard let query = DnsMessage.parseQuery(payload), query.qclass == DnsMessage.classIN else { return .drop }
        if query.qname == Self.dohCanary { return .answer(DnsAnswerBuilder.nodata(query)) }
        switch NameAction.of(query.qname, snapshot: snapshot, safeSearch: safeSearch) {
        case .block:
            return .answer(DnsAnswerBuilder.blocked(query))
        case .rewrite(let rule):
            switch query.qtype {
            case DnsMessage.typeHTTPS: return .answer(DnsAnswerBuilder.nodata(query))
            case DnsMessage.typeA, DnsMessage.typeAAAA: return .rewrite(query, rule)
            default: return .forward(query)
            }
        case .forward:
            if let cached = cache.get(query.qname, query.qtype, id: query.id, now: now) { return .answer(cached) }
            return .forward(query)
        }
    }

    /// Forward `payload` (the query's original bytes) and post-process the
    /// accepted reply: TTLs capped at 60 s; cached only when complete and
    /// settled (not truncated, rcode NOERROR or NXDOMAIN). nil → no reply.
    public func forward(
        _ query: DnsQuery, payload: [UInt8], via resolver: UpstreamResolver, now: () -> TimeInterval
    ) async -> [UInt8]? {
        guard
            let raw = await resolver.forward(payload, accept: { DnsMessage.isReplyTo(payload, question: query.questionBytes, reply: $0) })
        else { return nil }
        let response = DnsMessage.capTtls(raw, max: DnsAnswerBuilder.blockedTTL)
        let rcode = DnsMessage.rcode(response)
        if !DnsMessage.isTruncated(response) && (rcode == 0 || rcode == 3) {
            cache.put(query.qname, query.qtype, response, now: now())
        }
        return response
    }

    /// The SafeSearch answer: CNAME to the target plus the `resolved`
    /// target addresses (4/16-byte), or the rule's compiled-in fallback
    /// when resolution found none. TTL 60. Still a CNAME-only answer when
    /// both are empty. `resolved` must hold BOTH families, as Android's
    /// getAllByName does: the fallback applies only when the target has no
    /// address at all, so an AAAA query for a v4-only target stays
    /// CNAME-only rather than getting the compiled-in v6 address.
    /// ponytail: Android's 5-minute target cache (DnsForwarder.targetCache,
    /// written only when addresses are non-empty) is not ported; it belongs
    /// with whatever resolves the target in the tunnel.
    public func rewriteAnswer(_ query: DnsQuery, rule: SafeSearchMap.Rule, resolved: [[UInt8]]) -> [UInt8] {
        DnsAnswerBuilder.cnameWithAddresses(
            query, target: rule.target, addresses: resolved.isEmpty ? rule.fallbackAddresses : resolved, ttl: 60)
    }
}

/// Socket I/O to one upstream resolver, implemented by the tunnel with
/// real sockets that bypass the tunnel, and by tests with a fake.
public protocol DnsUpstreamTransport: Sendable {
    /// Send `query` over UDP to `upstream` port 53 and yield every datagram
    /// that arrives from it until the timeout, then finish. Throwing (or
    /// finishing at once) means unreachable.
    func udp(_ query: [UInt8], to upstream: String) async throws -> AsyncThrowingStream<[UInt8], Error>
    /// One RFC 7766 exchange over TCP port 53: write the 2-byte length and
    /// `query`, return the framed answer.
    func tcp(_ query: [UInt8], to upstream: String) async throws -> [UInt8]
}

/// Forwards allowed queries to the NETWORK'S OWN resolvers — never a Sitr
/// or third-party one. Port of UpstreamResolver.kt's selection, accept and
/// truncation-retry logic; I/O is the transport's.
public actor UpstreamResolver {
    /// Larger TCP answers are refused (the truncated UDP one is kept).
    static let maxReplyBytes = 4096

    public private(set) var upstreams: [String] = []
    /// Index of the upstream that answered last; it is tried first.
    private var preferred = 0
    private let transport: DnsUpstreamTransport
    /// The tunnel's own resolver addresses, excluded as a loop guard.
    private let syntheticAddresses: Set<String>

    public init(transport: DnsUpstreamTransport, syntheticAddresses: Set<String> = ["10.111.222.1", "fd66:f83a:c650::1"]) {
        self.transport = transport
        self.syntheticAddresses = syntheticAddresses
    }

    /// Returns true when the list changed (the caller then clears caches).
    @discardableResult
    public func setUpstreams(_ addresses: [String]) -> Bool {
        let next = addresses.filter { !syntheticAddresses.contains($0) }
        if next == upstreams { return false }
        upstreams = next
        preferred = 0
        return true
    }

    /// The last upstream that answered goes first, then the others in
    /// order. Only a datagram `accept` recognises is returned; junk is
    /// skipped until the transport's timeout. A truncated answer is fetched
    /// again over TCP from the same upstream and returned whole; if TCP
    /// fails, is not accepted or is over 4096 bytes, the truncated one is
    /// returned. `preferred` moves to any upstream that answered, truncated
    /// or not.
    /// ponytail: no bound on in-flight forwards here; Android caps them
    /// (32 forward + 4 target workers, queue 64, drop when full) and the
    /// tunnel must do the same around this call.
    public func forward(_ payload: [UInt8], accept: @Sendable ([UInt8]) -> Bool) async -> [UInt8]? {
        let list = upstreams
        let first = preferred
        for i in 0..<list.count {
            let index = (first + i) % list.count
            guard let reply = await overUdp(list[index], payload, accept) else { continue }
            preferred = index
            if !DnsMessage.isTruncated(reply) { return reply }
            if let full = try? await transport.tcp(payload, to: list[index]),
                full.count <= Self.maxReplyBytes, accept(full)
            {
                return full
            }
            return reply
        }
        return nil
    }

    private func overUdp(_ upstream: String, _ payload: [UInt8], _ accept: ([UInt8]) -> Bool) async -> [UInt8]? {
        do {
            for try await datagram in try await transport.udp(payload, to: upstream) where accept(datagram) {
                return datagram
            }
        } catch {}
        return nil
    }
}
