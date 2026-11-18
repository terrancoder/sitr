/// Diagnostics for the DEBUG-only tunnel prototype, written as JSON to the
/// App Group container so the Mac can pull them with devicectl.
///
/// PRIVACY: this is the owner's own phone. Nothing here may hold a looked-up
/// name except the reserved probe names below — counters, states, resolver
/// addresses, timings and error strings only.
import Foundation

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

public struct TunnelDiagnostics: Codable, Sendable {
    public struct Counters: Codable, Sendable {
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

    public var writer: String
    public var updatedAt = Date()
    public var startedAt: Date?
    public var state = "idle"
    public var counters = Counters()
    public var upstreams: [String] = []
    public var lastError: String?
    public var listsLoaded: [String] = []
    public var listsSkipped: [String] = []
    public var discovery: [Discovery] = []
    public var probes: [Probe] = []
    public var events: [Event] = []

    public init(writer: String) { self.writer = writer }

    public mutating func log(_ message: String) {
        events = Array((events + [Event(at: Date(), message: message)]).suffix(100))
    }

    public mutating func record(_ attempt: Discovery) {
        discovery = Array((discovery + [attempt]).suffix(40))
    }

    /// Records the decision for reserved names only; others are ignored.
    public mutating func probe(_ qname: String, qtype: Int, decision: String, ms: Int) {
        guard ProbeNames.isReserved(qname) else { return }
        probes = Array((probes + [Probe(at: Date(), name: qname, qtype: qtype, decision: decision, ms: ms)]).suffix(60))
    }

    /// `<group container>/Library/Caches/sitr-dns/<file>`: devicectl's
    /// container access policy only reaches Library/ in an App Group.
    public static func url(_ file: String) -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.sitrshield.sitr")?
            .appendingPathComponent("Library/Caches/sitr-dns", isDirectory: true).appendingPathComponent(file)
    }

    public func write(to url: URL) {
        var copy = self
        copy.updatedAt = Date()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(copy) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    public static func read(from url: URL) -> TunnelDiagnostics? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(TunnelDiagnostics.self, from: data)
    }
}
