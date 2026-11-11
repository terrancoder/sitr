package com.sitrshield.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

/**
 * The persistent notification IS the badge (fail-visible): green
 * "protection active" while the foreground service runs, red
 * "PROTECTION INACTIVE: <reason>" the moment it provably isn't. Colors
 * mirror the extension's badgeFor (#1a7f37 / #c62828). The notification
 * never mentions sync — sync state can't touch protection status.
 */
object EngineNotification {
    /**
     * DEFAULT importance, silenced: Android hides LOW ("silent") channels'
     * icons from the status bar, so on the old "sitr.protection" (LOW)
     * channel a protected phone showed no Sitr icon at all. Importance is
     * fixed once a channel exists, hence the new id.
     */
    const val CHANNEL_ID = "sitr.status"
    private const val LEGACY_CHANNEL_ID = "sitr.protection"

    /**
     * Red states get their own channel: a channel's importance is fixed
     * once created, and "protection has stopped" must not arrive silently
     * in the low-importance channel the green state lives in.
     */
    const val ALERT_CHANNEL_ID = "sitr.alert"
    const val NOTIFICATION_ID = 1

    private const val GREEN = 0xff1a7f37.toInt()
    private const val RED = 0xffc62828.toInt()

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Protection status",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "The padlock in the status bar while Sitr's filtering is active"
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(
                ALERT_CHANNEL_ID,
                "Protection warnings",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Shown when Sitr's filtering has stopped"
            }
        )
    }

    /**
     * False when the red warning cannot be shown: notifications denied
     * for the app (Android 13+ asks, and "Don't allow" is one tap) or the
     * warnings channel switched off. The home screen says so — otherwise
     * the only warning visible outside the app fails silently.
     */
    fun warningsVisible(context: Context): Boolean {
        ensureChannel(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        return manager.areNotificationsEnabled() &&
            manager.getNotificationChannel(ALERT_CHANNEL_ID)?.importance !=
            NotificationManager.IMPORTANCE_NONE
    }

    /**
     * Locked = protected, open padlock with "!" = not protected. The status
     * bar shows only the silhouette (Android paints it one colour), so the
     * two shapes carry the state there; the green/red colour shows in the
     * notification shade and on the app's home card.
     */
    private fun builder(context: Context, channel: String, icon: Int): NotificationCompat.Builder {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val contentIntent = launch?.let {
            PendingIntent.getActivity(
                context, 0, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        return NotificationCompat.Builder(context, channel)
            .setSmallIcon(icon)
            .setContentIntent(contentIntent)
    }

    fun active(context: Context): Notification =
        builder(context, CHANNEL_ID, R.drawable.ic_stat_locked)
            .setOnlyAlertOnce(true)
            .setContentTitle("Sitr — protection active")
            .setContentText("Filtering on this device. Nothing leaves it.")
            .setColor(GREEN)
            .setColorized(true) // honoured: this one belongs to the foreground service
            .setOngoing(true)
            .build()

    /**
     * Deliberately NOT only-alert-once: this replaces the green
     * notification under the same id, and that flag would mute exactly
     * the update that matters. The service posts it once per state
     * change, so it cannot repeat.
     */
    fun inactive(context: Context, reason: Protection.Reason): Notification =
        builder(context, ALERT_CHANNEL_ID, R.drawable.ic_stat_unlocked)
            .setContentTitle("Sitr — PROTECTION INACTIVE")
            .setContentText(describe(reason))
            .setStyle(NotificationCompat.BigTextStyle().bigText(describe(reason)))
            .setColor(RED)
            .setColorized(true)
            .build()

    fun describe(reason: Protection.Reason): String = when (reason) {
        Protection.Reason.NOT_RUNNING -> "Filtering is off. Tap to re-enable."
        Protection.Reason.VPN_REVOKED ->
            "The VPN was turned off or replaced by another app. Tap to re-enable."
        Protection.Reason.PRIVATE_DNS_STRICT ->
            "Private DNS is set to a fixed host and bypasses filtering. " +
                "Set it to Automatic in network settings."
        Protection.Reason.BLOCKLIST_LOAD_FAILED ->
            "The blocklist failed verification. Reinstall the app."
        Protection.Reason.NO_UPSTREAMS ->
            "The network offered no DNS server. Check the connection."
    }

    /** The user switched protection off on purpose: no warning is due. */
    fun cancel(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }

    fun post(context: Context, notification: Notification) {
        context.getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, notification)
    }
}
