package com.sitrshield.app.ui

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sitrshield.app.HouseholdActions
import com.sitrshield.app.R
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
    // A pending guardian lock request, checked again once that re-read lands.
    LaunchedEffect(facts.alwaysOn, facts.tunActive, guard) { ctx.actions.refreshChildPolicy() }
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

    ScreenTitle("Child lock")
    Spacer(Modifier.height(14.dp))
    // A guardian's lock request from their phone, waiting for steps 1 and 2.
    if (!ctx.settings.childLock && ctx.actions.lockPending(ctx.settings)) {
        SitrCard(borderColor = ProtectionRed.copy(alpha = 0.45f)) {
            CardTitle("Lock requested")
            Text(HouseholdActions.LOCK_PENDING, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(14.dp))
    }

    when {
        ctx.settings.childLock -> {
            // The lock's own status, as on Home: green only when the guard
            // is whole, red when any part of it is off.
            val container = if (guard) Hero.Green else Hero.Red
            val content = if (guard) Hero.OnGreen else Hero.OnRed
            HeroCard(container = container, content = content, goldRing = guard) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconBadge(
                        if (guard) R.drawable.ic_shield_check else R.drawable.ic_warning,
                        content,
                        large = true,
                    )
                    Text(
                        if (guard) "Guard mode is on" else "Guard mode is NOT fully on",
                        style = MaterialTheme.typography.headlineSmall,
                        modifier = Modifier
                            .weight(1f)
                            .semantics { heading() },
                    )
                }
                Column {
                    LockRow("Accessibility guard", guard, onHero = content)
                    LockRow("Always-on VPN", alwaysOn, onHero = content)
                }
                // A lock armed on the guardian's own phone by mistake must
                // be noticed (tester feedback 2026-11-26).
                if (ctx.settings.role == "guardian") {
                    Text(
                        "This guardian phone is locked. To lock your child's phone, " +
                            "turn this off and set the lock up in Sitr on the child's phone.",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }

            Spacer(Modifier.height(14.dp))
            SitrCard {
                CardTitle("Closed while the lock is on")
                Note("The screens that would switch Sitr off are closed:")
                for (screen in CLOSED_SCREENS) {
                    BulletLine(R.drawable.ic_nav_lock, screen, MaterialTheme.colorScheme.primary)
                }
            }

            Spacer(Modifier.height(14.dp))
            SitrCard {
                CardTitle("Not covered")
                for (gap in NOT_COVERED) {
                    BulletLine(R.drawable.ic_warning, gap, MaterialTheme.colorScheme.onSurfaceVariant)
                }
                RowDivider()
                Text(
                    "Check this screen when you pick the phone up.",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
            }

            Spacer(Modifier.height(14.dp))
            SecondaryButton("Turn off child lock (guardian PIN)", onClick = {
                unlock("Turn off child lock") {
                    ctx.app.update { it.copy(childLock = false) }
                }
            })
        }

        !hasPin -> SitrCard {
            Text(
                "The child lock is part of Sitr Family. Join this phone to your " +
                    "household and set a guardian PIN — the PIN is the only way " +
                    "to open the lock again.",
                style = MaterialTheme.typography.bodyMedium,
            )
            PrimaryButton("Open Sitr Family", onClick = { ctx.navigate(Screen.FAMILY) })
        }

        else -> GuardSetup(ctx, guard, alwaysOn)
    }

    if (adb && hasPin) {
        Spacer(Modifier.height(12.dp))
        Text(
            "USB debugging is on. With a computer it can wipe Sitr, lock and PIN " +
                "included. Turn it off in Developer options before you lock this phone.",
            style = MaterialTheme.typography.bodyMedium,
            color = ProtectionRed,
        )
    }

    note?.let {
        Spacer(Modifier.height(12.dp))
        Text(it, style = MaterialTheme.typography.bodyMedium, color = ProtectionRed)
    }
}

/**
 * What the armed guard closes, and what it does not: the same items, in
 * the same words, as the accessibility service's description
 * (guard_service_description) and the disclosure below. One per line so
 * a guardian can check them off.
 */
private val CLOSED_SCREENS = listOf(
    "Sitr's app info and other settings pages that show Sitr's name",
    "Uninstalling",
    "Sitr's VPN and accessibility settings",
    "The VPN disconnect dialog",
    "Developer options",
    "Adding users",
    "Setting up or opening a private space",
    "Second space and Dual apps (Xiaomi)",
    "The Private DNS dialog",
    "The mobile network reset",
)

private val NOT_COVERED = listOf(
    "A private space, work profile or other user that already exists (Sitr " +
        "filters only this phone's main user, and a private space can still " +
        "be opened from the apps list)",
    "Safe mode and factory reset (Android's own recovery tools)",
    "Settings in a language other than English, Bengali, Arabic, Turkish or " +
        "Malay, or worded differently by the phone maker, except those that " +
        "name Sitr",
    "A browser's own \"Secure DNS\" (the encrypted-DNS switch in Filter " +
        "categories covers well-known providers only)",
    "Apps that use their own DNS server",
    "Phone \"cleaner\" tools that force-stop apps — Android then switches " +
        "the guard off until a guardian turns it back on, and filtering stops " +
        "until Sitr is opened again",
)

/** One line of a list inside a card: a small mark, then the text. */
@Composable
private fun BulletLine(icon: Int, text: String, tint: Color, bold: Boolean = false) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(
            painterResource(icon),
            contentDescription = null,
            tint = tint,
            modifier = Modifier
                .padding(top = 1.dp)
                .size(18.dp),
        )
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (bold) FontWeight.Medium else null,
        )
    }
}

