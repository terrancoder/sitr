package com.sitrshield.core

import com.sitrshield.core.household.Household
import com.sitrshield.core.pin.LockoutClock
import com.sitrshield.core.pin.Pin
import com.sitrshield.core.pin.PinAttempts
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LockoutClockTest {
    @Test
    fun theClockNeverRunsBackwardsAcrossAReboot() {
        var base = 0L
        var last = 0L
        fun tick(uptime: Long): Long {
            base = LockoutClock.nextBase(base, last, uptime)
            last = uptime
            return base + uptime
        }
        assertEquals(600_000, tick(600_000)) // ten minutes after boot
        assertEquals(600_500, tick(500)) // rebooted: carries on from where it was
        assertEquals(660_000, tick(60_000))
    }

    @Test
    fun aDeadlineIsNeverFurtherAwayThanTheLongestWait() {
        val now = 5_000_000.0
        val yearAway = PinAttempts(count = 9, lockedUntil = now + 365 * 86_400_000.0)
        assertEquals(now + Pin.MAX_DELAY_MS, LockoutClock.clamp(yearAway, now).lockedUntil)
        val soon = PinAttempts(count = 5, lockedUntil = now + 30_000)
        assertEquals(soon, LockoutClock.clamp(soon, now))
        // A real lockout still holds on this clock.
        assertTrue(Pin.isLockedOut(LockoutClock.clamp(yearAway, now), now) is SitrResult.Err)
    }

    @Test
    fun onlyTheNeverSyncedJoinStateIsAPlaceholder() {
        val joined = Household.emptyState("joiner", 0.0)
        assertTrue(Household.isJoinPlaceholder(joined))
        assertFalse(Household.isJoinPlaceholder(Household.emptyState("creator", 1_760_000_000_000.0)))
        assertFalse(Household.isJoinPlaceholder(Household.bumpRev(joined, "joiner", 0.0)))
    }
}
