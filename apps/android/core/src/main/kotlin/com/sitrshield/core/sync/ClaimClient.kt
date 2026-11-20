package com.sitrshield.core.sync

import org.json.JSONObject
import java.io.IOException
import java.security.SecureRandom
import java.util.Base64

/**
 * The claim call (docs/sync-protocol.md §POST /v1/entitlement/claim) for a
 * Polar client. It goes through the same SyncTransport as the sync client,
 * the app's one HTTP call site, with the second base URL used only here
 * (§One call site, two hosts). The body carries no household ID and no
 * sync credential.
 */
class ClaimClient(
    private val transport: SyncTransport,
    private val baseUrl: String = DEFAULT_BASE_URL,
) {
    companion object {
        const val DEFAULT_BASE_URL = "https://claim.sitrshield.com"
        const val PATH = "/v1/entitlement/claim"

        /** A new claim secret: 32 random bytes, base64url without padding
         * (43 characters). Kept with the code, deleted only with it. */
        fun newClaimSecret(random: SecureRandom = SecureRandom()): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(random::nextBytes))
    }

    /** One POST. No answer (IOException) is "no network": Unavailable. */
    fun claim(code: String, claimSecret: String, replace: Boolean, current: Boolean): ClaimOutcome {
        val body = JSONObject()
            .put("source", "polar")
            .put("credential", code)
            .put("claim_secret", claimSecret)
            .put("replace", replace)
            .put("current", current)
            .toString()
            .toByteArray(Charsets.UTF_8)
        val response = try {
            transport.request("POST", "$baseUrl$PATH", mapOf("Content-Type" to "application/json"), body)
        } catch (_: IOException) {
            return Entitlement.claimOutcome(0, null)
        }
        return Entitlement.claimOutcome(response.status, String(response.body, Charsets.UTF_8))
    }
}
