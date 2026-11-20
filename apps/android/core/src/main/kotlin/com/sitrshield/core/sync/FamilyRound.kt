package com.sitrshield.core.sync

import com.sitrshield.core.gate.HouseholdRole

/** The subscription code this device holds and its claim secret, together. */
data class Subscription(val code: String, val claimSecret: String)

data class FamilyRoundResult(
    /** The sync round's outcome; null when there was no household and
     * nothing was sent. */
    val outcome: SyncOutcome?,
    /** The last claim answer of this round; null when no claim was made.
     * NotFamily: the caller deletes the code and the claim secret. */
    val claim: ClaimOutcome?,
    /** The claim state as saved at the end of the round. */
    val claims: ClaimState,
)

/**
 * One Sitr Family sync round (docs/sync-protocol.md §What each client must
 * do): decide (next) → claim if due → record → pick the token and whether
 * to force a write → SyncClient round → observe. A creation refused with
 * token-used / -expired / -invalid / -required claims once more and retries
 * the creation once; a `402 lapsed` claims at once (rule (d)) and syncs once
 * more. All I/O is passed in, so it runs against fakes in tests.
 *
 * Claims only with a subscription code, never on a child-role device, and
 * never while the stored state says bound elsewhere with E in the future
 * (next() returns none then). With no household nothing is sent at all.
 */
class FamilyRound(
    transport: SyncTransport,
    private val now: () -> Double,
    private val random: () -> Double,
    private val loadClaims: () -> ClaimState,
    private val saveClaims: (ClaimState) -> Unit,
    syncBaseUrl: String = SyncClient.DEFAULT_BASE_URL,
    claimBaseUrl: String = ClaimClient.DEFAULT_BASE_URL,
) {
    private val sync = SyncClient(transport, now, syncBaseUrl)
    private val claimClient = ClaimClient(transport, claimBaseUrl)

    /**
     * `household`: the round's input (its `entitlement` is a version 1
     * token, sent only when no version 2 token is held). `subscription`:
     * null when this device holds no code.
     */
    fun run(household: SyncInput?, subscription: Subscription?, role: HouseholdRole?): FamilyRoundResult {
        var claims = loadClaims()
        if (household == null) return FamilyRoundResult(null, null, claims)
        val householdId = SyncCrypto.deriveKeys(household.rootSecret).getOrNull()?.householdId
            ?: return FamilyRoundResult(sync.syncOnce(household), null, claims)
        val claimer = subscription?.takeIf { role != HouseholdRole.CHILD }
        var lastClaim: ClaimOutcome? = null

        fun save(s: ClaimState) {
            claims = s
            saveClaims(s)
        }

        fun claim(c: Subscription, current: Boolean) {
            val outcome = claimClient.claim(c.code, c.claimSecret, replace = false, current = current)
            lastClaim = outcome
            save(Entitlement.record(claims, outcome, current, now()))
        }

        fun claimIfDue(): Boolean {
            val c = claimer ?: return false
            val step = Entitlement.next(claims, now(), householdId, random)
            save(step.state) // keeps the drawn window time
            val decision = step.decision as? Decision.Claim ?: return false
            claim(c, decision.current)
            return true
        }

        fun round(): Pair<SyncOutcome, EntitlementToken?> {
            val token = Entitlement.tokenToSend(claims)
            val force = Entitlement.forcesWrite(claims)
            val outcome = sync.syncOnce(
                household.copy(entitlement = token?.raw ?: household.entitlement, forceWrite = force)
            )
            var s = claims
            if (outcome.created && token != null) s = Entitlement.created(s, token, householdId, outcome.entExp)
            val answer = SyncAnswer(
                entExp = outcome.entExp,
                lapsed = outcome.refusal == SyncRefusal.LAPSED,
                succeeded = outcome.status.state == SyncStatus.State.OK,
                forced = if (force) token?.raw else null,
            )
            save(Entitlement.observe(s, answer, householdId, now()))
            return outcome to token
        }

        claimIfDue()
        val (firstOutcome, sent) = round()
        var outcome = firstOutcome
        val refusal = outcome.refusal
        val c = claimer
        if (c != null && refusal != null && Entitlement.retriesCreate(refusal)) {
            // Creation refused for its token: claim once more, retry once.
            // Not after an Institutions answer, not while bound elsewhere.
            val boundNow = Entitlement.boundElsewhere(claims) && !HouseholdEnd.isLapsed(claims.end, now())
            if (lastClaim !is ClaimOutcome.NotFamily && !claims.stopped && !boundNow) {
                if (sent != null) save(claims.copy(tokens = claims.tokens - sent))
                claim(c, current = false)
                if (lastClaim is ClaimOutcome.Token) outcome = round().first
            }
        } else if (refusal == SyncRefusal.LAPSED && claimIfDue() && lastClaim is ClaimOutcome.Token) {
            outcome = round().first
        }
        return FamilyRoundResult(outcome, lastClaim, claims)
    }
}
