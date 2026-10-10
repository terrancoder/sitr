package com.sitrshield.core

import com.sitrshield.core.pin.Pin
import java.util.Random
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import kotlin.test.Test
import kotlin.test.assertContentEquals

/**
 * Pin.hash carries its own PBKDF2 loop (the platform one is too slow on
 * budget Android phones). It must agree with the platform implementation
 * bit for bit, for any PIN, salt length and iteration count.
 */
class PinKdfTest {
    private fun platform(pin: String, salt: ByteArray, iterations: Int): ByteArray =
        SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            .generateSecret(PBEKeySpec(pin.toCharArray(), salt, iterations, 256)).encoded

    @Test
    fun agreesWithThePlatformPbkdf2() {
        val random = Random(20261010)
        val pins = listOf(
            "1234", "2468", "correct horse battery staple", "পিন-১২৩৪", "رمز١٢٣٤",
            "x".repeat(32), "y".repeat(64), "z".repeat(65), "w".repeat(200), // around the 64-byte key block
        )
        for (pin in pins) {
            for (saltLength in listOf(1, 16, 51, 52, 64, 100)) { // the platform rejects an empty salt
                val salt = ByteArray(saltLength).also(random::nextBytes)
                for (iterations in listOf(1, 2, 3, 1000)) {
                    assertContentEquals(
                        platform(pin, salt, iterations),
                        Pin.hash(pin, salt, iterations),
                        "pin=${pin.take(8)} salt=$saltLength iterations=$iterations",
                    )
                }
            }
        }
    }

    @Test
    fun agreesAtTheRealIterationCount() {
        val salt = ByteArray(16) { it.toByte() }
        assertContentEquals(platform("2468", salt, Pin.ITERATIONS), Pin.hash("2468", salt, Pin.ITERATIONS))
    }
}
