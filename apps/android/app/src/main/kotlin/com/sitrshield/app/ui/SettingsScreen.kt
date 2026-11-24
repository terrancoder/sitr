package com.sitrshield.app.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.sitrshield.app.HouseholdActions
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx
import com.sitrshield.core.gate.Delay
import com.sitrshield.core.gate.DelayPhase
import kotlinx.coroutines.delay

/**
 * About & privacy — the in-app statement mirrors docs/data-flow.md and
 * docs/privacy-policy.md verbatim in substance (six-way consistency
 * rule). No purchase links anywhere in the app.
 */
@Composable
fun SettingsScreen(ctx: UiCtx) {
    val context = LocalContext.current
    // Read from the installed package: a hardcoded string goes stale with
    // the first release that forgets it.
    val version = remember {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName
    }
    var attributionError by remember { mutableStateOf<String?>(null) }
    // Not on the tab bar: reached from Home's header, left by Back.
    BackLink(onClick = { ctx.navigate(Screen.HOME) })
    ScreenTitle("About & privacy")
    Spacer(Modifier.height(14.dp))
    Column {
        Text("Appearance", style = MaterialTheme.typography.titleMedium)
        AppearanceSelector(ctx)
        Spacer(Modifier.height(12.dp))
        DelaySection(ctx)
        Spacer(Modifier.height(12.dp))
        Text("Privacy", style = MaterialTheme.typography.titleMedium)
        Text(
            "Filtering happens entirely on this device. Sitr transmits no " +
                "browsing history, no URLs, no identifiers, no telemetry, no " +
                "crash reports — in every tier.\n\n" +
                "The Android filter reads DNS lookup names on this device to " +
                "decide block/allow/rewrite; those names are never sent " +
                "anywhere, and allowed lookups go to the DNS server your " +
                "network already uses. They travel unencrypted, so Android's " +
                "automatic encrypted DNS (Private DNS) is not used while Sitr " +
                "is on, and your network operator can see the names, as it " +
                "could without Private DNS.\n\n" +
                "If you use Sitr Family, the only network request is an " +
                "end-to-end encrypted settings blob to sync.sitrshield.com — " +
                "unreadable by the server, tied to no account or email. " +
                "Without a household, the app makes zero network requests.\n\n" +
                "Sitr's accessibility service has two optional uses. While a " +
                "guardian has the child lock on, Sitr reads the text of Settings, " +
                "installer, Play Store and system windows on this device to " +
                "close the screens that would switch it off. While you have " +
                "Reels blocking on, Sitr reads the Facebook app's screen each " +
                "time it changes, only to check whether it is Reels. That text " +
                "is thrown away at once; nothing is stored, logged or sent. " +
                "Sitr reads no other apps.",
            style = MaterialTheme.typography.bodyMedium,
        )
        TextButton(onClick = {
            context.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse("https://sitrshield.com/privacy"))
            )
        }) { Text("Full privacy policy") }
        Spacer(Modifier.height(12.dp))
        Text("Staying protected", style = MaterialTheme.typography.titleMedium)
        Text(
            "For protection that survives reboots, enable Always-on VPN for " +
                "Sitr in system Settings → Network → VPN. Leave \"Block " +
                "connections without VPN\" OFF — Sitr's tunnel carries only " +
                "DNS, so that setting would block everything else.\n\n" +
                "Honestly stated: without the child lock, a determined user " +
                "can uninstall Sitr or turn the VPN off, and the guardian PIN " +
                "is friction, not security. On a child's phone in Sitr Family, " +
                "the child lock (the Child lock tab) keeps protection on until " +
                "the guardian PIN opens it. Keep the pairing code as secret as " +
                "the PIN: whoever has it is a member of the household and can " +
                "change it.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(12.dp))
        // Points at the one filter that can see pictures; Sitr can't check
        // whether it is on, so this stays plain advice, never a status.
        Text("Also turn on", style = MaterialTheme.typography.titleMedium)
        Text(
            "Sitr can't see pictures inside apps. Google Messages can blur nude " +
                "photos and videos on your child's phone: in Family Link, open " +
                "your child → Controls → Contacts, Calls + Texts → Sensitive " +
                "content warnings. It is on by default for supervised children.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(12.dp))
        Text("Open source", style = MaterialTheme.typography.titleMedium)
        Text(
            "Sitr is open source: the app's code is MPL-2.0. The blocklist is " +
                "public, with a written inclusion policy and an appeals process. " +
                "Its data is CC BY-SA 4.0 and built from public lists, credited " +
                "on GitHub. Version $version.",
            style = MaterialTheme.typography.bodyMedium,
        )
        TextButton(onClick = {
            attributionError = try {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ATTRIBUTION_URL)))
                null
            } catch (_: ActivityNotFoundException) {
                "No browser can open this link."
            }
        }) { Text("Blocklist sources and credits") }
        TextButton(onClick = { ctx.navigate(Screen.LICENCE) }) { Text("Licence and credits") }
        attributionError?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = ProtectionRed)
        }
    }
    Spacer(Modifier.height(16.dp))
    TextButton(onClick = { ctx.navigate(Screen.HOME) }) { Text("Back") }
}

