package com.sitrshield.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx
import com.sitrshield.core.SitrResult
import com.sitrshield.core.domains.DomainInput
import com.sitrshield.core.gate.MutationKind

/**
 * Device allow/block lists. These never leave the device. Per the
 * ladder: adding an allow or removing a block is loosening (PIN-gated);
 * adding a block or removing an allow never is. Input runs through the
 * same normalizer as the extension.
 */
@Composable
fun ListsScreen(ctx: UiCtx) {
    Text("Allow & block lists", style = MaterialTheme.typography.headlineSmall)
    Spacer(Modifier.height(4.dp))
    Text(
        "These lists apply on this device only and never leave it. " +
            "Household lists are managed on the Sitr Family screen.",
        style = MaterialTheme.typography.bodyMedium,
    )
    Spacer(Modifier.height(12.dp))

    DomainListEditor(
        title = "Always allow these sites",
        domains = ctx.settings.userAllow,
        onAdd = { domain, done ->
            ctx.attempt(MutationKind.ADD_DEVICE_ALLOW_RULE, "Allow $domain") {
                ctx.actions.addDeviceDomain(allow = true, domain = domain)
                done()
            }
        },
        onRemove = { domain ->
            // Tightening — never gated.
            ctx.attempt(MutationKind.REMOVE_DEVICE_ALLOW_RULE, "") {
                ctx.actions.removeDeviceDomain(allow = true, domain = domain)
            }
        },
    )

    Spacer(Modifier.height(16.dp))

    DomainListEditor(
        title = "Always block these sites",
        domains = ctx.settings.userBlock,
        onAdd = { domain, done ->
            ctx.attempt(MutationKind.ADD_DEVICE_BLOCK_RULE, "") {
                ctx.actions.addDeviceDomain(allow = false, domain = domain)
                done()
            }
        },
        onRemove = { domain ->
            ctx.attempt(MutationKind.REMOVE_DEVICE_BLOCK_RULE, "Unblock $domain") {
                ctx.actions.removeDeviceDomain(allow = false, domain = domain)
            }
        },
    )

    Spacer(Modifier.height(16.dp))
    TextButton(onClick = { ctx.navigate(Screen.HOME) }) { Text("Back") }
}

@Composable
fun DomainListEditor(
    title: String,
    domains: List<String>,
    onAdd: (String, () -> Unit) -> Unit,
    onRemove: (String) -> Unit,
) {
    var input by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    Text(title, style = MaterialTheme.typography.titleMedium)
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = input,
            onValueChange = { input = it; error = null },
            placeholder = { Text("example.com") },
            singleLine = true,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = {
            when (val normalized = DomainInput.normalize(input)) {
                is SitrResult.Err -> error = normalized.message
                is SitrResult.Ok -> onAdd(normalized.value) { input = "" }
            }
        }) { Text("Add") }
    }
    error?.let {
        Text(it, style = MaterialTheme.typography.bodySmall, color = ProtectionRed)
    }
    Column {
        for (domain in domains) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(domain, style = MaterialTheme.typography.bodyMedium)
                TextButton(onClick = { onRemove(domain) }) { Text("Remove") }
            }
        }
        if (domains.isEmpty()) {
            Text(
                "None yet.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
            )
        }
    }
}
