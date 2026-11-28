package com.sitrshield.core

import com.google.zxing.qrcode.decoder.Decoder
import com.sitrshield.core.sync.PairingCode
import com.sitrshield.core.sync.QrCode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The hand-written encoder, read back by zxing's decoder (test-only dependency). */
class QrCodeTest {
    @Test
    fun decodesBackToExactlyTheText() {
        val pairing = PairingCode.encode(ByteArray(32) { (it * 37 + 11).toByte() })
        assertEquals(69, pairing.length)
        // The pairing code (alphanumeric), byte mode, and every version 1-6.
        val texts = listOf(pairing, pairing.lowercase(), "SITR", "A".repeat(30), "A".repeat(50), "A".repeat(150))
        assertEquals(listOf(33, 37, 21, 25, 29, 41), texts.map { QrCode.encode(it).size })
        for (text in texts) {
            val decoded = Decoder().decode(QrCode.encode(text))
            assertEquals(text, decoded.text)
            assertEquals("M", decoded.ecLevel)
            // Error correction must not be quietly repairing an encoder bug.
            assertEquals(0, decoded.errorsCorrected)
            // Set only when zxing had to read the matrix mirrored.
            assertNull(decoded.other)
        }
    }
}
