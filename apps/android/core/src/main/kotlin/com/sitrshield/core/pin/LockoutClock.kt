package com.sitrshield.core.pin

/**
 * The PIN lockout's clock: time since boot, carried across reboots, so
 * nobody can set it. On the wall clock, moving the date forward ended a
 * lockout, and moving it forward, failing, and moving it back made one
 * that lasted years — with the child lock on, a guardian locked out for
 * good. Time spent powered off is not counted: a wait only gets longer.
 */
object LockoutClock {
    /** The base to store, given the uptime stored last and the uptime now (ms). */
    fun nextBase(base: Long, lastUptime: Long, uptime: Long): Long =
        if (uptime < lastUptime) base + lastUptime else base // uptime restarted: a reboot

    /** No stored deadline is honoured beyond the longest wait there is. */
    fun clamp(attempts: PinAttempts, now: Double): PinAttempts =
        if (attempts.lockedUntil - now > Pin.MAX_DELAY_MS) {
            attempts.copy(lockedUntil = now + Pin.MAX_DELAY_MS)
        } else attempts
}
