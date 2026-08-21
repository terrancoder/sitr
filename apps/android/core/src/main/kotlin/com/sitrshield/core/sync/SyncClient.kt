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
)

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
    /** Signed subscription token; sent only on household creation. */
    val entitlement: String? = null,
)

data class SyncOutcome(
    /** The state the caller must apply + persist (merge result). */
    val state: HouseholdState,
    val maxSeenRev: Int,
    val status: SyncStatus,
    /** ETag of the server copy after this sync (diagnostics only). */
    val etag: Int?,
)

class SyncClient(
    private val transport: SyncTransport,
    private val now: () -> Double,
    private val baseUrl: String = DEFAULT_BASE_URL,
) {
    companion object {
        const val DEFAULT_BASE_URL = "https://sync.sitrshield.com"

        internal fun parseEtag(raw: String?): Int? {
            val trimmed = raw?.trim() ?: return null
            val match = Regex("^\"(\\d{1,15})\"$").find(trimmed) ?: return null
            return match.groupValues[1].toIntOrNull()
        }
    }

    private class Remote(val state: HouseholdState?, val etag: Int?)

    private sealed class AttemptError {
        object Retry : AttemptError()
        object Offline : AttemptError()
        class Message(val message: String) : AttemptError()
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
        if (response.status == 404) return SitrResult.Ok(Remote(null, null))
        if (response.status !in 200..299) {
            return SitrResult.Err("server responded ${response.status}")
        }
        val etag = parseEtag(response.etagHeader)
        return when (val opened = Household.openState(response.body, keys.encKey)) {
            is SitrResult.Err -> opened
            is SitrResult.Ok -> SitrResult.Ok(Remote(opened.value, etag))
        }
    }

    private fun push(
        keys: SyncCrypto.HouseholdKeys,
        state: HouseholdState,
        etag: Int?,
        entitlement: String?,
    ): SitrResult<Int> {
        val sealed = when (val r = Household.sealState(state, keys.encKey)) {
            is SitrResult.Err -> return r
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
            return SitrResult.Err(OFFLINE)
        }
        if (response.status == 409) return SitrResult.Err(CONFLICT)
        if (response.status !in 200..299) {
            return SitrResult.Err("server responded ${response.status}")
        }
        return SitrResult.Ok(parseEtag(response.etagHeader) ?: 0)
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
            // Push only when the server copy differs from the merge result.
            if (remoteState != null && remoteState.rev == merged.rev && remoteState == merged) {
                return SyncOutcome(
                    state = merged,
                    maxSeenRev = maxOf(maxSeen, merged.rev),
                    status = SyncStatus(SyncStatus.State.OK, lastSuccessAt = now()),
                    etag = remote.etag,
                )
            }
            val toPush =
                if (remoteState != null && remoteState.rev >= merged.rev && remoteState != merged)
                    Household.bumpRev(merged, input.deviceId, now())
                else merged
            return when (val pushed = push(keys, toPush, remote.etag, input.entitlement)) {
                is SitrResult.Err -> when (pushed.message) {
                    CONFLICT -> AttemptError.Retry
                    OFFLINE -> AttemptError.Offline
                    else -> AttemptError.Message(pushed.message)
                }
                is SitrResult.Ok -> SyncOutcome(
                    state = toPush,
                    maxSeenRev = maxOf(maxSeen, toPush.rev),
                    status = SyncStatus(SyncStatus.State.OK, lastSuccessAt = now()),
                    etag = pushed.value,
                )
            }
        }

        return when (val first = attempt()) {
            is SyncOutcome -> first
            AttemptError.Offline -> failed("offline", offline = true)
            is AttemptError.Message -> failed(first.message)
            AttemptError.Retry ->
                // One concurrent-write retry: re-pull, re-merge, re-push.
                when (val second = attempt()) {
                    is SyncOutcome -> second
                    AttemptError.Retry -> failed("repeated version conflicts")
                    AttemptError.Offline -> failed("offline", offline = true)
                    is AttemptError.Message -> failed(second.message)
                    else -> failed("unexpected sync state")
                }
            else -> failed("unexpected sync state")
        }
    }
}

private const val OFFLINE = "offline"
private const val CONFLICT = "conflict"
