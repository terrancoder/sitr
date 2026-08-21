package com.sitrshield.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx
import com.sitrshield.app.sync.SyncWorker
import com.sitrshield.core.SitrResult
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.household.Household
import java.text.DateFormat
import java.util.Date

/**
 * Sitr Family — household create/join, shared lists, guardian PIN,
 * pairing code (guardian-only, PIN-gated: possession IS membership),
 * and sync status. Sync failures state plainly that filtering stays
 * fully active on this device.
 */
@Composable
fun FamilyScreen(ctx: UiCtx) {
    Text("Sitr Family", style = MaterialTheme.typography.headlineSmall)
    Spacer(Modifier.height(8.dp))

    if (ctx.settings.household == null || ctx.settings.role == null) {
        NoHousehold(ctx)
    } else {
        InHousehold(ctx)
    }

    Spacer(Modifier.height(16.dp))
    TextButton(onClick = { ctx.navigate(Screen.HOME) }) { Text("Back") }
}

@Composable
private fun NoHousehold(ctx: UiCtx) {
    var code by remember { mutableStateOf("") }
    var joinAsChild by remember { mutableStateOf(false) }
    var token by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    Text(
        "A household shares its allow/block lists and category settings " +
            "across every device, end-to-end encrypted — the sync server " +
            "cannot read them.",
        style = MaterialTheme.typography.bodyMedium,
    )
    Spacer(Modifier.height(12.dp))

    Text("Join a household", style = MaterialTheme.typography.titleMedium)
    OutlinedTextField(
        value = code,
        onValueChange = { code = it; error = null },
        placeholder = { Text("Pairing code (XXXX-XXXX-…)") },
        modifier = Modifier.fillMaxWidth(),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { joinAsChild = false }) {
            Text(if (!joinAsChild) "✓ Guardian" else "Guardian")
        }
        OutlinedButton(onClick = { joinAsChild = true }) {
            Text(if (joinAsChild) "✓ Child device" else "Child device")
        }
    }
    Button(
        onClick = {
            when (val joined = ctx.actions.joinHousehold(
                code, if (joinAsChild) "child" else "guardian",
            )) {
                is SitrResult.Err -> error = joined.message
                is SitrResult.Ok -> {}
            }
        },
        Modifier.fillMaxWidth(),
    ) { Text("Join") }

    Spacer(Modifier.height(16.dp))
    Text("Create a household", style = MaterialTheme.typography.titleMedium)
    Text(
        "Creating a household on the official sync server uses a Sitr " +
            "Family token.",
        style = MaterialTheme.typography.bodyMedium,
    )
    OutlinedTextField(
        value = token,
        onValueChange = { token = it; error = null },
        placeholder = { Text("sitr-ent-v1.… (paste your token)") },
        modifier = Modifier.fillMaxWidth(),
    )
    Button(
        onClick = {
            when (val created = ctx.actions.createHousehold(token)) {
                is SitrResult.Err -> error = created.message
                is SitrResult.Ok -> {}
            }
        },
        Modifier.fillMaxWidth(),
    ) { Text("Create household") }

    error?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, color = ProtectionRed, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun InHousehold(ctx: UiCtx) {
    val household = ctx.settings.household ?: return
    val isGuardian = ctx.settings.role == "guardian"
    var revealedCode by remember { mutableStateOf<String?>(null) }
    var newPin by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }

    Text(
        "This device is a ${ctx.settings.role} device. " +
            "${household.devices.size}/${Household.MAX_HOUSEHOLD_DEVICES} devices " +
            "enrolled (fair use).",
        style = MaterialTheme.typography.bodyMedium,
    )
    Text(
        ctx.settings.syncStatus.describe { at ->
            DateFormat.getDateTimeInstance().format(Date(at.toLong()))
        },
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.secondary,
    )
    OutlinedButton(onClick = { SyncWorker.kick(ctx.app) }) { Text("Sync now") }

    if (isGuardian) {
        Spacer(Modifier.height(12.dp))
        Text("Pairing", style = MaterialTheme.typography.titleMedium)
        if (revealedCode == null) {
            OutlinedButton(onClick = {
                ctx.requirePin("Show the pairing code") {
                    revealedCode = ctx.actions.pairingCode()
                }
            }) { Text("Show pairing code") }
        } else {
            Text(
                revealedCode!!,
                style = MaterialTheme.typography.bodyMedium,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                "Anyone with this code IS a member of your household — " +
                    "treat it like a house key.",
                style = MaterialTheme.typography.bodySmall,
                color = ProtectionRed,
            )
            TextButton(onClick = { revealedCode = null }) { Text("Hide") }
        }

        Spacer(Modifier.height(12.dp))
        Text("Guardian PIN", style = MaterialTheme.typography.titleMedium)
        Text(
            if (household.pin != null)
                "A PIN is set. It gates loosening actions on every household device."
            else
                "No PIN set. A PIN adds friction against casual loosening — " +
                    "it is not a security boundary, and we say so plainly.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = newPin,
                onValueChange = { newPin = it },
                placeholder = { Text("New PIN (4–32 chars)") },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = {
                ctx.attempt(MutationKind.CHANGE_PIN, "Change the guardian PIN") {
                    when (val set = ctx.actions.setPin(newPin)) {
                        is SitrResult.Err -> message = set.message
                        is SitrResult.Ok -> {
                            newPin = ""
                            message = "PIN updated."
                        }
                    }
                }
            }) { Text("Set") }
        }

        Spacer(Modifier.height(12.dp))
        Text("Household lists", style = MaterialTheme.typography.titleMedium)
        DomainListEditor(
            title = "Household allow list",
            domains = household.allowDomains,
            onAdd = { domain, done ->
                ctx.attempt(MutationKind.ADD_HOUSEHOLD_RULE, "") {
                    ctx.actions.addHouseholdDomain(allow = true, domain = domain)
                    done()
                }
            },
            onRemove = { domain ->
                ctx.attempt(MutationKind.REMOVE_HOUSEHOLD_RULE, "Remove $domain") {
                    ctx.actions.removeHouseholdDomain(allow = true, domain = domain)
                }
            },
        )
        Spacer(Modifier.height(8.dp))
        DomainListEditor(
            title = "Household block list",
            domains = household.blockDomains,
            onAdd = { domain, done ->
                ctx.attempt(MutationKind.ADD_HOUSEHOLD_RULE, "") {
                    ctx.actions.addHouseholdDomain(allow = false, domain = domain)
                    done()
                }
            },
            onRemove = { domain ->
                ctx.attempt(MutationKind.REMOVE_HOUSEHOLD_RULE, "Remove $domain") {
                    ctx.actions.removeHouseholdDomain(allow = false, domain = domain)
                }
            },
        )
    }

    Spacer(Modifier.height(12.dp))
    OutlinedButton(onClick = {
        ctx.attempt(MutationKind.LEAVE_HOUSEHOLD, "Leave the household") {
            ctx.actions.leaveHousehold()
        }
    }) { Text("Leave household") }

    message?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, style = MaterialTheme.typography.bodyMedium)
    }
}
