package com.sitrshield.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
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
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.sitrshield.app.data.Settings
import com.sitrshield.app.ui.CategoriesScreen
import com.sitrshield.app.ui.DelayText
import com.sitrshield.app.ui.ChildLockScreen
import com.sitrshield.app.ui.FamilyScreen
import com.sitrshield.app.ui.HomeScreen
import com.sitrshield.app.ui.LicenceScreen
import com.sitrshield.app.ui.ListsScreen
import com.sitrshield.app.ui.OnboardingScreen
import com.sitrshield.app.ui.PinDialog
import com.sitrshield.app.ui.SettingsScreen
import com.sitrshield.app.ui.SitrBottomBar
import com.sitrshield.app.ui.SitrTheme
import com.sitrshield.app.ui.TabScreens
import com.sitrshield.core.gate.Delay
import com.sitrshield.core.gate.DelayAction
import com.sitrshield.core.gate.DelayPhase
import com.sitrshield.core.gate.Gate
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.gate.MutationStep
import com.sitrshield.core.gate.MutationVerdict

enum class Screen { HOME, ONBOARDING, CATEGORIES, LISTS, FAMILY, SETTINGS, CHILD_LOCK, LICENCE }

/**
 * Shared per-screen context: settings snapshot, actions, navigation, and
 * the gate runner — every mutating tap goes through attempt(), which
 * consults the authority ladder, then "wait before loosening", then
 * collects the PIN when the verdict requires it (Delay.decide).
 */
class UiCtx(
    val app: SitrApp,
    val settings: Settings,
    val actions: HouseholdActions,
    val attempt: (MutationKind, String, () -> Unit) -> Unit,
    /** attempt() for any DelayAction, including shortening the wait. */
    val attemptAction: (DelayAction, String, () -> Unit) -> Unit,
    val requirePin: (String, () -> Unit) -> Unit,
    /** Joining a household: the delay alone, as Delay.JOIN_HOUSEHOLD_WAITS_AS. */
    val attemptJoin: (() -> Unit) -> Unit,
    val navigate: (Screen) -> Unit,
    /** Changes every time the activity resumes — a key for state that
     *  system settings can change behind the app's back. */
    val resumes: Int,
)

class MainActivity : ComponentActivity() {
    private val resumes = mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as SitrApp
        setContent {
            val settings by app.repository.settings.collectAsState()
            SitrTheme(appearance = settings.appearance) { SitrRoot(app, resumes.intValue) }
        }
    }

    override fun onResume() {
        super.onResume()
        // A pending guardian lock request is checked again here: steps 1
        // and 2 may just have been finished in Settings.
        // ponytail: reads the always-on fact as it stands; where it stays
        // stale until the VPN restarts (HyperOS), only the Child lock tab
        // re-reads it, so the request applies when that tab is opened.
        HouseholdActions(application as SitrApp).refreshChildPolicy()
        resumes.intValue++
    }
}

