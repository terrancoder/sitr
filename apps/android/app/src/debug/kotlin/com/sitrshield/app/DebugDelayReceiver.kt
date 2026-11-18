package com.sitrshield.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.sitrshield.core.gate.DelayStamp

/**
 * Debug-only test seam (src/debug, absent from release): moves the stored
 * "wait before loosening" request back by `ms` on BOTH clocks, as if that
 * much real time had passed. Not exported; send it as root:
 *   adb root; adb shell am broadcast -n <pkg>/com.sitrshield.app.DebugDelayReceiver --el ms 300000
 */
class DebugDelayReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val ms = intent.getLongExtra("ms", 0)
        val repo = (context.applicationContext as SitrApp).repository
        val s = repo.loosenDelayStamp ?: return
        repo.loosenDelayStamp = DelayStamp((s.atMono - ms).coerceAtLeast(0), (s.atWall - ms).coerceAtLeast(0))
    }
}
