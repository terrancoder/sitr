package com.sitrshield.app.ui

import android.view.WindowManager
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.sitrshield.app.HouseholdActions
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx
import com.sitrshield.app.sync.SyncWorker
import com.sitrshield.core.SitrResult
import com.sitrshield.core.gate.Gate
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.household.Household
import com.sitrshield.core.sync.CodeInput
import com.sitrshield.core.sync.Entitlement
import com.sitrshield.core.sync.FamilyPlan
import com.sitrshield.core.sync.SyncStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
    var code by rememberSaveable { mutableStateOf("") }
    var joinAsChild by rememberSaveable { mutableStateOf(false) }
    var token by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    var confirmMove by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

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
            ctx.attemptJoin {
                when (val joined = ctx.actions.joinHousehold(
                    code, if (joinAsChild) "child" else "guardian",
                )) {
                    is SitrResult.Err -> error = joined.message.sentence()
                    is SitrResult.Ok -> {}
                }
            }
        },
        Modifier.fillMaxWidth(),
    ) { Text("Join") }
    if (joinAsChild) {
        Text(
            "Joining as a child device clears this phone's own \"Always allow\" list.",
            style = MaterialTheme.typography.bodySmall,
        )
    }

    Spacer(Modifier.height(16.dp))
    Text("Create a household", style = MaterialTheme.typography.titleMedium)
    Text(
        "Creating a household on the official sync server uses your Sitr " +
            "Family subscription code, from the welcome page after you " +
            "subscribed on sitrshield.com. A Sitr Family token " +
            "(sitr-ent-v1.…) still works too.",
        style = MaterialTheme.typography.bodyMedium,
    )
    OutlinedTextField(
        value = token,
        onValueChange = { token = it; error = null },
        label = { Text("Subscription code or token") },
        placeholder = { Text("xxxxxxxx-xxxx-… or sitr-ent-v1.…") },
        singleLine = true,
        enabled = !creating,
        modifier = Modifier.fillMaxWidth(),
    )
    fun create(replace: Boolean) {
        val input = token
        creating = true
        scope.launch {
            val created = withContext(Dispatchers.IO) { ctx.actions.createHousehold(input, replace) }
            creating = false
            when (created) {
                HouseholdActions.CreateOutcome.Created -> token = ""
                HouseholdActions.CreateOutcome.ConfirmMove -> confirmMove = true
                is HouseholdActions.CreateOutcome.Refused -> error = created.message.sentence()
            }
        }
    }
    Button(
        enabled = !creating,
        onClick = {
            if (Entitlement.classifyCodeInput(token) is CodeInput.Code) {
                // A code is entering a subscription code: gated like the PIN.
                ctx.attempt(Gate.SUBSCRIPTION_GATED_AS, "Create a household") { create(replace = false) }
            } else {
                when (val created = ctx.actions.createHousehold(token)) {
                    is HouseholdActions.CreateOutcome.Refused -> error = created.message.sentence()
                    else -> {}
                }
            }
        },
        modifier = Modifier.fillMaxWidth(),
    ) { Text(if (creating) "Checking the subscription…" else "Create household") }
    if (confirmMove) {
        AlertDialog(
            onDismissRequest = { confirmMove = false },
            title = { Text("Renew on this phone?") },
            text = {
                Text(
                    "This subscription is renewed by another claim: another device, or " +
                        "this phone before it left a household (a new household with the " +
                        "same subscription in the same month always needs this). Move the " +
                        "renewals to this phone? This can be moved once every 180 days.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmMove = false
                    ctx.attempt(Gate.SUBSCRIPTION_GATED_AS, "Renew on this phone") { create(replace = true) }
                }) { Text("Move to this phone") }
            },
            dismissButton = { TextButton(onClick = { confirmMove = false }) { Text("Cancel") } },
        )
    }

    error?.let {
        Spacer(Modifier.height(8.dp))
        Text(
            it,
            color = ProtectionRed,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}

@Composable
private fun InHousehold(ctx: UiCtx) {
    val household = ctx.settings.household ?: return
    val isGuardian = ctx.settings.role == "guardian"
    var revealedCode by remember { mutableStateOf<String?>(null) }
    var newPin by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var hashing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

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

    // The code lives outside the settings: re-read it on every settings
    // change and resume, and after this screen saves or removes it.
    var codeEdits by remember { mutableIntStateOf(0) }
    val holdsCode = remember(ctx.settings, ctx.resumes, codeEdits) { ctx.app.secretStore.loadSubscription() != null }
    FamilyPlanBlock(ctx, isGuardian, holdsCode, { codeEdits++ }) { message = it }

    // Joined but never synced: this phone doesn't have the household's
    // PIN and lists yet, so there is nothing here it may change.
    val waiting = Household.isJoinPlaceholder(household)
    if (waiting && ctx.settings.syncStatus.state != SyncStatus.State.NOT_FOUND) {
        Spacer(Modifier.height(12.dp))
        Text(HouseholdActions.WAITING_FOR_FIRST_SYNC, style = MaterialTheme.typography.bodyMedium)
    }

    if (isGuardian && !waiting) {
        // Beside the count: the list holds only random ids, so the only way
        // to free a gone device's place is to clear it and let the live
        // devices add themselves back. Gated like changing the PIN.
        Text(
            "Clears the household's device list. Each device that still uses " +
                "this household adds itself again the next time it syncs: within " +
                "about 30 minutes, or when Sitr is opened on it. Use it to free " +
                "the places of devices that are gone.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.secondary,
        )
        OutlinedButton(onClick = {
            ctx.attempt(Gate.REFRESH_DEVICE_LIST_GATED_AS, "Refresh the device list") {
                message = when (val done = ctx.actions.refreshDeviceList()) {
                    is SitrResult.Err -> done.message
                    is SitrResult.Ok -> {
                        val n = ctx.app.repository.current().household?.devices?.size ?: 0
                        "The household now lists $n ${if (n == 1) "device" else "devices"}. " +
                            "The number rises again as its devices sync."
                    }
                }
            }
        }) { Text("Refresh device list") }

        Spacer(Modifier.height(12.dp))
        Text("Pairing", style = MaterialTheme.typography.titleMedium)
        if (revealedCode == null) {
            OutlinedButton(onClick = {
                ctx.requirePin("Show the pairing code") {
                    revealedCode = ctx.actions.pairingCode()
                }
            }) { Text("Show pairing code") }
        } else {
            // The code IS household membership: keep it out of screenshots
            // and the recents preview for as long as it is on screen.
            val window = LocalActivity.current?.window
            DisposableEffect(Unit) {
                window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
            }
            // Selectable, so it can be copied instead of retyped by hand.
            SelectionContainer {
                Text(
                    revealedCode!!,
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                )
            }
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
                    "on its own it is not a security boundary. With the child " +
                    "lock on a child's phone, it is the only way to switch " +
                    "protection off.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // Left readable on purpose: there is no "repeat PIN" field,
            // and a mistyped PIN nobody can see would lock the guardian
            // out of every loosening action. The password keyboard still
            // stops the keyboard from learning it.
            OutlinedTextField(
                value = newPin,
                onValueChange = { newPin = it },
                placeholder = { Text("New PIN (4–32 chars)") },
                keyboardOptions = PinKeyboard,
                singleLine = true,
                enabled = !hashing,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                enabled = !hashing,
                onClick = {
                    ctx.attempt(MutationKind.CHANGE_PIN, "Change the guardian PIN") {
                        val entered = newPin
                        hashing = true
                        scope.launch {
                            // PBKDF2 — seconds on a budget phone, so not here
                            // on the main thread.
                            val created = withContext(Dispatchers.Default) {
                                ctx.actions.createPinRecord(entered)
                            }
                            hashing = false
                            when (created) {
                                is SitrResult.Err -> message = created.message.sentence()
                                is SitrResult.Ok -> {
                                    ctx.actions.setPin(created.value)
                                    newPin = ""
                                    message = "PIN updated."
                                }
                            }
                        }
                    }
                },
            ) { Text(if (hashing) "Saving…" else "Set") }
        }

        Spacer(Modifier.height(12.dp))
        Text("Household lists", style = MaterialTheme.typography.titleMedium)
        DomainListEditor(
            title = "Household allow list",
            domains = household.allowDomains,
            refuse = ctx.app::adultListed,
            onAdd = { domain, done ->
                // An allow rule beats every category block except the
                // adult list on every device, so adding one is loosening:
                // same kind the extension gates it with (PIN when set).
                ctx.attempt(
                    MutationKind.ADD_DEVICE_ALLOW_RULE,
                    "Allow $domain on every household device",
                ) {
                    when (val added = ctx.actions.addHouseholdDomain(allow = true, domain = domain)) {
                        is SitrResult.Err -> message = added.message.sentence()
                        is SitrResult.Ok -> done()
                    }
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
                    when (val added = ctx.actions.addHouseholdDomain(allow = false, domain = domain)) {
                        is SitrResult.Err -> message = added.message.sentence()
                        is SitrResult.Ok -> done()
                    }
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
    var confirmLeave by remember { mutableStateOf(false) }
    OutlinedButton(onClick = {
        if (ctx.settings.childLock) {
            message = "Turn off the child lock before you leave the household."
        } else if (holdsCode) {
            // The warning first; the PIN (when set) after it.
            confirmLeave = true
        } else {
            val asPlaceholder = ctx.actions.leavesAsJoinPlaceholder()
            ctx.attempt(MutationKind.LEAVE_HOUSEHOLD, "Leave the household") {
                // The PIN dialog is the confirmation when there is a PIN.
                if (household.pin == null) confirmLeave = true
                else (ctx.actions.leaveHousehold(asPlaceholder) as? SitrResult.Err)?.let { message = it.message }
            }
        }
    }) { Text("Leave household") }
    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text("Leave this household?") },
            text = {
                Text(
                    "This phone forgets the household. If no other device has the " +
                        "pairing code, the household can't be joined again." +
                        if (holdsCode) "\n\nThis phone renews the Family plan. Leaving removes " +
                            "the subscription code from it, and the household runs only " +
                            "until its end date unless the code is entered on another " +
                            "guardian device." else "",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmLeave = false
                    // Again: the dialog can sit open past the wait's window.
                    val asPlaceholder = ctx.actions.leavesAsJoinPlaceholder()
                    ctx.attempt(MutationKind.LEAVE_HOUSEHOLD, "Leave the household") {
                        (ctx.actions.leaveHousehold(asPlaceholder) as? SitrResult.Err)?.let { message = it.message }
                    }
                }) { Text("Leave") }
            },
            dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text("Cancel") } },
        )
    }

    message?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * The Family plan: the household's end date and the specification's texts
 * (FamilyPlan.view), and on a guardian device the code controls, each
 * gated as Gate.SUBSCRIPTION_GATED_AS.
 */
