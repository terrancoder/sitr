package com.sitrshield.core.pin

import com.sitrshield.core.SitrResult
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import kotlin.math.min
import kotlin.math.pow

/**
 * Guardian PIN — pure derivation and lockout policy.
 * Port of extension/src/lib/pin.ts, pinned by apps/shared/fixtures/pin.json.
 *
 * The PIN is FRICTION, not security (threat-model.md): it stops a child
 * from casually loosening the filter. Stated, never overclaimed.
 * Lockout: no delay for the first few attempts, then exponential backoff.
 * The attempt counter is persisted BEFORE reporting failure so an app
 * restart cannot reset it.
 */
data class PinRecord(
    val iterations: Int,
    val saltB64: String,
    val hashB64: String,
)

data class PinAttempts(
    val count: Int,
    /** Epoch ms until which verification is refused. 0 = not locked. */
    val lockedUntil: Double,
)

object Pin {
    const val ITERATIONS = 600_000
    const val MIN_LENGTH = 4
    const val MAX_LENGTH = 32

    val NO_ATTEMPTS = PinAttempts(count = 0, lockedUntil = 0.0)

    private const val FREE_ATTEMPTS = 4
    private const val BASE_DELAY_MS = 30_000.0
    private const val MAX_DELAY_MS = 15 * 60_000.0

    fun isValidInput(pin: String): SitrResult<Unit> {
        if (pin.length < MIN_LENGTH || pin.length > MAX_LENGTH) {
            return SitrResult.Err("PIN must be $MIN_LENGTH–$MAX_LENGTH characters")
        }
        return SitrResult.Ok(Unit)
    }

    fun hash(pin: String, salt: ByteArray, iterations: Int): ByteArray {
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val spec = PBEKeySpec(pin.toCharArray(), salt, iterations, 256)
        return factory.generateSecret(spec).encoded
    }

    fun createRecord(pin: String): SitrResult<PinRecord> {
        when (val valid = isValidInput(pin)) {
            is SitrResult.Err -> return valid
            is SitrResult.Ok -> {}
        }
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val hashed = hash(pin, salt, ITERATIONS)
        return SitrResult.Ok(
            PinRecord(
                iterations = ITERATIONS,
                saltB64 = Base64.getEncoder().encodeToString(salt),
                hashB64 = Base64.getEncoder().encodeToString(hashed),
            )
        )
    }

    /** Constant-time-ish comparison; length leak is fine (fixed 32 bytes). */
    private fun bytesEqual(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
        return diff == 0
    }

    fun verify(pin: String, record: PinRecord): Boolean {
        val salt = try {
            Base64.getDecoder().decode(record.saltB64)
        } catch (_: IllegalArgumentException) {
            return false
        }
        val expected = try {
            Base64.getDecoder().decode(record.hashB64)
        } catch (_: IllegalArgumentException) {
            return false
        }
        return bytesEqual(hash(pin, salt, record.iterations), expected)
    }

    /** Attempt state after one more failure at time `now` (epoch ms). */
    fun backoffAfterFailure(count: Int, now: Double): PinAttempts {
        val next = count + 1
        if (next <= FREE_ATTEMPTS) return PinAttempts(count = next, lockedUntil = 0.0)
        val delay = min(
            BASE_DELAY_MS * 2.0.pow(next - FREE_ATTEMPTS - 1),
            MAX_DELAY_MS,
        )
        return PinAttempts(count = next, lockedUntil = now + delay)
    }

    fun isLockedOut(attempts: PinAttempts, now: Double): SitrResult<Unit> =
        if (attempts.lockedUntil > now) SitrResult.Err("locked until ${attempts.lockedUntil}")
        else SitrResult.Ok(Unit)
}
