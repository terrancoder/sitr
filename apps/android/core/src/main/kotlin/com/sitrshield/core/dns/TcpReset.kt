package com.sitrshield.core.dns

/**
 * TCP RST crafting — the engine's answer to TCP arriving on the tun.
 *
 * The DNS-only VPN handles UDP; TCP shows up in two cases: Android's
 * Private-DNS probe to :853 (RST makes the probe fail fast so the system
 * falls back to cleartext :53 into our filter, instead of hanging to a
 * timeout), and truncated-answer retries to :53 (RST until the TCP shim
 * ships — a documented gap, docs/mobile.md). Only SYN segments get a
 * RST/ACK; everything else is dropped by the caller.
 */
object TcpReset {
    /** Returns a RST/ACK reply for an IPv4/IPv6 TCP SYN packet, else null. */
    fun buildRstFor(packet: ByteArray): ByteArray? = when (IpPacket.ipVersion(packet)) {
        4 -> rst4(packet)
        6 -> rst6(packet)
        else -> null
    }

    private fun rst4(packet: ByteArray): ByteArray? {
        if (packet.size < 20) return null
        val ihl = (packet[0].toInt() and 0x0f) * 4
        if (ihl < 20 || packet.size < ihl + 20) return null
        if (packet[9].toInt() and 0xff != IpPacket.PROTO_TCP) return null
        val flags = packet[ihl + 13].toInt() and 0xff
        if (flags and 0x02 == 0 || flags and 0x10 != 0) return null // SYN only, no ACK
        val seq = u32(packet, ihl + 4)

        val reply = ByteArray(20 + 20)
        reply[0] = 0x45
        put16(reply, 2, 40)
        put16(reply, 6, 0x4000) // DF
        reply[8] = 64
        reply[9] = IpPacket.PROTO_TCP.toByte()
        packet.copyInto(reply, 12, 16, 20) // reply src = request dst
        packet.copyInto(reply, 16, 12, 16)
        put16(reply, 10, IpPacket.checksum(reply, 0, 20))

        fillTcpRst(
            reply, tcpOffset = 20,
            srcPort = DnsMessage.u16(packet, ihl + 2), // swap
            dstPort = DnsMessage.u16(packet, ihl),
            ackNumber = seq + 1,
        )
        var seed = pseudoSum(reply, 12, 4) + pseudoSum(reply, 16, 4)
        seed += IpPacket.PROTO_TCP.toLong() + 20L
        put16(reply, 20 + 16, IpPacket.checksum(reply, 20, 20, seed))
        return reply
    }

    private fun rst6(packet: ByteArray): ByteArray? {
        if (packet.size < 40 + 20) return null
        if (packet[6].toInt() and 0xff != IpPacket.PROTO_TCP) return null
        val flags = packet[40 + 13].toInt() and 0xff
        if (flags and 0x02 == 0 || flags and 0x10 != 0) return null
        val seq = u32(packet, 40 + 4)

        val reply = ByteArray(40 + 20)
        reply[0] = 0x60
        put16(reply, 4, 20)
        reply[6] = IpPacket.PROTO_TCP.toByte()
        reply[7] = 64
        packet.copyInto(reply, 8, 24, 40)
        packet.copyInto(reply, 24, 8, 24)

        fillTcpRst(
            reply, tcpOffset = 40,
            srcPort = DnsMessage.u16(packet, 42),
            dstPort = DnsMessage.u16(packet, 40),
            ackNumber = seq + 1,
        )
        var seed = pseudoSum(reply, 8, 16) + pseudoSum(reply, 24, 16)
        seed += 20L + IpPacket.PROTO_TCP.toLong()
        val sum = IpPacket.checksum(reply, 40, 20, seed)
        put16(reply, 40 + 16, sum)
        return reply
    }

    private fun fillTcpRst(
        bytes: ByteArray, tcpOffset: Int, srcPort: Int, dstPort: Int, ackNumber: Long,
    ) {
        put16(bytes, tcpOffset, srcPort)
        put16(bytes, tcpOffset + 2, dstPort)
        // seq = 0, ack = client seq + 1
        put32(bytes, tcpOffset + 8, ackNumber and 0xffffffffL)
        bytes[tcpOffset + 12] = 0x50 // data offset 5 words
        bytes[tcpOffset + 13] = 0x14 // RST | ACK
    }

    private fun u32(bytes: ByteArray, offset: Int): Long =
        (DnsMessage.u16(bytes, offset).toLong() shl 16) or
            DnsMessage.u16(bytes, offset + 2).toLong()

    private fun put16(bytes: ByteArray, offset: Int, value: Int) {
        bytes[offset] = ((value shr 8) and 0xff).toByte()
        bytes[offset + 1] = (value and 0xff).toByte()
    }

    private fun put32(bytes: ByteArray, offset: Int, value: Long) {
        put16(bytes, offset, ((value shr 16) and 0xffff).toInt())
        put16(bytes, offset + 2, (value and 0xffff).toInt())
    }

    private fun pseudoSum(bytes: ByteArray, offset: Int, length: Int): Long {
        var sum = 0L
        var i = offset
        while (i < offset + length) {
            sum += DnsMessage.u16(bytes, i).toLong()
            i += 2
        }
        return sum
    }
}
