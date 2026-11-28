package com.sitrshield.app.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import android.view.WindowManager
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.sitrshield.app.HouseholdActions
import com.sitrshield.app.R
import com.sitrshield.app.SitrApp
import com.sitrshield.app.UiCtx
import com.sitrshield.app.sync.SyncWorker
import com.sitrshield.core.SitrResult
import com.sitrshield.core.gate.Gate
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.categories.OptionalLists
import com.sitrshield.core.household.ChildPolicy
import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.sync.QrCode
import com.sitrshield.core.sync.SyncStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date
import kotlin.math.floor

/** The corner of a text field and of the button beside it. */
private val FieldShape = RoundedCornerShape(14.dp)

/**
 * Sitr Family — household create/join, shared lists, guardian PIN,
 * pairing code (guardian-only, PIN-gated: possession IS membership),
 * and sync status. Sync failures state plainly that filtering stays
 * fully active on this device.
 */
@Composable
fun FamilyScreen(ctx: UiCtx) {
    ScreenTitle("Sitr Family")
    Spacer(Modifier.height(14.dp))

    if (ctx.settings.household == null || ctx.settings.role == null) {
        NoHousehold(ctx)
    } else {
        InHousehold(ctx)
    }
}

@Composable
private fun NoHousehold(ctx: UiCtx) {
    var code by rememberSaveable { mutableStateOf("") }
    var joinAsChild by rememberSaveable { mutableStateOf(false) }
    var token by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current

    Text(
        "A household shares its allow/block lists, its guardian PIN and the " +
            "guardian's settings for child phones across every device, " +
            "end-to-end encrypted — the sync server " +
            "cannot read them.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(18.dp))

    SitrCard(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        CardTitle("Join a household")
        OutlinedTextField(
            value = code,
            onValueChange = { code = it; error = null },
            placeholder = { Text("Pairing code (XXXX-XXXX-…)") },
            trailingIcon = {
                // Read only on tap: Android 12+ shows a toast on every clipboard read.
                TextButton(onClick = {
                    context.getSystemService(ClipboardManager::class.java).primaryClip
                        ?.takeIf { it.itemCount > 0 }
                        ?.getItemAt(0)?.coerceToText(context)?.toString()?.trim()
                        ?.let { code = it; error = null }
                }) { Text("Paste") }
            },
            shape = FieldShape,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RoleChoice("Guardian", chosen = !joinAsChild, Modifier.weight(1f)) { joinAsChild = false }
            RoleChoice("Child device", chosen = joinAsChild, Modifier.weight(1f)) { joinAsChild = true }
        }
        PrimaryButton(
            "Join",
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
        )
        if (joinAsChild) {
            Note("Joining as a child device clears this phone's own \"Always allow\" list.")
        }
    }

    Spacer(Modifier.height(14.dp))
    SitrCard(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        CardTitle("Create a household")
        Text(
            "Creating a household on the official sync server uses a Sitr " +
                "Family token.",
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it; error = null },
            placeholder = { Text("sitr-ent-v1.… (paste your token)") },
            shape = FieldShape,
            modifier = Modifier.fillMaxWidth(),
        )
        PrimaryButton(
            "Create household",
            onClick = {
                when (val created = ctx.actions.createHousehold(token)) {
                    is SitrResult.Err -> error = created.message.sentence()
                    is SitrResult.Ok -> {}
                }
            },
        )
    }

    error?.let {
        Spacer(Modifier.height(12.dp))
        Text(it, color = ProtectionRed, style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * The guardian's settings for every child phone (policy.child). Turning
 * something on, or asking for the lock, is gated like adding a household
 * rule; turning something off, or asking to unlock, like removing one.
 */
@Composable
private fun ChildPhones(ctx: UiCtx, household: HouseholdState) {
    val policy = household.child ?: ctx.settings.childPolicy ?: ChildPolicy()
    var error by remember { mutableStateOf<String?>(null) }
    fun done(r: SitrResult<Unit>) { error = (r as? SitrResult.Err)?.message }
    fun set(on: Boolean, offTitle: String, change: (ChildPolicy) -> ChildPolicy) {
        if (on) ctx.attempt(MutationKind.ADD_HOUSEHOLD_RULE, "") { done(ctx.actions.setChildFilters(change)) }
        else ctx.attempt(MutationKind.REMOVE_HOUSEHOLD_RULE, offTitle) { done(ctx.actions.setChildFilters(change)) }
    }
    fun List<String>.with(key: String, on: Boolean) = if (on) this + key else this - key

    SitrCard(verticalArrangement = Arrangement.Top) {
        Note(
            "These settings replace the filter settings on every child phone in this " +
                "household. Anything you leave off here is turned off on the child phones " +
                "too, even if it was switched on there. A change reaches a child phone at " +
                "its next sync, within about 30 minutes, or at once with \"Sync now\" on " +
                "that phone.",
        )
        SwitchRow("Strict Search", policy.strictSearch, strong = true, onCheckedChange = { on ->
            set(on, "Turn off Strict Search on child phones") { it.copy(strictSearch = on) }
        })
        RowDivider()
        for ((key, label) in SitrApp.MEDIA_SITES) {
            SwitchRow("Images and video off on $label", key in policy.mediaOff, onCheckedChange = { on ->
                set(on, "Turn on images and video on $label on child phones") {
                    it.copy(mediaOff = it.mediaOff.with(key, on))
                }
            })
        }
        SwitchRow("Block Reels in the Facebook app", policy.reelsOff, onCheckedChange = { on ->
            set(on, "Turn off Reels blocking on child phones") { it.copy(reelsOff = on) }
        })
        Note("Reels blocking works on a child phone where Sitr guard (Child lock, step 2) is on.")
        RowDivider()
        for (list in OptionalLists.ALL) {
            SwitchRow(list.title, list.id in policy.optionalLists, onCheckedChange = { on ->
                set(on, "Turn off ${list.title} on child phones") {
                    it.copy(optionalLists = it.optionalLists.with(list.id, on))
                }
            })
        }
    }

    Spacer(Modifier.height(14.dp))
    val hasPin = household.pin != null
    SitrCard {
        CardTitle("Lock child phones")
        // Never "locked": this phone knows only what was asked and who confirmed it.
        val lock = policy.lock
        Text(
            if (lock == null) "Not requested"
            else "${if (lock.on) "Lock" else "Unlock"} requested at " +
                "${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(lock.at))}, " +
                "confirmed by ${ChildPolicy.confirmed(policy)} phone(s)",
            style = MaterialTheme.typography.bodyMedium,
        )
        Note(
            "The lock needs steps 1 and 2 of Child lock (always-on VPN and Sitr guard) " +
                "done once on the child's phone; until then that phone waits and then locks " +
                "by itself. This phone sees only what was asked and how many phones " +
                "confirmed it, not whether a phone is locked now.",
        )
        if (!hasPin) Note(HouseholdActions.NEEDS_PIN_FOR_LOCK, color = ProtectionRed)
        PrimaryButton("Lock child phones", enabled = hasPin, onClick = {
            ctx.attempt(MutationKind.ADD_HOUSEHOLD_RULE, "") { done(ctx.actions.requestChildLock(true)) }
        })
        SecondaryButton("Unlock child phones", enabled = hasPin, onClick = {
            ctx.attempt(MutationKind.REMOVE_HOUSEHOLD_RULE, "Unlock child phones") {
                done(ctx.actions.requestChildLock(false))
            }
        })
    }
    error?.let {
        Spacer(Modifier.height(12.dp))
        Text(it, color = ProtectionRed, style = MaterialTheme.typography.bodyMedium)
    }
}

/** One of the two roles to join as. The chosen one is tinted and ticked. */
@Composable
private fun RoleChoice(label: String, chosen: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val primary = MaterialTheme.colorScheme.primary
    OutlinedButton(
        onClick = onClick,
        modifier = modifier
            .heightIn(min = 48.dp)
            .semantics { selected = chosen },
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = if (chosen) primary.copy(alpha = 0.1f) else MaterialTheme.colorScheme.surfaceContainerLow,
            contentColor = if (chosen) primary else MaterialTheme.colorScheme.onSurface,
        ),
        border = BorderStroke(1.dp, if (chosen) primary else MaterialTheme.colorScheme.outline),
    ) {
        if (chosen) {
            Icon(painterResource(R.drawable.ic_check), contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(label, maxLines = 1)
    }
}

@Composable
private fun InHousehold(ctx: UiCtx) {
    val household = ctx.settings.household ?: return
    val role = ctx.settings.role ?: return
    val isGuardian = role == "guardian"
    var revealedCode by remember { mutableStateOf<String?>(null) }
    var newPin by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var hashing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    SitrCard(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconBadge(R.drawable.ic_nav_family, MaterialTheme.colorScheme.primary)
            Column {
                CardTitle("${role.replaceFirstChar { it.uppercase() }} device")
                Text(
                    "${household.devices.size}/${Household.MAX_HOUSEHOLD_DEVICES} devices " +
                        "enrolled (fair use).",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        // How many of the household's places are taken.
        Box(
            Modifier
                .fillMaxWidth()
                .height(6.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(MaterialTheme.colorScheme.outlineVariant),
        ) {
            Box(
                Modifier
                    .fillMaxWidth(
                        (household.devices.size.toFloat() / Household.MAX_HOUSEHOLD_DEVICES).coerceIn(0f, 1f)
                    )
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(3.dp))
                    .background(MaterialTheme.colorScheme.primary),
            )
        }
        RowDivider()
        Text(
            ctx.settings.syncStatus.describe { at ->
                DateFormat.getDateTimeInstance().format(Date(at.toLong()))
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        SecondaryButton("Sync now", onClick = { SyncWorker.kick(ctx.app) })
    }

    // Joined but never synced: this phone doesn't have the household's
    // PIN and lists yet, so there is nothing here it may change.
    val waiting = Household.isJoinPlaceholder(household)
    if (waiting && ctx.settings.syncStatus.state != SyncStatus.State.NOT_FOUND) {
        Spacer(Modifier.height(14.dp))
        SitrCard {
            Text(HouseholdActions.WAITING_FOR_FIRST_SYNC, style = MaterialTheme.typography.bodyMedium)
        }
    }

    if (isGuardian && !waiting) {
        Spacer(Modifier.height(14.dp))
        SitrCard {
            CardTitle("Pairing")
            if (revealedCode == null) {
                PrimaryButton("Show pairing code", onClick = {
                    ctx.requirePin("Show the pairing code") {
                        revealedCode = ctx.actions.pairingCode()
                    }
                })
            } else {
                // The code IS household membership: keep it out of screenshots
                // and the recents preview for as long as it is on screen.
                val window = LocalActivity.current?.window
                DisposableEffect(Unit) {
                    window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
                }
                val code = revealedCode!!
                val context = LocalContext.current
                var copied by remember { mutableStateOf(false) }
                // Selectable, so it can be copied instead of retyped by hand.
                SelectionContainer {
                    Text(
                        code,
                        style = MaterialTheme.typography.titleMedium,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                PairingQr(code, Modifier.align(Alignment.CenterHorizontally))
                // Sitr for Android has no camera permission and does not scan.
                Note(
                    "The other phone can also scan this QR code: with its camera " +
                        "app (then copy the text), or with the Sitr app on an iPhone.",
                )
                SecondaryButton("Copy code", onClick = {
                    copySensitive(context, "Sitr pairing code", code)
                    // Android 13+ confirms a copy itself; say it only below that.
                    copied = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                })
                if (copied) Note("Copied.")
                Note(
                    "Paste it on the other phone under Sitr Family → Join a household. " +
                        "The clipboard keeps the code until something else is copied.",
                )
                Text(
                    "Anyone with this code IS a member of your household — " +
                        "treat it like a house key.",
                    style = MaterialTheme.typography.bodySmall,
                    color = ProtectionRed,
                )
                TextButton(onClick = { revealedCode = null }) { Text("Hide") }
            }
        }

        Spacer(Modifier.height(14.dp))
        val hasPin = household.pin != null
        SitrCard {
            CardTitle(if (hasPin) "Change the guardian PIN" else "Set a guardian PIN")
            Text(
                if (hasPin)
                    "A PIN is set. It gates loosening actions on every household device."
                else
                    "No PIN set. A PIN adds friction against casual loosening — " +
                        "on its own it is not a security boundary. With the child " +
                        "lock on a child's phone, it is the only way to switch " +
                        "protection off.",
                style = MaterialTheme.typography.bodyMedium,
            )
            // The order, spelled out: people could not tell whether the PIN
            // dialog wanted the old PIN or the new one again.
            Note(
                if (hasPin)
                    "1. Type the new PIN below and tap Change PIN.\n" +
                        "2. Sitr asks for your current (old) PIN to confirm.\n" +
                        "3. The new PIN then works on every household device once they sync."
                else
                    "Type a PIN below and tap Set PIN. It then works on every " +
                        "household device once they sync.",
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Left readable on purpose: there is no "repeat PIN" field,
                // and a mistyped PIN nobody can see would lock the guardian
                // out of every loosening action. The password keyboard still
                // stops the keyboard from learning it.
                OutlinedTextField(
                    value = newPin,
                    onValueChange = { newPin = it },
                    placeholder = { Text(if (hasPin) "New PIN (4–32 characters)" else "PIN (4–32 characters)") },
                    keyboardOptions = PinKeyboard,
                    singleLine = true,
                    enabled = !hashing,
                    shape = FieldShape,
                    modifier = Modifier.weight(1f),
                )
                Button(
                    // New PIN first, then the current one in the dialog.
                    enabled = !hashing && newPin.isNotEmpty(),
                    shape = FieldShape,
                    modifier = Modifier.heightIn(min = 56.dp),
                    onClick = {
                        ctx.attempt(MutationKind.CHANGE_PIN, CHANGE_PIN_TITLE) {
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
                ) { Text(if (hashing) "Saving…" else if (hasPin) "Change PIN" else "Set PIN") }
            }
        }

        Spacer(Modifier.height(24.dp))
        SectionLabel("Household lists")
        SitrCard(borderColor = ListTone.ALLOW.edge()) {
            DomainListEditor(
                title = "Household allow list",
                tone = ListTone.ALLOW,
                domains = household.allowDomains,
                refuse = ctx.app::alwaysBlocked,
                onAdd = { domain, done ->
                    // An allow rule beats every list block except adult
                    // (on Android also gambling and dating), so it is loosening:
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
        }
        Spacer(Modifier.height(14.dp))
        SitrCard(borderColor = ListTone.BLOCK.edge()) {
            DomainListEditor(
                title = "Household block list",
                tone = ListTone.BLOCK,
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

        Spacer(Modifier.height(24.dp))
        SectionLabel("Child phones")
        ChildPhones(ctx, household)

        Spacer(Modifier.height(24.dp))
        SectionLabel("Devices")
        SitrCard {
            // Beside the count: the list holds only random ids, so the only way
            // to free a gone device's place is to clear it and let the live
            // devices add themselves back. Gated like changing the PIN.
            Note(
                "Use this when a phone is gone (lost, sold, Sitr removed) but still " +
                    "takes a place. The list empties; every phone still in the household " +
                    "adds itself back at its next sync, within about 30 minutes. " +
                    "Nothing is removed from any phone.",
            )
            SecondaryButton("Reset device list", onClick = {
                ctx.attempt(Gate.REFRESH_DEVICE_LIST_GATED_AS, "Reset the device list") {
                    message = when (val done = ctx.actions.refreshDeviceList()) {
                        is SitrResult.Err -> done.message
                        is SitrResult.Ok -> {
                            val n = ctx.app.repository.current().household?.devices?.size ?: 0
                            "The household now lists $n ${if (n == 1) "device" else "devices"}. " +
                                "The number rises again as its devices sync."
                        }
                    }
                }
            })
        }
    }

    Spacer(Modifier.height(18.dp))
    var confirmLeave by remember { mutableStateOf(false) }
    OutlinedButton(
        onClick = {
            if (ctx.settings.childLock) {
                message = "Turn off the child lock before you leave the household."
            } else {
                val asPlaceholder = ctx.actions.leavesAsJoinPlaceholder()
                ctx.attempt(MutationKind.LEAVE_HOUSEHOLD, "Leave the household") {
                    // The PIN dialog is the confirmation when there is a PIN.
                    if (household.pin == null) confirmLeave = true
                    else (ctx.actions.leaveHousehold(asPlaceholder) as? SitrResult.Err)?.let { message = it.message }
                }
            }
        },
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = ProtectionRed),
        border = BorderStroke(1.dp, ProtectionRed.copy(alpha = 0.5f)),
    ) {
        Icon(painterResource(R.drawable.ic_exit), contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Leave household")
    }
    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text("Leave this household?") },
            text = {
                Text(
                    "This phone forgets the household. If no other device has the " +
                        "pairing code, the household can't be joined again.",
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
        Spacer(Modifier.height(12.dp))
        Text(it, style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * The pairing code as a QR code: exactly the canonical string
 * (sync-protocol.md §Pairing code). Black on white with a 4-module quiet
 * zone in both themes; scanners expect dark modules on a light ground.
 */
@Composable
private fun PairingQr(code: String, modifier: Modifier = Modifier) {
    val modules = remember(code) { QrCode.encode(code) }
    Canvas(modifier.size(220.dp).semantics { contentDescription = "Pairing code as a QR code" }) {
        val cells = modules.size + 8
        // Whole pixels per module: fractional ones leave hairline seams.
        val cell = floor(size.minDimension / cells)
        val origin = floor((size.minDimension - cell * cells) / 2) + 4 * cell
        drawRect(Color.White)
        for (row in modules.indices) for (col in modules.indices) {
            if (modules[row][col]) {
                drawRect(Color.Black, Offset(origin + col * cell, origin + row * cell), Size(cell, cell))
            }
        }
    }
}

/** Marked sensitive, so the clipboard preview hides it (honoured from Android 13). */
private fun copySensitive(context: Context, label: String, text: String) {
    val clip = ClipData.newPlainText(label, text)
    clip.description.extras = PersistableBundle().apply {
        putBoolean(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) ClipDescription.EXTRA_IS_SENSITIVE
            else "android.content.extra.IS_SENSITIVE",
            true,
        )
    }
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
}

/** Core messages are lower-case fragments (shared with the other ports); show them as sentences. */
private fun String.sentence() = replaceFirstChar { it.uppercase() }
