package com.sitrshield.core.sync

/**
 * Sync status — Family-screen visibility ONLY.
 * Port of extension/src/lib/sync/status.ts.
 *
 * INVARIANT: sync state never touches protection status or the
 * notification. Filtering is local; a broken sync leaves protection fully
 * intact, so it must not paint anything red. It IS surfaced here, never
 * swallowed.
 */
data class SyncStatus(
    val state: State,
    val lastSuccessAt: Double? = null,
    val error: String? = null,
) {
    enum class State { NEVER, OK, ERROR, OFFLINE }

    companion object {
        val NEVER_SYNCED = SyncStatus(State.NEVER)
    }

    fun describe(formatTime: (Double) -> String): String = when (state) {
        State.NEVER -> "Sync: not yet synced on this device."
        State.OK ->
            if (lastSuccessAt != null)
                "Sync: up to date (last synced ${formatTime(lastSuccessAt)})."
            else "Sync: up to date."
        State.OFFLINE -> "Sync: offline — filtering still fully active on this device."
        State.ERROR ->
            "Sync: failed (${error ?: "unknown error"}) — filtering still fully active on this device."
    }
}
