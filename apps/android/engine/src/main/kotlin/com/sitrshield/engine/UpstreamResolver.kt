package com.sitrshield.engine

import com.sitrshield.core.dns.DnsMessage
import java.io.DataInputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Forwards allowed queries to the NETWORK'S OWN resolvers — never to any
 * Sitr or third-party resolver (docs/threat-model.md T9). Upstreams come
 * from the default network's LinkProperties (set by the service's
 * default-network callback); the VPN's own synthetic addresses are
 * filtered out as a loop guard. Sockets are protect()-ed so they bypass
 * the tun.
 *
 * One blocking socket per in-flight query on a bounded executor: simple,
 * obviously correct, and cheap at DNS rates (a few queries per second).
 * If the pool saturates, excess queries are dropped and the client
 * retries — never queued unboundedly.
 */
class UpstreamResolver(
    /** VpnService::protect — keeps forwarding sockets out of the tun. */
    private val protect: (DatagramSocket) -> Boolean,
    private val protectStream: (Socket) -> Boolean,
    /** Always 53 in the app; the tests run a fake resolver on a free port. */
    private val port: Int = 53,
) {
    @Volatile
    var upstreams: List<InetAddress> = emptyList()
        private set

    /** Index of the upstream that answered last; it is tried first. */
    @Volatile
    private var preferred = 0

    /** The tun's own resolver addresses, excluded from upstream lists. */
    private val syntheticAddresses = setOf("10.111.222.1", "fd66:f83a:c650::1")

    // core == max: a ThreadPoolExecutor only grows past its core size once
    // the queue is FULL, so "2, 32" ran two workers and two slow upstream
    // round-trips stalled every other query behind them.
    val executor = pool(32)

    /**
     * SafeSearch target lookups go through the system resolver and get
     * their own pool, so a burst of them can never occupy the workers
     * that forward everyone else's queries — sharing one pool deadlocked
     * all DNS for ~20 s whenever two rewritten hosts were looked up at once.
     */
    val targetExecutor = pool(4)

    private fun pool(size: Int) = ThreadPoolExecutor(
        size, size, 30, TimeUnit.SECONDS,
        LinkedBlockingQueue(64),
        ThreadPoolExecutor.DiscardPolicy(),
    ).apply { allowCoreThreadTimeOut(true) }

    /** Returns true when the list actually changed. */
    fun setUpstreams(addresses: List<InetAddress>): Boolean {
        val next = addresses.filter { it.hostAddress !in syntheticAddresses }
        if (next == upstreams) return false
        upstreams = next
        preferred = 0
        return true
    }

    /**
     * Blocking round-trip of a raw DNS payload. The upstream that answered
     * last is tried first, then the others, so one dead resolver costs a
     * single timeout rather than one per query. Call only from the
     * executor, never the tun loop.
     *
     * Only a datagram that `accept` recognises as the answer to this query
     * is returned. The socket is connected, so the kernel already drops
     * anything not sent from that upstream's port 53; a stray or forged
     * datagram that still arrives is skipped, not returned.
     *
     * A truncated answer is fetched again over TCP from the same upstream
     * (RFC 7766) and returned whole: the client would otherwise retry over
     * TCP into the tun, which only resets.
     */
    fun forward(
        payload: ByteArray,
        timeoutMs: Int = 2_000,
        accept: (ByteArray) -> Boolean,
    ): ByteArray? {
        val list = upstreams
        val first = preferred
        for (i in list.indices) {
            val index = (first + i) % list.size
            val reply = try {
                overUdp(list[index], payload, timeoutMs, accept)
            } catch (_: Exception) {
                null // unreachable, refused or silent: try the next upstream
            } ?: continue
            preferred = index
            if (!DnsMessage.isTruncated(reply)) return reply
            return try {
                overTcp(list[index], payload, timeoutMs, accept)
            } catch (_: Exception) {
                null
            } ?: reply
        }
        return null
    }

    private fun overUdp(
        upstream: InetAddress,
        payload: ByteArray,
        timeoutMs: Int,
        accept: (ByteArray) -> Boolean,
    ): ByteArray? = DatagramSocket().use { socket ->
        if (!protect(socket)) return null
        socket.connect(upstream, port)
        socket.send(DatagramPacket(payload, payload.size))
        val buffer = ByteArray(MAX_REPLY_BYTES)
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        var reply: ByteArray? = null
        while (reply == null) {
            val remaining = ((deadline - System.nanoTime()) / 1_000_000L).toInt()
            if (remaining <= 0) break
            socket.soTimeout = remaining
            val response = DatagramPacket(buffer, buffer.size)
            socket.receive(response) // SocketTimeoutException ends the wait
            reply = buffer.copyOfRange(0, response.length).takeIf(accept)
        }
        reply
    }

    private fun overTcp(
        upstream: InetAddress,
        payload: ByteArray,
        timeoutMs: Int,
        accept: (ByteArray) -> Boolean,
    ): ByteArray? = Socket().use { socket ->
        if (!protectStream(socket)) return null
        socket.connect(InetSocketAddress(upstream, port), timeoutMs)
        socket.soTimeout = timeoutMs
        val framed = ByteArray(2 + payload.size)
        framed[0] = (payload.size shr 8).toByte()
        framed[1] = payload.size.toByte()
        payload.copyInto(framed, 2)
        socket.getOutputStream().apply { write(framed); flush() }
        val input = DataInputStream(socket.getInputStream())
        val length = input.readUnsignedShort()
        // Larger than we would ever hand back over UDP: keep the truncated one.
        if (length > MAX_REPLY_BYTES) return null
        ByteArray(length).also(input::readFully).takeIf(accept)
    }

    fun shutdown() {
        executor.shutdownNow()
        targetExecutor.shutdownNow()
    }

    private companion object {
        const val MAX_REPLY_BYTES = 4096
    }
}
