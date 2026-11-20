package com.sitrshield.core.sync

import com.sitrshield.core.gate.Gate
import com.sitrshield.core.gate.GateContext
import com.sitrshield.core.gate.MutationVerdict

/** What the Family screen shows about the plan, and which controls. */
data class PlanView(
    val lines: List<String>,
    val enterCode: Boolean = false,
    val removeCode: Boolean = false,
    val tryAgain: Boolean = false,
    val renewHere: Boolean = false,
)

/**
 * The Family screen's plan block for a Polar client (Android), pure
 * (docs/sync-protocol.md §Claim errors, §Sync 402, §No
 * X-Sitr-Entitlement-Expires header, §Extension and Android). Dates are
 * formatted by the caller (`date`, epoch ms).
 */
object FamilyPlan {
    const val LOCKED = "turn off the child lock first"
    const val MANAGED = "settings are locked by your organization"
    const val CHILD_NO_CODE = "a child device does not hold a subscription code"
    const val UNAVAILABLE = "The subscription service could not be reached. Try again later."
    const val RENEWS_HERE = "This phone renews the Family plan."

    /** Entering, removing or moving a code: refused under the child lock,
     * then as the gate says (Gate.SUBSCRIPTION_GATED_AS: a managed lock, a
     * child device). The PIN is the caller's. Null: allowed. */
    fun codeRefusal(childLock: Boolean, gate: GateContext): String? {
        if (childLock) return LOCKED
        val verdict = Gate.gateMutation(Gate.SUBSCRIPTION_GATED_AS, gate) as? MutationVerdict.Refused ?: return null
        return when (verdict.reason) {
            MutationVerdict.Reason.MANAGED_LOCKED -> MANAGED
            MutationVerdict.Reason.CHILD_DEVICE -> CHILD_NO_CODE
        }
    }

    /** The sentence for a claim answer; null for a family token. */
    fun claimText(outcome: ClaimOutcome, date: (Double) -> String): String? = when (outcome) {
        is ClaimOutcome.Token -> null
        is ClaimOutcome.NotFamily -> Entitlement.TEXTS.getValue("plan-not-accepted")
        is ClaimOutcome.Refused -> refusalText(outcome.reason, outcome.retryAfter, date)
        ClaimOutcome.Unavailable -> UNAVAILABLE
    }

    private fun refusalText(r: ClaimReason, retryAfter: Double?, date: (Double) -> String): String {
        val text = Entitlement.TEXTS.getValue(r.wire)
        return if (retryAfter != null) text.replace("{date}", date(retryAfter)) else text
    }

    /**
     * `holdsCode`: this phone holds a subscription code. `guardian`: a
     * guardian device (controls; a child device gets the end date and the
     * neutral notices only). `institutions`: the last code was an
     * Institutions plan's and was dropped.
     */
    fun view(
        s: ClaimState,
        now: Double,
        holdsCode: Boolean,
        guardian: Boolean,
        institutions: Boolean,
        date: (Double) -> String,
    ): PlanView {
        val lines = mutableListOf<String>()
        if (institutions && !holdsCode) lines += Entitlement.TEXTS.getValue("plan-not-accepted")
        val e = s.entExp
        if (e != null && !HouseholdEnd.isLapsed(s.end, now)) lines += "Covered until ${date(e)}."
        val notice = Entitlement.notice(s, now, holdsCode)
        when (notice) {
            Notice.NONE -> {}
            Notice.ENTER_CODE -> lines += Entitlement.TEXTS.getValue("enter-code").replace("{date}", date(e!!))
            Notice.REPLACEMENT_USED ->
                lines += Entitlement.TEXTS.getValue("replacement-used").replace("{date}", date(s.retryAfter!!))
            else -> lines += Entitlement.TEXTS.getValue(notice.wire)
        }
        val r = s.lastRefusal
        if (holdsCode) {
            // This phone's own claim answer, unless the notice already says it.
            val said = when (r) {
                ClaimReason.INACTIVE, ClaimReason.REVOKED -> notice == Notice.ENDED
                ClaimReason.PAYMENT_PENDING -> notice == Notice.PAYMENT_PROBLEM
                ClaimReason.REPLACEMENT_USED -> notice == Notice.REPLACEMENT_USED
                else -> false
            }
            when {
                r == null -> lines += RENEWS_HERE
                !said -> lines += refusalText(r, s.retryAfter, date)
            }
        }
        if (!guardian) return PlanView(lines)
        return PlanView(
            lines,
            enterCode = !holdsCode,
            removeCode = holdsCode,
            tryAgain = holdsCode && (s.stopped || s.backoff != null ||
                r == ClaimReason.PAYMENT_PENDING || r == ClaimReason.INACTIVE || r == ClaimReason.REVOKED),
            renewHere = holdsCode && Entitlement.offersReplace(s, now),
        )
    }
}
