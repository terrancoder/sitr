package com.sitrshield.core

import com.sitrshield.core.dns.DnsAnswerBuilder
import com.sitrshield.core.dns.DnsMessage
import com.sitrshield.core.dns.IpPacket
import com.sitrshield.core.dns.UdpDatagram
import java.net.InetAddress
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * DNS + IP codec golden tests — packets are hand-assembled here so the
 * codec is checked against the wire format, not against itself.
 */
class DnsCodecTest {
    /** Hand-build a DNS query payload for `name` with the given qtype. */
    private fun query(
        name: String,
        qtype: Int,
        id: Int = 0x1234,
        flags: Int = 0x0100, // RD
    ): ByteArray {
        val out = ArrayList<Byte>()
        fun put16(v: Int) {
            out.add(((v shr 8) and 0xff).toByte())
            out.add((v and 0xff).toByte())
        }
        put16(id)
        put16(flags)
        put16(1) // QDCOUNT
        put16(0)
        put16(0)
        put16(0)
        for (label in name.split('.')) {
            out.add(label.length.toByte())
            label.toByteArray(Charsets.US_ASCII).forEach { out.add(it) }
        }
        out.add(0)
        put16(qtype)
        put16(DnsMessage.CLASS_IN)
        return out.toByteArray()
    }

    @Test
    fun parsesAWellFormedQuery() {
        val parsed = assertNotNull(
            DnsMessage.parseQuery(query("Blocked.Example", DnsMessage.TYPE_A))
        )
        assertEquals(0x1234, parsed.id)
        assertEquals("blocked.example", parsed.qname)
        assertEquals(DnsMessage.TYPE_A, parsed.qtype)
        assertEquals(DnsMessage.CLASS_IN, parsed.qclass)
        assertTrue(parsed.recursionDesired)
    }

    @Test
    fun rejectsNonQueriesAndMalformedPackets() {
        // A response (QR=1).
        assertNull(DnsMessage.parseQuery(query("a.example", 1, flags = 0x8180)))
        // Two questions.
        val two = query("a.example", 1).also { it[5] = 2 }
        assertNull(DnsMessage.parseQuery(two))
        // Compression pointer in the qname.
        val pointer = query("a.example", 1).also { it[12] = 0xc0.toByte() }
        assertNull(DnsMessage.parseQuery(pointer))
        // Truncated.
        assertNull(DnsMessage.parseQuery(query("a.example", 1).copyOfRange(0, 14)))
        // Non-standard opcode.
        assertNull(DnsMessage.parseQuery(query("a.example", 1, flags = 0x2800)))
    }

    @Test
    fun blockedAnswerForAIsZeroAddress() {
        val q = assertNotNull(DnsMessage.parseQuery(query("blocked.example", DnsMessage.TYPE_A)))
        val response = DnsAnswerBuilder.blocked(q)

        assertEquals(0x1234, DnsMessage.u16(response, 0))
        assertEquals(0x8180, DnsMessage.u16(response, 2)) // QR|RD|RA, NOERROR
        assertEquals(1, DnsMessage.u16(response, 4)) // QDCOUNT
        assertEquals(1, DnsMessage.u16(response, 6)) // ANCOUNT
        // Question echoed verbatim.
        val questionEnd = 12 + q.questionBytes.size
        assertTrue(
            response.copyOfRange(12, questionEnd).contentEquals(q.questionBytes)
        )
        // Answer: full name, type A, class IN, TTL 300, rdlength 4, 0.0.0.0.
        val nameLen = DnsMessage.encodeName("blocked.example").size
        var at = questionEnd + nameLen
        assertEquals(DnsMessage.TYPE_A, DnsMessage.u16(response, at)); at += 2
        assertEquals(DnsMessage.CLASS_IN, DnsMessage.u16(response, at)); at += 2
        assertEquals(0, DnsMessage.u16(response, at)); at += 2 // TTL high
        assertEquals(300, DnsMessage.u16(response, at)); at += 2 // TTL low
        assertEquals(4, DnsMessage.u16(response, at)); at += 2
        assertTrue(response.copyOfRange(at, at + 4).contentEquals(ByteArray(4)))
    }

