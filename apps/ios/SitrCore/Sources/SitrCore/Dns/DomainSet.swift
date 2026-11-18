/// A compiled category domain set, held as the verified artifact bytes.
///
/// Artifact format (tools/compiler, `--android-out`, emitAndroid.ts
/// `serializeDomainList`): ASCII, one domain per line, LF-terminated, the
/// last line included, sorted by JavaScript's default `Array.sort()`
/// (parse.ts / guards.ts `mergeTiers`) and deduplicated. JS sorts by UTF-16
/// code unit; on the validated alphabet (`a-z 0-9 - .`) that is identical
/// to unsigned byte order, so the file is STRICTLY ASCENDING BY UNSIGNED
/// BYTE COMPARISON (memcmp, a proper prefix sorting first).
///
/// Load, in this order, failing closed with `DomainSetError`:
///  1. SHA-256 of the whole artifact must equal the expected hex
///     (case-insensitive) → else `.checksumMismatch`.
///  2. Every line must pass `DomainInput.isValidDomain` (checked on bytes,
///     same rule) → else `.invalidLine(n)`. Empty lines are rejected,
///     except that an artifact of exactly "" or "\n" is the empty set. A
///     missing final LF is tolerated.
///  3. Every line must sort strictly after the previous one → else
///     `.unsorted(n)`. Duplicates count as unsorted.
/// The bytes are then kept as ONE `Data`; no per-entry objects exist.
///
/// `contains(name)` — binary search over line boundaries, comparing bytes:
///  - Window `[lo, hi)` of byte offsets, both always at line starts
///    (`lo = 0`, `hi = count`).
///  - While `lo < hi`: `mid = (lo + hi) / 2`; walk back from `mid` to the
///    start `s` of its line (byte after the previous LF, or `lo`); walk
///    forward to its end `e` (the next LF, or `hi`). Compare `name` with
///    `bytes[s..<e]` lexicographically, whole line against whole name (a
///    name containing LF can therefore never match). Equal → found;
///    name < line → `hi = s`; name > line → `lo = e + 1`.
///  - Each step removes at least one line, so it ends in O(log n) steps of
///    O(line length) work. Memory: the artifact bytes, nothing else.
/// Subdomains are not this type's concern; `DecisionSnapshot` asks for
/// each suffix of a name in turn.
import CryptoKit
import Foundation

public enum DomainSetError: Error, Equatable, Sendable {
    case checksumMismatch
    /// 1-based line number.
    case invalidLine(Int)
    /// 1-based line number of the first line not strictly after its predecessor.
    case unsorted(Int)
}

public struct DomainSet: Sendable {
    /// The verified artifact bytes (see the type's doc comment).
    public let bytes: Data
    public let count: Int

    /// Load a compiler artifact after verifying it against `expectedSha256Hex`.
    public init(artifact: Data, expectedSha256Hex: String) throws {
        let digest = SHA256.hash(data: artifact).map { String(format: "%02x", $0) }.joined()
        guard digest == expectedSha256Hex.lowercased() else { throw DomainSetError.checksumMismatch }
        count = try Self.validate(artifact)
        bytes = artifact
    }

    /// An in-memory set (Strict Search hosts, tests): sorted and
    /// deduplicated here, then validated as an artifact would be.
    public init(domains: [String]) throws {
        let sorted = Set(domains).map { Array($0.utf8) }.sorted { $0.lexicographicallyPrecedes($1) }
        var data = Data()
        for d in sorted {
            data.append(contentsOf: d)
            data.append(0x0a)
        }
        count = try Self.validate(data)
        bytes = data
    }

    /// Checks 2 and 3 of the load sequence; returns the line count.
    private static func validate(_ data: Data) throws -> Int {
        try data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> Int in
            let n = buf.count
            if n == 0 || (n == 1 && buf[0] == 0x0a) { return 0 }
            var lines = 0
            var start = 0
            var prev: Range<Int>? = nil
            while start < n {
                var end = start
                while end < n && buf[end] != 0x0a { end += 1 }
                lines += 1
                let line = UnsafeRawBufferPointer(rebasing: buf[start..<end])
                guard isValidDomainBytes(line) else { throw DomainSetError.invalidLine(lines) }
                if let p = prev, compare(line, UnsafeRawBufferPointer(rebasing: buf[p])) <= 0 {
                    throw DomainSetError.unsorted(lines)
                }
                prev = start..<end
                start = end + 1
            }
            return lines
        }
    }

    public func contains(_ name: String) -> Bool { contains(Substring(name)) }

    /// Exact membership of `name` (no subdomain logic); see the type's doc.
    public func contains(_ name: Substring) -> Bool {
        if count == 0 { return false }  // "\n" would read as one empty line
        if let hit = name.utf8.withContiguousStorageIfAvailable({ search(UnsafeRawBufferPointer($0)) }) {
            return hit
        }
        let copy = Array(name.utf8)
        return copy.withUnsafeBytes { search($0) }
    }

    private func search(_ key: UnsafeRawBufferPointer) -> Bool {
        bytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> Bool in
            var lo = 0
            var hi = buf.count
            while lo < hi {
                let mid = (lo + hi) / 2
                var s = mid
                while s > lo && buf[s - 1] != 0x0a { s -= 1 }
                var e = mid
                while e < hi && buf[e] != 0x0a { e += 1 }
                let c = Self.compare(key, UnsafeRawBufferPointer(rebasing: buf[s..<e]))
                if c == 0 { return true }
                if c < 0 { hi = s } else { lo = e + 1 }
            }
            return false
        }
    }

    /// memcmp order; a proper prefix sorts first.
    private static func compare(_ a: UnsafeRawBufferPointer, _ b: UnsafeRawBufferPointer) -> Int {
        let n = min(a.count, b.count)
        for i in 0..<n where a[i] != b[i] { return a[i] < b[i] ? -1 : 1 }
        return a.count == b.count ? 0 : (a.count < b.count ? -1 : 1)
    }

    /// `DomainInput.isValidDomain` on bytes: lowercase LDH labels of 1–63,
    /// alphanumeric at both ends, ≥ 2 labels, ≤ 253 bytes.
    static func isValidDomainBytes(_ d: UnsafeRawBufferPointer) -> Bool {
        if d.isEmpty || d.count > 253 { return false }
        func alnum(_ c: UInt8) -> Bool { (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) }
        var labels = 0
        var start = 0
        while true {
            var end = start
            while end < d.count && d[end] != 0x2e { end += 1 }
            let len = end - start
            if len < 1 || len > 63 || !alnum(d[start]) || !alnum(d[end - 1]) { return false }
            for i in start..<end where !alnum(d[i]) && d[i] != 0x2d { return false }
            labels += 1
            if end == d.count { break }
            start = end + 1
        }
        return labels >= 2
    }
}
