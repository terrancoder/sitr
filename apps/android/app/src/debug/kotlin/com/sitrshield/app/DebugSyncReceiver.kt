package com.sitrshield.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.sitrshield.app.sync.Endpoints

/**
 * Debug-only test seam (src/debug, absent from release): points both hosts
 * at the local development servers. Not exported; send it as root:
 *   adb root
 *   adb shell am broadcast -n <pkg>/com.sitrshield.app.DebugSyncReceiver \
 *     --es sync http://127.0.0.1:8787 --es claim http://127.0.0.1:8788
 * `--ez reset true` goes back to the real hosts. Only
 * http://127.0.0.1:<port> is accepted.
 */
class DebugSyncReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        resultData = if (intent.getBooleanExtra("reset", false)) {
            "reset=${Endpoints.setOverride(app, null, null)}"
        } else {
            val sync = intent.getStringExtra("sync")
            val claim = intent.getStringExtra("claim")
            "override=${Endpoints.setOverride(app, sync, claim)} sync=${Endpoints.sync(app)} claim=${Endpoints.claim(app)}"
        }
    }
}
