package com.sitrshield.core.gate

/**
 * "Pause protection": the VPN goes down for 5 or 15 minutes and comes back
 * by itself. Pure: no clock reads; the app supplies both clocks (the same
 * DelayClockReading as "wait before loosening") and persists the records.
 *
 * The rule is Delay's: a misbehaving clock may end a pause EARLY and keep
 * the allowance used LONGER, never the other way round.
 *   - A pause ends when EITHER clock says its time is up, or either clock
 *     went back (a reboot restarts the monotonic clock).
 *   - The allowance: at most 15 minutes of pause in any 60. Each pause is
 *     a record that counts until BOTH clocks place its start 60 minutes
 *     back. A clock that went back restamps the record at now, so after a
 *     reboot every remembered pause counts for a full hour again.
 *   - "Resume now" gives nothing back: a pause uses its whole chosen
 *     length, wherever it is resumed (Home or the notification), so the
 *     record is written once, before the pause starts.
 */
data class PauseRecord(val at: DelayStamp, val usedMs: Long)

object Pause {
    val MINUTES_ALLOWED = listOf(5, 15)
    const val ALLOWANCE_MS: Long = 15 * 60_000L
    const val WINDOW_MS: Long = 60 * 60_000L

    /** A pause switches all filtering off: gated exactly like turning protection off. */
    val GATED_AS = MutationKind.DISABLE_CATEGORY

    /** Ms of pause left; 0 = over. */
    fun remaining(start: DelayStamp, lengthMs: Long, now: DelayClockReading): Long {
        val mono = now.mono - start.atMono
        val wall = now.wall - start.atWall
        if (mono < 0 || wall < 0) return 0
        return (lengthMs - maxOf(mono, wall)).coerceAtLeast(0)
    }

    /** Records still counting, restamped where a clock went back. Persist when changed. */
    fun live(records: List<PauseRecord>, now: DelayClockReading): List<PauseRecord> =
        records.mapNotNull { r ->
            val mono = now.mono - r.at.atMono
            val wall = now.wall - r.at.atWall
            when {
                mono < 0 || wall < 0 -> r.copy(at = DelayStamp(now))
                minOf(mono, wall) >= WINDOW_MS -> null
                else -> r
            }
        }

    /** Ms until a record stops counting: the slower clock decides. */
    private fun expiresIn(r: PauseRecord, now: DelayClockReading): Long =
        WINDOW_MS - minOf(now.mono - r.at.atMono, now.wall - r.at.atWall)

    /**
     * Ms until a pause of `minutes` fits the allowance; 0 = it fits now.
     * `records` must already be `live` for `now`.
     */
    fun waitFor(minutes: Int, records: List<PauseRecord>, now: DelayClockReading): Long {
        val need = minutes * 60_000L
        var used = records.sumOf { it.usedMs }
        if (used + need <= ALLOWANCE_MS) return 0
        for (r in records.sortedBy { expiresIn(it, now) }) {
            used -= r.usedMs
            if (used + need <= ALLOWANCE_MS) return expiresIn(r, now)
        }
        return WINDOW_MS // unreachable for need <= ALLOWANCE_MS
    }
}
