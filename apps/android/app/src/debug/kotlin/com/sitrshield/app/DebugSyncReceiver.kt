package com.sitrshield.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.sitrshield.app.sync.Endpoints
import com.sitrshield.app.sync.SyncWorker

/**
 * Debug-only test seam (src/debug, absent from release) for sync against
 * the local development servers. Not exported; send it as root:
 *   adb root
 *   adb shell am broadcast -n <pkg>/com.sitrshield.app.DebugSyncReceiver \
 *     --es sync http://127.0.0.1:8787 --es claim http://127.0.0.1:8788
 * Extras, applied in this order: `sync` + `claim` (endpoint override,
 * http://127.0.0.1:<port> only; `--ez reset true` back to the real hosts),
 * `create` (createHousehold with that version 1 token), `code`
 * (saveSubscriptionCode), `removeCode` (removeSubscriptionCode), `run`
 * (one SyncWorker run now, without the network constraint, so it runs in
 * airplane mode over `adb reverse`), `dump` (the claim state and sync
 * status as the broadcast's result; never the code or the claim secret).
 */
class DebugSyncReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as SitrApp
        val actions = HouseholdActions(app)
        val out = mutableListOf<String>()
        if (intent.getBooleanExtra("reset", false)) {
            out += "reset=${Endpoints.setOverride(app, null, null)}"
        }
        val sync = intent.getStringExtra("sync")
        val claim = intent.getStringExtra("claim")
        if (sync != null || claim != null) out += "override=${Endpoints.setOverride(app, sync, claim)}"
        intent.getStringExtra("create")?.let { out += "create=${actions.createHousehold(it.ifEmpty { null })}" }
        intent.getStringExtra("code")?.let { out += "code=${actions.saveSubscriptionCode(it)}" }
        if (intent.getBooleanExtra("removeCode", false)) out += "removeCode=${actions.removeSubscriptionCode()}"
        if (intent.getBooleanExtra("run", false)) {
            WorkManager.getInstance(app).enqueueUniqueWork(
                "sitr-debug-sync",
                ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<SyncWorker>().build(),
            )
            out += "run=enqueued"
        }
        if (intent.getBooleanExtra("dump", false)) {
            val s = app.repository.current()
            out += "endpoints=${Endpoints.sync(app)},${Endpoints.claim(app)}"
            out += "holdsCode=${app.secretStore.loadSubscription() != null}"
            out += "role=${s.role} sync=${s.syncStatus}"
            out += "claims=${s.claims.toJson()}"
        }
        resultData = out.joinToString(" | ")
    }
}
