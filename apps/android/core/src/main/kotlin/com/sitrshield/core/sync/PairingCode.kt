package com.sitrshield.core.sync

import com.sitrshield.core.SitrResult

/**
 * Pairing codes — Crockford Base32(version ‖ rootSecret ‖ CRC-16), grouped
 * for readability. Port of the pairing-code half of
 * extension/src/lib/sync/crypto.ts, pinned by apps/shared/fixtures/
 * {pairing,crc16}.json. Possession of this code IS household membership.
 */
object PairingCode {
    /** Crockford Base32 — no I, L, O, U; case-insensitive on decode. */
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private const val PAIR_VERSION = 0x01

    /** CRC-16/CCITT-FALSE over the payload, catches typos in manual entry. */
    fun crc16(bytes: ByteArray): Int {
        var crc = 0xffff
        for (byte in bytes) {
            crc = crc xor ((byte.toInt() and 0xff) shl 8)
            repeat(8) {
                crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x1021) and 0xffff
                else (crc shl 1) and 0xffff
            }
        }
        return crc
    }

    private fun b32encode(bytes: ByteArray): String {
        var bits = 0
        var acc = 0
        val out = StringBuilder()
        for (byte in bytes) {
            acc = (acc shl 8) or (byte.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                out.append(ALPHABET[(acc ushr (bits - 5)) and 31])
                bits -= 5
            }
        }
        if (bits > 0) out.append(ALPHABET[(acc shl (5 - bits)) and 31])
        return out.toString()
    }

    private fun b32decode(s: String): SitrResult<ByteArray> {
        val normalized = s.uppercase()
            .replace('O', '0')
            .replace('I', '1')
            .replace('L', '1')
        var bits = 0
        var acc = 0
        val out = ArrayList<Byte>()
        for (ch in normalized) {
            val v = ALPHABET.indexOf(ch)
            if (v < 0) return SitrResult.Err("invalid pairing-code character: $ch")
            acc = (acc shl 5) or v
            bits += 5
            if (bits >= 8) {
                out.add(((acc ushr (bits - 8)) and 0xff).toByte())
                bits -= 8
            }
        }
        return SitrResult.Ok(out.toByteArray())
    }

    fun encode(rootSecret: ByteArray): String {
        val payload = ByteArray(1 + rootSecret.size + 2)
        payload[0] = PAIR_VERSION.toByte()
        rootSecret.copyInto(payload, 1)
        val crc = crc16(payload.copyOfRange(0, 1 + rootSecret.size))
        payload[1 + rootSecret.size] = (crc ushr 8).toByte()
        payload[2 + rootSecret.size] = (crc and 0xff).toByte()
        return b32encode(payload).chunked(4).joinToString("-")
    }

    fun decode(code: String): SitrResult<ByteArray> {
        val cleaned = code.filter { it != '-' && !it.isWhitespace() }
        val payload = when (val decoded = b32decode(cleaned)) {
            is SitrResult.Err -> return decoded
            is SitrResult.Ok -> decoded.value
        }
        if (payload.size < 1 + SyncCrypto.ROOT_SECRET_BYTES + 2) {
            return SitrResult.Err("pairing code is too short")
        }
        if (payload[0].toInt() != PAIR_VERSION) {
            return SitrResult.Err("pairing code is from a newer version of Sitr")
        }
        val body = payload.copyOfRange(0, 1 + SyncCrypto.ROOT_SECRET_BYTES)
        val expected = crc16(body)
        val got = ((payload[1 + SyncCrypto.ROOT_SECRET_BYTES].toInt() and 0xff) shl 8) or
            (payload[2 + SyncCrypto.ROOT_SECRET_BYTES].toInt() and 0xff)
        if (expected != got) {
            return SitrResult.Err("pairing code check failed — please re-check the characters")
        }
        return SitrResult.Ok(body.copyOfRange(1, body.size))
    }
}
