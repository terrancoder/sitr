package com.sitrshield.core.dns

import java.net.InetAddress

/**
 * DNS answer crafting — pure byte assembly, no network.
 *
 * Blocked A/AAAA queries are answered NOERROR with 0.0.0.0 / :: (not
 * NXDOMAIN — some apps treat NXDOMAIN as "try the next resolver", and
 * 0.0.0.0 fails fastest; decision recorded in docs/architecture.md).
 * HTTPS/SVCB (type 65) queries for blocked or SafeSearch-rewritten hosts
 * get NODATA so ECH / alternative-endpoint hints cannot bypass the answer
 * rewrite. Names are written uncompressed — a few bytes larger, always
 * valid.
 */
object DnsAnswerBuilder {
    const val BLOCKED_TTL = 300L

    class ResourceRecord(
        val name: String,
        val type: Int,
        val ttl: Long,
        val rdata: ByteArray,
    )

    /** NOERROR + 0.0.0.0/:: for A/AAAA; NODATA for everything else. */
    fun blocked(query: DnsQuery): ByteArray = when (query.qtype) {
        DnsMessage.TYPE_A -> answer(
            query,
            listOf(
                ResourceRecord(
                    query.qname, DnsMessage.TYPE_A, BLOCKED_TTL, ByteArray(4)
                )
            ),
        )
        DnsMessage.TYPE_AAAA -> answer(
            query,
            listOf(
                ResourceRecord(
                    query.qname, DnsMessage.TYPE_AAAA, BLOCKED_TTL, ByteArray(16)
                )
            ),
        )
        else -> nodata(query)
    }

    /** NOERROR with zero answers. */
    fun nodata(query: DnsQuery): ByteArray = answer(query, emptyList())

    /**
     * SafeSearch rewrite: qname CNAME target, plus the target's addresses
     * for the queried record type.
     */
    fun cnameWithAddresses(
        query: DnsQuery,
        target: String,
        addresses: List<InetAddress>,
        ttl: Long,
    ): ByteArray {
        val records = ArrayList<ResourceRecord>()
        records.add(
            ResourceRecord(query.qname, DnsMessage.TYPE_CNAME, ttl, DnsMessage.encodeName(target))
        )
        for (address in addresses) {
            val bytes = address.address
            val type = if (bytes.size == 4) DnsMessage.TYPE_A else DnsMessage.TYPE_AAAA
            if (type != query.qtype) continue
            records.add(ResourceRecord(target, type, ttl, bytes))
        }
        return answer(query, records)
    }

    /** Assemble a NOERROR response echoing the question. */
    fun answer(query: DnsQuery, records: List<ResourceRecord>): ByteArray {
        val out = ArrayList<Byte>(12 + query.questionBytes.size + records.size * 32)
        fun put16(v: Int) {
            out.add(((v shr 8) and 0xff).toByte())
            out.add((v and 0xff).toByte())
        }
        fun put32(v: Long) {
            put16(((v shr 16) and 0xffff).toInt())
            put16((v and 0xffff).toInt())
        }
        put16(query.id)
        // QR=1, opcode 0, AA=0, TC=0, RD copied, RA=1, rcode NOERROR.
        put16(0x8000 or (query.flags and 0x0100) or 0x0080)
        put16(1) // QDCOUNT
        put16(records.size) // ANCOUNT
        put16(0) // NSCOUNT
        put16(0) // ARCOUNT
        query.questionBytes.forEach { out.add(it) }
        for (record in records) {
            DnsMessage.encodeName(record.name).forEach { out.add(it) }
            put16(record.type)
            put16(DnsMessage.CLASS_IN)
            put32(record.ttl)
            put16(record.rdata.size)
            record.rdata.forEach { out.add(it) }
        }
        return out.toByteArray()
    }
}
