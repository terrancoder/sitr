package com.sitrshield.core.dns

/**
 * DNS wire-format parsing — strict, allocation-light, pure.
 *
 * Queries are parsed strictly: exactly one question, no compression
 * pointers in the qname (queries never legitimately have them), label and
 * name length limits enforced. A malformed or non-standard packet parses
 * to null and the engine forwards it untouched — the filter fails OPEN for
 * packets it cannot understand and CLOSED only for names it decided to
 * block.
 */
class DnsQuery(
    val id: Int,
    val flags: Int,
    /** Lowercased, no trailing dot. */
    val qname: String,
    val qtype: Int,
    val qclass: Int,
    /** The raw question section, echoed verbatim into answers. */
    val questionBytes: ByteArray,
) {
    val recursionDesired: Boolean get() = flags and 0x0100 != 0
}

object DnsMessage {
    const val TYPE_A = 1
    const val TYPE_CNAME = 5
    const val TYPE_AAAA = 28
    const val TYPE_HTTPS = 65
    const val CLASS_IN = 1

    /**
     * Parse a DNS QUERY payload. Returns null when this is not a plain
     * single-question standard query (the engine forwards those raw).
     */
    fun parseQuery(payload: ByteArray): DnsQuery? {
        if (payload.size < 12 + 1 + 4) return null
        val id = u16(payload, 0)
        val flags = u16(payload, 2)
        if (flags and 0x8000 != 0) return null // QR=1: a response, not a query
        if ((flags shr 11) and 0xf != 0) return null // non-standard opcode
        if (u16(payload, 4) != 1) return null // QDCOUNT must be exactly 1

        val name = StringBuilder()
        var offset = 12
        var totalLength = 0
        while (true) {
            if (offset >= payload.size) return null
            val len = payload[offset].toInt() and 0xff
            if (len == 0) {
                offset += 1
                break
            }
            if (len and 0xc0 != 0) return null // compression pointer in a query
            if (len > 63) return null
            if (offset + 1 + len > payload.size) return null
            totalLength += len + 1
            if (totalLength > 254) return null
            if (name.isNotEmpty()) name.append('.')
            for (i in 0 until len) {
                name.append((payload[offset + 1 + i].toInt() and 0xff).toChar())
            }
            offset += 1 + len
        }
        if (name.isEmpty()) return null
        if (offset + 4 > payload.size) return null
        val qtype = u16(payload, offset)
        val qclass = u16(payload, offset + 2)
        val question = payload.copyOfRange(12, offset + 4)
        return DnsQuery(
            id = id,
            flags = flags,
            qname = name.toString().lowercase(),
            qtype = qtype,
            qclass = qclass,
            questionBytes = question,
        )
    }

    /**
     * True when `reply` answers `query`: same transaction id, the response
     * bit set, and the question echoed. Everything an upstream sends back
     * is checked with this before it is cached or handed to a client — the
     * cache re-ids replies for later queries, so an unchecked datagram
     * would be served to every client that asks for the name.
     *
     * `question` is the parsed query's raw question section, or null when
     * the query did not parse (then id + response bit is all that can be
     * checked). Names compare ASCII-case-insensitively, as the system
     * resolver does; type and class must match exactly.
     */
    fun isReplyTo(query: ByteArray, question: ByteArray?, reply: ByteArray): Boolean {
        if (query.size < 12 || reply.size < 12) return false
        if (reply[0] != query[0] || reply[1] != query[1]) return false
        if (reply[2].toInt() and 0x80 == 0) return false
        if (question == null) return true
        if (u16(reply, 4) != 1 || reply.size < 12 + question.size) return false
        val nameLength = question.size - 4
        for (i in question.indices) {
            var a = question[i].toInt() and 0xff
            var b = reply[12 + i].toInt() and 0xff
            if (i < nameLength) {
                if (a in 'A'.code..'Z'.code) a += 32
                if (b in 'A'.code..'Z'.code) b += 32
            }
            if (a != b) return false
        }
        return true
    }

    /** The TC bit: the answer did not fit in the datagram. */
    fun isTruncated(message: ByteArray): Boolean =
        message.size > 2 && message[2].toInt() and 0x02 != 0

    /** RCODE of a response (0 = NOERROR, 2 = SERVFAIL, 3 = NXDOMAIN). */
    fun rcode(message: ByteArray): Int =
        if (message.size > 3) message[3].toInt() and 0x0f else -1

    internal fun u16(bytes: ByteArray, offset: Int): Int =
        ((bytes[offset].toInt() and 0xff) shl 8) or (bytes[offset + 1].toInt() and 0xff)

    /** Encode a dotted name as uncompressed DNS labels. */
    internal fun encodeName(name: String): ByteArray {
        val out = ArrayList<Byte>(name.length + 2)
        for (label in name.trimEnd('.').split('.')) {
            val bytes = label.toByteArray(Charsets.US_ASCII)
            out.add(bytes.size.toByte())
            bytes.forEach { out.add(it) }
        }
        out.add(0)
        return out.toByteArray()
    }
}
