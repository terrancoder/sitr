package com.sitrshield.app.boot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.VpnService
import com.sitrshield.app.SitrApp
import com.sitrshield.engine.EngineNotification
import com.sitrshield.engine.Protection
import com.sitrshield.engine.SitrVpnService

/**
 * Boot re-arm. Always-on VPN is the primary restart story; this receiver
 * covers non-always-on setups: restart the service when the user wanted
 * filtering on and consent still stands, and show the red notification
 * when it can't come back — a device that silently boots unprotected is
 * the fail-visible rule's core case.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val app = context.applicationContext as SitrApp
        if (!app.repository.current().filterEnabled) return
        if (VpnService.prepare(context) == null) {
            SitrVpnService.start(context)
        } else {
            EngineNotification.ensureChannel(context)
            EngineNotification.post(
                context,
                EngineNotification.inactive(context, Protection.Reason.VPN_REVOKED),
            )
        }
    }
}
