/// Diagnostics for DEBUG builds of the DNS filter, written as JSON to the
/// App Group container so the Mac can pull them with devicectl. Release
/// builds never read or write it (PacketTunnelProvider and the app call
/// it only under #if DEBUG).
///
/// PRIVACY: this is the owner's own phone. Nothing here may hold a looked-up
/// name except the reserved probe names below — counters, states, resolver
/// addresses, timings and error strings only.
import Darwin
import Foundation

#if DEBUG  // device testing only: a Release build holds no probe names
public enum ProbeNames {
    public static let suffix = ".sitr-probe.test"
    /// Fixed names whose decision may be recorded by name (with the www.
    /// form browsers actually ask for). One each from adult, gambling and
    /// dating.domains.
    public static let fixed: Set<String> = [
        "www.google.com", "www.youtube.com", "www.bing.com", "example.com",
        "pornhub.com", "www.pornhub.com", "bet365.com", "www.bet365.com", "tinder.com", "www.tinder.com",
    ]

    public static func isReserved(_ qname: String) -> Bool {
        qname.hasSuffix(suffix) || fixed.contains(qname)
    }
}
#endif

/// The process's memory as the jetsam limit sees it.
public struct MemorySample: Codable, Sendable, Equatable {
    public var at: Date
    /// task_info(TASK_VM_INFO).phys_footprint: what the extension limit counts.
    public var footprintBytes: UInt64
    /// os_proc_available_memory(): headroom before the limit (iOS only).
    public var availableBytes: UInt64?

    public init(at: Date, footprintBytes: UInt64, availableBytes: UInt64?) {
        (self.at, self.footprintBytes, self.availableBytes) = (at, footprintBytes, availableBytes)
    }

    public static func now() -> MemorySample {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        #if os(iOS)
            let available: UInt64? = UInt64(os_proc_available_memory())
        #else
            let available: UInt64? = nil
        #endif
        return MemorySample(at: Date(), footprintBytes: kr == KERN_SUCCESS ? info.phys_footprint : 0, availableBytes: available)
    }
}

public struct TunnelDiagnostics: Codable, Sendable {
    public struct Counters: Codable, Sendable, Equatable {
        public var seen = 0, blocked = 0, rewritten = 0, forwarded = 0, cacheHits = 0
        public var failed = 0, dropped = 0, overloaded = 0, tcpReset = 0
        public init() {}
    }

    /// One resolver-discovery attempt: what the system reported, what was
    /// kept after removing the tunnel's own addresses.
    public struct Discovery: Codable, Sendable {
        public var at: Date
        public var trigger: String
        public var method: String
        public var raw: [String]
        public var usable: [String]
        public var ms: Int
        public init(at: Date, trigger: String, method: String, raw: [String], usable: [String], ms: Int) {
            (self.at, self.trigger, self.method, self.raw, self.usable, self.ms) = (at, trigger, method, raw, usable, ms)
        }
    }

    public struct Probe: Codable, Sendable {
        public var at: Date
        public var name: String
        public var qtype: Int
        public var decision: String
        public var ms: Int
    }

    public struct Event: Codable, Sendable {
        public var at: Date
        public var message: String
    }

    /// One provider process run. A run whose `stoppedAt` is nil and that is
    /// not the current one ended without stopTunnel (jetsam, crash).
    public struct Run: Codable, Sendable {
        public var startedAt: Date
        public var stoppedAt: Date?
        public var stopReason: String?
        /// Last diagnostics write of a run that ended without a stop.
        public var lastSeenAt: Date?
    }

    /// One real network change and how the tunnel came back from it.
    public struct PathChange: Codable, Sendable {
        public var at: Date
        public var status: String
        /// "<name> <type>", e.g. "en0 wifi", "pdp_ip0 cellular".
        public var interfaces: [String]
        public var gateways: [String]
        /// Filled when forwarding resumes (or the attempt gives up).
        public var method: String?
        public var upstreams: [String] = []
        /// Forwarding was off (queries needing an upstream DROPPED) this long.
        public var forwardingOffMs: Int?
        /// The tunnel's DNS settings were removed this long: lookups in this
        /// window bypassed the filter. nil = settings never removed.
        public var unfilteredMs: Int?
        public var droppedWhileOff = 0
        /// Forwards sent on the previous network that failed after this
        /// change (optional: older files lack it).
        public var failedInFlight: Int?
        /// Forwards sent on this network, after forwarding resumed, that failed.
        public var failedAfter: Int?
        /// Of all failures attributed here: timeouts vs immediate send errors.
        public var failedTimeout: Int?
        public var failedSendError: Int?
        /// Per-process hashes of the failed queries (name + type with a
        /// random per-run seed, never the name), capped; their count is the
        /// number of distinct lookups behind the failures.
        public var failedQueryHashes: [Int]?
        /// Forwarding resumed → the first upstream answer on this network.
        public var firstAnswerMs: Int?

