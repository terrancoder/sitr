package com.sitrshield.engine

import com.sitrshield.core.dns.DnsAnswerBuilder
import com.sitrshield.core.dns.DnsMessage
import com.sitrshield.core.dns.DnsQuery
import com.sitrshield.core.dns.SafeSearchMap
import com.sitrshield.core.dns.UdpDatagram
import com.sitrshield.core.rules.NameAction
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap

/**
 * Per-query decision + dispatch. Immediate answers (blocked, NODATA,
 * cache hits) are written synchronously from the tun loop; anything that
 * touches the network (forwarding, SafeSearch target resolution) runs on
 * the resolver's bounded executors so the loop never blocks.
 *
 * Decision order per query (NameAction):
 *  1. unparseable / non-IN → dropped. No stub resolver sends these, and
 *     forwarding what the filter cannot read let a blocked name through
 *     (a compressed qname is answered upstream)
 *  1b. the DNS-over-HTTPS canary → NODATA, so Firefox leaves its own DoH off
 *  2. the DecisionSnapshot ladder → blocked answer
 *  3. SafeSearch host → NODATA for HTTPS/SVCB, CNAME rewrite for A/AAAA
 *  4. forward
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
        val query = DnsMessage.parseQuery(datagram.payload) ?: return
        if (query.qclass != DnsMessage.CLASS_IN) return
        if (query.qname == DOH_CANARY) {
            writeReply(datagram, DnsAnswerBuilder.nodata(query))
            return
        }

        val action = NameAction.of(
            query.qname, EngineController.snapshot, EngineController.safeSearchMap,
        )
        when (action) {
            NameAction.Block ->
                writeReply(datagram, DnsAnswerBuilder.blocked(query))
            is NameAction.Rewrite -> when (query.qtype) {
                // No ECH / alternative-endpoint hints for rewritten hosts.
                DnsMessage.TYPE_HTTPS ->
                    writeReply(datagram, DnsAnswerBuilder.nodata(query))
                DnsMessage.TYPE_A, DnsMessage.TYPE_AAAA ->
                    upstream.targetExecutor.execute {
                        guarded {
                            writeReply(
                                datagram,
                                DnsAnswerBuilder.cnameWithAddresses(
                                    query,
                                    action.rule.target,
                                    resolveTarget(action.rule),
                                    ttl = 60,
                                ),
                            )
                        }
                    }
                else -> forwardRaw(datagram, query)
            }
            NameAction.Forward -> {
                val cached = cache.get(query.qname, query.qtype, query.id, now())
                if (cached != null) {
                    writeReply(datagram, cached)
                } else {
                    forwardRaw(datagram, query)
                }
            }
        }
    }

    private fun forwardRaw(datagram: UdpDatagram, query: DnsQuery) {
        upstream.executor.execute {
            guarded {
                val response = upstream.forward(datagram.payload) {
                    DnsMessage.isReplyTo(datagram.payload, query.questionBytes, it)
                }?.let { DnsMessage.capTtls(it, DnsAnswerBuilder.BLOCKED_TTL) } ?: return@guarded
                // Cache only complete, settled answers: a truncated reply or
                // a server failure should be asked again, not pinned for 60 s.
                val rcode = DnsMessage.rcode(response)
                if (!DnsMessage.isTruncated(response) &&
                    (rcode == 0 || rcode == 3)
                ) {
                    cache.put(query.qname, query.qtype, response, now())
                }
                writeReply(datagram, response)
            }
        }
    }

    /** A pool thread that throws takes the whole process down with it. */
    private inline fun guarded(block: () -> Unit) {
        try {
            block()
        } catch (_: Exception) {
        }
    }

    /**
     * Runtime resolution of the SafeSearch enforcement target is primary
     * (vendors renumber); the compiled-in published addresses are the
     * last-resort fallback so SafeSearch never silently drops out. Sitr
     * is excluded from its own tunnel, so this system lookup goes straight
     * to the default network's resolver and never re-enters the filter.
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

    private companion object {
        /** support.mozilla.org/kb/canary-domain-use-application-dnsnet */
        const val DOH_CANARY = "use-application-dns.net"
    }

    fun clearCaches() {
        cache.clear()
        targetCache.clear()
    }
}
