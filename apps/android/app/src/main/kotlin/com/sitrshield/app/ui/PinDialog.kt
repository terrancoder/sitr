package com.sitrshield.app.ui

import android.content.Context
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.sitrshield.core.SitrResult
import com.sitrshield.core.pin.Pin
import com.sitrshield.core.pin.PinAttempts

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

@Composable
fun PinDialog(
    context: Context,
    title: String,
    verify: (String) -> Boolean,
    onSuccess: () -> Unit,
    onDismiss: () -> Unit,
) {
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            androidx.compose.foundation.layout.Column {
                Text("Enter the guardian PIN.")
                OutlinedTextField(
                    value = pin,
                    onValueChange = { pin = it },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                )
                error?.let { Text(it, color = ProtectionRed) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
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
                if (verify(pin)) {
                    PinAttemptsStore.reset(context)
                    onSuccess()
                } else {
                    PinAttemptsStore.save(
                        context, Pin.backoffAfterFailure(attempts.count, now),
                    )
                    error = "Wrong PIN."
                    pin = ""
                }
            }) { Text("Confirm") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
