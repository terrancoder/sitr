package com.sitrshield.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
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
    Text("About & privacy", style = MaterialTheme.typography.headlineSmall)
    Spacer(Modifier.height(8.dp))
    Column {
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
                "Without a household, the app makes zero network requests.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(12.dp))
        Text("Staying protected", style = MaterialTheme.typography.titleMedium)
        Text(
            "For protection that survives reboots, enable Always-on VPN for " +
                "Sitr in system Settings → Network → VPN. Leave \"Block " +
                "connections without VPN\" OFF — Sitr's tunnel carries only " +
                "DNS, so that setting would block everything else.\n\n" +
                "Honestly stated: on an unmanaged device, a determined user " +
                "can uninstall Sitr or turn the VPN off — Android offers no " +
                "legitimate way to prevent that, and Sitr refuses illegitimate " +
                "ones. The guardian PIN is friction, not security. Real " +
                "enforcement comes from managed devices (Family Link or an " +
                "organization's management).",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(12.dp))
        Text("Open source", style = MaterialTheme.typography.titleMedium)
        Text(
            "Sitr is open source (MPL-2.0). The blocklist is public, with a " +
                "written inclusion policy and an appeals process. Version 0.1.0.",
            style = MaterialTheme.typography.bodyMedium,
        )
    }
    Spacer(Modifier.height(16.dp))
    TextButton(onClick = { ctx.navigate(Screen.HOME) }) { Text("Back") }
}
