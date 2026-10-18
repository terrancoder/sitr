package com.sitrshield.app.ui

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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx

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
    Text("About & privacy", style = MaterialTheme.typography.headlineSmall)
    Spacer(Modifier.height(8.dp))
    Column {
        Text("Appearance", style = MaterialTheme.typography.titleMedium)
        AppearanceSelector(ctx)
        Spacer(Modifier.height(12.dp))
        Text("Privacy", style = MaterialTheme.typography.titleMedium)
        Text(
            "Filtering happens entirely on this device. Sitr transmits no " +
                "browsing history, no URLs, no identifiers, no telemetry, no " +
                "crash reports — in every tier.\n\n" +
                "The Android filter reads DNS lookup names on this device to " +
                "decide block/allow/rewrite; those names are never sent " +
                "anywhere, and allowed lookups go to the DNS server your " +
                "network already uses.\n\n" +
                "If you use Sitr Family, the only network request is an " +
                "end-to-end encrypted settings blob to sync.sitrshield.com — " +
                "unreadable by the server, tied to no account or email. " +
                "Without a household, the app makes zero network requests.\n\n" +
                "The optional child lock uses Android's Accessibility service: " +
                "while a guardian has it on, Sitr reads the text of Settings, " +
                "installer, Play Store and system windows on this device to " +
                "close the screens that would switch it off. That text is " +
                "discarded at once; nothing is stored or sent.",
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
                "the child lock (Home → Child lock) makes the PIN the only way " +
                "to switch protection off.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(12.dp))
        Text("Open source", style = MaterialTheme.typography.titleMedium)
        Text(
            "Sitr is open source (MPL-2.0). The blocklist is public, with a " +
                "written inclusion policy and an appeals process. Version $version.",
            style = MaterialTheme.typography.bodyMedium,
        )
    }
    Spacer(Modifier.height(16.dp))
    TextButton(onClick = { ctx.navigate(Screen.HOME) }) { Text("Back") }
}

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
