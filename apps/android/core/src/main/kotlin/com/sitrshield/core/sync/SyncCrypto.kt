package com.sitrshield.core.sync

import com.sitrshield.core.SitrResult
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.security.SecureRandom

/**
 * Sync crypto — key derivation and blob sealing.
 * Port of extension/src/lib/sync/crypto.ts; wire format normative in
 * docs/sync-protocol.md, pinned by apps/shared/fixtures/{hkdf,blob}.json.
 *
 * The server never sees the root secret or the encryption key — only the
 * derived household id, the derived bearer credential, and an opaque
 * AES-256-GCM blob.
 */
object SyncCrypto {
    const val ROOT_SECRET_BYTES = 32
    const val BLOB_VERSION: Int = 0x01
    const val MAX_BLOB_BYTES = 64 * 1024

    private const val INFO_ENC = "sitr-sync v1 encryption key"
    private const val INFO_AUTH = "sitr-sync v1 auth credential"
    private const val INFO_ID = "sitr-sync v1 household id"
    private val AAD = "sitr-sync v1".toByteArray(Charsets.UTF_8)

    class HouseholdKeys(
        val encKey: ByteArray,
        val authToken: String,
        val householdId: String,
    )

    fun generateRootSecret(): ByteArray =
        ByteArray(ROOT_SECRET_BYTES).also { SecureRandom().nextBytes(it) }

    fun toHex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }

    fun fromHex(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "odd-length hex" }
        return ByteArray(hex.length / 2) { i ->
            hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }

    /**
     * HKDF-SHA256 (RFC 5869) with an EMPTY salt — like the reference's
     * WebCrypto call. HMAC pads a zero-length key and a 32-byte zero key
     * identically, so extract uses 32 zero bytes (JCA rejects empty keys);
     * the fixtures prove the outputs match the reference bit-for-bit.
     */
    internal fun hkdf(secret: ByteArray, info: String, bytes: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = mac.doFinal(secret)

        val out = ByteArray(bytes)
        var generated = 0
        var previous = ByteArray(0)
        var counter = 1
        while (generated < bytes) {
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(previous)
            mac.update(info.toByteArray(Charsets.UTF_8))
            mac.update(counter.toByte())
            previous = mac.doFinal()
            val take = minOf(previous.size, bytes - generated)
            previous.copyInto(out, generated, 0, take)
            generated += take
            counter += 1
        }
        return out
    }

    fun deriveKeys(rootSecret: ByteArray): SitrResult<HouseholdKeys> {
        if (rootSecret.size != ROOT_SECRET_BYTES) {
            return SitrResult.Err("root secret must be $ROOT_SECRET_BYTES bytes")
        }
        return SitrResult.Ok(
            HouseholdKeys(
                encKey = hkdf(rootSecret, INFO_ENC, 32),
                authToken = toHex(hkdf(rootSecret, INFO_AUTH, 32)),
                householdId = toHex(hkdf(rootSecret, INFO_ID, 16)),
            )
        )
    }

    /** Blob layout: version byte ‖ 12-byte nonce ‖ AES-GCM ciphertext+tag. */
    fun seal(
        plaintext: ByteArray,
        encKey: ByteArray,
        nonce: ByteArray? = null,
    ): SitrResult<ByteArray> {
        val nonceBytes = nonce ?: ByteArray(12).also { SecureRandom().nextBytes(it) }
        if (nonceBytes.size != 12) return SitrResult.Err("nonce must be 12 bytes")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(encKey, "AES"),
            GCMParameterSpec(128, nonceBytes),
        )
        cipher.updateAAD(AAD)
        val ct = cipher.doFinal(plaintext)
        val blob = ByteArray(1 + 12 + ct.size)
        blob[0] = BLOB_VERSION.toByte()
        nonceBytes.copyInto(blob, 1)
        ct.copyInto(blob, 13)
        if (blob.size > MAX_BLOB_BYTES) {
            return SitrResult.Err("sealed blob exceeds $MAX_BLOB_BYTES bytes")
        }
        return SitrResult.Ok(blob)
    }

    /** Opens a blob to the raw plaintext; state sanitizing lives in Household. */
    fun open(blob: ByteArray, encKey: ByteArray): SitrResult<ByteArray> {
        if (blob.size < 1 + 12 + 16) return SitrResult.Err("blob too short")
        if (blob[0].toInt() and 0xff != BLOB_VERSION) {
            return SitrResult.Err("unknown blob version: ${blob[0].toInt() and 0xff}")
        }
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(encKey, "AES"),
                GCMParameterSpec(128, blob, 1, 12),
            )
            cipher.updateAAD(AAD)
            SitrResult.Ok(cipher.doFinal(blob, 13, blob.size - 13))
        } catch (_: Exception) {
            SitrResult.Err("blob failed authentication — wrong key or tampered data")
        }
    }
}
