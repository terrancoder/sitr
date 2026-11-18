package com.sitrshield.core.domainset

import com.sitrshield.core.SitrResult
import java.security.MessageDigest

/**
 * A compiled category domain set, held as the verified artifact bytes —
 * the same algorithm as apps/ios/SitrCore/Sources/SitrCore/Dns/DomainSet.swift.
 *
 * Artifact format (tools/compiler `--android-out`, emitAndroid.ts):
 * ASCII, one domain per line, LF-terminated, sorted and deduplicated. On
 * the validated alphabet (`a-z 0-9 - .`) the compiler's JS sort equals
 * unsigned byte order, so the file is STRICTLY ASCENDING BY UNSIGNED BYTE
 * COMPARISON (a proper prefix sorts first).
 *
 * Load, in this order, failing closed (the engine refuses to start — a
 * silently dropped domain is a silently unprotected user):
 *  1. SHA-256 of the whole artifact equals the expected hex (any case).
 *  2. Every line passes `DomainInput.isValidDomain` (checked on bytes).
 *     Empty lines are rejected, except that an artifact of exactly "" or
 *     "\n" is the empty set. A missing final LF is tolerated.
 *  3. Every line sorts strictly after the previous one; a duplicate
 *     counts as unsorted.
 * The bytes are then kept as ONE ByteArray; no per-entry objects exist.
 *
 * `contains(name)` is a binary search over line boundaries comparing
 * bytes: window `[lo, hi)` of offsets at line starts; take `mid`, walk to
 * its line `[s, e)`, compare the whole name with the whole line, then
 * `hi = s` or `lo = e + 1`. O(log n) steps of O(line length); memory is
 * the artifact. Subdomains are DecisionSnapshot's concern.
 */
class DomainSet private constructor(private val bytes: ByteArray, val size: Int) {

    /** Exact membership of `name` (no subdomain logic). */
    fun contains(name: String): Boolean = contains(name, 0)

    /**
     * Exact membership of `name.substring(from)` without allocating it.
     * Chars are compared by code against unsigned bytes; the lines are
     * ASCII, so a non-ASCII or LF-containing name simply never matches.
     */
    fun contains(name: String, from: Int): Boolean {
        if (size == 0) return false // "\n" would read as one empty line
        var lo = 0
        var hi = bytes.size
        while (lo < hi) {
            val mid = (lo + hi) ushr 1
            var s = mid
            while (s > lo && bytes[s - 1] != LF) s--
            var e = mid
            while (e < hi && bytes[e] != LF) e++
            val c = compare(name, from, s, e)
            if (c == 0) return true
            if (c < 0) hi = s else lo = e + 1
        }
        return false
    }

    private fun compare(name: String, from: Int, s: Int, e: Int): Int {
        val an = name.length - from
        val bn = e - s
        for (i in 0 until minOf(an, bn)) {
            val a = name[from + i].code
            val b = bytes[s + i].toInt() and 0xff
            if (a != b) return if (a < b) -1 else 1
        }
        return an.compareTo(bn)
    }

    companion object {
        private const val LF = '\n'.code.toByte()

        /** Load a compiler artifact after verifying it against `expectedSha256Hex`. */
        fun load(artifact: ByteArray, expectedSha256Hex: String): SitrResult<DomainSet> {
            if (sha256Hex(artifact) != expectedSha256Hex.lowercase()) {
                return SitrResult.Err("domain list failed checksum verification — refusing to load")
            }
            return validate(artifact)
        }

        /** An in-memory set (Strict Search hosts, tests): sorted and deduplicated, then validated. */
        fun of(domains: Collection<String>): SitrResult<DomainSet> {
            val sorted = domains.toSet().map { it.toByteArray(Charsets.UTF_8) }
                .sortedWith { a, b -> compareBytes(a, 0, a.size, b, 0, b.size) }
            val out = java.io.ByteArrayOutputStream()
            for (d in sorted) {
                out.write(d)
                out.write(LF.toInt())
            }
            return validate(out.toByteArray())
        }

        /** Lowercase hex SHA-256 — the form checksums.json uses. */
        fun sha256Hex(data: ByteArray): String {
            val digits = "0123456789abcdef"
            val b = MessageDigest.getInstance("SHA-256").digest(data)
            val sb = StringBuilder(b.size * 2)
            for (x in b) {
                val v = x.toInt() and 0xff
                sb.append(digits[v ushr 4]).append(digits[v and 0xf])
            }
            return sb.toString()
        }

        /** Checks 2 and 3 of the load sequence. */
        private fun validate(data: ByteArray): SitrResult<DomainSet> {
            val n = data.size
            if (n == 0 || (n == 1 && data[0] == LF)) return SitrResult.Ok(DomainSet(data, 0))
            var lines = 0
            var start = 0
            var prevStart = -1
            var prevEnd = -1
            while (start < n) {
                var end = start
                while (end < n && data[end] != LF) end++
                lines++
                if (!isValidDomainBytes(data, start, end)) {
                    return SitrResult.Err("invalid domain on line $lines")
                }
                if (prevStart >= 0 && compareBytes(data, start, end, data, prevStart, prevEnd) <= 0) {
                    return SitrResult.Err("domain list is not strictly sorted at line $lines")
                }
                prevStart = start
                prevEnd = end
                start = end + 1
            }
            return SitrResult.Ok(DomainSet(data, lines))
        }

        /** Unsigned byte order; a proper prefix sorts first. */
        private fun compareBytes(a: ByteArray, aS: Int, aE: Int, b: ByteArray, bS: Int, bE: Int): Int {
            val an = aE - aS
            val bn = bE - bS
            for (i in 0 until minOf(an, bn)) {
                val x = a[aS + i].toInt() and 0xff
                val y = b[bS + i].toInt() and 0xff
                if (x != y) return if (x < y) -1 else 1
            }
            return an.compareTo(bn)
        }

        /**
         * `DomainInput.isValidDomain` on `d[start, end)`: lowercase LDH
         * labels of 1–63, alphanumeric at both ends, ≥ 2 labels, ≤ 253 bytes.
         */
        internal fun isValidDomainBytes(d: ByteArray, start: Int = 0, end: Int = d.size): Boolean {
            val len = end - start
            if (len < 1 || len > 253) return false
            fun alnum(c: Byte) = c in 0x61..0x7a || c in 0x30..0x39
            var labels = 0
            var ls = start
            while (true) {
                var le = ls
                while (le < end && d[le] != '.'.code.toByte()) le++
                val ll = le - ls
                if (ll < 1 || ll > 63 || !alnum(d[ls]) || !alnum(d[le - 1])) return false
                for (i in ls until le) if (!alnum(d[i]) && d[i] != '-'.code.toByte()) return false
                labels++
                if (le == end) break
                ls = le + 1
            }
            return labels >= 2
        }
    }
}
