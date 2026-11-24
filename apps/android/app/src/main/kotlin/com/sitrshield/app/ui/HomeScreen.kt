package com.sitrshield.app.ui

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.SystemClock
import android.provider.Settings
import android.text.format.DateFormat
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedIconButton
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sitrshield.app.R
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx
import com.sitrshield.app.lock.ChildLock
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.gate.Pause
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
 *
 * The status is a block of colour (HeroCard): green for proven-active,
 * red for not protected, plain paper when filtering was switched off on
 * purpose. The other screens are on the tab bar; About is the header's
 * button.
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

    // The status notification's "Pause" opens the app here, once.
    var pauseSheet by remember {
        val intent = (context as? Activity)?.intent
        mutableStateOf(intent?.getBooleanExtra(EngineNotification.EXTRA_OPEN_PAUSE, false) == true)
            .also { intent?.removeExtra(EngineNotification.EXTRA_OPEN_PAUSE) }
    }

    val paused = facts.pausedUntil != 0L
    val active = enabled && protection is Protection.Active

    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(
            painterResource(
                if (LocalSitrDark.current) R.drawable.ic_sitr_mark_dark else R.drawable.ic_sitr_mark
            ),
            contentDescription = null, // the name beside it says it
            modifier = Modifier.size(30.dp),
        )
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "Sitr",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .alignByBaseline()
                    .semantics { heading() },
            )
            Text(
                "سِتْر",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Normal,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.alignByBaseline(),
            )
        }
        OutlinedIconButton(
            onClick = { ctx.navigate(Screen.SETTINGS) },
            colors = IconButtonDefaults.outlinedIconButtonColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                contentColor = MaterialTheme.colorScheme.onSurface,
            ),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Icon(painterResource(R.drawable.ic_info), contentDescription = "About & privacy")
        }
    }
    Spacer(Modifier.height(16.dp))

    when {
        // First: always-on can run a pause with the switch off.
        paused -> HeroCard(container = Hero.Red, content = Hero.OnRed) {
            IconBadge(EngineR.drawable.ic_stat_unlocked, Hero.OnRed, large = true)
            HeroText(
                "Paused until ${clockTime(context, facts.pausedUntil)}",
                "Nothing on this phone is filtered until then. Protection " +
                    "comes back by itself.",
                Hero.OnRedSoft,
            )
            // Tightening: no gate.
            HeroButton(
                "Resume now",
                onClick = { SitrVpnService.resume(context) },
                container = Hero.OnRed,
                content = Hero.RedInk,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        // Switched off on purpose: neither green nor red, and no rings.
        !enabled -> HeroCard(
            container = MaterialTheme.colorScheme.surfaceVariant,
            content = MaterialTheme.colorScheme.onSurface,
            rings = false,
        ) {
            IconBadge(EngineR.drawable.ic_stat_unlocked, MaterialTheme.colorScheme.onSurface, large = true)
            HeroText(
                "Filtering is off",
                "Turn on protection to block adult, gambling and dating " +
                    "sites and enforce SafeSearch — entirely on this device.",
                MaterialTheme.colorScheme.onSurface,
            )
            PrimaryButton("Turn on protection", onClick = ::turnOn)
        }
        protection is Protection.Active -> HeroCard(
            container = Hero.Green,
            content = Hero.OnGreen,
            goldRing = true,
        ) {
            IconBadge(EngineR.drawable.ic_stat_locked, Hero.OnGreen, large = true)
            HeroText(
                "Protection active",
                "Browse clean. Stay private.",
                Hero.OnGreenSoft,
            )
            // Switching everything off is the largest loosening
            // there is, so it takes the same gate as switching
            // one category off: refused on a child or locked
            // device, PIN when one is set. (The gate table has no
            // kind of its own for it — the extension it is shared
            // with has no global off switch.)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                HeroButton(
                    "Pause",
                    onClick = { pauseSheet = true },
                    container = Hero.OnGreen,
                    content = Hero.GreenInk,
                    modifier = Modifier.weight(1f),
                    icon = R.drawable.ic_pause,
                )
                HeroOutlinedButton(
                    "Turn off",
                    onClick = ::turnOff,
                    content = Hero.OnGreen,
                    modifier = Modifier.weight(1f),
                    icon = R.drawable.ic_power,
                )
            }
        }
        protection is Protection.Inactive -> HeroCard(container = Hero.Red, content = Hero.OnRed) {
            IconBadge(EngineR.drawable.ic_stat_unlocked, Hero.OnRed, large = true)
            HeroText(
                "Protection inactive",
                EngineNotification.describe(protection.reason),
                Hero.OnRedSoft,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                HeroButton(
                    "Re-enable",
                    onClick = ::turnOn,
                    container = Hero.OnRed,
                    content = Hero.RedInk,
                    modifier = Modifier.weight(1f),
                    icon = R.drawable.ic_refresh,
                )
                // Someone who moved to another VPN on purpose must
                // be able to say so — same gate as the green state.
                HeroOutlinedButton(
                    "Turn off",
                    onClick = ::turnOff,
                    content = Hero.OnRed,
                    modifier = Modifier.weight(1f),
                    icon = R.drawable.ic_power,
                )
            }
        }
    }

    // The notification is the only warning anyone sees without opening
    // the app. When it cannot be delivered, say so here — re-checked on
    // every resume, since the switch lives in system settings.
    val warningsVisible = remember(ctx.resumes) { EngineNotification.warningsVisible(context) }
    if (!warningsVisible) {
        Spacer(Modifier.height(12.dp))
        SitrCard(borderColor = ProtectionRed.copy(alpha = 0.45f)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    painterResource(R.drawable.ic_warning),
                    contentDescription = null,
                    tint = ProtectionRed,
                    modifier = Modifier.size(20.dp),
                )
                Text(
                    "Warnings are switched off",
                    style = MaterialTheme.typography.titleMedium,
                    color = ProtectionRed,
                )
            }
            Text(
                "Notifications for Sitr are off, so it cannot warn you if " +
                    "protection stops. You would only find out by opening this app.",
                style = MaterialTheme.typography.bodyMedium,
            )
            SecondaryButton("Open notification settings", onClick = {
                context.startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                )
            })
        }
    }

    if (pauseSheet && protection is Protection.Active) {
        PauseSheet(ctx, lockdown = facts.lockdown == true) { pauseSheet = false }
    }

    Spacer(Modifier.height(22.dp))
    SectionLabel(
        if (active) "Enforced on this device" else "Not enforced right now",
        // Red only when protection should be on and is not.
        color = if (active || (!enabled && !paused)) MaterialTheme.colorScheme.onSurfaceVariant
        else ProtectionRed,
    )
    SitrCard(
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 2.dp),
        verticalArrangement = Arrangement.Top,
    ) {
        ProtectionRow(R.drawable.ic_eye_off, "Adult content blocking", null, active)
        RowDivider()
        ProtectionRow(R.drawable.ic_search, "SafeSearch", "Google, Bing, DuckDuckGo", active)
        RowDivider()
        ProtectionRow(R.drawable.ic_video, "YouTube Restricted Mode", null, active)
        RowDivider()
        ProtectionRow(R.drawable.ic_dice, "Gambling", null, active)
        RowDivider()
        ProtectionRow(R.drawable.ic_heart, "Dating", null, active)
    }

    // The child lock's state belongs next to protection: a guard that has
    // been switched off is exactly what a guardian needs to see.
    val guardWhole = remember(ctx.resumes) { ChildLock.isGuardServiceOn(context) }
    if (ctx.settings.childLock) {
        Spacer(Modifier.height(12.dp))
        if (guardWhole) {
            NavCard(
                R.drawable.ic_shield_check,
                "Child lock",
                "Guard mode is on",
                onClick = { ctx.navigate(Screen.CHILD_LOCK) },
            )
        } else {
            NavCard(
                R.drawable.ic_warning,
                "Child lock is NOT fully on",
                "Open Child lock to see what is off.",
                onClick = { ctx.navigate(Screen.CHILD_LOCK) },
                warning = true,
            )
        }
    }

    val managed = ctx.app.managedPolicy()
    if (managed.isManaged) {
        Spacer(Modifier.height(12.dp))
        Text(
            "This device is managed by ${managed.organizationName ?: "your organization"}.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** An elapsedRealtime instant as the time of day it falls on. */
private fun clockTime(context: android.content.Context, elapsed: Long): String =
    DateFormat.getTimeFormat(context).format(
        java.util.Date(System.currentTimeMillis() + (elapsed - SystemClock.elapsedRealtime()))
    )

/**
 * "Pause protection": says what a pause does BEFORE the user picks a
 * length. Picking goes through the gate exactly like "Turn off"
 * (refused on a child or locked device, the wait, the PIN), then the
 * 15-in-60 allowance is checked again and the whole pause recorded.
 */
@Composable
private fun PauseSheet(ctx: UiCtx, lockdown: Boolean, close: () -> Unit) {
    val context = LocalContext.current
    val waits = remember { ctx.actions.pauseWaits() }
    // Lockdown may have been switched on since the service last looked.
    LaunchedEffect(Unit) { SitrVpnService.refresh(context) }
    fun later(ms: Long) = clockTime(context, SystemClock.elapsedRealtime() + ms)
    val note = when {
        lockdown -> "\"Block connections without VPN\" is on for Sitr, so a pause " +
            "would cut this phone off from the internet. Turn that setting off to pause."
        waits.getValue(5) > 0 -> "You have used this hour's pauses. You can pause again at " +
            "${later(waits.getValue(5))}."
        waits.getValue(15) > 0 -> "A 15-minute pause is possible again at " +
            "${later(waits.getValue(15))}."
        else -> null
    }
    AlertDialog(
        onDismissRequest = close,
        title = { Text("Pause protection") },
        text = {
            Text(
                "While paused, Sitr's VPN is off. Nothing on this phone is filtered, " +
                    "and apps that refuse to work while a VPN is on will work. " +
                    "Protection comes back by itself when the time is up, even if " +
                    "the phone is asleep.\n\nYou can pause for up to 15 minutes in " +
                    "any hour. A pause counts in full even if you resume early." +
                    (note?.let { "\n\n$it" } ?: ""),
                style = MaterialTheme.typography.bodyMedium,
            )
        },
        confirmButton = {
            Row {
                for (minutes in Pause.MINUTES_ALLOWED) {
                    TextButton(
                        enabled = !lockdown && waits.getValue(minutes) == 0L,
                        onClick = {
                            close()
                            ctx.attempt(Pause.GATED_AS, "Pause protection") {
                                ctx.actions.startPause(minutes)
                            }
                        },
                    ) { Text("$minutes minutes") }
                }
            }
        },
        dismissButton = { TextButton(onClick = close) { Text("Cancel") } },
    )
}

/** One always-on protection: what it is, and whether it is enforced right now. */
@Composable
private fun ProtectionRow(@DrawableRes icon: Int, label: String, detail: String?, enforced: Boolean) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(icon),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp),
        )
        // The label takes the slack and wraps; the status word never
        // does — "enforced" broken across three lines is unreadable.
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            if (detail != null) {
                Text(
                    detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        StatusWord(
            if (enforced) "Enforced" else "Off",
            ok = enforced,
            color = if (enforced) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
