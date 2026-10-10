package com.sitrshield.app.ui

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.sitrshield.core.SitrResult
import com.sitrshield.core.pin.Pin
import com.sitrshield.core.pin.PinAttempts
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Guardian PIN ceremony. Lockout mirrors pin.ts exactly: 4 free
 * attempts, then exponential backoff — and the attempt counter is
 * PERSISTED BEFORE the failure is rendered, so killing the app cannot
 * reset it.
 */
object PinAttemptsStore {
    private const val PREFS = "sitr-pin-attempts"

    fun load(context: Context): PinAttempts {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return PinAttempts(
            count = prefs.getInt("count", 0),
            lockedUntil = prefs.getLong("lockedUntil", 0).toDouble(),
        )
    }

    fun save(context: Context, attempts: PinAttempts) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putInt("count", attempts.count)
            .putLong("lockedUntil", attempts.lockedUntil.toLong())
            .commit() // synchronous on purpose: persisted BEFORE failure shows
    }

    fun reset(context: Context) = save(context, Pin.NO_ATTEMPTS)
}

/**
 * A password keyboard, not a text one: the visual mask alone still lets
 * the keyboard learn what is typed and offer it back later — on a child's
 * device that is the guardian's PIN in the suggestion strip.
 */
val PinKeyboard = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false)

@Composable
fun PinDialog(
    context: Context,
    title: String,
    /** PBKDF2 at 600,000 iterations — runs off the main thread here. */
    verify: (String) -> Boolean,
    onSuccess: () -> Unit,
    onDismiss: () -> Unit,
) {
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                Text("Enter the guardian PIN.")
                OutlinedTextField(
                    value = pin,
                    onValueChange = { pin = it },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = PinKeyboard,
                    singleLine = true,
                    enabled = !checking,
                )
                error?.let { Text(it, color = ProtectionRed) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !checking,
                onClick = {
                    val now = System.currentTimeMillis().toDouble()
                    val attempts = PinAttemptsStore.load(context)
                    when (Pin.isLockedOut(attempts, now)) {
                        is SitrResult.Err -> {
                            val seconds =
                                ((attempts.lockedUntil - now) / 1000).toInt().coerceAtLeast(1)
                            error = "Too many attempts — try again in ${seconds}s."
                            return@TextButton
                        }
                        is SitrResult.Ok -> {}
                    }
                    // Count the attempt as failed BEFORE the slow check
                    // starts, and clear it only on success: dismissing the
                    // dialog mid-check cancels the coroutine, and must not
                    // become a way to guess without being counted.
                    PinAttemptsStore.save(context, Pin.backoffAfterFailure(attempts.count, now))
                    val entered = pin
                    checking = true
                    error = null
                    scope.launch {
                        val ok = withContext(Dispatchers.Default) { verify(entered) }
                        checking = false
                        if (ok) {
                            PinAttemptsStore.reset(context)
                            onSuccess()
                        } else {
                            error = "Wrong PIN."
                            pin = ""
                        }
                    }
                },
            ) { Text(if (checking) "Checking…" else "Confirm") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