@Composable
fun SitrRoot(app: SitrApp, resumes: Int) {
    val context = LocalContext.current
    val settings by app.repository.settings.collectAsState()
    val actions = remember { HouseholdActions(app) }
    // Saveable: a rotation recreates the activity, and plain `remember`
    // dropped the user back on Home from wherever they were.
    var screen by rememberSaveable {
        mutableStateOf(if (app.repository.current().onboarded) Screen.HOME else Screen.ONBOARDING)
    }
    // System Back returns to Home from a sub-screen instead of leaving the app.
    BackHandler(enabled = screen != Screen.HOME && screen != Screen.ONBOARDING) {
        screen = if (screen == Screen.LICENCE) Screen.SETTINGS else Screen.HOME
    }
    // The action kind rides along so the delay can be checked again after
    // the PIN; null for reveals that are not gate kinds (no delay).
    var pinRequest by remember { mutableStateOf<Triple<String, DelayAction?, () -> Unit>?>(null) }
    var gateMessage by remember { mutableStateOf<String?>(null) }
    var hold by remember { mutableStateOf<HouseholdActions.DelayState?>(null) }

    // Gate, then "wait before loosening", then the PIN. A held change
    // does not happen, so a switch keeps showing the stored value.
    val attemptAction: (DelayAction, String, () -> Unit) -> Unit = { kind, title, action ->
        val delay = actions.delayState()
        when (val step = actions.decide(kind, delay.phase)) {
            is MutationStep.Refused -> gateMessage = when (step.reason) {
                MutationVerdict.Reason.MANAGED_LOCKED ->
                    "Settings are locked by your organization."
                MutationVerdict.Reason.CHILD_DEVICE ->
                    // A child refused leaving has no household PIN to give.
                    if (kind == DelayAction.Kind(MutationKind.LEAVE_HOUSEHOLD)) Gate.CHILD_LEAVE_NEEDS_PIN
                    else "This is managed by your guardian."
            }
            MutationStep.Wait -> hold = delay
            MutationStep.Pin -> pinRequest = Triple(title, kind, action)
            MutationStep.Go -> action()
        }
    }
    val ctx = UiCtx(
        app = app,
        settings = settings,
        actions = actions,
        attempt = { kind, title, action -> attemptAction(DelayAction.Kind(kind), title, action) },
        attemptAction = attemptAction,
        requirePin = { title, action ->
            if (settings.household?.pin != null) pinRequest = Triple(title, null, action) else action()
        },
        attemptJoin = { action ->
            val delay = actions.delayState()
            if (Delay.needsWait(DelayAction.Kind(Delay.JOIN_HOUSEHOLD_WAITS_AS), delay.phase)) {
                hold = delay
            } else {
                action()
            }
        },
        navigate = { screen = it },
        resumes = resumes,
    )

    Scaffold(
        // The five places of the app. Onboarding, About and the licence
        // have no tab bar: they are left with their own button or Back.
        bottomBar = { if (screen in TabScreens) SitrBottomBar(screen) { screen = it } },
    ) { padding ->
        // Keyed by screen: each screen opens at its top instead of at the
        // scroll position of the one before it.
        key(screen) {
            Column(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 16.dp)
            ) {
                when (screen) {
                    Screen.ONBOARDING -> OnboardingScreen(ctx)
                    Screen.HOME -> HomeScreen(ctx)
                    Screen.CATEGORIES -> CategoriesScreen(ctx)
                    Screen.LISTS -> ListsScreen(ctx)
                    Screen.FAMILY -> FamilyScreen(ctx)
                    Screen.SETTINGS -> SettingsScreen(ctx)
                    Screen.CHILD_LOCK -> ChildLockScreen(ctx)
                    Screen.LICENCE -> LicenceScreen(ctx)
                }
            }
        }
    }

    pinRequest?.let { (title, kind, action) ->
        PinDialog(
            context = context,
            title = title,
            verify = actions::verifyPin,
            onSuccess = {
                pinRequest = null
                // The PIN dialog can sit open past the window: check again.
                val after = actions.delayState()
                if (kind != null && Delay.needsWait(kind, after.phase)) hold = after else action()
            },
            onDismiss = { pinRequest = null },
        )
    }

    hold?.let { held ->
        val idle = held.phase == DelayPhase.IDLE
        AlertDialog(
            onDismissRequest = { hold = null },
            title = { Text("Wait before loosening") },
            text = { Text(DelayText.hold(held), style = MaterialTheme.typography.bodyMedium) },
            // While waiting, only "Close": a prominent "Cancel request" got
            // tapped by habit. Cancelling stays in Settings.
            confirmButton = {
                TextButton(onClick = {
                    hold = null
                    if (idle) actions.startDelayRequest()
                }) { Text(if (idle) "Start the wait" else "Close") }
            },
            dismissButton = if (idle) {
                { TextButton(onClick = { hold = null }) { Text("Cancel") } }
            } else null,
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