/**
 * Google Play's prominent disclosure for the Accessibility API, word for
 * word in the dialog. One text for both uses of the one service, shown
 * from the child lock and from the Reels switch, so neither skips it.
 */
internal const val GUARD_DISCLOSURE =
    "Sitr's accessibility service does two separate things. Each works only " +
        "while it is switched on in Sitr.\n\n" +
        "Reels blocking in Facebook (your choice). While it is on, each time the " +
        "Facebook app's screen changes, Sitr reads the text and labels on that " +
        "screen (this can include posts, names and comments) only to check " +
        "whether it is Reels. If it is, Sitr switches Facebook to its Home tab " +
        "or presses Back for you. Reel previews in your feed stay visible, and " +
        "Facebook in a browser is not covered.\n\n" +
        "Child lock (set by a guardian). While a guardian has the lock on, Sitr " +
        "reads the text and type of the window in front of you when it is " +
        "Settings, an app installer, the Play Store, a system dialog or, on " +
        "Xiaomi phones, the Second space and Dual apps screens, to " +
        "recognise the screens that would switch Sitr off: its app info and " +
        "other settings pages that show Sitr's name, uninstalling, its VPN and " +
        "accessibility settings, the VPN disconnect dialog, Developer options, " +
        "adding users, setting up or opening a private space, Second space and " +
        "Dual apps (Xiaomi), the Private DNS dialog and the mobile network " +
        "reset. It closes them. The lock opens " +
        "only with the guardian PIN. Sitr filters only this phone's main user: " +
        "a private space, work profile or other user that already exists is " +
        "not filtered, so remove it before you lock the phone.\n\n" +
        "What is kept: nothing. The text stays in this phone's memory only while " +
        "that one screen change is checked, then it is thrown away. Nothing is " +
        "stored, logged or sent anywhere. While Reels blocking is off, Sitr " +
        "receives nothing from Facebook. Sitr reads no other apps."

