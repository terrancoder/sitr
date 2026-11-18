package com.sitrshield.core.gate

/**
 * "Wait before loosening" — an optional, device-local delay in front of
 * every loosening change. Port of extension/src/lib/delay.ts (and of the
 * two-clock combiner in apps/ios/SitrCore/Sources/SitrCore/Delay.swift),
 * pinned by apps/shared/fixtures/delay.json. Pure: no clock reads; the app
 * supplies the time and persists whatever `evaluate` hands back.
 *
 * The one rule: a misbehaving clock may open the window LATE, never EARLY.
 */
enum class DelayPhase(val wire: String) {
    OFF("off"), IDLE("idle"), WAITING("waiting"), OPEN("open");

    companion object {
        fun fromWire(s: String?): DelayPhase? = entries.firstOrNull { it.wire == s }
    }
}

data class DelayRequest(val at: Long)

data class DelayEvaluation(
    val phase: DelayPhase,
    val remainingMs: Long,
    /** The request to persist: may be restarted (clock went back) or cleared. */
    val request: DelayRequest?,
)

/**
 * A gate kind, or the delay's one action of its own: making the delay
 * shorter (or off). Making it longer (or turning it on) is free.
 */
sealed class DelayAction {
    data class Kind(val kind: MutationKind) : DelayAction()
    data object ShortenDelay : DelayAction()

    companion object {
        fun fromWire(s: String?): DelayAction? =
            if (s == "shortenDelay") ShortenDelay else MutationKind.fromWire(s)?.let(::Kind)
    }
}

sealed class MutationStep {
    data class Refused(val reason: MutationVerdict.Reason) : MutationStep()
    data object Wait : MutationStep()
    data object Pin : MutationStep()
    data object Go : MutationStep()
}

/** One reading of both clocks, in ms. `mono` counts during sleep and
 *  restarts from zero at boot; `wall` is the user-settable time of day. */
data class DelayClockReading(val mono: Long, val wall: Long)

/** A stored request: when it was made, on both clocks. */
data class DelayStamp(val atMono: Long, val atWall: Long) {
    constructor(now: DelayClockReading) : this(now.mono, now.wall)
}

data class DelayTwoClockEvaluation(
    val phase: DelayPhase,
    val remainingMs: Long,
    /** Persist whenever it differs from the stamp passed in. */
    val stamp: DelayStamp?,
)

object Delay {
    /** Allowed delays in minutes; 0 = off. */
    val MINUTES_ALLOWED = listOf(0, 5, 30, 60, 360, 1440)
    /** How long changes stay open once the wait has run out. */
    const val WINDOW_MS: Long = 10 * 60_000L
    /** The gate has no row for the delay (gate.json stays as it is), so
     *  shortening it is gated exactly like disabling a category. */
    val SHORTEN_DELAY_GATED_AS = MutationKind.DISABLE_CATEGORY
    /** Joining a household waits exactly like disabling a category
     *  (delay.json "joinHouseholdWaitsAs"). The delay alone: never refused
     *  (no household yet, so no lock row or child role applies) and no PIN
     *  (a device outside a household has none). */
    val JOIN_HOUSEHOLD_WAITS_AS = MutationKind.DISABLE_CATEGORY

    /** Gate.LOOSENING is private (and Gate.kt is fixture-pinned as is);
     *  DelayTest checks this copy against the gate's PIN rule. */
    internal val LOOSENING = setOf(
        MutationKind.DISABLE_CATEGORY,
        MutationKind.REMOVE_DEVICE_BLOCK_RULE,
        MutationKind.ADD_DEVICE_ALLOW_RULE,
        MutationKind.REMOVE_HOUSEHOLD_RULE,
        MutationKind.LEAVE_HOUSEHOLD,
        MutationKind.LOOSEN_MEDIA_MODE,
        MutationKind.ADD_IMAGE_ALLOW_RULE,
    )

    fun sanitizeMinutes(raw: Int): Int = if (raw in MINUTES_ALLOWED) raw else 0

    fun evaluate(delayMinutes: Int, request: DelayRequest?, now: Long): DelayEvaluation {
        if (delayMinutes <= 0) return DelayEvaluation(DelayPhase.OFF, 0, null)
        if (request == null) return DelayEvaluation(DelayPhase.IDLE, 0, null)
        val delayMs = delayMinutes * 60_000L
        // Clock went backwards (reboot on a monotonic clock, wall clock set
        // back): restart the wait from now rather than guess.
        if (now < request.at) return DelayEvaluation(DelayPhase.WAITING, delayMs, DelayRequest(now))
        // Via elapsed, never `at + delay`: no overflow near the top of the range.
        val elapsed = now - request.at
        if (elapsed < delayMs) return DelayEvaluation(DelayPhase.WAITING, delayMs - elapsed, request)
        if (elapsed - delayMs < WINDOW_MS) {
            return DelayEvaluation(DelayPhase.OPEN, WINDOW_MS - (elapsed - delayMs), request)
        }
        return DelayEvaluation(DelayPhase.IDLE, 0, null)
    }

