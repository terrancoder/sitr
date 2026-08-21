package com.sitrshield.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx

/**
 * Three honest steps: what Sitr does and does NOT do; why Android will
 * show a VPN key icon (DNS-only design, plainly explained); and why the
 * notification permission matters (fail-visible — a denial means no red
 * warning when protection drops, which is itself surfaced on Home).
 */
@Composable
fun OnboardingScreen(ctx: UiCtx) {
    var step by remember { mutableIntStateOf(0) }

    val notificationLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { finish(ctx) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when (step) {
            0 -> {
                Text("Sitr — سِتْر", style = MaterialTheme.typography.headlineMedium)
                Text(
                    "A halal/family content filter whose privacy you can verify, " +
                        "not just trust.",
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    "Sitr blocks adult, gambling and dating sites and enforces " +
                        "SafeSearch — entirely on this device.\n\n" +
                        "No accounts. No analytics. No crash reports. Your browsing " +
                        "never leaves this phone, in any tier. The blocklist is " +
                        "public and identical for every user, and the app is open " +
                        "source, so this is verifiable — not a promise.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Button(onClick = { step = 1 }, Modifier.fillMaxWidth()) { Text("Continue") }
            }
            1 -> {
                Text("About the VPN icon", style = MaterialTheme.typography.headlineSmall)
                Text(
                    "Android's only system-wide filtering mechanism is a local VPN, " +
                        "so a key icon will appear while Sitr is on.\n\n" +
                        "Sitr's VPN is DNS-only: the tunnel carries nothing but DNS " +
                        "lookups, decided on this device. Allowed lookups go to the " +
                        "DNS server your network already uses — never to us; there is " +
                        "no Sitr server involved and no traffic inspection. This is " +
                        "documented, with its limits, in the public threat model.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Button(onClick = { step = 2 }, Modifier.fillMaxWidth()) { Text("Continue") }
            }
            2 -> {
                Text("Fail-visible protection", style = MaterialTheme.typography.headlineSmall)
                Text(
                    "If protection ever stops — the VPN is turned off, another VPN " +
                        "takes over, a setting bypasses filtering — Sitr shows a red " +
                        "warning instead of pretending. It never reports silently " +
                        "working when it isn't.\n\n" +
                        "Allow notifications so that warning can reach you.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Button(
                    onClick = {
                        if (Build.VERSION.SDK_INT >= 33) {
                            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        } else {
                            finish(ctx)
                        }
                    },
                    Modifier.fillMaxWidth(),
                ) { Text("Allow notifications & finish") }
                TextButton(onClick = { finish(ctx) }) { Text("Skip") }
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

private fun finish(ctx: UiCtx) {
    ctx.app.applySettings(ctx.app.repository.current().copy(onboarded = true))
    ctx.navigate(Screen.HOME)
}
