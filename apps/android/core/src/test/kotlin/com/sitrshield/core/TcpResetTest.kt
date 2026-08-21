package com.sitrshield.core

import com.sitrshield.core.dns.DnsMessage
import com.sitrshield.core.dns.IpPacket
import com.sitrshield.core.dns.TcpReset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TcpResetTest {
    /** Hand-build a minimal IPv4 TCP segment. */
    private fun tcp4(
        flags: Int,
        srcPort: Int = 40000,
        dstPort: Int = 853,
        seq: Long = 0x11223344L,
    ): ByteArray {
        val packet = ByteArray(40)
        packet[0] = 0x45
        packet[2] = 0
        packet[3] = 40
        packet[8] = 64
        packet[9] = IpPacket.PROTO_TCP.toByte()
        byteArrayOf(10, 111, -34, 2).copyInto(packet, 12)
        byteArrayOf(10, 111, -34, 1).copyInto(packet, 16)
        packet[20] = (srcPort shr 8).toByte(); packet[21] = (srcPort and 0xff).toByte()
        packet[22] = (dstPort shr 8).toByte(); packet[23] = (dstPort and 0xff).toByte()
        packet[24] = ((seq shr 24) and 0xff).toByte()
        packet[25] = ((seq shr 16) and 0xff).toByte()
        packet[26] = ((seq shr 8) and 0xff).toByte()
        packet[27] = (seq and 0xff).toByte()
        packet[32] = 0x50
        packet[33] = flags.toByte()
        return packet
    }

    @Test
    fun synGetsRstAckWithCorrectFieldsAndChecksums() {
        val syn = tcp4(flags = 0x02)
        val rst = assertNotNull(TcpReset.buildRstFor(syn))

        // IP: swapped addresses, TCP proto, header checksum verifies to 0.
        assertTrue(rst.copyOfRange(12, 16).contentEquals(syn.copyOfRange(16, 20)))
        assertTrue(rst.copyOfRange(16, 20).contentEquals(syn.copyOfRange(12, 16)))
        assertEquals(0, IpPacket.checksum(rst, 0, 20))

        // TCP: ports swapped, RST|ACK, ack = seq+1.
        assertEquals(853, DnsMessage.u16(rst, 20))
        assertEquals(40000, DnsMessage.u16(rst, 22))
        assertEquals(0x14, rst[33].toInt() and 0xff)
        val ack = (DnsMessage.u16(rst, 28).toLong() shl 16) or DnsMessage.u16(rst, 30).toLong()
        assertEquals(0x11223345L, ack)

        // TCP checksum verifies over the pseudo-header.
        var seed = 0L
        for (i in 12 until 20 step 2) seed += DnsMessage.u16(rst, i).toLong()
        seed += IpPacket.PROTO_TCP.toLong() + 20L
        assertEquals(0, IpPacket.checksum(rst, 20, 20, seed))
    }

    @Test
    fun nonSynSegmentsGetNoRst() {
        assertNull(TcpReset.buildRstFor(tcp4(flags = 0x10))) // bare ACK
        assertNull(TcpReset.buildRstFor(tcp4(flags = 0x12))) // SYN|ACK
        assertNull(TcpReset.buildRstFor(tcp4(flags = 0x01))) // FIN
        assertNull(TcpReset.buildRstFor(ByteArray(10)))
    }

    @Test
    fun ipv6SynGetsCheckedRst() {
        val packet = ByteArray(60)
        packet[0] = 0x60
        packet[4] = 0; packet[5] = 20
        packet[6] = IpPacket.PROTO_TCP.toByte()
        packet[7] = 64
        val src = ByteArray(16).also { it[0] = 0xfd.toByte(); it[15] = 2 }
        val dst = ByteArray(16).also { it[0] = 0xfd.toByte(); it[15] = 1 }
        src.copyInto(packet, 8)
        dst.copyInto(packet, 24)
        packet[40] = (40000 shr 8).toByte(); packet[41] = (40000 and 0xff).toByte()
        packet[42] = (853 shr 8).toByte(); packet[43] = (853 and 0xff).toByte()
        packet[47] = 0x44 // seq low byte
        packet[52] = 0x50
        packet[53] = 0x02 // SYN

        val rst = assertNotNull(TcpReset.buildRstFor(packet))
        assertTrue(rst.copyOfRange(8, 24).contentEquals(dst))
        assertTrue(rst.copyOfRange(24, 40).contentEquals(src))
        assertEquals(0x14, rst[53].toInt() and 0xff)

        var seed = 0L
        for (i in 8 until 40 step 2) seed += DnsMessage.u16(rst, i).toLong()
        seed += 20L + IpPacket.PROTO_TCP.toLong()
        assertEquals(0, IpPacket.checksum(rst, 40, 20, seed))
    }
}
