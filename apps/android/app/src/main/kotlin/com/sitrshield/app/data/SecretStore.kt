package com.sitrshield.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.sitrshield.core.sync.Subscription
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Household root secret (and the subscription code with its claim
 * secret) at rest — wrapped with a non-exportable Android
 * Keystore AES-GCM key. The raw secret is needed for HKDF, so the
 * Keystore WRAPS rather than derives. At-rest hygiene, not a security
 * boundary: device compromise is out of scope, same as the extension's
 * storage.local (threat-model.md T7).
 */
class SecretStore(context: Context) {
    private val prefs =
        context.getSharedPreferences("sitr-secret", Context.MODE_PRIVATE)

    private val alias = "sitr-root-secret-wrap"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore",
        )
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return generator.generateKey()
    }

    /** Wraps `plain` under the Keystore key, with its own IV, at `ivKey`/`dataKey`. */
    private fun seal(ivKey: String, dataKey: String, plain: ByteArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val wrapped = cipher.doFinal(plain)
        prefs.edit()
            .putString(ivKey, Base64.getEncoder().encodeToString(cipher.iv))
            .putString(dataKey, Base64.getEncoder().encodeToString(wrapped))
            .apply()
    }

    private fun open(ivKey: String, dataKey: String): ByteArray? {
        val iv = prefs.getString(ivKey, null) ?: return null
        val wrapped = prefs.getString(dataKey, null) ?: return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                key(),
                GCMParameterSpec(128, Base64.getDecoder().decode(iv)),
            )
            cipher.doFinal(Base64.getDecoder().decode(wrapped))
        } catch (_: Exception) {
            null
        }
    }

    fun save(rootSecret: ByteArray) = seal("iv", "secret", rootSecret)

    fun load(): ByteArray? = open("iv", "secret")

    /**
     * The subscription code and its claim secret, kept together under the
     * same key as the root secret (docs/sync-protocol.md §Android), and
     * deleted together: by clearSubscription, and by clear() on leave.
     */
    fun saveSubscription(sub: Subscription) =
        seal("subIv", "sub", "${sub.code}\n${sub.claimSecret}".toByteArray(Charsets.UTF_8))

    fun loadSubscription(): Subscription? {
        val parts = open("subIv", "sub")?.toString(Charsets.UTF_8)?.split('\n') ?: return null
        return if (parts.size == 2) Subscription(parts[0], parts[1]) else null
    }

    fun clearSubscription() {
        prefs.edit().remove("subIv").remove("sub").apply()
    }

    /** Leaving: the root secret, the subscription code and the claim secret. */
    fun clear() {
        prefs.edit().clear().apply()
    }
}
