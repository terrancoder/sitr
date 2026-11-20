package com.sitrshield.core.sync

import com.sitrshield.core.SitrResult
import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import java.io.IOException

/**
 * Sync client — pull → merge → push against the one documented endpoint
 * (docs/data-flow.md, docs/sync-protocol.md).
 * Port of extension/src/lib/sync/client.ts.
 *
 * THIS CLIENT'S TRANSPORT IS THE ANDROID APP'S ONLY HTTP CALL SITE —
 * the app implements SyncTransport in exactly one place (SyncHttp);
 * data-flow.md invites auditors to verify that claim; keep it true.
 *
 * INVARIANT: sync outcomes touch ONLY the sync status and household
 * state. They never touch protection status — filtering is local, so a
 * dead server leaves protection fully intact.
 *
 * Rollback detection: we remember the highest household rev ever
 * decrypted (`maxSeenRev`). An authenticated blob with a lower rev is an
 * error, surfaced but never applied.
 */
class SyncHttpResponse(
    val status: Int,
    val etagHeader: String?,
    val body: ByteArray,
    /** X-Sitr-Entitlement-Expires as received: the household's end `E`
     * (docs/sync-protocol.md §Telling clients the end). */
    val entExpHeader: String? = null,
) {
    val entExp: Double? get() = HouseholdEnd.parseEndHeader(entExpHeader)
}

/** Throw IOException to signal "offline"; anything else is a server error. */
interface SyncTransport {
    @Throws(IOException::class)
    fun request(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: ByteArray?,
    ): SyncHttpResponse
}

data class SyncInput(
    val rootSecret: ByteArray,
    /** The locally applied state (may be ahead of the server's). */
    val local: HouseholdState,
    /** Highest rev this device has ever decrypted from the server. */
    val maxSeenRev: Int,
    val deviceId: String,
    /** Signed subscription token. Sent with every push (docs/sync-protocol.md §Using the token). */
    val entitlement: String? = null,
    /** Write the household even when nothing changed, so a new token
     * reaches the server. Never writes a join placeholder. */
    val forceWrite: Boolean = false,
)

data class SyncOutcome(
    /** The state the caller must apply + persist (merge result). */
    val state: HouseholdState,
    val maxSeenRev: Int,
    val status: SyncStatus,
    /** ETag of the server copy after this sync (diagnostics only). */
    val etag: Long?,
    /** The household's end `E` from the last response that carried it. */
    val entExp: Double? = null,
    /** The sync server's 402 reason, when a write was refused with one. */
    val refusal: SyncRefusal? = null,
    /** This round created the household (a 201 to If-None-Match). */
    val created: Boolean = false,
)