/** The disclosure dialog's title, shared like the text. */
internal const val GUARD_DISCLOSURE_TITLE = "Before you turn on Sitr's accessibility service"

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
            title = { Text(GUARD_DISCLOSURE_TITLE) },
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
    // Unknown is accepted only before Android 10, which can't report it;
    // later, unknown means the filter isn't running.
    val ready = ChildLock.isReady(guard, alwaysOn, hasPin = true)
    val guardianPhone = ctx.settings.role == "guardian"
    var confirmLock by remember { mutableStateOf(false) }

    fun lock() {
        // Start from clean Settings tasks when the lock is armed:
        // restart both, then come back here.
        val fresh = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { back ->
            runCatching {
                context.startActivities(
                    arrayOf(
                        Intent(Settings.ACTION_SETTINGS).addFlags(fresh),
                        Intent(Settings.ACTION_VPN_SETTINGS).addFlags(fresh),
                        back,
                    ),
                )
            }
        }
        ctx.app.update { it.copy(childLock = true) }
    }

    // A guardian who arms the lock on their own phone locks the wrong
    // phone (tester feedback 2026-11-26): ask first. A child's phone
    // locks straight away.
    if (confirmLock) {
        AlertDialog(
            onDismissRequest = { confirmLock = false },
            title = { Text("Lock this phone?") },
            text = {
                Text(
                    "This is a guardian device. The child lock locks the phone it is " +
                        "turned on on, so Sitr can't be switched off or uninstalled on " +
                        "this phone until the guardian PIN opens it.\n\nTo lock your " +
                        "child's phone, open Sitr on the child's phone and do these steps there.",
                    Modifier.verticalScroll(rememberScrollState()),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmLock = false
                    lock()
                }) { Text("Lock") }
            },
            dismissButton = {
                TextButton(onClick = { confirmLock = false }) { Text("Cancel") }
            },
        )
    }

    SitrCard {
        CardTitle("Guard mode — any phone, no reset")
        if (guardianPhone) {
            BulletLine(
                R.drawable.ic_info,
                "This is a guardian phone. The child lock locks the phone it is set " +
                    "up on: this one. To lock your child's phone, open Sitr on the " +
                    "child's phone and do these steps there.",
                MaterialTheme.colorScheme.primary,
                bold = true,
            )
        }
        Text(
            "Guard mode closes the screens that would switch Sitr off, until the " +
                "guardian PIN opens the lock. Three steps, in this order.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Note(
            "Before you start, remove any private space, work profile or other " +
                "user (Settings → Security & privacy → Private space, Settings → " +
                "System → Users). Sitr doesn't filter them, and they stay open while " +
                "the lock is on.",
        )

        RowDivider()
        LockRow("1. Always-on VPN", alwaysOn)
        if (alwaysOn != true) {
            Note("So no other VPN app can take Sitr's place. After you tap the button:")
            GuideStep('a', "In the VPN list, tap the gear next to Sitr.", "Sitr", MockEnd.GEAR)
            GuideStep('b', "Switch on \"Always-on VPN\".", "Always-on VPN", MockEnd.SWITCH_ON)
            GuideStep(
                'c',
                "Leave \"Block connections without VPN\" off.",
                "Block connections without VPN",
                MockEnd.SWITCH_OFF,
                tap = false,
            )
            OutlinedButton(onClick = {
                context.startActivity(Intent(Settings.ACTION_VPN_SETTINGS))
            }) { Text("Open VPN settings") }
        }

        RowDivider()
        LockRow("2. Accessibility guard", guard)
        if (!guard) {
            Note(
                "Tap the button, read the notice and tap \"I agree\". Then, in " +
                    "Accessibility settings:",
            )
            GuideStep(
                'a',
                "Open \"Downloaded apps\" (on some phones \"Installed apps\").",
                "Downloaded apps",
                MockEnd.CHEVRON,
            )
            GuideStep('b', "Tap \"Sitr guard\".", "Sitr guard", MockEnd.CHEVRON)
            GuideStep('c', "Switch on \"Use Sitr guard\".", "Use Sitr guard", MockEnd.SWITCH_ON)
            GuideStep(
                'd',
                "Tap \"Allow\" when Android asks to confirm.",
                "Allow Sitr guard to have full control of your device?",
                MockEnd.ALLOW,
            )
            Note(
                "On Samsung the list is called \"Installed apps\". On Xiaomi it is " +
                    "\"Downloaded apps\" under Settings → Additional settings → Accessibility.",
            )
            OutlinedButton(onClick = { disclosure = true }) {
                Text("Turn on accessibility guard")
            }

            Spacer(Modifier.height(4.dp))
            SitrCard(contentPadding = PaddingValues(12.dp)) {
                Text(
                    "If the switch is greyed out",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.semantics { heading() },
                )
                Note("Android does this for apps not installed from the Play Store.")
                GuideStep('a', "Open Sitr's App info (Settings → Apps → Sitr).", "App info", MockEnd.MENU)
                GuideStep(
                    'b',
                    "Tap ⋮ at the top right, then \"Allow restricted settings\".",
                    "Allow restricted settings",
                    MockEnd.CHEVRON,
                )
                GuideStep('c', "Come back here and switch \"Use Sitr guard\" on.")
            }
        }

        RowDivider()
        LockRow("3. Lock this phone", false)
        if (ready) {
            // Steps 1 and 2 done is not locked: the accessibility service
            // alone arms nothing (GuardService checks childLock first).
            Row(
                Modifier
                    .fillMaxWidth()
                    .border(1.dp, ProtectionRed.copy(alpha = 0.45f), RoundedCornerShape(12.dp))
                    .padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(
                    painterResource(R.drawable.ic_warning),
                    contentDescription = null,
                    tint = ProtectionRed,
                    modifier = Modifier.size(20.dp),
                )
                Column {
                    Text(
                        "Not locked yet",
                        style = MaterialTheme.typography.titleSmall,
                        color = ProtectionRed,
                    )
                    Text(
                        "Sitr can still be switched off or uninstalled on this phone " +
                            "until you tap \"Lock this phone\".",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        } else if (alwaysOn == null && Build.VERSION.SDK_INT >= 29) {
            Note("Turn on protection on Home first: while Sitr's filter is stopped, step 1 can't be checked.")
        } else {
            Note("Finish steps 1 and 2 first.")
        }
        Button(
            enabled = ready,
            onClick = { if (guardianPhone) confirmLock = true else lock() },
        ) { Text("Lock this phone") }
    }
}

/**
 * One part of the guard and whether it is on. In a card the word takes
 * the status colour; on a hero ([onHero]) everything takes the hero's.
 */
@Composable
private fun LockRow(label: String, ok: Boolean?, onHero: Color? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        // null: Android before 10, or the filter isn't running — can't tell.
        StatusWord(
            when (ok) { true -> "On"; false -> "Off"; null -> "Unknown" },
            ok = ok == true,
            color = onHero ?: when (ok) {
                true -> MaterialTheme.colorScheme.primary
                false -> ProtectionRed
                null -> MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
    }
}
