package com.sitrshield.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.sitrshield.app.data.Settings
import com.sitrshield.app.ui.CategoriesScreen
import com.sitrshield.app.ui.FamilyScreen
import com.sitrshield.app.ui.HomeScreen
import com.sitrshield.app.ui.ListsScreen
import com.sitrshield.app.ui.OnboardingScreen
import com.sitrshield.app.ui.PinDialog
import com.sitrshield.app.ui.SettingsScreen
import com.sitrshield.app.ui.SitrTheme
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.gate.MutationVerdict

enum class Screen { HOME, ONBOARDING, CATEGORIES, LISTS, FAMILY, SETTINGS }

/**
 * Shared per-screen context: settings snapshot, actions, navigation, and
 * the gate runner — every mutating tap goes through attempt(), which
 * consults the authority ladder and collects the PIN when the verdict
 * requires it.
 */
class UiCtx(
    val app: SitrApp,
    val settings: Settings,
    val actions: HouseholdActions,
    val attempt: (MutationKind, String, () -> Unit) -> Unit,
    val requirePin: (String, () -> Unit) -> Unit,
    val navigate: (Screen) -> Unit,
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as SitrApp
        setContent {
            SitrTheme { SitrRoot(app) }
        }
    }
}

@Composable
fun SitrRoot(app: SitrApp) {
    val context = LocalContext.current
    val settings by app.repository.settings.collectAsState()
    val actions = remember { HouseholdActions(app) }
    var screen by remember {
        mutableStateOf(if (app.repository.current().onboarded) Screen.HOME else Screen.ONBOARDING)
    }
    var pinRequest by remember { mutableStateOf<Pair<String, () -> Unit>?>(null) }
    var gateMessage by remember { mutableStateOf<String?>(null) }

    val ctx = UiCtx(
        app = app,
        settings = settings,
        actions = actions,
        attempt = { kind, title, action ->
            when (val verdict = actions.gate(kind)) {
                is MutationVerdict.Refused -> gateMessage = when (verdict.reason) {
                    MutationVerdict.Reason.MANAGED_LOCKED ->
                        "Settings are locked by your organization."
                    MutationVerdict.Reason.CHILD_DEVICE ->
                        "This is managed by your guardian."
                }
                is MutationVerdict.Allowed ->
                    if (verdict.requiresPin) pinRequest = title to action else action()
            }
        },
        requirePin = { title, action ->
            if (settings.household?.pin != null) pinRequest = title to action else action()
        },
        navigate = { screen = it },
    )

    Scaffold { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(20.dp)
        ) {
            when (screen) {
                Screen.ONBOARDING -> OnboardingScreen(ctx)
                Screen.HOME -> HomeScreen(ctx)
                Screen.CATEGORIES -> CategoriesScreen(ctx)
                Screen.LISTS -> ListsScreen(ctx)
                Screen.FAMILY -> FamilyScreen(ctx)
                Screen.SETTINGS -> SettingsScreen(ctx)
            }
        }
    }

    pinRequest?.let { (title, action) ->
        PinDialog(
            context = context,
            title = title,
            verify = actions::verifyPin,
            onSuccess = {
                pinRequest = null
                action()
            },
            onDismiss = { pinRequest = null },
        )
    }

    gateMessage?.let { message ->
        AlertDialog(
            onDismissRequest = { gateMessage = null },
            title = { Text("Not allowed") },
            text = { Text(message, style = MaterialTheme.typography.bodyMedium) },
            confirmButton = {
                TextButton(onClick = { gateMessage = null }) { Text("OK") }
            },
        )
    }
}