        public init(at: Date, status: String, interfaces: [String], gateways: [String]) {
            (self.at, self.status, self.interfaces, self.gateways) = (at, status, interfaces, gateways)
        }
    }

    /// Counts and latency for one fixed-length interval (also a heartbeat).
    public struct Interval: Codable, Sendable {
        public var start: Date
        public var seconds: Int
        public var counts: Counters
        /// Upstream round-trip of forwarded lookups, ms (nil: none).
        public var p50: Int?, p90: Int?, p99: Int?, max: Int?
        public var footprintBytes: UInt64
        public var peakFootprintBytes: UInt64
        public var availableBytes: UInt64?
    }

    public static let intervalSeconds = 300
    static let limits = (events: 200, discovery: 40, probes: 60, runs: 50, paths: 100, intervals: 288)

    public var writer: String
    public var updatedAt = Date()
    public var startedAt: Date?
    public var state = "idle"
    /// This run's totals.
    public var counters = Counters()
    public var upstreams: [String] = []
    public var lastError: String?
    public var listsLoaded: [String] = []
    public var listsSkipped: [String] = []
    public var discovery: [Discovery] = []
    public var probes: [Probe] = []
    /// Lookups of each `ProbeNames.fixed` name that reached the tunnel,
    /// across runs (a blocked test name loading with a low count here means
    /// the lookup went around the tunnel).
    public var probeCounts: [String: Int] = [:]
    public var events: [Event] = []
    public var runs: [Run] = []
    public var paths: [PathChange] = []
    public var intervals: [Interval] = []
    public var memoryAtStart: MemorySample?
    public var memoryLast: MemorySample?
    public var peakFootprintBytes: UInt64 = 0
    /// Counters at the start of the open interval.
    public var intervalBase = Counters()
    public var intervalStart: Date?

    public init(writer: String) { self.writer = writer }

    public mutating func log(_ message: String) {
        events = Array((events + [Event(at: Date(), message: message)]).suffix(Self.limits.events))
    }

    public mutating func record(_ attempt: Discovery) {
        discovery = Array((discovery + [attempt]).suffix(Self.limits.discovery))
    }

    #if DEBUG
    /// Records the decision for reserved names only; others are ignored.
    public mutating func probe(_ qname: String, qtype: Int, decision: String, ms: Int) {
        guard ProbeNames.isReserved(qname) else { return }
        if ProbeNames.fixed.contains(qname) { probeCounts[qname, default: 0] += 1 }
        probes = Array((probes + [Probe(at: Date(), name: qname, qtype: qtype, decision: decision, ms: ms)]).suffix(Self.limits.probes))
    }
    #endif

    /// Starts a run on top of the previous file: closes a run that never
    /// saw stopTunnel and resets the per-run state.
    public mutating func beginRun(at now: Date) {
        // A run killed without stopTunnel left its last interval open.
        if let last = runs.last, last.stoppedAt == nil, intervalStart != nil {
            closeInterval(at: updatedAt, latencies: [], peakFootprint: peakFootprintBytes)
        }
        if let last = runs.indices.last, runs[last].stoppedAt == nil {
            runs[last].lastSeenAt = updatedAt
            log("previous run (started \(runs[last].startedAt)) ended without stop; last write \(updatedAt)")
        }
        runs = Array((runs + [Run(startedAt: now)]).suffix(Self.limits.runs))
        (startedAt, counters, intervalBase, intervalStart) = (now, Counters(), Counters(), now)
        (upstreams, lastError, memoryAtStart, peakFootprintBytes) = ([], nil, nil, 0)
    }

    public mutating func endRun(at now: Date, reason: String) {
        guard let last = runs.indices.last else { return }
        runs[last].stoppedAt = now
        runs[last].stopReason = reason
    }

    public mutating func record(_ change: PathChange) {
        paths = Array((paths + [change]).suffix(Self.limits.paths))
    }

