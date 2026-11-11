package com.sitrshield.app.ui

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx
import com.sitrshield.app.lock.ChildLock
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.engine.EngineController
import com.sitrshield.engine.EngineNotification
import com.sitrshield.engine.Protection
import com.sitrshield.engine.SitrVpnService
import com.sitrshield.engine.R as EngineR

/**
 * The status home — the in-app twin of the notification badge. Green
 * only when protection is PROVEN active; every failure state carries its
 * reason and a one-tap fix. Sync state never appears here (it lives on
 * the Family screen): sync cannot touch protection status.
 */
@Composable
fun HomeScreen(ctx: UiCtx) {
    val context = LocalContext.current
    val facts by EngineController.facts.collectAsState()
    val protection = EngineController.protection(facts)
    // Android starts an always-on VPN by itself; a running filter is on
    // whatever the switch last said.
    val enabled = ctx.settings.filterEnabled || facts.tunActive

    val consentLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            ctx.app.update { it.copy(filterEnabled = true) }
            SitrVpnService.start(context)
        }
    }

    fun turnOn() {
        val consent = VpnService.prepare(context)
        if (consent != null) {
            consentLauncher.launch(consent)
        } else {
            ctx.app.update { it.copy(filterEnabled = true) }
            SitrVpnService.start(context)
        }
    }

    fun turnOff() {
        ctx.attempt(MutationKind.DISABLE_CATEGORY, "Turn off protection") {
            ctx.app.update { it.copy(filterEnabled = false) }
            SitrVpnService.stop(context)
        }
    }

    Text("Sitr", style = MaterialTheme.typography.headlineMedium)
    Spacer(Modifier.height(12.dp))

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            when {
                !enabled -> {
                    StatusTitle("Filtering is off", locked = false, MaterialTheme.colorScheme.onSurface)
                    Text(
                        "Turn on protection to block adult, gambling and dating " +
                            "sites and enforce SafeSearch — entirely on this device.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Button(onClick = ::turnOn) { Text("Turn on protection") }
                }
                protection is Protection.Active -> {
                    StatusTitle("Protection active", locked = true, MaterialTheme.colorScheme.primary)
                    Text(
                        "Filtering on this device. Nothing leaves it.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    // Switching everything off is the largest loosening
                    // there is, so it takes the same gate as switching
                    // one category off: refused on a child or locked
                    // device, PIN when one is set. (The gate table has no
                    // kind of its own for it — the extension it is shared
                    // with has no global off switch.)
                    OutlinedButton(onClick = ::turnOff) { Text("Turn off") }
                }
                protection is Protection.Inactive -> {
                    StatusTitle("PROTECTION INACTIVE", locked = false, ProtectionRed)
                    Text(
                        EngineNotification.describe(protection.reason),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = ::turnOn) { Text("Re-enable") }
                        // Someone who moved to another VPN on purpose must
                        // be able to say so — same gate as the green state.
                        OutlinedButton(onClick = ::turnOff) { Text("Turn off") }
                    }
                }
            }
        }
    }

    // The notification is the only warning anyone sees without opening
    // the app. When it cannot be delivered, say so here — re-checked on
    // every resume, since the switch lives in system settings.
    val warningsVisible = remember(ctx.resumes) { EngineNotification.warningsVisible(context) }
    if (!warningsVisible) {
        Spacer(Modifier.height(12.dp))
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Warnings are switched off",
                    style = MaterialTheme.typography.titleMedium,
                    color = ProtectionRed,
                )
                Text(
                    "Notifications for Sitr are off, so it cannot warn you if " +
                        "protection stops. You would only find out by opening this app.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedButton(onClick = {
                    context.startActivity(
                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                    )
                }) { Text("Open notification settings") }
            }
        }
    }

    Spacer(Modifier.height(16.dp))
    val active = enabled && protection is Protection.Active
    val disabled = ctx.settings.household?.disabledCategories
        ?: ctx.settings.disabledCategories
    ProtectionRow("Adult content blocking", active)
    ProtectionRow("SafeSearch (Google, Bing, DuckDuckGo)", active)
    ProtectionRow("YouTube Restricted Mode", active)
    ProtectionRow("Gambling", active && "sitr_gambling" !in disabled)
    ProtectionRow("Dating", active && "sitr_dating" !in disabled)

    // The child lock's state belongs next to protection: a guard that has
    // been switched off is exactly what a guardian needs to see.
    val guardWhole = remember(ctx.resumes) { ChildLock.isGuardServiceOn(context) }
    when {
        ctx.settings.childLock && guardWhole -> ProtectionRow("Child lock (Guard mode)", true)
        ctx.settings.childLock -> Text(
            "Child lock is NOT fully on — open Child lock to see what is off.",
            style = MaterialTheme.typography.bodyMedium,
            color = ProtectionRed,
        )
    }

    val managed = ctx.app.managedPolicy()
    if (managed.isManaged) {
        Spacer(Modifier.height(8.dp))
        Text(
            "This device is managed by ${managed.organizationName ?: "your organization"}.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.secondary,
        )
    }

    Spacer(Modifier.height(20.dp))
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(
            onClick = { ctx.navigate(Screen.CATEGORIES) },
            Modifier.fillMaxWidth(),
        ) { Text("Filter categories") }
        OutlinedButton(
            onClick = { ctx.navigate(Screen.LISTS) },
            Modifier.fillMaxWidth(),
        ) { Text("Allow & block lists") }
        OutlinedButton(
            onClick = { ctx.navigate(Screen.FAMILY) },
            Modifier.fillMaxWidth(),
        ) { Text("Sitr Family") }
        OutlinedButton(
            onClick = { ctx.navigate(Screen.CHILD_LOCK) },
            Modifier.fillMaxWidth(),
        ) { Text("Child lock") }
        OutlinedButton(
            onClick = { ctx.navigate(Screen.SETTINGS) },
            Modifier.fillMaxWidth(),
        ) { Text("About & privacy") }
    }
}

/** The status title with the same padlock the status bar shows, in colour. */
@Composable
private fun StatusTitle(text: String, locked: Boolean, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(
            painterResource(if (locked) EngineR.drawable.ic_stat_locked else EngineR.drawable.ic_stat_unlocked),
            contentDescription = null, // the title says it
            tint = color,
            modifier = Modifier.size(32.dp),
        )
        Text(text, style = MaterialTheme.typography.titleLarge, color = color)
    }
}

@Composable
private fun ProtectionRow(label: String, enforced: Boolean) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The label takes the slack and wraps; the status word never
        // does — "enforced" broken across three lines is unreadable.
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
        Text(
            if (enforced) "enforced" else "off",
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            color = if (enforced) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.secondary,
        )
    }
}