    /** True when `action` must wait for the open window before it may run. */
    fun needsWait(action: DelayAction, phase: DelayPhase): Boolean {
        if (phase == DelayPhase.OFF || phase == DelayPhase.OPEN) return false
        return when (action) {
            DelayAction.ShortenDelay -> true
            is DelayAction.Kind -> action.kind in LOOSENING
        }
    }

    /** Changing the setting: ShortenDelay when shorter or off, else free (null). */
    fun changeAction(from: Int, to: Int): DelayAction? =
        if (to < from) DelayAction.ShortenDelay else null

    /**
     * The whole order in one place: gate first, then the delay, then the
     * PIN. After a correct PIN the caller asks `needsWait` AGAIN — the PIN
     * dialog can sit open past the window.
     */
    fun decide(action: DelayAction, ctx: GateContext, phase: DelayPhase): MutationStep {
        val kind = when (action) {
            DelayAction.ShortenDelay -> SHORTEN_DELAY_GATED_AS
            is DelayAction.Kind -> action.kind
        }
        return when (val verdict = Gate.gateMutation(kind, ctx)) {
            is MutationVerdict.Refused -> MutationStep.Refused(verdict.reason)
            is MutationVerdict.Allowed -> when {
                needsWait(action, phase) -> MutationStep.Wait
                verdict.requiresPin -> MutationStep.Pin
                else -> MutationStep.Go
            }
        }
    }

    /**
     * Evaluate on both clocks and keep the STRICTER answer:
     *   - either clock went back → the wait restarts on both;
     *   - either clock is past the window → closed, request cleared (it
     *     can never open, so a countdown would be a lie);
     *   - the two clocks' windows can never overlap → cleared, same reason;
     *   - either clock still waiting → waiting, for the longer remainder;
     *   - open only when both say open, for the shorter remainder.
     *
     * Why this holds:
     *   - Wall clock set forward: the monotonic clock is still waiting.
     *   - Reboot: elapsedRealtime restarts at zero, so afterwards
     *     `nowMono − atMono ≤ nowMono ≤ real time since the request`. It can
     *     only run late — or go "backwards" and restart the wait.
     *   - State copied onto another device: its uptime is unrelated, so the
     *     monotonic reading may run early — but the wall clock still counts
     *     honestly from the request.
     *
     * ponytail: two faults at once open it early — a copied state landing
     * in the open band on uptime AND a wall clock set forward. Android has
     * allowBackup=false, so only a rooted copy gets there. Upgrade path:
     * stamp the boot count (Settings.Global.BOOT_COUNT) and restart on change.
     */
    fun evaluate(delayMinutes: Int, stamp: DelayStamp?, now: DelayClockReading): DelayTwoClockEvaluation {
        if (delayMinutes <= 0) return DelayTwoClockEvaluation(DelayPhase.OFF, 0, null)
        if (stamp == null) return DelayTwoClockEvaluation(DelayPhase.IDLE, 0, null)
        if (now.mono < stamp.atMono || now.wall < stamp.atWall) {
            return DelayTwoClockEvaluation(DelayPhase.WAITING, delayMinutes * 60_000L, DelayStamp(now))
        }
        val both = listOf(
            evaluate(delayMinutes, DelayRequest(stamp.atMono), now.mono),
            evaluate(delayMinutes, DelayRequest(stamp.atWall), now.wall),
        )
        val closed = DelayTwoClockEvaluation(DelayPhase.IDLE, 0, null)
        if (both.any { it.phase == DelayPhase.IDLE }) return closed
        // Each clock's open window, in ms from now. If the two never
        // overlap, it can never open: clear rather than count down to nothing.
        val spans = both.map {
            if (it.phase == DelayPhase.OPEN) 0L to it.remainingMs
            else it.remainingMs to it.remainingMs + WINDOW_MS
        }
        if (spans.maxOf { it.first } >= spans.minOf { it.second }) return closed
        val waiting = both.filter { it.phase == DelayPhase.WAITING }
        if (waiting.isNotEmpty()) {
            return DelayTwoClockEvaluation(DelayPhase.WAITING, waiting.maxOf { it.remainingMs }, stamp)
        }
        return DelayTwoClockEvaluation(DelayPhase.OPEN, both.minOf { it.remainingMs }, stamp)
    }
}