    @Test
    fun blockedAnswerForHttpsTypeIsNodata() {
        val q = assertNotNull(
            DnsMessage.parseQuery(query("blocked.example", DnsMessage.TYPE_HTTPS))
        )
        val response = DnsAnswerBuilder.blocked(q)
        assertEquals(0, DnsMessage.u16(response, 6), "ANCOUNT must be zero (NODATA)")
        assertEquals(0x8180, DnsMessage.u16(response, 2))
    }

    @Test
    fun cnameRewriteCarriesTargetAddresses() {
        val q = assertNotNull(DnsMessage.parseQuery(query("www.google.com", DnsMessage.TYPE_A)))
        val response = DnsAnswerBuilder.cnameWithAddresses(
            q,
            "forcesafesearch.google.com",
            listOf(InetAddress.getByName("216.239.38.120")),
            ttl = 60,
        )
        assertEquals(2, DnsMessage.u16(response, 6), "CNAME + A")
        // Walk to the CNAME rdata and confirm it decodes to the target.
        var at = 12 + q.questionBytes.size
        at += DnsMessage.encodeName("www.google.com").size
        assertEquals(DnsMessage.TYPE_CNAME, DnsMessage.u16(response, at)); at += 2
        at += 2 + 4 // class, ttl
        val rdlen = DnsMessage.u16(response, at); at += 2
        assertTrue(
            response.copyOfRange(at, at + rdlen)
                .contentEquals(DnsMessage.encodeName("forcesafesearch.google.com"))
        )
        // AAAA query gets the CNAME but no mismatched A records.
        val q6 = assertNotNull(
            DnsMessage.parseQuery(query("www.google.com", DnsMessage.TYPE_AAAA))
        )
        val response6 = DnsAnswerBuilder.cnameWithAddresses(
            q6, "forcesafesearch.google.com",
            listOf(InetAddress.getByName("216.239.38.120")), 60,
        )
        assertEquals(1, DnsMessage.u16(response6, 6), "CNAME only — no A for an AAAA query")
    }

    /** Independent RFC 1071 checksum for verification. */
    private fun refChecksum(bytes: ByteArray, offset: Int, length: Int, seed: Long): Int {
        var sum = seed
        var i = offset
        while (i + 1 < offset + length) {
            sum += ((bytes[i].toInt() and 0xff) shl 8 or (bytes[i + 1].toInt() and 0xff)).toLong()
            i += 2
        }
        if (i < offset + length) sum += ((bytes[i].toInt() and 0xff) shl 8).toLong()
        while (sum shr 16 != 0L) sum = (sum and 0xffff) + (sum shr 16)
        return sum.toInt().inv() and 0xffff
    }

    private fun buildIpv4UdpPacket(
        srcIp: ByteArray, dstIp: ByteArray, srcPort: Int, dstPort: Int, payload: ByteArray,
    ): ByteArray {
        val udpLen = 8 + payload.size
        val packet = ByteArray(20 + udpLen)
        packet[0] = 0x45
        packet[2] = ((20 + udpLen) shr 8).toByte()
        packet[3] = ((20 + udpLen) and 0xff).toByte()
        packet[8] = 64
        packet[9] = IpPacket.PROTO_UDP.toByte()
        srcIp.copyInto(packet, 12)
        dstIp.copyInto(packet, 16)
        val ipSum = refChecksum(packet, 0, 20, 0)
        packet[10] = (ipSum shr 8).toByte()
        packet[11] = (ipSum and 0xff).toByte()
        packet[20] = (srcPort shr 8).toByte()
        packet[21] = (srcPort and 0xff).toByte()
        packet[22] = (dstPort shr 8).toByte()
        packet[23] = (dstPort and 0xff).toByte()
        packet[24] = (udpLen shr 8).toByte()
        packet[25] = (udpLen and 0xff).toByte()
        payload.copyInto(packet, 28)
        return packet
    }

