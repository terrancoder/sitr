package com.sitrshield.core.household

import com.sitrshield.core.SitrResult
import com.sitrshield.core.categories.Categories
import com.sitrshield.core.domains.DomainInput
import com.sitrshield.core.pin.PinRecord
import com.sitrshield.core.sync.SyncCrypto
import org.json.JSONArray
import org.json.JSONObject

/**
 * Household state — the settings a family shares across devices.
 * Port of extension/src/lib/household.ts, pinned by apps/shared/fixtures/
 * {sanitize,merge,blob}.json.
 *
 * Merge strategy: last-writer-wins on a monotonic `rev` counter; ties
 * broken by `updatedAt`, then `updatedBy`. Kotlin String comparison is by
 * UTF-16 code unit, same as the reference's JavaScript `>`, so every
 * implementation picks the same winner.
 */
data class HouseholdState(
    val rev: Int,
    val updatedAt: Double,
    val updatedBy: String,
    val allowDomains: List<String> = emptyList(),
    val blockDomains: List<String> = emptyList(),
    val devices: List<String> = emptyList(),
    val disabledCategories: List<String> = emptyList(),
    val pin: PinRecord? = null,
    val childLockOptions: Boolean = true,
)

object Household {
    /** Hard cap keeps the encrypted blob far under the server's 64 KiB limit. */
    const val MAX_HOUSEHOLD_DOMAINS = 2_000

    /**
     * Fair-use soft cap (threat-model: friction, never surveillance).
     * Enforced by honest clients only — the server cannot count devices,
     * which is the product working as designed.
     */
    const val MAX_HOUSEHOLD_DEVICES = 20

    fun emptyState(deviceId: String, now: Double): HouseholdState =
        HouseholdState(
            rev = 1,
            updatedAt = now,
            updatedBy = deviceId,
            devices = listOf(deviceId),
        )

    /** JSON number that is genuinely a number (org.json booleans are Boolean). */
    private fun asNumber(v: Any?): Double? = when (v) {
        null, JSONObject.NULL, is Boolean -> null
        is Number -> v.toDouble()
        else -> null
    }

    private fun asList(v: Any?): List<Any?>? = when (v) {
        is JSONArray -> (0 until v.length()).map { v.opt(it) }
        else -> null
    }

    private fun sanitizeDomains(raw: Any?): SitrResult<List<String>> {
        val array = asList(raw) ?: return SitrResult.Ok(emptyList())
        val seen = LinkedHashSet<String>()
        for (item in array) {
            if (item is String && DomainInput.isValidDomain(item)) seen.add(item)
        }
        val domains = seen.sorted()
        if (domains.size > MAX_HOUSEHOLD_DOMAINS) {
            return SitrResult.Err("household list exceeds $MAX_HOUSEHOLD_DOMAINS domains")
        }
        return SitrResult.Ok(domains)
    }

