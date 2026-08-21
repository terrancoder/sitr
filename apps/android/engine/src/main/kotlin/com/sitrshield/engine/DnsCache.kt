package com.sitrshield.engine

/**
 * Small answer cache — raw upstream response bytes keyed by
 * (qname, qtype), fixed conservative 60-second TTL. On a hit only the
 * DNS ID is patched (compression pointers are message-relative, so the
 * bytes stay valid). Honoring per-record TTLs needs compression-aware
 * answer parsing and is the documented v1.1 refinement (docs/mobile.md);
 * a short fixed TTL can only ever be MORE fresh than the records allow.
 */
class DnsCache(private val maxEntries: Int = 1024) {
    private class Entry(val bytes: ByteArray, val expiresAt: Long)

    private val map = object : LinkedHashMap<String, Entry>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: Map.Entry<String, Entry>): Boolean =
            size > maxEntries
    }

    private val ttlMs = 60_000L

    @Synchronized
    fun get(qname: String, qtype: Int, id: Int, now: Long): ByteArray? {
        val entry = map["$qname|$qtype"] ?: return null
        if (entry.expiresAt < now) {
            map.remove("$qname|$qtype")
            return null
        }
        val copy = entry.bytes.copyOf()
        copy[0] = ((id shr 8) and 0xff).toByte()
        copy[1] = (id and 0xff).toByte()
        return copy
    }

    @Synchronized
    fun put(qname: String, qtype: Int, response: ByteArray, now: Long) {
        map["$qname|$qtype"] = Entry(response.copyOf(), now + ttlMs)
    }

    @Synchronized
    fun clear() {
        map.clear()
    }
}
