package com.sitrshield.engine

import com.sitrshield.core.dns.DnsAnswerBuilder
import com.sitrshield.core.dns.DnsMessage
import com.sitrshield.core.dns.SafeSearchMap
import com.sitrshield.core.dns.UdpDatagram
import com.sitrshield.core.rules.DecisionSnapshot
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap

/**
 * Per-query decision + dispatch. Immediate answers (blocked, NODATA,
 * cache hits) are written synchronously from the tun loop; anything that
 * touches the network (forwarding, SafeSearch target resolution) runs on
 * the resolver's bounded executor so the loop never blocks.
 *
 * Decision order per query:
 *  1. unparseable / non-IN → forward raw (fail OPEN for what we can't
 *     read; the filter fails CLOSED only for names it decided to block)
 *  2. SafeSearch host → NODATA for HTTPS/SVCB, CNAME rewrite for A/AAAA
 *  3. the DecisionSnapshot ladder → blocked answer or forward
 */
class DnsForwarder(
    private val upstream: UpstreamResolver,
    private val cache: DnsCache,
    private val writeReply: (UdpDatagram, ByteArray) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private class ResolvedTarget(val addresses: List<InetAddress>, val expiresAt: Long)

    private val targetCache = ConcurrentHashMap<String, ResolvedTarget>()

    fun handle(datagram: UdpDatagram) {
        val query = DnsMessage.parseQuery(datagram.payload)
        if (query == null || query.qclass != DnsMessage.CLASS_IN) {
            forwardRaw(datagram, null)
            return
        }

        val safeSearchRule = EngineController.safeSearchMap.ruleFor(query.qname)
        if (safeSearchRule != null) {
            when (query.qtype) {
                // No ECH / alternative-endpoint hints for rewritten hosts.
                DnsMessage.TYPE_HTTPS ->
                    writeReply(datagram, DnsAnswerBuilder.nodata(query))
                DnsMessage.TYPE_A, DnsMessage.TYPE_AAAA ->
                    upstream.executor.execute {
                        writeReply(
                            datagram,
                            DnsAnswerBuilder.cnameWithAddresses(
                                query,
                                safeSearchRule.target,
                                resolveTarget(safeSearchRule),
                                ttl = 60,
                            ),
                        )
                    }
                else -> forwardRaw(datagram, query)
            }
            return
        }

        when (EngineController.snapshot.decide(query.qname)) {
            DecisionSnapshot.Verdict.BLOCK ->
                writeReply(datagram, DnsAnswerBuilder.blocked(query))
            DecisionSnapshot.Verdict.FORWARD -> {
                val cached = cache.get(query.qname, query.qtype, query.id, now())
                if (cached != null) {
                    writeReply(datagram, cached)
                } else {
                    forwardRaw(datagram, query)
                }
            }
        }
    }

    private fun forwardRaw(datagram: UdpDatagram, query: com.sitrshield.core.dns.DnsQuery?) {
        upstream.executor.execute {
            val response = upstream.forward(datagram.payload) ?: return@execute
            if (query != null) cache.put(query.qname, query.qtype, response, now())
            writeReply(datagram, response)
        }
    }

    /**
     * Runtime resolution of the SafeSearch enforcement target is primary
     * (vendors renumber); the compiled-in published addresses are the
     * last-resort fallback so SafeSearch never silently drops out. The
     * system lookup for the target flows back through this filter — the
     * target hosts themselves are never mapped or blocked, so it
     * terminates at the upstream.
     */
    private fun resolveTarget(rule: SafeSearchMap.Rule): List<InetAddress> {
        val cached = targetCache[rule.target]
        if (cached != null && cached.expiresAt > now()) return cached.addresses
        val resolved = try {
            InetAddress.getAllByName(rule.target).toList()
        } catch (_: Exception) {
            emptyList()
        }
        val addresses = resolved.ifEmpty {
            (rule.fallbackA + rule.fallbackAaaa).mapNotNull {
                try {
                    InetAddress.getByName(it) // numeric — no lookup
                } catch (_: Exception) {
                    null
                }
            }
        }
        if (addresses.isNotEmpty()) {
            targetCache[rule.target] = ResolvedTarget(addresses, now() + 5 * 60_000)
        }
        return addresses
    }

    fun clearCaches() {
        cache.clear()
        targetCache.clear()
    }
}
