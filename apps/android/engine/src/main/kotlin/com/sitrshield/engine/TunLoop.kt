package com.sitrshield.engine

import android.os.ParcelFileDescriptor
import com.sitrshield.core.dns.IpPacket
import com.sitrshield.core.dns.TcpReset
import com.sitrshield.core.dns.UdpDatagram
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * The tun read loop — one dedicated thread; each read is one IP
 * datagram. Only the synthetic resolver addresses are routed here, so
 * the traffic is DNS by construction:
 *  - UDP:53  → DnsForwarder
 *  - TCP SYN → RST (Private-DNS :853 probes fail fast into cleartext;
 *              truncated-answer :53 retries RST until the TCP shim ships
 *              — documented gap, docs/mobile.md)
 *  - rest    → dropped
 * Replies are written back under a lock (writes must not interleave).
 */
class TunLoop(
    private val tun: ParcelFileDescriptor,
    private val onDead: () -> Unit,
) {
    private val input = FileInputStream(tun.fileDescriptor)
    private val output = FileOutputStream(tun.fileDescriptor)
    private val writeLock = Any()

    @Volatile
    private var running = true

    lateinit var forwarder: DnsForwarder

    private val thread = Thread(::loop, "sitr-tun")

    fun start() {
        thread.start()
    }

    fun writeReply(request: UdpDatagram, payload: ByteArray) {
        writeRaw(IpPacket.buildUdpReply(request, payload))
    }

    private fun writeRaw(packet: ByteArray) {
        try {
            synchronized(writeLock) { output.write(packet) }
        } catch (_: Exception) {
            // The tun is gone; the read loop notices and reports.
        }
    }

    fun stop() {
        running = false
        thread.interrupt()
        try {
            tun.close()
        } catch (_: Exception) {
        }
    }

    private fun loop() {
        val buffer = ByteArray(32_767)
        while (running) {
            val length = try {
                input.read(buffer)
            } catch (_: Exception) {
                break
            }
            if (length <= 0) continue
            val packet = buffer.copyOfRange(0, length)
            val datagram = IpPacket.parseUdp(packet)
            when {
                datagram != null && datagram.dstPort == 53 -> forwarder.handle(datagram)
                isTcp(packet) -> TcpReset.buildRstFor(packet)?.let(::writeRaw)
                // Anything else cannot occur given the routes; drop.
            }
        }
        if (running) onDead()
    }

    private fun isTcp(packet: ByteArray): Boolean = when (IpPacket.ipVersion(packet)) {
        4 -> packet.size > 9 && packet[9].toInt() and 0xff == IpPacket.PROTO_TCP
        6 -> packet.size > 6 && packet[6].toInt() and 0xff == IpPacket.PROTO_TCP
        else -> false
    }
}
