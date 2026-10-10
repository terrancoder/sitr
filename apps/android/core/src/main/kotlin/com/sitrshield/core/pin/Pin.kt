package com.sitrshield.core.pin

import com.sitrshield.core.SitrResult
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
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

    /**
     * Largest iteration count accepted from a synced record (pin.ts). The
     * count arrives with the household state; unbounded, one bad record
     * means minutes of hashing the next time anyone types the PIN.
     */
    const val MAX_ITERATIONS = 10_000_000
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

    /**
     * PBKDF2-HMAC-SHA256 with a 32-byte output (one block).
     *
     * Not SecretKeyFactory("PBKDF2WithHmacSHA256"): on Android that is a
     * pure-Java implementation, and 600,000 iterations took 17–20 s on a
     * budget phone — on every PIN entry. Looping javax.crypto.Mac is not
     * much better there (about 10 s: each doFinal rebuilds its native
     * context). So only the first block uses Mac; the remaining
     * iterations run on the two HMAC pad states directly, two SHA-256
     * compressions each, with no allocation. Output is pinned by pin.json
     * and checked against the platform PBKDF2 in PinKdfTest.
     */
    fun hash(pin: String, salt: ByteArray, iterations: Int): ByteArray {
        var key = pin.toByteArray(Charsets.UTF_8)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        mac.update(salt)
        mac.update(byteArrayOf(0, 0, 0, 1)) // block index 1, big-endian
        val first = mac.doFinal()

        // HMAC's two pad blocks, absorbed once.
        if (key.size > 64) key = MessageDigest.getInstance("SHA-256").digest(key)
        val w = IntArray(64)
        val inner = IntArray(8)
        val outer = IntArray(8)
        for (pad in 0..1) {
            for (i in 0 until 16) {
                var word = 0
                for (b in 0 until 4) {
                    val k = if (i * 4 + b < key.size) key[i * 4 + b].toInt() and 0xff else 0
                    word = (word shl 8) or (k xor if (pad == 0) 0x36 else 0x5c)
                }
                w[i] = word
            }
            val state = if (pad == 0) inner else outer
            SHA256_INIT.copyInto(state)
            compress(state, w)
        }

        val u = IntArray(8) { i ->
            ((first[i * 4].toInt() and 0xff) shl 24) or ((first[i * 4 + 1].toInt() and 0xff) shl 16) or
                ((first[i * 4 + 2].toInt() and 0xff) shl 8) or (first[i * 4 + 3].toInt() and 0xff)
        }
        val t = u.copyOf()
        val state = IntArray(8)
        repeat(iterations - 1) {
            // inner = SHA256(ipad ‖ u): one more block — 32 bytes of u, the
            // 0x80 marker, and the length of (64 + 32) bytes in bits.
            for (pass in 0..1) {
                (if (pass == 0) u else state).copyInto(w, 0, 0, 8)
                w[8] = 0x80000000.toInt()
                for (i in 9..14) w[i] = 0
                w[15] = 768
                (if (pass == 0) inner else outer).copyInto(state)
                compress(state, w)
            }
            state.copyInto(u)
            for (i in 0 until 8) t[i] = t[i] xor u[i]
        }
        return ByteArray(32) { i -> (t[i / 4] ushr (24 - 8 * (i % 4))).toByte() }
    }

    private val SHA256_INIT = intArrayOf(
        0x6a09e667, 0xbb67ae85.toInt(), 0x3c6ef372, 0xa54ff53a.toInt(),
        0x510e527f, 0x9b05688c.toInt(), 0x1f83d9ab, 0x5be0cd19,
    )

    private val SHA256_K = intArrayOf(
        0x428a2f98, 0x71374491, 0xb5c0fbcf.toInt(), 0xe9b5dba5.toInt(), 0x3956c25b, 0x59f111f1,
        0x923f82a4.toInt(), 0xab1c5ed5.toInt(), 0xd807aa98.toInt(), 0x12835b01, 0x243185be,
        0x550c7dc3, 0x72be5d74, 0x80deb1fe.toInt(), 0x9bdc06a7.toInt(), 0xc19bf174.toInt(),
        0xe49b69c1.toInt(), 0xefbe4786.toInt(), 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
        0x5cb0a9dc, 0x76f988da, 0x983e5152.toInt(), 0xa831c66d.toInt(), 0xb00327c8.toInt(),
        0xbf597fc7.toInt(), 0xc6e00bf3.toInt(), 0xd5a79147.toInt(), 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb,
        0x81c2c92e.toInt(), 0x92722c85.toInt(), 0xa2bfe8a1.toInt(), 0xa81a664b.toInt(),
        0xc24b8b70.toInt(), 0xc76c51a3.toInt(), 0xd192e819.toInt(), 0xd6990624.toInt(),
        0xf40e3585.toInt(), 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f,
        0x84c87814.toInt(), 0x8cc70208.toInt(), 0x90befffa.toInt(), 0xa4506ceb.toInt(),
        0xbef9a3f7.toInt(), 0xc67178f2.toInt(),
    )

    /** One SHA-256 compression: `w[0..15]` is the block, `w[16..63]` scratch. */
    private fun compress(state: IntArray, w: IntArray) {
        for (i in 16 until 64) {
            val x = w[i - 15]
            val y = w[i - 2]
            w[i] = w[i - 16] + (x.rotateRight(7) xor x.rotateRight(18) xor (x ushr 3)) +
                w[i - 7] + (y.rotateRight(17) xor y.rotateRight(19) xor (y ushr 10))
        }
        var a = state[0]; var b = state[1]; var c = state[2]; var d = state[3]
        var e = state[4]; var f = state[5]; var g = state[6]; var h = state[7]
        for (i in 0 until 64) {
            val t1 = h + (e.rotateRight(6) xor e.rotateRight(11) xor e.rotateRight(25)) +
                ((e and f) xor (e.inv() and g)) + SHA256_K[i] + w[i]
            val t2 = (a.rotateRight(2) xor a.rotateRight(13) xor a.rotateRight(22)) +
                ((a and b) xor (a and c) xor (b and c))
            h = g; g = f; f = e; e = d + t1
            d = c; c = b; b = a; a = t1 + t2
        }
        state[0] += a; state[1] += b; state[2] += c; state[3] += d
        state[4] += e; state[5] += f; state[6] += g; state[7] += h
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
        // Nothing outside the valid length can match a record, and an
        // empty key is not one the Mac accepts.
        if (isValidInput(pin) is SitrResult.Err) return false
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