@Composable
private fun FamilyPlanBlock(
    ctx: UiCtx,
    isGuardian: Boolean,
    holdsCode: Boolean,
    codeChanged: () -> Unit,
    say: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var code by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf(false) }
    var confirmRenew by remember { mutableStateOf(false) }
    // Re-read on every settings change and resume: the texts depend on the clock.
    val now = remember(ctx.settings, ctx.resumes) { System.currentTimeMillis().toDouble() }
    val view = FamilyPlan.view(
        ctx.settings.claims, now, holdsCode, isGuardian, ctx.settings.planNotAccepted, HouseholdActions::date,
    )
    // A version 1 household with no code here: nothing to say, no block.
    if (view.lines.isEmpty() && !isGuardian) return

    fun offMain(title: String, action: () -> SitrResult<Unit>, done: () -> Unit = {}) {
        ctx.attempt(Gate.SUBSCRIPTION_GATED_AS, title) {
            busy = true
            scope.launch {
                val r = withContext(Dispatchers.IO) { action() }
                busy = false
                when (r) {
                    is SitrResult.Err -> say(r.message.sentence())
                    is SitrResult.Ok -> done()
                }
            }
        }
    }

    Spacer(Modifier.height(12.dp))
    Text("Family plan", style = MaterialTheme.typography.titleMedium)
    Column(Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }) {
        for (line in view.lines) Text(line, style = MaterialTheme.typography.bodyMedium)
    }
    if (view.enterCode) {
        OutlinedTextField(
            value = code,
            onValueChange = { code = it },
            label = { Text("Subscription code") },
            placeholder = { Text("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedButton(enabled = !busy, onClick = {
            ctx.attempt(Gate.SUBSCRIPTION_GATED_AS, "Enter the subscription code") {
                when (val saved = ctx.actions.saveSubscriptionCode(code)) {
                    is SitrResult.Err -> say(saved.message.sentence())
                    is SitrResult.Ok -> {
                        codeChanged()
                        code = ""
                        say("Code saved. This phone renews the Family plan from now on.")
                    }
                }
            }
        }) { Text("Save code") }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (view.tryAgain) {
            OutlinedButton(enabled = !busy, onClick = { offMain("Try again", ctx.actions::tryAgain) }) {
                Text("Try again")
            }
        }
        if (view.renewHere) {
            OutlinedButton(enabled = !busy, onClick = { confirmRenew = true }) { Text("Renew on this phone") }
        }
    }
    if (view.removeCode) {
        OutlinedButton(enabled = !busy, onClick = { confirmRemove = true }) { Text("Remove code") }
    }

    if (confirmRemove) {
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            title = { Text("Remove the subscription code?") },
            text = { Text("Renewals stop on this phone. The household keeps working until its end date.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmRemove = false
                    ctx.attempt(Gate.SUBSCRIPTION_GATED_AS, "Remove the subscription code") {
                        val end = ctx.app.repository.current().claims.entExp
                        when (val removed = ctx.actions.removeSubscriptionCode()) {
                            is SitrResult.Err -> say(removed.message.sentence())
                            is SitrResult.Ok -> {
                                codeChanged()
                                say(
                                    if (end != null) Entitlement.TEXTS.getValue("code-removed")
                                        .replace("{date}", HouseholdActions.date(end))
                                    else "This device no longer renews the subscription."
                                )
                            }
                        }
                    }
                }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text("Cancel") } },
        )
    }
    if (confirmRenew) {
        AlertDialog(
            onDismissRequest = { confirmRenew = false },
            title = { Text("Renew on this phone?") },
            text = {
                Text(
                    "The renewals move from the other device to this phone. " +
                        "This can be moved once every 180 days.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmRenew = false
                    offMain("Renew on this phone", ctx.actions::renewHere) {
                        say("This phone renews the Family plan now.")
                    }
                }) { Text("Move to this phone") }
            },
            dismissButton = { TextButton(onClick = { confirmRenew = false }) { Text("Cancel") } },
        )
    }
}

/** Core messages are lower-case fragments (shared with the other ports); show them as sentences. */
private fun String.sentence() = replaceFirstChar { it.uppercase() }
