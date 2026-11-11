package com.sitrshield.engine

import com.sitrshield.core.dns.UdpDatagram
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** What the forwarder does with queries it must not, or cannot, decide. */
class DnsForwarderTest {
    private val loopback = InetAddress.getByName("127.0.0.1")
    private val a = byteArrayOf(0, 1, 0, 1) // QTYPE A, QCLASS IN

    private fun header(questions: Int = 1) =
        byteArrayOf(0x12, 0x34, 0x01, 0x00, 0, questions.toByte(), 0, 0, 0, 0, 0, 0)

    private fun name(s: String): ByteArray =
        s.split('.').fold(ByteArray(0)) { acc, l -> acc + l.length.toByte() + l.toByteArray() } + 0

    private fun datagram(payload: ByteArray) = UdpDatagram(
        4, byteArrayOf(10, 111, 222.toByte(), 2), byteArrayOf(10, 111, 222.toByte(), 1), 40000, 53, payload,
    )

    /** An upstream that answers anything: every datagram comes back with the response bit set. */
    private fun echoUpstream(seen: AtomicInteger): DatagramSocket {
        val socket = DatagramSocket(0, loopback)
        thread(isDaemon = true) {
            try {
                while (true) {
                    val request = DatagramPacket(ByteArray(512), 512)
                    socket.receive(request)
                    seen.incrementAndGet()
                    val reply = request.data.copyOf(request.length).also { it[2] = 0x81.toByte(); it[3] = 0x80.toByte() }
                    socket.send(DatagramPacket(reply, reply.size, request.socketAddress))
                }
            } catch (_: Exception) {
            }
        }
        return socket
    }

    @Test
    fun dropsQueriesItCannotReadAndAnswersTheDohCanaryItself() {
        val seen = AtomicInteger()
        val replies = CopyOnWriteArrayList<ByteArray>()
        echoUpstream(seen).use { upstream ->
            val resolver = UpstreamResolver({ true }, { true }, upstream.localPort)
            resolver.setUpstreams(listOf(loopback))
            val forwarder = DnsForwarder(resolver, DnsCache(), { _, reply -> replies.add(reply) })

            // A qname sent as a compression pointer, two questions, and class CHAOS.
            forwarder.handle(datagram(header() + byteArrayOf(0xC0.toByte(), 18) + a + name("blocked.example")))
            forwarder.handle(datagram(header(2) + name("example.com") + a + name("blocked.example") + a))
            forwarder.handle(datagram(header() + name("blocked.example") + byteArrayOf(0, 1, 0, 3)))
            Thread.sleep(300)
            assertEquals(0, seen.get(), "an unreadable query reached the upstream")
            assertTrue(replies.isEmpty())

            // Firefox's canary: answered here, NOERROR with no records.
            forwarder.handle(datagram(header() + name("use-application-dns.net") + a))
            assertEquals(1, replies.size)
            assertEquals(0, replies[0][3].toInt() and 0x0f) // RCODE
            assertEquals(0, replies[0][7].toInt()) // ANCOUNT
            assertEquals(0, seen.get())

            // An ordinary query still goes upstream and comes back.
            forwarder.handle(datagram(header() + name("example.com") + a))
            val deadline = System.currentTimeMillis() + 3000
            while (replies.size < 2 && System.currentTimeMillis() < deadline) Thread.sleep(20)
            assertEquals(2, replies.size)
            assertEquals(1, seen.get())
            resolver.shutdown()
        }
    }
}
