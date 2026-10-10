package com.sitrshield.engine

import com.sitrshield.core.dns.DnsMessage
import java.io.DataInputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The resolver against a fake upstream on loopback. These are the paths
 * that only fail on a real network: a forged or malformed datagram, a
 * dead first resolver, and a truncated answer.
 */
class UpstreamResolverTest {
    private val v4 = InetAddress.getByName("127.0.0.1")
    private val v6 = InetAddress.getByName("::1")

    /** A query for example.com A and the matching reply with `extra` appended. */
    private val query = byteArrayOf(
        0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0,
        7, 'e'.code.toByte(), 'x'.code.toByte(), 'a'.code.toByte(), 'm'.code.toByte(),
        'p'.code.toByte(), 'l'.code.toByte(), 'e'.code.toByte(),
        3, 'c'.code.toByte(), 'o'.code.toByte(), 'm'.code.toByte(), 0,
        0, 1, 0, 1,
    )
    private val question = DnsMessage.parseQuery(query)!!.questionBytes

    private fun reply(truncated: Boolean = false, tail: Int = 0): ByteArray =
        query.copyOf(query.size + tail).also {
            it[2] = (0x81 or if (truncated) 0x02 else 0).toByte()
            it[3] = 0x80.toByte()
        }

    private fun accept(candidate: ByteArray) = DnsMessage.isReplyTo(query, question, candidate)

    private fun resolver(port: Int) = UpstreamResolver({ true }, { true }, port)

    /** One-shot UDP upstream: answers the first query with `datagrams`, in order. */
    private fun udpUpstream(address: InetAddress, vararg datagrams: ByteArray): DatagramSocket {
        val socket = DatagramSocket(0, address)
        thread(isDaemon = true) {
            try {
                val request = DatagramPacket(ByteArray(512), 512)
                socket.receive(request)
                for (d in datagrams) {
                    socket.send(DatagramPacket(d, d.size, request.socketAddress))
                }
            } catch (_: Exception) {
            }
        }
        return socket
    }

    @Test
    fun skipsDatagramsThatAreNotTheAnswer() {
        // Empty, one byte, wrong id — then the real one. Before the check
        // the first of these was returned (and cached, and later crashed
        // the cache hit).
        val wrongId = reply().also { it[1] = 0x35 }
        udpUpstream(v4, ByteArray(0), ByteArray(1), wrongId, reply()).use { server ->
            val r = resolver(server.localPort)
            r.setUpstreams(listOf(v4))
            assertContentEquals(reply(), r.forward(query, 1_000, ::accept))
        }
    }

    @Test
    fun givesUpWhenOnlyJunkArrives() {
        udpUpstream(v4, ByteArray(0), reply().also { it[1] = 0x35 }).use { server ->
            val r = resolver(server.localPort)
            r.setUpstreams(listOf(v4))
            assertNull(r.forward(query, 300, ::accept))
        }
    }

    @Test
    fun fallsBackToTheNextUpstreamAndRemembersIt() {
        val answering = DatagramSocket(0, v4)
        // Bound but silent: the worst kind of dead resolver, a full timeout.
        val silent = DatagramSocket(answering.localPort, v6)
        thread(isDaemon = true) {
            repeat(2) {
                try {
                    val request = DatagramPacket(ByteArray(512), 512)
                    answering.receive(request)
                    answering.send(DatagramPacket(reply(), reply().size, request.socketAddress))
                } catch (_: Exception) {
                }
            }
        }
        answering.use {
            silent.use {
                val r = resolver(answering.localPort)
                r.setUpstreams(listOf(v6, v4))
                // The first round pays one timeout on the silent upstream.
                assertContentEquals(reply(), r.forward(query, 300, ::accept))
                // The second must ask the one that answered FIRST.
                val started = System.nanoTime()
                assertContentEquals(reply(), r.forward(query, 300, ::accept))
                val elapsedMs = (System.nanoTime() - started) / 1_000_000
                assertTrue(elapsedMs < 250, "dead upstream was asked first again: ${elapsedMs}ms")
            }
        }
    }

    @Test
    fun refetchesATruncatedAnswerOverTcp() {
        val full = reply(tail = 900) // larger than a no-EDNS datagram allows
        ServerSocket(0, 1, v4).use { tcp ->
            val udp = DatagramSocket(tcp.localPort, v4)
            thread(isDaemon = true) {
                try {
                    val request = DatagramPacket(ByteArray(512), 512)
                    udp.receive(request)
                    val tc = reply(truncated = true)
                    udp.send(DatagramPacket(tc, tc.size, request.socketAddress))
                    tcp.accept().use { client ->
                        val input = DataInputStream(client.getInputStream())
                        val asked = ByteArray(input.readUnsignedShort()).also(input::readFully)
                        assertContentEquals(query, asked)
                        client.getOutputStream().apply {
                            write(byteArrayOf((full.size shr 8).toByte(), full.size.toByte()))
                            write(full)
                            flush()
                        }
                    }
                } catch (_: Exception) {
                }
            }
            udp.use {
                val r = resolver(tcp.localPort)
                r.setUpstreams(listOf(v4))
                val answer = r.forward(query, 1_000, ::accept)
                assertEquals(full.size, answer?.size)
                assertTrue(!DnsMessage.isTruncated(answer!!))
            }
        }
    }

    @Test
    fun keepsTheTruncatedAnswerWhenTcpIsRefused() {
        udpUpstream(v4, reply(truncated = true)).use { server ->
            val r = resolver(server.localPort) // no TCP listener on that port
            r.setUpstreams(listOf(v4))
            val answer = r.forward(query, 500, ::accept)
            assertTrue(DnsMessage.isTruncated(answer!!))
        }
    }

    @Test
    fun cacheNeverServesAReplyItCannotReId() {
        val cache = DnsCache()
        cache.put("example.com", 1, ByteArray(1), now = 0)
        assertNull(cache.get("example.com", 1, id = 7, now = 1))
        cache.put("example.com", 1, reply(), now = 0)
        val hit = cache.get("example.com", 1, id = 0x0102, now = 1)!!
        assertEquals(0x01, hit[0].toInt())
        assertEquals(0x02, hit[1].toInt())
    }
}
