package com.sitrshield.core

import com.sitrshield.core.gate.GateContext
import com.sitrshield.core.gate.HouseholdRole
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.sync.ClaimOutcome
import com.sitrshield.core.sync.ClaimReason
import com.sitrshield.core.sync.ClaimState
import com.sitrshield.core.sync.Entitlement
import com.sitrshield.core.sync.FamilyPlan
import com.sitrshield.core.sync.FamilyRound
import com.sitrshield.core.sync.PlanView
import com.sitrshield.core.sync.HouseholdEnd.Companion.DAY
import com.sitrshield.core.sync.Subscription
import com.sitrshield.core.sync.SyncCrypto
import com.sitrshield.core.sync.SyncHttpResponse
import com.sitrshield.core.sync.SyncInput
import com.sitrshield.core.sync.SyncRun
import com.sitrshield.core.sync.SyncTransport
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The Family screen's plan block, the code refusals, creation with a
 * claimed token, and the one-round-at-a-time lock. */
class FamilyPlanTest {
    private val e = 1_796_342_400_000.0 // E
    private val date: (Double) -> String = { "D${((it - e) / DAY).toLong()}" }
    private val waiting = Entitlement.TEXTS.getValue("waiting")

    private fun view(s: ClaimState, now: Double, holdsCode: Boolean = true, guardian: Boolean = true, inst: Boolean = false) =
        FamilyPlan.view(s, now, holdsCode, guardian, inst, date)

    @Test
    fun codeRefusals() {
        val guardian = GateContext(false, HouseholdRole.GUARDIAN, hasPin = true)
        assertNull(FamilyPlan.codeRefusal(false, guardian))
        assertNull(FamilyPlan.codeRefusal(false, GateContext(false, null, false)), "no household: may create")
        assertEquals(FamilyPlan.LOCKED, FamilyPlan.codeRefusal(true, guardian))
        assertEquals(FamilyPlan.MANAGED, FamilyPlan.codeRefusal(false, guardian.copy(managedLockOptions = true)))
        assertEquals(FamilyPlan.CHILD_NO_CODE, FamilyPlan.codeRefusal(false, guardian.copy(role = HouseholdRole.CHILD)))
    }

    @Test
    fun coveredAndRenewingHere() {
        val v = view(ClaimState(entExp = e, appliedHousehold = "h"), e - 20 * DAY)
        assertEquals(listOf("Covered until D0.", FamilyPlan.RENEWS_HERE), v.lines)
        assertTrue(v.removeCode && !v.enterCode && !v.tryAgain && !v.renewHere)
    }

    @Test
    fun underTwoDaysAndLapsedShowTheNeutralSentence() {
        assertEquals(listOf("Covered until D0.", waiting), view(ClaimState(entExp = e), e - DAY, holdsCode = false).lines)
        assertEquals(listOf(waiting), view(ClaimState(entExp = e), e + DAY, holdsCode = false).lines)
        assertEquals(listOf(waiting), view(ClaimState(entExp = e - DAY, lapsed = true), e, holdsCode = false, guardian = false).lines)
    }

    @Test
    fun boundElsewhereOffersRenewHereOnlyWhenTheEndIsNear() {
        val bound = ClaimState(entExp = e, lastRefusal = ClaimReason.BOUND_TO_OTHER_DEVICE)
        val far = view(bound, e - 10 * DAY)
        assertEquals(listOf("Covered until D0.", "Another device renews this subscription."), far.lines)
        assertFalse(far.renewHere)
        assertTrue(view(bound, e - DAY).renewHere)
    }

    @Test
    fun replacementUsedAndPaymentProblemAndStops() {
        val moved = view(ClaimState(entExp = e, lastRefusal = ClaimReason.REPLACEMENT_USED, retryAfter = e + 5 * DAY), e - DAY)
        assertEquals(listOf("Covered until D0.", "The renewing device was moved recently. It can be moved again on D5."), moved.lines)
        val pay = view(ClaimState(entExp = e, lastRefusal = ClaimReason.PAYMENT_PENDING, notBefore = e), e + DAY)
        assertEquals(listOf(Entitlement.TEXTS.getValue("payment-problem")), pay.lines)
        assertTrue(pay.tryAgain)
        val unknown = view(ClaimState(lastRefusal = ClaimReason.UNKNOWN_CODE, stopped = true), e)
        assertEquals(listOf(Entitlement.TEXTS.getValue("unknown-code")), unknown.lines)
        assertTrue(unknown.tryAgain)
    }

