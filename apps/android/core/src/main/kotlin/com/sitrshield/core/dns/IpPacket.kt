package com.sitrshield.core.dns

/**
 * Minimal IPv4/IPv6 + UDP codec for the tun device — parses exactly what a
 * DNS-only VPN can receive (routes cover only the synthetic resolver
 * addresses) and builds the reply datagrams. Fragmented packets and
 * non-UDP protocols are not handled here: the engine drops or shims them
 * (TCP:53/:853 handling lives in :engine). All checksums are computed;
 * the IPv6 UDP checksum is mandatory per RFC 8200.
 */
class UdpDatagram(
    val ipVersion: Int,
    val srcIp: ByteArray,
    val dstIp: ByteArray,
    val srcPort: Int,
    val dstPort: Int,
    val payload: ByteArray,
)

object IpPacket {
    const val PROTO_UDP = 17
    const val PROTO_TCP = 6

    fun ipVersion(packet: ByteArray): Int =
        if (packet.isEmpty()) 0 else (packet[0].toInt() and 0xf0) shr 4

    /** Parse a UDP datagram out of an IPv4 or IPv6 packet; null otherwise. */
    fun parseUdp(packet: ByteArray): UdpDatagram? = when (ipVersion(packet)) {
        4 -> parseUdp4(packet)
        6 -> parseUdp6(packet)
        else -> null
    }

    private fun parseUdp4(packet: ByteArray): UdpDatagram? {
        if (packet.size < 20) return null
        val ihl = (packet[0].toInt() and 0x0f) * 4
        if (ihl < 20 || packet.size < ihl + 8) return null
        if (packet[9].toInt() and 0xff != PROTO_UDP) return null
        val fragField = DnsMessage.u16(packet, 6)
        if (fragField and 0x3fff != 0) return null // MF set or fragment offset
        val udpLen = DnsMessage.u16(packet, ihl + 4)
        if (udpLen < 8 || ihl + udpLen > packet.size) return null
        return UdpDatagram(
            ipVersion = 4,
            srcIp = packet.copyOfRange(12, 16),
            dstIp = packet.copyOfRange(16, 20),
            srcPort = DnsMessage.u16(packet, ihl),
            dstPort = DnsMessage.u16(packet, ihl + 2),
            payload = packet.copyOfRange(ihl + 8, ihl + udpLen),
        )
    }

    private fun parseUdp6(packet: ByteArray): UdpDatagram? {
        if (packet.size < 40 + 8) return null
        if (packet[6].toInt() and 0xff != PROTO_UDP) return null // no ext headers
        val payloadLen = DnsMessage.u16(packet, 4)
        if (payloadLen < 8 || 40 + payloadLen > packet.size) return null
        return UdpDatagram(
            ipVersion = 6,
            srcIp = packet.copyOfRange(8, 24),
            dstIp = packet.copyOfRange(24, 40),
            srcPort = DnsMessage.u16(packet, 40),
            dstPort = DnsMessage.u16(packet, 42),
            payload = packet.copyOfRange(48, 40 + payloadLen),
        )
    }

    /** Build the reply datagram: src/dst swapped, checksums correct. */
    fun buildUdpReply(request: UdpDatagram, payload: ByteArray): ByteArray =
        if (request.ipVersion == 4) buildReply4(request, payload)
        else buildReply6(request, payload)

    private fun buildReply4(request: UdpDatagram, payload: ByteArray): ByteArray {
        val udpLen = 8 + payload.size
        val packet = ByteArray(20 + udpLen)
        packet[0] = 0x45
        put16(packet, 2, 20 + udpLen) // total length
        put16(packet, 6, 0x4000) // DF
        packet[8] = 64 // TTL
        packet[9] = PROTO_UDP.toByte()
        request.dstIp.copyInto(packet, 12) // reply src = request dst
        request.srcIp.copyInto(packet, 16)
        put16(packet, 10, checksum(packet, 0, 20))

        put16(packet, 20, request.dstPort)
        put16(packet, 22, request.srcPort)
        put16(packet, 24, udpLen)
        payload.copyInto(packet, 28)
        val sum = udpChecksum4(packet, 12, 16, 20, udpLen)
        put16(packet, 26, if (sum == 0) 0xffff else sum)
        return packet
    }

    private fun buildReply6(request: UdpDatagram, payload: ByteArray): ByteArray {
        val udpLen = 8 + payload.size
        val packet = ByteArray(40 + udpLen)
        packet[0] = 0x60
        put16(packet, 4, udpLen)
        packet[6] = PROTO_UDP.toByte()
        packet[7] = 64 // hop limit
        request.dstIp.copyInto(packet, 8)
        request.srcIp.copyInto(packet, 24)

        put16(packet, 40, request.dstPort)
        put16(packet, 42, request.srcPort)
        put16(packet, 44, udpLen)
        payload.copyInto(packet, 48)
        val sum = udpChecksum6(packet, 8, 24, 40, udpLen)
        put16(packet, 46, if (sum == 0) 0xffff else sum) // mandatory for IPv6
        return packet
    }

    private fun put16(bytes: ByteArray, offset: Int, value: Int) {
        bytes[offset] = ((value shr 8) and 0xff).toByte()
        bytes[offset + 1] = (value and 0xff).toByte()
    }

    /** RFC 1071 ones'-complement sum over a byte range. */
    internal fun checksum(bytes: ByteArray, offset: Int, length: Int, seed: Long = 0): Int {
        var sum = seed
        var i = offset
        val end = offset + length
        while (i + 1 < end) {
            sum += DnsMessage.u16(bytes, i).toLong()
            i += 2
        }
        if (i < end) sum += ((bytes[i].toInt() and 0xff) shl 8).toLong()
        while (sum shr 16 != 0L) sum = (sum and 0xffff) + (sum shr 16)
        return sum.toInt().inv() and 0xffff
    }

    private fun pseudoHeaderSum(bytes: ByteArray, ipOffset: Int, ipLen: Int): Long {
        var sum = 0L
        var i = ipOffset
        val end = ipOffset + ipLen
        while (i < end) {
            sum += DnsMessage.u16(bytes, i).toLong()
            i += 2
        }
        return sum
    }

    private fun udpChecksum4(
        packet: ByteArray, srcOffset: Int, dstOffset: Int, udpOffset: Int, udpLen: Int,
    ): Int {
        var seed = pseudoHeaderSum(packet, srcOffset, 4) + pseudoHeaderSum(packet, dstOffset, 4)
        seed += PROTO_UDP.toLong()
        seed += udpLen.toLong()
        return checksum(packet, udpOffset, udpLen, seed)
    }

    private fun udpChecksum6(
        packet: ByteArray, srcOffset: Int, dstOffset: Int, udpOffset: Int, udpLen: Int,
    ): Int {
        var seed = pseudoHeaderSum(packet, srcOffset, 16) + pseudoHeaderSum(packet, dstOffset, 16)
        seed += udpLen.toLong()
        seed += PROTO_UDP.toLong()
        return checksum(packet, udpOffset, udpLen, seed)
    }
}
