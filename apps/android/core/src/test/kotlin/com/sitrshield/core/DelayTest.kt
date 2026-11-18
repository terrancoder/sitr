package com.sitrshield.core

import com.sitrshield.core.gate.Delay
import com.sitrshield.core.gate.DelayAction
import com.sitrshield.core.gate.DelayClockReading
import com.sitrshield.core.gate.DelayPhase
import com.sitrshield.core.gate.DelayStamp
import com.sitrshield.core.gate.DelayTwoClockEvaluation
import com.sitrshield.core.gate.Gate
import com.sitrshield.core.gate.GateContext
import com.sitrshield.core.gate.HouseholdRole
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.gate.MutationStep
import com.sitrshield.core.gate.MutationVerdict
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * The two-clock rule and the gate → delay → PIN order (port of
 * apps/ios/SitrCore/Tests/SitrCoreTests/DelayTests.swift). The pure
 * single-clock function is pinned by delay.json in FixtureTest.
 */
class DelayTest {
    private val min5 = 5 * 60_000L
    private val window = Delay.WINDOW_MS
    private val t = 1_700_000_000_000L
    /** Requested after 1 h of uptime. */
    private val stamp = DelayStamp(atMono = 3_600_000, atWall = t)

    private fun eval(mono: Long, wall: Long, s: DelayStamp = stamp) =
        Delay.evaluate(5, s, DelayClockReading(mono, wall))

    private fun ev(phase: DelayPhase, remaining: Long, s: DelayStamp?) =
        DelayTwoClockEvaluation(phase, remaining, s)

    @Test
    fun loosenCopyMatchesTheGate() {
        // Gate.kt's own set is private: loosening = PIN-gated, minus changePin.
        val pinned = MutationKind.entries.filter {
            it != MutationKind.CHANGE_PIN &&
                Gate.gateMutation(it, GateContext(false, null, true)) == MutationVerdict.Allowed(true)
        }.toSet()
        assertEquals(pinned, Delay.LOOSENING)
    }

    @Test
    fun bothClocksAgree() {
        assertEquals(ev(DelayPhase.WAITING, min5 - 60_000, stamp), eval(stamp.atMono + 60_000, t + 60_000))
        assertEquals(ev(DelayPhase.OPEN, window - 1000, stamp), eval(stamp.atMono + min5 + 1000, t + min5 + 1000))
        assertEquals(ev(DelayPhase.IDLE, 0, null), eval(stamp.atMono + min5 + window, t + min5 + window))
        // Same as the pure function on either clock.
        for (dt in listOf(0L, 1, min5 - 1, min5, min5 + window - 1, min5 + window)) {
            val pure = Delay.evaluate(5, com.sitrshield.core.gate.DelayRequest(t), t + dt)
            val two = eval(stamp.atMono + dt, t + dt)
            assertEquals(pure.phase, two.phase, "dt=$dt")
            assertEquals(pure.remainingMs, two.remainingMs, "dt=$dt")
        }
    }

    @Test
    fun wallClockForwardNeverOpensEarly() {
        for (jump in listOf(min5, min5 + 1, min5 + window / 2, 86_400_000L)) {
            assertNotEquals(DelayPhase.OPEN, eval(stamp.atMono + 60_000, t + jump).phase, "jump $jump")
        }
        assertEquals(ev(DelayPhase.WAITING, min5 - 60_000, stamp), eval(stamp.atMono + 60_000, t + min5 + 1000))
    }

    @Test
    fun wallClockBackRestartsBoth() {
        val now = DelayClockReading(stamp.atMono + min5 + 1000, t - 1)
        assertEquals(ev(DelayPhase.WAITING, min5, DelayStamp(now)), Delay.evaluate(5, stamp, now))
    }

    @Test
    fun rebootWithSmallUptimeRestarts() {
        val now = DelayClockReading(10_000, t + min5 + 1000)
        assertEquals(ev(DelayPhase.WAITING, min5, DelayStamp(now)), Delay.evaluate(5, stamp, now))
    }

    @Test
    fun rebootWithLargeUptimeOnlyRunsLate() {
        // New uptime ≥ atMono after a reboot: nowMono − atMono ≤ real elapsed.
        assertEquals(ev(DelayPhase.WAITING, min5 - 120_000, stamp), eval(stamp.atMono + 120_000, t + min5 + 1000))
        assertEquals(DelayPhase.IDLE, eval(stamp.atMono + 120_000, t + 86_400_000).phase)
    }

    @Test
    fun copiedStateNeverOpensEarly() {
        val low = DelayClockReading(1000, t + 60_000)
        assertEquals(ev(DelayPhase.WAITING, min5, DelayStamp(low)), Delay.evaluate(5, stamp, low))
        assertNotEquals(DelayPhase.OPEN, eval(30 * 86_400_000L, t + 60_000).phase)
        assertEquals(ev(DelayPhase.WAITING, min5 - 60_000, stamp), eval(stamp.atMono + min5 + 1000, t + 60_000))
    }