    @Test
    fun parsesIpv4UdpAndBuildsCheckedReply() {
        val payload = query("blocked.example", DnsMessage.TYPE_A)
        val packet = buildIpv4UdpPacket(
            srcIp = byteArrayOf(10, 111, -34, 2), // 10.111.222.2
            dstIp = byteArrayOf(10, 111, -34, 1), // 10.111.222.1
            srcPort = 51000,
            dstPort = 53,
            payload = payload,
        )
        val datagram = assertNotNull(IpPacket.parseUdp(packet))
        assertEquals(4, datagram.ipVersion)
        assertEquals(51000, datagram.srcPort)
        assertEquals(53, datagram.dstPort)
        assertTrue(datagram.payload.contentEquals(payload))

        val answerPayload = DnsAnswerBuilder.blocked(
            assertNotNull(DnsMessage.parseQuery(datagram.payload))
        )
        val reply = IpPacket.buildUdpReply(datagram, answerPayload)

        // Reply parses, with src/dst swapped.
        val parsedReply = assertNotNull(IpPacket.parseUdp(reply))
        assertEquals(53, parsedReply.srcPort)
        assertEquals(51000, parsedReply.dstPort)
        assertTrue(parsedReply.srcIp.contentEquals(datagram.dstIp))
        assertTrue(parsedReply.dstIp.contentEquals(datagram.srcIp))
        assertTrue(parsedReply.payload.contentEquals(answerPayload))

        // IP header checksum verifies to zero over the header.
        assertEquals(0, refChecksum(reply, 0, 20, 0))
        // UDP checksum verifies over the pseudo-header + UDP segment.
        val udpLen = 8 + answerPayload.size
        var seed = 0L
        for (i in 12 until 20 step 2) {
            seed += ((reply[i].toInt() and 0xff) shl 8 or (reply[i + 1].toInt() and 0xff)).toLong()
        }
        seed += IpPacket.PROTO_UDP.toLong() + udpLen.toLong()
        assertEquals(0, refChecksum(reply, 20, udpLen, seed))
    }

    @Test
    fun parsesIpv6UdpAndBuildsCheckedReply() {
        val payload = query("blocked.example", DnsMessage.TYPE_AAAA)
        val src = ByteArray(16).also { it[0] = 0xfd.toByte(); it[15] = 2 }
        val dst = ByteArray(16).also { it[0] = 0xfd.toByte(); it[15] = 1 }
        val udpLen = 8 + payload.size
        val packet = ByteArray(40 + udpLen)
        packet[0] = 0x60
        packet[4] = (udpLen shr 8).toByte()
        packet[5] = (udpLen and 0xff).toByte()
        packet[6] = IpPacket.PROTO_UDP.toByte()
        packet[7] = 64
        src.copyInto(packet, 8)
        dst.copyInto(packet, 24)
        packet[40] = (51000 shr 8).toByte()
        packet[41] = (51000 and 0xff).toByte()
        packet[43] = 53
        packet[44] = (udpLen shr 8).toByte()
        packet[45] = (udpLen and 0xff).toByte()
        payload.copyInto(packet, 48)

        val datagram = assertNotNull(IpPacket.parseUdp(packet))
        assertEquals(6, datagram.ipVersion)

        val answerPayload = DnsAnswerBuilder.blocked(
            assertNotNull(DnsMessage.parseQuery(datagram.payload))
        )
        val reply = IpPacket.buildUdpReply(datagram, answerPayload)
        val parsedReply = assertNotNull(IpPacket.parseUdp(reply))
        assertTrue(parsedReply.srcIp.contentEquals(dst))
        assertTrue(parsedReply.dstIp.contentEquals(src))
        assertTrue(parsedReply.payload.contentEquals(answerPayload))

        // Mandatory IPv6 UDP checksum verifies.
        val replyUdpLen = 8 + answerPayload.size
        var seed = 0L
        for (i in 8 until 40 step 2) {
            seed += ((reply[i].toInt() and 0xff) shl 8 or (reply[i + 1].toInt() and 0xff)).toLong()
        }
        seed += replyUdpLen.toLong() + IpPacket.PROTO_UDP.toLong()
        assertEquals(0, refChecksum(reply, 40, replyUdpLen, seed))
        val checksumField = DnsMessage.u16(reply, 46)
        assertTrue(checksumField != 0, "IPv6 UDP checksum must never be zero")
    }

    @Test
    fun rejectsFragmentsAndNonUdp() {
        val payload = query("a.example", DnsMessage.TYPE_A)
        val packet = buildIpv4UdpPacket(
            ByteArray(4), ByteArray(4), 1000, 53, payload
        )
        // Fragment offset set.
        val fragmented = packet.copyOf().also { it[7] = 1 }
        assertNull(IpPacket.parseUdp(fragmented))
        // TCP protocol.
        val tcp = packet.copyOf().also { it[9] = IpPacket.PROTO_TCP.toByte() }
        assertNull(IpPacket.parseUdp(tcp))
        // Garbage.
        assertNull(IpPacket.parseUdp(ByteArray(3)))
    }
}