    /// A forward that got no answer, attributed to a network change:
    /// `sentBeforeChange` = sent before the latest path change. `open` is
    /// the change still being recovered from, if any. Entries from earlier
    /// runs are never touched.
    public mutating func recordFailure(
        sentBeforeChange: Bool, open: inout PathChange?, timedOut: Bool? = nil, queryHash: Int? = nil
    ) {
        counters.failed += 1
        func detail(_ c: inout PathChange) {
            if let timedOut {
                if timedOut { c.failedTimeout = (c.failedTimeout ?? 0) + 1 } else { c.failedSendError = (c.failedSendError ?? 0) + 1 }
            }
            if let queryHash {
                var hashes = c.failedQueryHashes ?? []
                if !hashes.contains(queryHash), hashes.count < 200 { hashes.append(queryHash) }
                c.failedQueryHashes = hashes
            }
        }
        if sentBeforeChange, open != nil {
            open!.failedInFlight = (open!.failedInFlight ?? 0) + 1
            detail(&open!)
            return
        }
        guard let last = paths.indices.last, paths[last].at >= (startedAt ?? .distantPast) else { return }
        if sentBeforeChange {
            paths[last].failedInFlight = (paths[last].failedInFlight ?? 0) + 1
        } else {
            paths[last].failedAfter = (paths[last].failedAfter ?? 0) + 1
        }
        detail(&paths[last])
    }

    /// The first upstream answer after forwarding resumed on the latest
    /// network (this run's entries only; the first one wins).
    public mutating func recordFirstAnswer(ms: Int) {
        guard let last = paths.indices.last, paths[last].at >= (startedAt ?? .distantPast), paths[last].firstAnswerMs == nil
        else { return }
        paths[last].firstAnswerMs = ms
    }

    public mutating func sample(_ m: MemorySample) {
        if memoryAtStart == nil { memoryAtStart = m }
        memoryLast = m
        peakFootprintBytes = Swift.max(peakFootprintBytes, m.footprintBytes)
    }

    /// Closes the open interval with this run's counter deltas and the
    /// upstream latencies (ms) seen in it.
    public mutating func closeInterval(at now: Date, latencies: [Int], peakFootprint: UInt64) {
        let start = intervalStart ?? now
        let c = counters, b = intervalBase
        var d = Counters()
        (d.seen, d.blocked, d.rewritten, d.forwarded, d.cacheHits) =
            (c.seen - b.seen, c.blocked - b.blocked, c.rewritten - b.rewritten, c.forwarded - b.forwarded, c.cacheHits - b.cacheHits)
        (d.failed, d.dropped, d.overloaded, d.tcpReset) =
            (c.failed - b.failed, c.dropped - b.dropped, c.overloaded - b.overloaded, c.tcpReset - b.tcpReset)
        let sorted = latencies.sorted()
        let m = memoryLast
        let interval = Interval(
            start: start, seconds: Int(now.timeIntervalSince(start).rounded()), counts: d,
            p50: Self.percentile(sorted, 50), p90: Self.percentile(sorted, 90), p99: Self.percentile(sorted, 99), max: sorted.last,
            footprintBytes: m?.footprintBytes ?? 0, peakFootprintBytes: peakFootprint, availableBytes: m?.availableBytes)
        intervals = Array((intervals + [interval]).suffix(Self.limits.intervals))
        (intervalBase, intervalStart) = (c, now)
    }

    /// Nearest-rank percentile of an ascending array; nil when empty.
    public static func percentile(_ sorted: [Int], _ p: Int) -> Int? {
        guard !sorted.isEmpty else { return nil }
        let rank = Int((Double(p) / 100 * Double(sorted.count)).rounded(.up))
        return sorted[Swift.min(Swift.max(rank, 1), sorted.count) - 1]
    }

    #if DEBUG
    // The file I/O exists in DEBUG builds only: a Release build of the app
    // or the DNS filter has no code path that creates or reads this file.
    /// `<group container>/Library/Caches/sitr-dns/<file>`: devicectl's
    /// container access policy only reaches Library/ in an App Group.
    public static func url(_ file: String) -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.sitrshield.sitr")?
            .appendingPathComponent("Library/Caches/sitr-dns", isDirectory: true).appendingPathComponent(file)
    }

    public func encoded() -> Data? {
        var copy = self
        copy.updatedAt = Date()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return try? encoder.encode(copy)
    }

    public func write(to url: URL) {
        guard let data = encoded() else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    public static func read(from url: URL) -> TunnelDiagnostics? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(TunnelDiagnostics.self, from: data)
    }
    #endif
}