private const val ATTRIBUTION_URL =
    "https://github.com/terrancoder/sitr/blob/main/blocklist/imports/ATTRIBUTION.md"

/**
 * System / Light / Dark. Cosmetic only, so it is never PIN-gated; it
 * still flows through SitrApp.update — the single mutation path.
 */
@Composable
private fun AppearanceSelector(ctx: UiCtx) {
    val options = listOf(
        Appearance.SYSTEM to "System",
        Appearance.LIGHT to "Light",
        Appearance.DARK to "Dark",
    )
    Column {
        for ((value, label) in options) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .selectable(
                        selected = ctx.settings.appearance == value,
                        role = Role.RadioButton,
                        onClick = {
                            ctx.app.update { it.copy(appearance = value) }
                        },
                    )
                    .padding(vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(
                    selected = ctx.settings.appearance == value,
                    onClick = null,
                )
                Text(label, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

/** Wording shared with iOS (DelayText in SettingsAboutView.swift). */
object DelayText {
    fun label(minutes: Int): String = when {
        minutes == 0 -> "Off"
        minutes == 60 -> "1 hour"
        minutes < 60 -> "$minutes minutes"
        else -> "${minutes / 60} hours"
    }

    fun remaining(ms: Long): String {
        val total = (ms + 999) / 1000
        val h = total / 3600
        val m = (total % 3600) / 60
        val sec = total % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
    }

    fun status(d: HouseholdActions.DelayState): String = when (d.phase) {
        DelayPhase.OFF -> "Off. Changes apply straight away."
        DelayPhase.IDLE -> "On (${label(d.minutes)}). No request: changes that loosen " +
            "protection are held until you start the wait and it runs out."
        DelayPhase.WAITING -> "Ready in ${remaining(d.remainingMs)}."
        DelayPhase.OPEN -> "Changes open for ${remaining(d.remainingMs)}."
    }

    fun hold(d: HouseholdActions.DelayState): String =
        if (d.phase == DelayPhase.IDLE) {
            "Changes that loosen protection are set to wait ${label(d.minutes)}. Start the wait?"
        } else {
            "Ready in ${remaining(d.remainingMs)}. Then changes stay open for " +
                "${Delay.WINDOW_MS / 60_000} minutes. Try the change again then."
        }
}

/**
 * "Wait before loosening": device-local, never synced. Shortening the
 * wait (or turning it off) goes through the gate and the wait itself;
 * lengthening it is free. Locked, like every other row, under a managed
 * lockOptions.
 */
@Composable
private fun DelaySection(ctx: UiCtx) {
    var d by remember { mutableStateOf<HouseholdActions.DelayState?>(null) }
    // Re-evaluated every second: the status line is the only signal that
    // the wait has ended (no notification, no new permission).
    LaunchedEffect(Unit) {
        while (true) {
            d = ctx.actions.delayState()
            delay(1000)
        }
    }
    val state = d ?: return
    val locked = ctx.app.managedPolicy().lockOptions
    fun refresh() { d = ctx.actions.delayState() }

    Text("Wait before loosening", style = MaterialTheme.typography.titleMedium)
    for (minutes in Delay.MINUTES_ALLOWED) {
        Row(
            Modifier
                .fillMaxWidth()
                .selectable(
                    selected = state.minutes == minutes,
                    enabled = !locked,
                    role = Role.RadioButton,
                    onClick = {
                        if (minutes == state.minutes) return@selectable
                        val save = {
                            ctx.actions.setDelayMinutes(minutes)
                            refresh()
                        }
                        val action = Delay.changeAction(state.minutes, minutes)
                        if (action != null) ctx.attemptAction(action, "Shorten the wait", save) else save()
                    },
                )
                .padding(vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = state.minutes == minutes, onClick = null, enabled = !locked)
            Text(DelayText.label(minutes), style = MaterialTheme.typography.bodyMedium)
        }
    }
    Text(
        DelayText.status(state),
        style = MaterialTheme.typography.bodyMedium,
        color = if (state.phase == DelayPhase.OPEN) ProtectionRed else MaterialTheme.colorScheme.onSurface,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(
            enabled = !locked && state.phase == DelayPhase.IDLE,
            onClick = { ctx.actions.startDelayRequest(); refresh() },
        ) { Text("Start the wait") }
        OutlinedButton(
            enabled = !locked && (state.phase == DelayPhase.WAITING || state.phase == DelayPhase.OPEN),
            onClick = { ctx.actions.cancelDelayRequest(); refresh() },
        ) { Text("Cancel request") }
    }
    if (locked) {
        Text(
            "Settings are locked by your organization.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    Text(
        "When this is on, a change that loosens protection — turning protection " +
            "or a category off, allowing or unblocking a site, joining or leaving a " +
            "household, shortening this wait — is held. Start the wait; when it runs " +
            "out, changes stay open for ${Delay.WINDOW_MS / 60_000} minutes. Restarting " +
            "the phone or changing its clock can restart or cancel the wait. There " +
            "is no notification when it ends: check back here. The wait is local to " +
            "this device: changes made on another device in your household arrive by " +
            "sync and are not held.\n\n" +
            "What it cannot do on Android: it slows down changes made inside Sitr. " +
            "It cannot stop anyone switching the VPN off in Android's settings, or " +
            "uninstalling the app. Turning off the child lock takes the guardian " +
            "PIN and does not wait. For a child's phone, use a household with a " +
            "guardian PIN and the child lock.",
        style = MaterialTheme.typography.bodySmall,
    )
}

/**
 * The licence notice bundled from apps/shared/blocklists/NOTICE.txt (see
 * copyNotice in app/build.gradle.kts): CC BY-SA attribution travels with
 * the lists. The root column already scrolls.
 */
@Composable
fun LicenceScreen(ctx: UiCtx) {
    val context = LocalContext.current
    val notice = remember {
        runCatching { context.assets.open("NOTICE.txt").use { it.readBytes().decodeToString() } }
            .getOrElse { "The licence notice is missing from this build." }
    }
    BackLink(onClick = { ctx.navigate(Screen.SETTINGS) })
    ScreenTitle("Licence and credits")
    Spacer(Modifier.height(14.dp))
    Text(notice, style = MaterialTheme.typography.bodySmall)
    Spacer(Modifier.height(16.dp))
    TextButton(onClick = { ctx.navigate(Screen.SETTINGS) }) { Text("Back") }
}
