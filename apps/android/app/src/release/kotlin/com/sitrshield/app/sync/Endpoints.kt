package com.sitrshield.app.sync

import android.content.Context
import com.sitrshield.core.sync.ClaimClient
import com.sitrshield.core.sync.SyncClient

/**
 * The two hosts the app talks to (docs/data-flow.md), as constants. The
 * debug build has its own Endpoints (src/debug) that can point both at a
 * local development server; the release build has only these.
 */
object Endpoints {
    const val SYNC = SyncClient.DEFAULT_BASE_URL
    const val CLAIM = ClaimClient.DEFAULT_BASE_URL

    @Suppress("UNUSED_PARAMETER")
    fun sync(context: Context): String = SYNC

    @Suppress("UNUSED_PARAMETER")
    fun claim(context: Context): String = CLAIM
}
