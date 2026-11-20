package com.sitrshield.core.sync

import com.sitrshield.core.SitrResult
import com.sitrshield.core.gate.HouseholdRole
import com.sitrshield.core.household.Household

/**
 * One background sync run with a household (Android's SyncWorker): a
 * FamilyRound, then, when this device is missing from the device list, the
 * enrolment round (Household.enrolDevice) as a second run(). A claim
 * answered with a token of another plan (NotFamily) drops the code at once
 * through `dropSubscription`, before the second round, so an Institutions
 * code is claimed once only.
 */
object SyncRun {
    private val lock = Any()

    /**
     * One round at a time in this process: the worker's periodic and
     * immediate runs, and the claims made from the Family screen, which
     * write the same claim state. A second caller waits rather than skips,
     * so it starts from the settings as they are after the first, and a
     * change made during a round still gets synced.
     */
    fun <T> exclusive(block: () -> T): T = synchronized(lock, block)

    fun run(
        round: FamilyRound,
        input: SyncInput,
        subscription: Subscription?,
        role: HouseholdRole?,
        now: Double,
        dropSubscription: () -> Unit,
    ): SyncOutcome {
        var sub = subscription
        fun once(i: SyncInput): SyncOutcome {
            val r = round.run(i, sub, role)
            if (r.claim is ClaimOutcome.NotFamily && sub != null) {
                dropSubscription()
                sub = null
            }
            return r.outcome ?: error("FamilyRound sends nothing only without a household")
        }

        var outcome = once(input)
        // Honest fair-use enrolment, as the extension's service worker: join
        // the device list when missing, below the cap; at the cap, surface
        // it (filtering stays active).
        if (outcome.status.state == SyncStatus.State.OK) {
            when (val enrolled = Household.enrolDevice(outcome.state, input.deviceId, now)) {
                is SitrResult.Err -> outcome = outcome.copy(
                    status = SyncStatus(SyncStatus.State.ERROR, error = enrolled.message)
                )
                is SitrResult.Ok -> enrolled.value?.let { state ->
                    outcome = once(input.copy(local = state, maxSeenRev = outcome.maxSeenRev))
                }
            }
        }
        return outcome
    }
}