    fun sanitizePinRecord(raw: Any?): PinRecord? {
        val o = raw as? JSONObject ?: return null
        val iterations = asNumber(o.opt("iterations")) ?: return null
        if (asNumber(o.opt("v")) != 1.0) return null
        if (o.opt("algo") != "PBKDF2-SHA256") return null
        if (iterations < 1 || iterations % 1.0 != 0.0) return null
        val saltB64 = o.opt("saltB64") as? String ?: return null
        val hashB64 = o.opt("hashB64") as? String ?: return null
        return try {
            java.util.Base64.getDecoder().decode(saltB64)
            java.util.Base64.getDecoder().decode(hashB64)
            PinRecord(iterations.toInt(), saltB64, hashB64)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /**
     * Total validator for anything claiming to be a HouseholdState — used
     * on every decrypted blob and every storage read. Unknown schema
     * versions are an ERROR, not a guess.
     */
    fun sanitize(raw: Any?): SitrResult<HouseholdState> {
        val o = raw as? JSONObject
            ?: return SitrResult.Err("household state is not an object")
        if (asNumber(o.opt("v")) != 1.0) {
            return SitrResult.Err("unknown household state version")
        }
        val rev = asNumber(o.opt("rev"))
        if (rev == null || rev % 1.0 != 0.0 || rev < 1) {
            return SitrResult.Err("household state has no valid rev")
        }
        val allowDomains = when (val r = sanitizeDomains(o.opt("allowDomains"))) {
            is SitrResult.Err -> return r
            is SitrResult.Ok -> r.value
        }
        val blockDomains = when (val r = sanitizeDomains(o.opt("blockDomains"))) {
            is SitrResult.Err -> return r
            is SitrResult.Ok -> r.value
        }

        val devices = asList(o.opt("devices"))
            ?.filterIsInstance<String>()
            ?.filter { it.isNotEmpty() && it.length <= 64 }
            ?.let { LinkedHashSet(it).sorted() }
            ?: emptyList()
        if (devices.size > MAX_HOUSEHOLD_DEVICES) {
            return SitrResult.Err(
                "household has more than $MAX_HOUSEHOLD_DEVICES devices — see the fair-use policy"
            )
        }

        val updatedAtRaw = asNumber(o.opt("updatedAt"))
        val updatedBy = (o.opt("updatedBy") as? String)?.take(64) ?: ""
        val policy = o.opt("policy") as? JSONObject
        val childLockOptions = policy?.opt("childLockOptions") != false

        return SitrResult.Ok(
            HouseholdState(
                rev = rev.toInt(),
                updatedAt = if (updatedAtRaw != null && updatedAtRaw >= 0) updatedAtRaw else 0.0,
                updatedBy = updatedBy,
                allowDomains = allowDomains,
                blockDomains = blockDomains,
                devices = devices,
                disabledCategories = Categories.sanitizeDisabled(asList(o.opt("disabledCategories"))),
                pin = sanitizePinRecord(o.opt("pin")),
                childLockOptions = childLockOptions,
            )
        )
    }

    /** Last-writer-wins; ties broken by updatedAt, then updatedBy (stable). */
    fun merge(a: HouseholdState, b: HouseholdState): HouseholdState {
        if (a.rev != b.rev) return if (a.rev > b.rev) a else b
        if (a.updatedAt != b.updatedAt) return if (a.updatedAt > b.updatedAt) a else b
        return if (a.updatedBy > b.updatedBy) a else b
    }

    /** A new revision authored by this device. */
    fun bumpRev(s: HouseholdState, deviceId: String, now: Double): HouseholdState =
        s.copy(rev = s.rev + 1, updatedAt = now, updatedBy = deviceId)

    /** The JSON object shape shared with the reference implementation. */
    fun toJSONObject(s: HouseholdState): JSONObject {
        val o = JSONObject()
        o.put("v", 1)
        o.put("rev", s.rev)
        if (s.updatedAt % 1.0 == 0.0) o.put("updatedAt", s.updatedAt.toLong())
        else o.put("updatedAt", s.updatedAt)
        o.put("updatedBy", s.updatedBy)
        o.put("allowDomains", JSONArray(s.allowDomains))
        o.put("blockDomains", JSONArray(s.blockDomains))
        o.put("devices", JSONArray(s.devices))
        o.put("disabledCategories", JSONArray(s.disabledCategories))
        s.pin?.let { pin ->
            o.put(
                "pin",
                JSONObject()
                    .put("v", 1)
                    .put("algo", "PBKDF2-SHA256")
                    .put("iterations", pin.iterations)
                    .put("saltB64", pin.saltB64)
                    .put("hashB64", pin.hashB64)
            )
        }
        o.put("policy", JSONObject().put("childLockOptions", s.childLockOptions))
        return o
    }

    /** Seal a state for the wire: JSON-encode then SyncCrypto.seal. */
    fun sealState(
        state: HouseholdState,
        encKey: ByteArray,
        nonce: ByteArray? = null,
    ): SitrResult<ByteArray> =
        SyncCrypto.seal(
            toJSONObject(state).toString().toByteArray(Charsets.UTF_8),
            encKey,
            nonce,
        )

    /** Open a blob to a SANITIZED state — decrypt, JSON-parse, sanitize. */
    fun openState(blob: ByteArray, encKey: ByteArray): SitrResult<HouseholdState> {
        val plaintext = when (val r = SyncCrypto.open(blob, encKey)) {
            is SitrResult.Err -> return r
            is SitrResult.Ok -> r.value
        }
        val parsed = try {
            JSONObject(String(plaintext, Charsets.UTF_8))
        } catch (_: Exception) {
            return SitrResult.Err("decrypted blob is not valid JSON")
        }
        return sanitize(parsed)
    }
}
