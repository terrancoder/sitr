package com.sitrshield.core

import com.sitrshield.core.gate.Delay
import com.sitrshield.core.gate.DelayAction
import com.sitrshield.core.gate.DelayClockReading
import com.sitrshield.core.gate.DelayPhase
import com.sitrshield.core.gate.DelayStamp
import com.sitrshield.core.gate.GateContext
import com.sitrshield.core.gate.HouseholdRole
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.gate.MutationStep
import com.sitrshield.core.gate.MutationVerdict
import com.sitrshield.core.gate.Pause
import com.sitrshield.core.gate.PauseRecord
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pause timing and the 15-in-60 allowance on fixed clocks. mono is
 * elapsedRealtime (counts sleep, restarts at boot), wall the settable time.
 */
class PauseTest {
    private val min = 60_000L
    private val start = DelayStamp(atMono = 1_000_000L, atWall = 1_700_000_000_000L)

    /** Both clocks `ms` after the start, unless one is given explicitly. */
    private fun at(ms: Long, mono: Long = start.atMono + ms, wall: Long = start.atWall + ms) =
        DelayClockReading(mono, wall)

    private fun rec(startMs: Long, usedMin: Long) =
        PauseRecord(DelayStamp(start.atMono + startMs, start.atWall + startMs), usedMin * min)

    @Test
    fun aPauseIsGatedLikeTurningProtectionOff() {
        assertEquals(MutationKind.DISABLE_CATEGORY, Pause.GATED_AS)
        assertEquals(listOf(5, 15), Pause.MINUTES_ALLOWED)
    }

    @Test
    fun aPauseTakesTheSameGateAsTurningProtectionOff() {
        val pause = DelayAction.Kind(Pause.GATED_AS)
        fun ctx(role: HouseholdRole? = null, pin: Boolean = false, locked: Boolean = false) =
            GateContext(managedLockOptions = locked, role = role, hasPin = pin)
        assertEquals(MutationStep.Go, Delay.decide(pause, ctx(), DelayPhase.OFF))
        assertEquals(MutationStep.Pin, Delay.decide(pause, ctx(HouseholdRole.GUARDIAN, pin = true), DelayPhase.OFF))
        assertEquals(MutationStep.Wait, Delay.decide(pause, ctx(), DelayPhase.IDLE))
        assertEquals(
            MutationStep.Refused(MutationVerdict.Reason.CHILD_DEVICE),
            Delay.decide(pause, ctx(HouseholdRole.CHILD, pin = true), DelayPhase.OFF),
        )
        assertEquals(
            MutationStep.Refused(MutationVerdict.Reason.MANAGED_LOCKED),
            Delay.decide(pause, ctx(locked = true), DelayPhase.OPEN),
        )
    }

    @Test
    fun pauseRunsItsLengthOnBothClocks() {
        assertEquals(5 * min, Pause.remaining(start, 5 * min, at(0)))
        assertEquals(2 * min, Pause.remaining(start, 5 * min, at(3 * min)))
        assertEquals(0, Pause.remaining(start, 5 * min, at(5 * min)))
        assertEquals(0, Pause.remaining(start, 5 * min, at(9 * min)))
    }

    @Test
    fun wallClockForwardEndsThePauseEarlyNeverLate() {
        // mono says 1 minute in, wall says an hour: the stricter (sooner) end wins.
        assertEquals(0, Pause.remaining(start, 15 * min, at(min, wall = start.atWall + 60 * min)))
        // wall a little ahead shortens it by that much.
        assertEquals(10 * min, Pause.remaining(start, 15 * min, at(min, wall = start.atWall + 5 * min)))
    }

    @Test
    fun aClockGoingBackEndsThePause() {
        assertEquals(0, Pause.remaining(start, 15 * min, at(min, wall = start.atWall - min)))
        // Reboot: elapsedRealtime restarts near zero.
        assertEquals(0, Pause.remaining(start, 15 * min, at(min, mono = 30_000L)))
    }

    @Test
    fun resumeNowGivesNothingBack() {
        // A 15-minute pause resumed after one minute: its record was written
        // whole before it started, so the allowance stays used for the hour.
        val resumedEarly = listOf(rec(0, 15))
        assertEquals(59 * min, Pause.waitFor(5, Pause.live(resumedEarly, at(min)), at(min)))
    }

    @Test
    fun allowanceIsFifteenMinutesInAnySixty() {
        val now = at(20 * min)
        assertEquals(0, Pause.waitFor(15, emptyList(), now))
        // Three pauses of 5 use it all; the next fits when the first is an hour old.
        val three = listOf(rec(0, 5), rec(5 * min, 5), rec(10 * min, 5))
        assertEquals(40 * min, Pause.waitFor(5, three, now))
        // 15 needs all three gone: the last started at 10, so at 70.
        assertEquals(50 * min, Pause.waitFor(15, three, now))
    }

    @Test
    fun aPauseThatWouldExceedTheAllowanceWaits() {
        val now = at(10 * min)
        val used = listOf(rec(0, 12))
        assertEquals(50 * min, Pause.waitFor(5, used, now)) // 12 + 5 > 15
        assertEquals(0, Pause.waitFor(5, listOf(rec(0, 10)), now)) // 10 + 5 = 15 exactly fits
        assertEquals(50 * min, Pause.waitFor(15, listOf(rec(0, 1)), now)) // one used minute blocks 15
    }

    @Test
    fun recordsStopCountingOnlyWhenBothClocksSayAnHour() {
        val r = listOf(rec(0, 15))
        assertEquals(emptyList(), Pause.live(r, at(60 * min)))
        assertEquals(r, Pause.live(r, at(59 * min)))
        // Wall set forward two hours: the monotonic clock still counts it.
        assertEquals(r, Pause.live(r, at(5 * min, wall = start.atWall + 120 * min)))
    }

    @Test
    fun rebootOrClockBackKeepsTheAllowanceUsedForAFullHour() {
        val r = listOf(rec(0, 15))
        // Reboot 30 minutes later: mono restarted at 20 s. The record is restamped at now.
        val afterBoot = DelayClockReading(mono = 20_000L, wall = start.atWall + 30 * min)
        val live = Pause.live(r, afterBoot)
        assertEquals(listOf(PauseRecord(DelayStamp(afterBoot), 15 * min)), live)
        assertEquals(60 * min, Pause.waitFor(5, live, afterBoot))
        // Wall clock set back: same.
        val back = at(10 * min, wall = start.atWall - 5 * min)
        assertEquals(60 * min, Pause.waitFor(5, Pause.live(r, back), back))
    }
}
