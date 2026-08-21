package com.sitrshield.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Household root secret at rest — wrapped with a non-exportable Android
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

    fun save(rootSecret: ByteArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val wrapped = cipher.doFinal(rootSecret)
        prefs.edit()
            .putString("iv", Base64.getEncoder().encodeToString(cipher.iv))
            .putString("secret", Base64.getEncoder().encodeToString(wrapped))
            .apply()
    }

    fun load(): ByteArray? {
        val iv = prefs.getString("iv", null) ?: return null
        val wrapped = prefs.getString("secret", null) ?: return null
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

    fun clear() {
        prefs.edit().clear().apply()
    }
}