class SyncClient(
    private val transport: SyncTransport,
    private val now: () -> Double,
    private val baseUrl: String = DEFAULT_BASE_URL,
) {
    companion object {
        const val DEFAULT_BASE_URL = "https://sync.sitrshield.com"

        internal fun parseEtag(raw: String?): Long? {
            val trimmed = raw?.trim() ?: return null
            val match = Regex("^\"(\\d{1,15})\"$").find(trimmed) ?: return null
            return match.groupValues[1].toLongOrNull()
        }
    }

    private class Remote(val state: HouseholdState?, val etag: Long?, val entExp: Double?)

    private class Pushed(val etag: Long, val entExp: Double?)

    private sealed class AttemptError {
        object Retry : AttemptError()
        object Offline : AttemptError()
        class Message(val message: String) : AttemptError()
        class Refused(val refusal: SyncRefusal, val entExp: Double?) : AttemptError()
    }

    private fun blobUrl(keys: SyncCrypto.HouseholdKeys): String =
        "$baseUrl/v1/blob/${keys.householdId}"

    private fun pull(keys: SyncCrypto.HouseholdKeys): SitrResult<Remote> {
        val response = try {
            transport.request(
                "GET", blobUrl(keys),
                mapOf("Authorization" to "Bearer ${keys.authToken}"),
                null,
            )
        } catch (_: IOException) {
            return SitrResult.Err(OFFLINE)
        }
        if (response.status == 404) return SitrResult.Ok(Remote(null, null, response.entExp))
        if (response.status !in 200..299) {
            return SitrResult.Err("server responded ${response.status}")
        }
        val etag = parseEtag(response.etagHeader)
        return when (val opened = Household.openState(response.body, keys.encKey)) {
            is SitrResult.Err -> opened
            is SitrResult.Ok -> SitrResult.Ok(Remote(opened.value, etag, response.entExp))
        }
    }

    private fun push(
        keys: SyncCrypto.HouseholdKeys,
        state: HouseholdState,
        etag: Long?,
        entitlement: String?,
    ): Any /* Pushed | AttemptError */ {
        val sealed = when (val r = Household.sealState(state, keys.encKey)) {
            is SitrResult.Err -> return AttemptError.Message(r.message)
            is SitrResult.Ok -> r.value
        }
        val headers = buildMap {
            put("Authorization", "Bearer ${keys.authToken}")
            if (etag != null) put("If-Match", "\"$etag\"") else put("If-None-Match", "*")
            if (!entitlement.isNullOrEmpty()) put("X-Sitr-Entitlement", entitlement)
        }
        val response = try {
            transport.request("PUT", blobUrl(keys), headers, sealed)
        } catch (_: IOException) {
            return AttemptError.Offline
        }
        if (response.status == 409) return AttemptError.Retry
        HouseholdEnd.parseSyncRefusal(response.status, String(response.body, Charsets.UTF_8))
            ?.let { return AttemptError.Refused(it, response.entExp) }
        if (response.status !in 200..299) {
            return AttemptError.Message("server responded ${response.status}")
        }
        return Pushed(parseEtag(response.etagHeader) ?: 0L, response.entExp)
    }

    /**
     * Leaving a household: take this device out of the shared device list
     * so its fair-use place is freed. A normal round first (adopt the
     * latest state), then the same state without this device as a new
     * revision. Best effort — offline or an error leaves the place taken.
     */
    fun unenroll(input: SyncInput): SyncOutcome {
        // A join placeholder was never enrolled and has nothing to take
        // off a list: it sends nothing.
        if (Household.isJoinPlaceholder(input.local)) {
            return SyncOutcome(input.local, input.maxSeenRev, SyncStatus.NEVER_SYNCED, null)
        }
        var outcome = syncOnce(input)
        repeat(2) {
            if (outcome.status.state != SyncStatus.State.OK ||
                input.deviceId !in outcome.state.devices
            ) return outcome
            val without = outcome.state.copy(devices = outcome.state.devices - input.deviceId)
            outcome = syncOnce(
                input.copy(
                    local = Household.bumpRev(without, input.deviceId, now()),
                    maxSeenRev = outcome.maxSeenRev,
                )
            )
        }
        return outcome
    }

    /**
     * One full sync round. Never throws. The returned state is always safe
     * to apply: merged, sanitized (via openState), and rollback-checked.
     */
    fun syncOnce(input: SyncInput): SyncOutcome {
        fun failed(error: String, offline: Boolean = false): SyncOutcome =
            SyncOutcome(
                state = input.local,
                maxSeenRev = input.maxSeenRev,
                status = SyncStatus(
                    state = if (offline) SyncStatus.State.OFFLINE else SyncStatus.State.ERROR,
                    error = error,
                ),
                etag = null,
            )

        val keys = when (val derived = SyncCrypto.deriveKeys(input.rootSecret)) {
            is SitrResult.Err -> return failed(derived.message)
            is SitrResult.Ok -> derived.value
        }

        fun attempt(): Any /* SyncOutcome | AttemptError */ {
            val remote = when (val pulled = pull(keys)) {
                is SitrResult.Err ->
                    return if (pulled.message == OFFLINE) AttemptError.Offline
                    else AttemptError.Message(pulled.message)
                is SitrResult.Ok -> pulled.value
            }

            // A joiner never creates the household: with no server copy, its
            // placeholder stays local and the round writes nothing (a wrong
            // code must not create a household; the creator pushes its own).
            if (remote.state == null && Household.isJoinPlaceholder(input.local)) {
                return SyncOutcome(
                    input.local, input.maxSeenRev, SyncStatus(SyncStatus.State.NOT_FOUND), null, remote.entExp,
                )
            }
            var merged = input.local
            var maxSeen = input.maxSeenRev
            val remoteState = remote.state
            if (remoteState != null) {
                if (remoteState.rev < input.maxSeenRev) {
                    return AttemptError.Message(
                        "server returned an older household state than previously seen — refusing to apply it"
                    )
                }
                maxSeen = maxOf(maxSeen, remoteState.rev)
                merged = Household.merge(input.local, remoteState)
            }
            // Push only when the server copy differs from the merge result,
            // or a forced write carries a new token (never a placeholder).
            val force = input.forceWrite && !Household.isJoinPlaceholder(merged)
            if (remoteState != null && remoteState.rev == merged.rev && remoteState == merged && !force) {
                return SyncOutcome(
                    state = merged,
                    maxSeenRev = maxOf(maxSeen, merged.rev),
                    status = SyncStatus(SyncStatus.State.OK, lastSuccessAt = now()),
                    etag = remote.etag,
                    entExp = remote.entExp,
                )
            }
            val toPush =
                if (remoteState != null && remoteState.rev >= merged.rev && remoteState != merged)
                    Household.bumpRev(merged, input.deviceId, now())
                else merged
            return when (val pushed = push(keys, toPush, remote.etag, input.entitlement)) {
                is Pushed -> SyncOutcome(
                    state = toPush,
                    maxSeenRev = maxOf(maxSeen, toPush.rev),
                    status = SyncStatus(SyncStatus.State.OK, lastSuccessAt = now()),
                    etag = pushed.etag,
                    entExp = pushed.entExp ?: remote.entExp,
                    // Sent with If-None-Match: a 2xx is a creation.
                    created = remote.etag == null,
                )
                is AttemptError.Refused -> AttemptError.Refused(pushed.refusal, pushed.entExp ?: remote.entExp)
                else -> pushed
            }
        }

        fun refused(r: AttemptError.Refused): SyncOutcome {
            val text = if (r.refusal == SyncRefusal.LAPSED) HouseholdEnd.WAITING_TEXT
            else Entitlement.TEXTS.getValue(r.refusal.wire)
            return failed(text).copy(entExp = r.entExp, refusal = r.refusal)
        }

        return when (val first = attempt()) {
            is SyncOutcome -> first
            AttemptError.Offline -> failed("offline", offline = true)
            is AttemptError.Message -> failed(first.message)
            is AttemptError.Refused -> refused(first)
            AttemptError.Retry ->
                // One concurrent-write retry: re-pull, re-merge, re-push.
                when (val second = attempt()) {
                    is SyncOutcome -> second
                    AttemptError.Retry -> failed("repeated version conflicts")
                    AttemptError.Offline -> failed("offline", offline = true)
                    is AttemptError.Message -> failed(second.message)
                    is AttemptError.Refused -> refused(second)
                    else -> failed("unexpected sync state")
                }
            else -> failed("unexpected sync state")
        }
    }
}

private const val OFFLINE = "offline"
