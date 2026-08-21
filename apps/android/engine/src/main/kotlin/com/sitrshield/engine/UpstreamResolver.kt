package com.sitrshield.engine

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Forwards allowed queries to the NETWORK'S OWN resolvers — never to any
 * Sitr or third-party resolver (docs/threat-model.md T9). Upstreams come
 * from the underlying network's LinkProperties (set by the service's
 * NOT_VPN network callback); the VPN's own synthetic addresses are
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
) {
    @Volatile
    var upstreams: List<InetAddress> = emptyList()
        private set

    /** The tun's own resolver addresses, excluded from upstream lists. */
    private val syntheticAddresses = setOf("10.111.222.1", "fd66:f83a:c650::1")

    val executor = ThreadPoolExecutor(
        2, 32, 30, TimeUnit.SECONDS,
        LinkedBlockingQueue(64),
        ThreadPoolExecutor.DiscardPolicy(),
    )

    fun setUpstreams(addresses: List<InetAddress>) {
        upstreams = addresses.filter { it.hostAddress !in syntheticAddresses }
    }

    /**
     * Blocking round-trip of a raw DNS payload to the first responding
     * upstream. Call only from the executor, never the tun loop.
     */
    fun forward(payload: ByteArray, timeoutMs: Int = 5_000): ByteArray? {
        for (upstream in upstreams) {
            try {
                DatagramSocket().use { socket ->
                    if (!protect(socket)) return@use
                    socket.soTimeout = timeoutMs
                    socket.send(DatagramPacket(payload, payload.size, upstream, 53))
                    val buffer = ByteArray(4096)
                    val response = DatagramPacket(buffer, buffer.size)
                    socket.receive(response)
                    return buffer.copyOfRange(0, response.length)
                }
            } catch (_: Exception) {
                // Try the next upstream; null after the last one.
            }
        }
        return null
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