    @Test
    fun eitherClockPastWindowClears() {
        assertEquals(ev(DelayPhase.IDLE, 0, null), eval(stamp.atMono + min5 + 1000, t + min5 + window))
    }

    @Test
    fun windowsThatCanNeverOverlapClear() {
        val day = 86_400_000L
        val hour = 3_600_000L
        val s = DelayStamp(0, t)
        assertEquals(ev(DelayPhase.IDLE, 0, null), Delay.evaluate(1440, s, DelayClockReading(hour, t + day - 2 * hour)))
        assertEquals(
            ev(DelayPhase.WAITING, 5 * 60_000, s),
            Delay.evaluate(1440, s, DelayClockReading(day - 5 * 60_000, t + day + 60_000)),
        )
    }

    @Test
    fun openOnlyWhileBothOpenForTheShorterRemainder() {
        assertEquals(ev(DelayPhase.OPEN, window - 5000, stamp), eval(stamp.atMono + min5 + 1000, t + min5 + 5000))
    }

    @Test
    fun offAndNoRequest() {
        assertEquals(ev(DelayPhase.OFF, 0, null), Delay.evaluate(0, stamp, DelayClockReading(0, 0)))
        assertEquals(ev(DelayPhase.IDLE, 0, null), Delay.evaluate(5, null, DelayClockReading(0, 0)))
    }

    @Test
    fun joiningAHouseholdWaitsLikeDisablingACategory() {
        val join = DelayAction.Kind(Delay.JOIN_HOUSEHOLD_WAITS_AS)
        assertTrue(Delay.needsWait(join, DelayPhase.IDLE))
        assertTrue(Delay.needsWait(join, DelayPhase.WAITING))
        // Wait off (a normal first-time join) or window open: straight through.
        assertFalse(Delay.needsWait(join, DelayPhase.OFF))
        assertFalse(Delay.needsWait(join, DelayPhase.OPEN))
    }

    @Test
    fun decisionOrder() {
        val child = GateContext(false, HouseholdRole.CHILD, true)
        val managed = GateContext(true, null, false)
        val pin = GateContext(false, HouseholdRole.GUARDIAN, true)
        val none = GateContext(false, null, false)
        val off = DelayAction.Kind(MutationKind.DISABLE_CATEGORY)
        val shorten = DelayAction.ShortenDelay
        // Gate first: refused stays refused, even while waiting or open.
        assertEquals(MutationStep.Refused(MutationVerdict.Reason.CHILD_DEVICE), Delay.decide(off, child, DelayPhase.WAITING))
        assertEquals(MutationStep.Refused(MutationVerdict.Reason.CHILD_DEVICE), Delay.decide(shorten, child, DelayPhase.OPEN))
        assertEquals(MutationStep.Refused(MutationVerdict.Reason.MANAGED_LOCKED), Delay.decide(shorten, managed, DelayPhase.OPEN))
        // Then the delay, before any PIN prompt.
        assertEquals(MutationStep.Wait, Delay.decide(off, pin, DelayPhase.IDLE))
        assertEquals(MutationStep.Wait, Delay.decide(shorten, pin, DelayPhase.WAITING))
        assertEquals(MutationStep.Wait, Delay.decide(off, none, DelayPhase.WAITING))
        // Then the PIN.
        assertEquals(MutationStep.Pin, Delay.decide(off, pin, DelayPhase.OPEN))
        assertEquals(MutationStep.Pin, Delay.decide(shorten, pin, DelayPhase.OPEN))
        assertEquals(MutationStep.Go, Delay.decide(off, none, DelayPhase.OPEN))
        assertEquals(MutationStep.Go, Delay.decide(off, none, DelayPhase.OFF))
        // Tightening never waits; changePin waits for nothing but the PIN.
        assertEquals(MutationStep.Go, Delay.decide(DelayAction.Kind(MutationKind.ENABLE_CATEGORY), pin, DelayPhase.IDLE))
        assertEquals(MutationStep.Pin, Delay.decide(DelayAction.Kind(MutationKind.CHANGE_PIN), pin, DelayPhase.IDLE))
        // The re-check after a correct PIN: the window closed while the
        // dialog was open → held again.
        assertTrue(Delay.needsWait(off, DelayPhase.IDLE))
        assertTrue(Delay.needsWait(shorten, DelayPhase.WAITING))
        assertFalse(Delay.needsWait(off, DelayPhase.OPEN))
        // Lengthening (or turning on) is free; shortening (or off) is gated.
        assertEquals(null, Delay.changeAction(0, 5))
        assertEquals(DelayAction.ShortenDelay, Delay.changeAction(5, 0))
    }
}
