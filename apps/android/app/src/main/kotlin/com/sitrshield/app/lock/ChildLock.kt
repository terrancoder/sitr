package com.sitrshield.app.lock

import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.provider.Settings
import com.sitrshield.engine.EngineController

/**
 * The child lock (threat-model T7): what stops a child switching Sitr off.
 *
 * Guard mode (docs/child-lock.md) — any phone, no reset. The
 * accessibility guard (GuardService) closes the screens that would switch
 * Sitr off, uninstalling included. No Device Admin: Play's Malware policy
 * forbids using it to block uninstalling. Bypassable by safe mode and
 * factory reset, which it leaves alone (Play's Accessibility policy); the
 * UI says so.
 *
 * It is opened only with the household's guardian PIN (on the phone, or
 * by an unlock request from a guardian phone, which takes the PIN there) — and refused,
 * not waved through, when this device has no PIN (a cleared app must not
 * become an unlocked app).
 */
object ChildLock {
    /** adb can clear Sitr's data, PIN and lock included; the guard can't see it. */
    fun isUsbDebuggingOn(context: Context): Boolean =
        Settings.Global.getInt(context.contentResolver, Settings.Global.ADB_ENABLED, 0) == 1

    fun isGuardServiceOn(context: Context): Boolean {
        val enabled = Settings.Secure.getString(
            context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        val me = ComponentName(context, GuardService::class.java)
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    /**
     * Steps 1 and 2 done and a PIN to open the lock with. Always-on
     * unknown counts only before Android 10, which can't report it.
     */
    fun isReady(guard: Boolean, alwaysOn: Boolean?, hasPin: Boolean): Boolean =
        hasPin && guard && (alwaysOn ?: (Build.VERSION.SDK_INT < 29))

    /** The same, read now (a guardian's lock request from a sync). */
    fun isReady(context: Context, hasPin: Boolean): Boolean {
        val facts = EngineController.facts.value
        // The fact outlives a stopped VPN; stopped means not protected.
        return isReady(isGuardServiceOn(context), facts.alwaysOn.takeIf { facts.tunActive }, hasPin)
    }
}
