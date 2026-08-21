package com.sitrshield.app.ui

import android.app.Activity
import android.net.VpnService
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx
import com.sitrshield.engine.EngineController
import com.sitrshield.engine.EngineNotification
import com.sitrshield.engine.Protection
import com.sitrshield.engine.SitrVpnService

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
    val enabled = ctx.settings.filterEnabled

    val consentLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            ctx.app.applySettings(ctx.app.repository.current().copy(filterEnabled = true))
            SitrVpnService.start(context)
        }
    }

    fun turnOn() {
        val consent = VpnService.prepare(context)
        if (consent != null) {
            consentLauncher.launch(consent)
        } else {
            ctx.app.applySettings(ctx.app.repository.current().copy(filterEnabled = true))
            SitrVpnService.start(context)
        }
    }

    Text("Sitr", style = MaterialTheme.typography.headlineMedium)
    Spacer(Modifier.height(12.dp))

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            when {
                !enabled -> {
                    Text(
                        "Filtering is off",
                        style = MaterialTheme.typography.titleLarge,
                    )
                    Text(
                        "Turn on protection to block adult, gambling and dating " +
                            "sites and enforce SafeSearch — entirely on this device.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Button(onClick = ::turnOn) { Text("Turn on protection") }
                }
                protection is Protection.Active -> {
                    Text(
                        "Protection active",
                        style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Text(
                        "Filtering on this device. Nothing leaves it.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    OutlinedButton(onClick = {
                        ctx.app.applySettings(
                            ctx.app.repository.current().copy(filterEnabled = false)
                        )
                        SitrVpnService.stop(context)
                    }) { Text("Turn off") }
                }
                protection is Protection.Inactive -> {
                    Text(
                        "PROTECTION INACTIVE",
                        style = MaterialTheme.typography.titleLarge,
                        color = ProtectionRed,
                    )
                    Text(
                        EngineNotification.describe(protection.reason),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Button(onClick = ::turnOn) { Text("Re-enable") }
                }
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
            onClick = { ctx.navigate(Screen.SETTINGS) },
            Modifier.fillMaxWidth(),
        ) { Text("About & privacy") }
    }
}

@Composable
private fun ProtectionRow(label: String, enforced: Boolean) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(
            if (enforced) "enforced" else "off",
            style = MaterialTheme.typography.bodyMedium,
            color = if (enforced) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.secondary,
        )
    }
}
