package com.sitrshield.app.ui

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx
import com.sitrshield.app.lock.ChildLock
import com.sitrshield.engine.EngineController
import com.sitrshield.engine.SitrVpnService

/**
 * Child lock — Guard mode (the accessibility guard). Turning
 * it on is tightening and never gated; turning it off takes the
 * household's guardian PIN, and is refused — not waved through — when
 * this device has no PIN.
 */
@Composable
fun ChildLockScreen(ctx: UiCtx) {
    val context = LocalContext.current
    val facts by EngineController.facts.collectAsState()
    // System settings change behind the app's back: re-read on resume.
    val guard = remember(ctx.resumes) { ChildLock.isGuardServiceOn(context) }
    val adb = remember(ctx.resumes) { ChildLock.isUsbDebuggingOn(context) }
    // Switching always-on on for the VPN that is already connected doesn't
    // restart it (HyperOS, Android 16), so the fact would stay "off" after
    // the parent comes back from Settings. A start to the running service
    // re-reads it.
    LaunchedEffect(ctx.resumes) { if (facts.tunActive) SitrVpnService.start(context) }
    // The fact outlives a stopped VPN; stopped means not protected.
    val alwaysOn = facts.alwaysOn.takeIf { facts.tunActive }
    val hasPin = ctx.settings.household?.pin != null
    var note by remember { mutableStateOf<String?>(null) }

    fun unlock(title: String, action: () -> Unit) {
        if (!hasPin) {
            note = "This phone has no guardian PIN, so the lock can't be opened here. " +
                "Sync it with your Sitr Family household first."
        } else {
            ctx.requirePin(title, action)
        }
    }

    Text("Child lock", style = MaterialTheme.typography.headlineSmall)
    Spacer(Modifier.height(8.dp))

    when {
        ctx.settings.childLock -> Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    if (guard) "Guard mode is on" else "Guard mode is NOT fully on",
                    style = MaterialTheme.typography.titleLarge,
                    color = if (guard) MaterialTheme.colorScheme.primary else ProtectionRed,
                )
                LockRow("Accessibility guard", guard)
                LockRow("Always-on VPN", alwaysOn)
                Text(
                    "The screens that would switch Sitr off are closed: its app " +
                        "info, uninstalling, its VPN and accessibility settings, the " +
                        "VPN disconnect dialog, Developer options, adding users and " +
                        "factory reset. " +
                        "Not covered: restarting into safe mode on phones where that " +
                        "is done with the volume keys, settings shown in a language " +
                        "other than English except those that name Sitr, and phone " +
                        "\"cleaner\" tools that force-stop apps — Android then " +
                        "switches the guard off until a guardian turns it back on, " +
                        "and filtering stops until Sitr is opened again. " +
                        "Check this screen when you pick the phone up.",
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedButton(onClick = {
                    unlock("Turn off child lock") {
                        ctx.app.update { it.copy(childLock = false) }
                    }
                }) { Text("Turn off child lock (guardian PIN)") }
            }
        }

        !hasPin -> Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "The child lock is part of Sitr Family. Join this phone to your " +
                        "household and set a guardian PIN — the PIN is the only way " +
                        "to open the lock again.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Button(onClick = { ctx.navigate(Screen.FAMILY) }) { Text("Open Sitr Family") }
            }
        }

        else -> GuardSetup(ctx, guard, alwaysOn)
    }

    if (adb && hasPin) {
        Spacer(Modifier.height(8.dp))
        Text(
            "USB debugging is on. With a computer it can wipe Sitr, lock and PIN " +
                "included. Turn it off in Developer options before you lock this phone.",
            style = MaterialTheme.typography.bodyMedium,
            color = ProtectionRed,
        )
    }

    note?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, style = MaterialTheme.typography.bodyMedium, color = ProtectionRed)
    }

    Spacer(Modifier.height(16.dp))
    TextButton(onClick = { ctx.navigate(Screen.HOME) }) { Text("Back") }
}

/** Google Play's prominent disclosure for the Accessibility API, word for word in the dialog. */
private const val GUARD_DISCLOSURE =
    "Sitr's child lock uses Android's Accessibility service. While a guardian " +
        "has the lock on, Sitr reads the text of the window in front of you when " +
        "it is Settings, an app installer, the Play Store or a system dialog, to " +
        "recognise the screens that would switch Sitr off — its app info, " +
        "uninstalling, its VPN and accessibility settings, the VPN disconnect dialog, " +
        "Developer options, adding users, factory reset and safe mode — and " +
        "closes them. The text is checked on this phone and discarded at once: " +
        "nothing is stored, and nothing is sent anywhere. Sitr doesn't read other " +
        "apps, and the lock opens only with the guardian PIN."

/**
 * Guard mode setup. Always-on VPN comes before the guard, because the
 * armed guard closes the VPN screens. The accessibility
 * step opens the disclosure dialog first: only its "I agree" opens
 * accessibility settings — Back, a tap outside or "No thanks" doesn't.
 */
@Composable
private fun GuardSetup(ctx: UiCtx, guard: Boolean, alwaysOn: Boolean?) {
    val context = LocalContext.current
    var disclosure by remember { mutableStateOf(false) }
    if (disclosure) {
        AlertDialog(
            onDismissRequest = { disclosure = false },
            title = { Text("Before you turn on the accessibility guard") },
            // Scrolls: at large font sizes the whole disclosure must stay readable.
            text = { Text(GUARD_DISCLOSURE, Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = {
                TextButton(onClick = {
                    disclosure = false
                    context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                }) { Text("I agree") }
            },
            dismissButton = {
                TextButton(onClick = { disclosure = false }) { Text("No thanks") }
            },
        )
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Guard mode — any phone, no reset", style = MaterialTheme.typography.titleMedium)
            Text(
                "Guard mode closes the screens that would switch Sitr off, so " +
                    "protection stays on until the guardian PIN opens the lock. " +
                    "It takes two steps.",
                style = MaterialTheme.typography.bodyMedium,
            )

            LockRow("1. Always-on VPN", alwaysOn)
            Text(
                "Set Sitr as the always-on VPN so no other VPN app can take its " +
                    "place. Leave \"Block connections without VPN\" off.",
                style = MaterialTheme.typography.bodySmall,
            )
            OutlinedButton(onClick = {
                context.startActivity(Intent(Settings.ACTION_VPN_SETTINGS))
            }) { Text("Open VPN settings") }

            LockRow("2. Accessibility guard", guard)
            Text(
                "In the list, open \"Sitr child lock\" and switch it on. If the " +
                    "switch is greyed out, open Sitr's App info, tap ⋮ and " +
                    "\"Allow restricted settings\" first.",
                style = MaterialTheme.typography.bodySmall,
            )
            OutlinedButton(onClick = { disclosure = true }) {
                Text("Turn on accessibility guard")
            }

            Button(
                // Unknown is accepted only before Android 10, which can't
                // report it; later, unknown means the filter isn't running.
                enabled = guard && (alwaysOn ?: (Build.VERSION.SDK_INT < 29)),
                onClick = { ctx.app.update { it.copy(childLock = true) } },
            ) { Text("Lock this phone") }
        }
    }
}

@Composable
private fun LockRow(label: String, ok: Boolean?) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        // null: Android before 10, or the filter isn't running — can't tell.
        Text(
            when (ok) { true -> "on"; false -> "off"; null -> "unknown" },
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            color = when (ok) {
                true -> MaterialTheme.colorScheme.primary
                false -> ProtectionRed
                null -> MaterialTheme.colorScheme.secondary
            },
        )
    }
}
