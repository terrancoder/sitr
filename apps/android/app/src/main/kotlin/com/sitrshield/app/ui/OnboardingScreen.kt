package com.sitrshield.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sitrshield.app.R
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx

private const val STEPS = 3

/**
 * Three honest steps: what Sitr does and does NOT do; why Android will
 * show a VPN key icon (DNS-only design, plainly explained); and why the
 * notification permission matters (fail-visible — a denial means no red
 * warning when protection drops; Home shows a row saying so for as long
 * as warnings cannot be delivered).
 */
@Composable
fun OnboardingScreen(ctx: UiCtx) {
    var step by rememberSaveable { mutableIntStateOf(0) }

    val notificationLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { finish(ctx) }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        StepBar(step)
        Spacer(Modifier.height(10.dp))
        when (step) {
            0 -> {
                EmblemTile()
                Spacer(Modifier.height(2.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        "Sitr",
                        style = MaterialTheme.typography.displaySmall,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .alignByBaseline()
                            .semantics { heading() },
                    )
                    Text(
                        "سِتْر",
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Normal,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.alignByBaseline(),
                    )
                }
                Text(
                    "A family content filter whose privacy you can verify, " +
                        "not just trust.",
                    style = MaterialTheme.typography.headlineSmall,
                )
                Text(
                    "Sitr blocks adult, gambling and dating sites and enforces " +
                        "SafeSearch — entirely on this device.",
                    style = MaterialTheme.typography.bodyLarge,
                )
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Promise("No accounts.")
                    Promise("No analytics.")
                    Promise("No crash reports.")
                }
                Text(
                    "Your browsing " +
                        "never leaves this phone, in any tier. The blocklist is " +
                        "public and identical for every user, and the app is open " +
                        "source, so this is verifiable — not a promise.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(6.dp))
                PrimaryButton("Continue", onClick = { step = 1 })
            }
            1 -> {
                Text(
                    "About the VPN icon",
                    style = MaterialTheme.typography.headlineLarge,
                    modifier = Modifier.semantics { heading() },
                )
                Text(
                    "Android's only system-wide filtering mechanism is a local VPN, " +
                        "so a key icon will appear while Sitr is on.\n\n" +
                        "Sitr's VPN is DNS-only: the tunnel carries nothing but DNS " +
                        "lookups, decided on this device. Allowed lookups go to the " +
                        "DNS server your network already uses — never to us; there is " +
                        "no Sitr server involved and no traffic inspection. Those lookups " +
                        "travel unencrypted, so Android's automatic encrypted DNS is " +
                        "not used while Sitr is on. This is " +
                        "documented, with its limits, in the public threat model.",
                    style = MaterialTheme.typography.bodyLarge,
                )
                Spacer(Modifier.height(6.dp))
                PrimaryButton("Continue", onClick = { step = 2 })
            }
            2 -> {
                Text(
                    "Fail-visible protection",
                    style = MaterialTheme.typography.headlineLarge,
                    modifier = Modifier.semantics { heading() },
                )
                Text(
                    "If protection ever stops — the VPN is turned off, another VPN " +
                        "takes over, Private DNS is set to a fixed host — Sitr shows a red " +
                        "warning instead of pretending. It never reports silently " +
                        "working when it isn't.\n\n" +
                        "Allow notifications so that warning can reach you.",
                    style = MaterialTheme.typography.bodyLarge,
                )
                Spacer(Modifier.height(6.dp))
                PrimaryButton(
                    "Allow notifications & finish",
                    onClick = {
                        if (Build.VERSION.SDK_INT >= 33) {
                            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        } else {
                            finish(ctx)
                        }
                    },
                )
                TextButton(
                    onClick = { finish(ctx) },
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                ) { Text("Skip") }
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

/** Where the reader is: one bar per step, the ones reached in green. */
@Composable
private fun StepBar(step: Int) {
    Row(
        Modifier
            .fillMaxWidth()
            .semantics { contentDescription = "Step ${step + 1} of $STEPS" },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (i in 0 until STEPS) {
            Box(
                Modifier
                    .weight(1f)
                    .height(4.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(
                        if (i <= step) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.outline
                    )
            )
        }
    }
}

/**
 * The logo, as the launcher shows it: the emblem on a white tile. The
 * artwork is drawn for white, so the tile stays white in the dark
 * appearance too (brand-kit/README.md, "Ground").
 */
@Composable
private fun EmblemTile() {
    val shape = RoundedCornerShape(26.dp)
    Box(
        Modifier
            .size(96.dp)
            .clip(shape)
            .background(Color.White)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape),
        contentAlignment = Alignment.Center,
    ) {
        // The launcher foreground has the adaptive icon's margin around the
        // emblem, so it is drawn larger than the tile and clipped by it.
        Image(
            painterResource(R.mipmap.ic_launcher_foreground),
            contentDescription = null, // the name below says it
            modifier = Modifier.requiredSize(132.dp),
        )
    }
}

/** One of the three things the app does not have, with a tick. */
@Composable
private fun Promise(text: String) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(R.drawable.ic_check),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(18.dp),
        )
        Text(text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
    }
}

private fun finish(ctx: UiCtx) {
    ctx.app.update { it.copy(onboarded = true) }
    ctx.navigate(Screen.HOME)
}
