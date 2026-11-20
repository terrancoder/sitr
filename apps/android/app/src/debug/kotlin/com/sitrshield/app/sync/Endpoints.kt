package com.sitrshield.app.sync

import android.content.Context
import com.sitrshield.core.sync.ClaimClient
import com.sitrshield.core.sync.SyncClient

/**
 * Debug builds only (src/debug; release has the constants alone): the two
 * hosts, or a local development server set by DebugSyncReceiver. Only
 * http://127.0.0.1:<port> is accepted, and debug's network security config
 * allows cleartext to 127.0.0.1 and nothing else.
 */
object Endpoints {
    const val SYNC = SyncClient.DEFAULT_BASE_URL
    const val CLAIM = ClaimClient.DEFAULT_BASE_URL

    private val LOCAL = Regex("http://127\\.0\\.0\\.1:[0-9]{1,5}")

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences("sitr-debug-endpoints", Context.MODE_PRIVATE)

    fun sync(context: Context): String = prefs(context).getString("sync", null) ?: SYNC

    fun claim(context: Context): String = prefs(context).getString("claim", null) ?: CLAIM

    /** Both hosts to `local` (e.g. sync 8787, claim 8788), or back to the
     * constants with nulls. Anything but http://127.0.0.1:<port> is refused. */
    fun setOverride(context: Context, sync: String?, claim: String?): Boolean {
        if (listOfNotNull(sync, claim).any { !LOCAL.matches(it) }) return false
        prefs(context).edit().putString("sync", sync).putString("claim", claim).commit()
        return true
    }
}
