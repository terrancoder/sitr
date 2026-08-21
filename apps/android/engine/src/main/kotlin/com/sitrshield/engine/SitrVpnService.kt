package com.sitrshield.engine

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.core.app.ServiceCompat

/**
 * The DNS-only filter VPN (docs/architecture.md §Mobile engines,
 * threat-model.md T9).
 *
 * The tun routes ONLY the synthetic resolver addresses — exclusively DNS
 * enters the tunnel; the engine cannot see other traffic even in
 * principle. Allowed queries are forwarded to the underlying network's
 * own resolvers via protect()-ed sockets. Fail-visible: every state in
 * which filtering is not provably active goes red (notification +
 * EngineFacts), never optimistic.
 */
class SitrVpnService : VpnService() {
    companion object {
        const val ACTION_STOP = "com.sitrshield.engine.STOP"

        /** Tun-side addresses; routes cover only the two resolver IPs. */
        private const val TUN_ADDR4 = "10.111.222.2"
        private const val DNS4 = "10.111.222.1"
        private const val TUN_ADDR6 = "fd66:f83a:c650::2"
        private const val DNS6 = "fd66:f83a:c650::1"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, SitrVpnService::class.java))
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, SitrVpnService::class.java).setAction(ACTION_STOP)
            )
        }
    }

    private var tun: ParcelFileDescriptor? = null
    private var loop: TunLoop? = null
    private var resolver: UpstreamResolver? = null
    private var forwarder: DnsForwarder? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            EngineController.updateFacts { it.copy(tunActive = false) }
            shutdown()
            stopSelf()
            return START_NOT_STICKY
        }

        EngineNotification.ensureChannel(this)
        ServiceCompat.startForeground(
            this,
            EngineNotification.NOTIFICATION_ID,
            EngineNotification.active(this),
            if (Build.VERSION.SDK_INT >= 34)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED
            else 0,
        )

        if (tun != null) return START_STICKY // already running (always-on restart)

        // Fail-visible: never run without a verified blocklist snapshot.
        // The app installs it (EngineController.apply) before starting us;
        // an always-on cold start goes through SitrApp which re-loads it.
        if (!EngineController.facts.value.blocklistVerified) {
            EngineNotification.post(
                this,
                EngineNotification.inactive(this, Protection.Reason.BLOCKLIST_LOAD_FAILED),
            )
            stopSelf()
            return START_NOT_STICKY
        }

        val established = Builder()
            .setSession("Sitr")
            .setMtu(1500)
            .addAddress(TUN_ADDR4, 32)
            .addAddress(TUN_ADDR6, 128)
            .addDnsServer(DNS4)
            .addDnsServer(DNS6)
            .addRoute(DNS4, 32)
            .addRoute(DNS6, 128)
            .setBlocking(true)
            .apply { if (Build.VERSION.SDK_INT >= 29) setMetered(false) }
            .establish()

        if (established == null) {
            // Consent missing or another VPN holds the slot.
            EngineController.updateFacts {
                it.copy(tunActive = false, revokedAt = System.currentTimeMillis())
            }
            EngineNotification.post(
                this,
                EngineNotification.inactive(this, Protection.Reason.VPN_REVOKED),
            )
            stopSelf()
            return START_NOT_STICKY
        }

        tun = established
        val upstream = UpstreamResolver(protect = { socket -> protect(socket) })
        resolver = upstream
        val tunLoop = TunLoop(established) {
            EngineController.updateFacts { it.copy(tunActive = false) }
            refreshNotification()
        }
        val dnsForwarder = DnsForwarder(
            upstream = upstream,
            cache = DnsCache(),
            writeReply = tunLoop::writeReply,
        )
        forwarder = dnsForwarder
        tunLoop.forwarder = dnsForwarder
        loop = tunLoop
        tunLoop.start()

        registerNetworkCallback()
        EngineController.updateFacts { it.copy(tunActive = true, revokedAt = 0) }
        refreshNotification()
        return START_STICKY
    }

    /** The system or another VPN took the slot — the red-badge moment. */
    override fun onRevoke() {
        EngineController.updateFacts {
            it.copy(tunActive = false, revokedAt = System.currentTimeMillis())
        }
        // Post as a NON-ongoing notification so it survives stopForeground.
        EngineNotification.post(
            this,
            EngineNotification.inactive(this, Protection.Reason.VPN_REVOKED),
        )
        shutdown()
        stopSelf()
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    /**
     * Watch the UNDERLYING network (NOT_VPN): its resolvers are our
     * upstreams, and its Private-DNS setting decides whether we are
     * bypassed (strict mode → red, surfaced, service keeps running so
     * recovery is instant when the user fixes the setting).
     */
    private fun registerNetworkCallback() {
        val manager = getSystemService(ConnectivityManager::class.java)
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) {
                resolver?.setUpstreams(lp.dnsServers)
                forwarder?.clearCaches()
                val strict = Build.VERSION.SDK_INT >= 28 &&
                    lp.isPrivateDnsActive && lp.privateDnsServerName != null
                EngineController.updateFacts {
                    it.copy(
                        hasUpstreams = resolver?.upstreams?.isNotEmpty() == true,
                        privateDnsStrict = strict,
                    )
                }
                refreshNotification()
            }

            override fun onLost(network: Network) {
                forwarder?.clearCaches()
            }
        }
        manager.registerNetworkCallback(request, callback)
        networkCallback = callback
    }

    private fun refreshNotification() {
        val notification = when (val p = EngineController.protection()) {
            is Protection.Active -> EngineNotification.active(this)
            is Protection.Inactive -> EngineNotification.inactive(this, p.reason)
        }
        EngineNotification.post(this, notification)
    }

    private fun shutdown() {
        networkCallback?.let {
            getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it)
        }
        networkCallback = null
        loop?.stop()
        loop = null
        resolver?.shutdown()
        resolver = null
        forwarder = null
        tun = null
    }
}
