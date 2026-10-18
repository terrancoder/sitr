package com.sitrshield.app.lock

import android.content.ComponentName
import android.content.Context
import android.provider.Settings

/**
 * The child lock (threat-model T7): what stops a child switching Sitr off.
 *
 * Guard mode (docs/child-lock.md) — any phone, no reset. The
 * accessibility guard (GuardService) closes the screens that would switch
 * Sitr off, uninstalling included. No Device Admin: Play's Malware policy
 * forbids using it to block uninstalling. Bypassable by safe mode on
 * phones whose power menu we can't see, which the UI says.
 *
 * It is opened only with the household's guardian PIN — and refused,
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
}