    @Test
    fun legacyHouseholdAndTheInstitutionsFlag() {
        val legacy = view(ClaimState(entExp = e), e - 50 * DAY, holdsCode = false, inst = true)
        assertEquals(
            listOf(
                "This is a code for Sitr for Institutions.",
                "Covered until D0.",
                "Enter your subscription code on one guardian device before D0.",
            ),
            legacy.lines,
        )
        assertTrue(legacy.enterCode && !legacy.removeCode)
    }

    @Test
    fun aChildDeviceGetsNoControls() {
        val v = view(ClaimState(entExp = e), e - DAY, holdsCode = false, guardian = false)
        assertEquals(PlanView(listOf("Covered until D0.", waiting)), v)
    }

    @Test
    fun claimTexts() {
        assertEquals("This is a code for Sitr for Institutions.", FamilyPlan.claimText(ClaimOutcome.NotFamily("inst-starter"), date))
        assertEquals(FamilyPlan.UNAVAILABLE, FamilyPlan.claimText(ClaimOutcome.Unavailable, date))
        assertEquals(
            "Another device renews this subscription.",
            FamilyPlan.claimText(ClaimOutcome.Refused(ClaimReason.BOUND_TO_OTHER_DEVICE, null), date),
        )
    }

    /** Creating with a code: the token claimed by the screen is held; the
     * worker's round sends no claim and creates with it (created()). */
    @Test
    fun aHeldTokenCreatesTheHouseholdWithoutAnotherClaim() {
        val secret = ByteArray(32) { (it + 9).toByte() }
        val hid = SyncCrypto.deriveKeys(secret).getOrNull()!!.householdId
        val payload = """{"v":2,"plan":"family","term":"month","per":${(e - 33 * DAY).toLong()},"exp":${e.toLong()}}"""
        val raw = "sitr-ent-v2." + Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toByteArray()) + ".c2ln"
        val token = Entitlement.parseToken(raw)!!
        var stored = Entitlement.record(ClaimState(), ClaimOutcome.Token(token), current = false, now = e - 20 * DAY)
        val sent = mutableListOf<String>()
        val transport = object : SyncTransport {
            override fun request(method: String, url: String, headers: Map<String, String>, body: ByteArray?): SyncHttpResponse {
                sent += "$method ${url.substringAfter("//").substringBefore('/')} ${headers["X-Sitr-Entitlement"] == raw}"
                return if (method == "GET") SyncHttpResponse(404, null, ByteArray(0))
                else SyncHttpResponse(201, "\"1\"", ByteArray(0), e.toLong().toString())
            }
        }
        val local = HouseholdState(rev = 1, updatedAt = 1.0, updatedBy = "d", devices = listOf("d"))
        val result = FamilyRound(transport, { e - 20 * DAY }, { 0.5 }, { stored }, { stored = it })
            .run(SyncInput(secret, local, 0, "d"), Subscription("3f2b8c4e-9d1a-4e7b-a6c5-0f1e2d3c4b5a", "S"), HouseholdRole.GUARDIAN)
        assertTrue(result.outcome!!.created)
        assertEquals(listOf("GET sync.sitrshield.com false", "PUT sync.sitrshield.com true"), sent)
        assertEquals(hid, stored.appliedHousehold)
        assertEquals(e, stored.entExp)
        assertEquals(emptyList(), stored.tokens)
    }

    @Test
    fun oneRoundAtATimeAndASecondCallerWaits() {
        val inside = AtomicInteger()
        val most = AtomicInteger()
        val ran = AtomicInteger()
        val threads = (1..4).map {
            thread {
                SyncRun.exclusive {
                    most.accumulateAndGet(inside.incrementAndGet(), ::maxOf)
                    Thread.sleep(30)
                    inside.decrementAndGet()
                    ran.incrementAndGet()
                }
            }
        }
        threads.forEach { it.join() }
        assertEquals(1, most.get())
        assertEquals(4, ran.get(), "every caller ran: none skipped")
    }
}
