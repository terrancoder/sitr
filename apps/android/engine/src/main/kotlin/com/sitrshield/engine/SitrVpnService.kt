package com.sitrshield.engine

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.sitrshield.core.gate.DelayClockReading
import com.sitrshield.core.gate.DelayStamp
import com.sitrshield.core.gate.Pause

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
        const val ACTION_PAUSE = "com.sitrshield.engine.PAUSE"
        const val ACTION_RESUME = "com.sitrshield.engine.RESUME"
        const val ACTION_REFRESH = "com.sitrshield.engine.REFRESH"
        private const val EXTRA_PAUSE_MS = "pauseMs"

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

        /** Takes the tun down for `ms`; the gate and the allowance are the caller's. */
        fun pause(context: Context, ms: Long) {
            context.startService(
                Intent(context, SitrVpnService::class.java)
                    .setAction(ACTION_PAUSE).putExtra(EXTRA_PAUSE_MS, ms)
            )
        }

        /**
         * Re-reads always-on and lockdown into the facts. Android re-delivers
         * a start when always-on is set, but not when lockdown is toggled
         * later (seen on API 30), so the pause sheet asks before it shows.
         */
        fun refresh(context: Context) {
            context.startService(
                Intent(context, SitrVpnService::class.java).setAction(ACTION_REFRESH)
            )
        }

        fun resume(context: Context) {
            context.startService(
                Intent(context, SitrVpnService::class.java).setAction(ACTION_RESUME)
            )
        }
    }

    private var tun: ParcelFileDescriptor? = null
    private var loop: TunLoop? = null
    private var resolver: UpstreamResolver? = null
    private var forwarder: DnsForwarder? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    /** The verdict the notification currently shows (startForeground posts green). */
    private var shown: Protection? = null

    /**
     * The pause, in memory only: a process death or a reboot ends it, and
     * whatever starts the service next (always-on, boot, the user) brings
     * protection back. While it runs the service stays in the foreground
     * with no tun — Android 12+ would refuse to start it again from the
     * background — and a partial wake lock keeps the timer on time in
     * Doze (Doze ignores wake locks only below foreground-service state).
     */
    private var pauseStart: DelayStamp? = null
    private var pauseLength = 0L
    private var wakeLock: PowerManager.WakeLock? = null
    private var timeReceiver: BroadcastReceiver? = null
    private val handler = Handler(Looper.getMainLooper())
    private val checkPause = object : Runnable {
        override fun run() {
            val start = pauseStart ?: return
            val left = Pause.remaining(start, pauseLength, clocks())
            if (left > 0) handler.postDelayed(this, left) else endPause()
        }
    }

    private fun refreshAlwaysOn() {
        if (Build.VERSION.SDK_INT >= 29) {
            EngineController.updateFacts { it.copy(alwaysOn = isAlwaysOn, lockdown = isLockdownEnabled) }
        }
    }

    private fun clocks() = DelayClockReading(SystemClock.elapsedRealtime(), System.currentTimeMillis())

    /** Non-VPN networks the callback has reported, most recent last. */
    private val seen = LinkedHashMap<Network, LinkProperties>()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_REFRESH -> {
                if (tun == null && pauseStart == null) stopSelf() else refreshAlwaysOn()
                return START_STICKY
            }
            ACTION_PAUSE -> {
                val ms = intent.getLongExtra(EXTRA_PAUSE_MS, 0)
                refreshAlwaysOn() // lockdown is read live: a pause under it cuts the phone off
                when {
                    pauseStart != null -> {}
                    tun == null -> stopSelf() // nothing running to pause
                    ms > 0 && EngineController.facts.value.lockdown != true -> beginPause(ms)
                }
                return START_STICKY
            }
            ACTION_RESUME -> {
                if (pauseStart != null) endPause() else if (tun == null) stopSelf()
                return START_STICKY
            }
        }
        if (intent?.action == ACTION_STOP) {
            clearPause()
            EngineController.updateFacts { it.copy(tunActive = false) }
            shutdown()
            // Also clears a red warning left behind by an earlier revoke.
            EngineNotification.cancel(this)
            stopSelf()
            return START_NOT_STICKY
        }

        EngineNotification.ensureChannel(this)
        if (pauseStart != null) {
            // Always-on (or a boot or update start) asking for the VPN
            // mid-pause: the pause passed the gate, so it stands. A
            // startForegroundService() still owes startForeground().
            ServiceCompat.startForeground(
                this, EngineNotification.NOTIFICATION_ID, pausedNotification(),
                if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED else 0,
            )
            return START_STICKY
        }
        ServiceCompat.startForeground(
            this,
            EngineNotification.NOTIFICATION_ID,
            EngineNotification.active(this),
            if (Build.VERSION.SDK_INT >= 34)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED
            else 0,
        )
        synchronized(this) { shown = Protection.Active }

        if (tun != null) { // already running (always-on restart)
            // Setting always-on for a running VPN re-delivers this start.
            if (Build.VERSION.SDK_INT >= 29) {
                EngineController.updateFacts { it.copy(alwaysOn = isAlwaysOn, lockdown = isLockdownEnabled) }
            }
            refreshNotification() // startForeground just painted it green
            return START_STICKY
        }

        // Fail-visible: never run without a verified blocklist snapshot.
        // The app installs it (EngineController.apply) before starting us;
        // an always-on cold start goes through SitrApp which re-loads it.
        if (!EngineController.facts.value.blocklistVerified) {
            stopWithWarning(Protection.Reason.BLOCKLIST_LOAD_FAILED)
            return START_NOT_STICKY
        }
        return if (startTunnel()) START_STICKY else START_NOT_STICKY
    }

    /** Establishes the tun and starts filtering; false when it could not (warning shown). */
    private fun startTunnel(): Boolean {
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
            // Sitr stays outside its own tunnel: its sockets (and its
            // "active network") are then the real default network, so the
            // resolvers followDefaultNetwork() reads always belong to the
            // network the forwarded queries leave by.
            .addDisallowedApplication(packageName)
            .apply { if (Build.VERSION.SDK_INT >= 29) setMetered(false) }
            .establish()

        if (established == null) {
            // Consent missing or another VPN holds the slot.
            EngineController.updateFacts {
                it.copy(tunActive = false, revokedAt = System.currentTimeMillis())
            }
            stopWithWarning(Protection.Reason.VPN_REVOKED)
            return false
        }

        tun = established
        val upstream = UpstreamResolver(
            protect = { socket -> protect(socket) },
            protectStream = { socket -> protect(socket) },
        )
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

        // No network at all is not a failure (there is nothing to filter,
        // and the next network reports before DNS can flow), so the facts
        // start clean and followDefaultNetwork() fills in what is known —
        // synchronously, or the first status would always be "no DNS
        // server" and sound the warning on every start.
        EngineController.updateFacts {
            it.copy(
                tunActive = true, revokedAt = 0, hasUpstreams = true, privateDnsStrict = false,
                alwaysOn = if (Build.VERSION.SDK_INT >= 29) isAlwaysOn else null,
                lockdown = if (Build.VERSION.SDK_INT >= 29) isLockdownEnabled else null,
            )
        }
        followDefaultNetwork()
        registerNetworkCallback()
        return true
    }

    private fun beginPause(ms: Long) {
        val now = clocks()
        pauseStart = DelayStamp(now)
        pauseLength = ms
        shutdown() // the tun closes: other apps see no VPN at all
        EngineController.updateFacts { it.copy(tunActive = false, pausedUntil = now.mono + ms) }
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sitr:pause")
            .apply { setReferenceCounted(false); acquire(ms + 60_000) }
        handler.postDelayed(checkPause, ms)
        // Backstop for the timer: an inexact allow-while-idle alarm (no
        // permission; never fires before its time) delivers RESUME to this
        // live, foreground process if the timer has not ended the pause.
        getSystemService(AlarmManager::class.java).setAndAllowWhileIdle(
            AlarmManager.ELAPSED_REALTIME_WAKEUP, now.mono + ms, resumeAlarm(),
        )
        // The wall clock moved: the stricter clock may end the pause now.
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) = checkPause.run()
        }
        ContextCompat.registerReceiver(
            this, receiver, IntentFilter(Intent.ACTION_TIME_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        timeReceiver = receiver
        refreshNotification()
    }

    /** Time is up or "Resume now": protection comes back with no tap. */
    private fun endPause() {
        clearPause()
        if (!EngineController.facts.value.blocklistVerified) {
            stopWithWarning(Protection.Reason.BLOCKLIST_LOAD_FAILED)
            return
        }
        if (!startTunnel()) return
        refreshNotification()
    }

    private fun resumeAlarm(): PendingIntent = PendingIntent.getService(
        this, 3, Intent(this, SitrVpnService::class.java).setAction(ACTION_RESUME),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun clearPause() {
        handler.removeCallbacks(checkPause)
        getSystemService(AlarmManager::class.java).cancel(resumeAlarm())
        timeReceiver?.let(::unregisterReceiver)
        timeReceiver = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        if (pauseStart == null) return
        pauseStart = null
        EngineController.updateFacts { it.copy(pausedUntil = 0) }
    }

    private fun pausedNotification() = EngineNotification.paused(
        this,
        System.currentTimeMillis() + (EngineController.facts.value.pausedUntil - SystemClock.elapsedRealtime()),
    )

    /** The system or another VPN took the slot — the red-badge moment. */
    override fun onRevoke() {
        EngineController.updateFacts {
            it.copy(tunActive = false, revokedAt = System.currentTimeMillis())
        }
        stopWithWarning(Protection.Reason.VPN_REVOKED)
    }

    /**
     * Fail-visible exit: the red notification must outlive the service.
     * Android cancels a foreground service's notification id when the
     * service stops — whatever its flags — so the notification is detached
     * from the service first and only then turned red.
     */
    private fun stopWithWarning(reason: Protection.Reason) {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH)
        EngineNotification.post(this, EngineNotification.inactive(this, reason))
        shutdown()
        stopSelf()
    }

    override fun onDestroy() {
        clearPause()
        shutdown()
        super.onDestroy()
    }

    /**
     * Any change to a non-VPN network is only a TRIGGER: what the engine
     * uses is always re-read from the system's active network, which for
     * this app (excluded from its own tunnel) is the default network its
     * forwarded queries leave by. Taking resolvers from whichever network
     * reported last used the wrong network's resolvers whenever two were
     * visible, and kept a lost network's.
     *
     * (registerDefaultNetworkCallback cannot do this: Android reports a
     * VPN's own network as its owner's default, exclusion or not.)
     *
     * The callback also remembers each non-VPN network's link properties,
     * most recently reported last — the fallback in followDefaultNetwork.
     */
    private fun registerNetworkCallback() {
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = followDefaultNetwork()
            override fun onLost(network: Network) {
                synchronized(seen) { seen.remove(network) }
                followDefaultNetwork()
            }
            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) {
                synchronized(seen) {
                    seen.remove(network)
                    seen[network] = lp
                }
                followDefaultNetwork()
            }
            override fun onCapabilitiesChanged(network: Network, nc: NetworkCapabilities) =
                followDefaultNetwork()
        }
        getSystemService(ConnectivityManager::class.java)
            .registerNetworkCallback(request, callback)
        networkCallback = callback
    }

    /**
     * The default network's resolvers are our upstreams, and its
     * Private-DNS setting decides whether we conflict with it (strict mode →
     * red, surfaced, service keeps running so recovery is instant when the
     * user fixes the setting). With no network the upstream list is empty
     * (queries get no answer) and the last verdict stands.
     */
    private fun followDefaultNetwork() {
        val upstream = resolver ?: return
        val manager = getSystemService(ConnectivityManager::class.java)
        val active = manager.activeNetwork
        val activeIsVpn = active?.let(manager::getNetworkCapabilities)
            ?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        // Should the system ever name a VPN (ours included) as this app's
        // active network, its resolvers are not the ones to forward to:
        // fall back to the non-VPN network that reported last, which is
        // what this engine used before it followed the active network.
        val link =
            if (active != null && !activeIsVpn) manager.getLinkProperties(active)
            else synchronized(seen) { seen.values.lastOrNull() }
        if (upstream.setUpstreams(link?.dnsServers.orEmpty())) forwarder?.clearCaches()
        if (link != null) {
            EngineController.updateFacts {
                it.copy(
                    hasUpstreams = upstream.upstreams.isNotEmpty(),
                    privateDnsStrict = isPrivateDnsStrict(link),
                )
            }
        }
        refreshNotification()
    }

    private fun isPrivateDnsStrict(lp: LinkProperties): Boolean =
        Build.VERSION.SDK_INT >= 28 && lp.isPrivateDnsActive && lp.privateDnsServerName != null

    /**
     * Posts only when the verdict changed: link-property callbacks arrive
     * in bursts, and re-posting a red notification would re-alert each time.
     */
    private fun refreshNotification() {
        val p = EngineController.protection()
        synchronized(this) {
            if (p == shown) return
            shown = p
        }
        val notification = when {
            p == Protection.Inactive(Protection.Reason.PAUSED) -> pausedNotification()
            p is Protection.Active -> EngineNotification.active(this)
            else -> EngineNotification.inactive(this, (p as Protection.Inactive).reason)
        }
        EngineNotification.post(this, notification)
    }

    private fun shutdown() {
        networkCallback?.let {
            getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it)
        }
        networkCallback = null
        synchronized(seen) { seen.clear() }
        loop?.stop()
        loop = null
        resolver?.shutdown()
        resolver = null
        forwarder = null
        tun = null
    }
}
