package com.sitrshield.core

import com.sitrshield.core.gate.HouseholdRole
import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.sync.ClaimOutcome
import com.sitrshield.core.sync.ClaimReason
import com.sitrshield.core.sync.ClaimState
import com.sitrshield.core.sync.Entitlement
import com.sitrshield.core.sync.FamilyRound
import com.sitrshield.core.sync.HouseholdEnd.Companion.DAY
import com.sitrshield.core.sync.Subscription
import com.sitrshield.core.sync.SyncCrypto
import com.sitrshield.core.sync.SyncHttpResponse
import com.sitrshield.core.sync.SyncInput
import com.sitrshield.core.sync.SyncRefusal
import com.sitrshield.core.sync.SyncStatus
import com.sitrshield.core.sync.SyncTransport
import org.json.JSONObject
import java.util.Base64
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * FamilyRound against a fake transport scripted per request: what is sent
 * to which host, and what is stored, for creation, renewal, a lapse, a
 * subscription bound elsewhere, a version 1 server and a child device.
 */
class FamilyRoundTest {
    private class Request(val method: String, val url: String, val headers: Map<String, String>, val body: ByteArray?)

    /** Each step checks the request it answers. */
    private class Step(val method: String, val url: String, val answer: (Request) -> SyncHttpResponse)

    private class FakeTransport(steps: List<Step>) : SyncTransport {
        private val queue = ArrayDeque(steps)
        val requests = mutableListOf<Request>()
        val unused: Int get() = queue.size

        override fun request(method: String, url: String, headers: Map<String, String>, body: ByteArray?): SyncHttpResponse {
            val r = Request(method, url, headers, body)
            requests.add(r)
            val step = queue.removeFirstOrNull() ?: fail("unexpected $method $url")
            assertEquals("${step.method} ${step.url}", "$method $url")
            return step.answer(r)
        }
    }

    private val secret = ByteArray(32) { (it + 7).toByte() }
    private val keys = SyncCrypto.deriveKeys(secret).getOrNull()!!
    private val hid = keys.householdId
    private val blobUrl = "https://sync.sitrshield.com/v1/blob/$hid"
    private val claimUrl = "https://claim.sitrshield.com/v1/entitlement/claim"
    private val sub = Subscription("3f2b8c4e-9d1a-4e7b-a6c5-0f1e2d3c4b5a", "A".repeat(43))

    private val dec4 = 1_796_342_400_000.0
    private val jan4 = dec4 + 31 * DAY
    private val nov1 = dec4 - 33 * DAY
    private val dec1 = dec4 - 3 * DAY

    private fun token(per: Double, exp: Double): String {
        val payload = """{"v":2,"plan":"family","term":"month","per":${per.toLong()},"exp":${exp.toLong()}}"""
        return "sitr-ent-v2." + Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toByteArray()) + ".c2ln"
    }

    /** A header value: decimal epoch ms. */
    private fun ms(t: Double) = t.toLong().toString()

    private val nov = token(nov1, dec4)
    private val dec = token(dec1, jan4)

    private val household = HouseholdState(rev = 3, updatedAt = 3000.0, updatedBy = "device-a", devices = listOf("device-a"))
    private fun sealed(s: HouseholdState) = Household.sealState(s, keys.encKey).getOrNull()!!
    private fun input(local: HouseholdState = household, v1: String? = null) =
        SyncInput(secret, local, maxSeenRev = household.rev, deviceId = "device-a", entitlement = v1)

    private var stored = ClaimState()
    private val transports = mutableListOf<FakeTransport>()
    private val requests: List<Request> get() = transports.flatMap { it.requests }

    private fun round(now: Double, steps: List<Step>, random: Double = 0.5): FamilyRound {
        val transport = FakeTransport(steps).also(transports::add)
        return FamilyRound(transport, { now }, { random }, { stored }, { stored = it })
    }

    private fun claimStep(status: Int, body: String, current: Boolean = false) = Step("POST", claimUrl) { r ->
        val sent = JSONObject(String(r.body!!))
        assertEquals(setOf("source", "credential", "claim_secret", "replace", "current"), sent.keySet())
        assertEquals("polar", sent.get("source"))
        assertEquals(sub.code, sent.get("credential"))
        assertEquals(sub.claimSecret, sent.get("claim_secret"))
        assertEquals(false, sent.get("replace"))
        assertEquals(current, sent.get("current"))
        assertTrue(r.headers.keys.none { it == "Authorization" || it.startsWith("X-Sitr") }, "no sync credential")
        SyncHttpResponse(status, null, body.toByteArray())
    }

    private fun tokenStep(raw: String, current: Boolean = false) = claimStep(200, """{"token":"$raw"}""", current)

    private fun get(state: HouseholdState?, etag: Long = 3, expires: String? = null) = Step("GET", blobUrl) {
        if (state == null) SyncHttpResponse(404, null, ByteArray(0), expires)
        else SyncHttpResponse(200, "\"$etag\"", sealed(state), expires)
    }

    private fun put(status: Int, token: String?, expires: String? = null, body: String = "", ifMatch: String? = "\"3\"") =
        Step("PUT", blobUrl) { r ->
            assertEquals(token, r.headers["X-Sitr-Entitlement"])
            assertEquals(ifMatch, r.headers["If-Match"])
            SyncHttpResponse(status, "\"4\"", body.toByteArray(), expires)
        }

    @AfterTest
    fun everyRequestWentToOneOfTheTwoHosts() {
        assertTrue(transports.all { it.unused == 0 }, "script not used up")
        for (r in requests) {
            assertTrue(r.url == claimUrl || r.url.startsWith("https://sync.sitrshield.com/v1/blob/"), r.url)
        }
    }

    @Test
    fun noHouseholdSendsNothing() {
        val result = round(dec1, emptyList()).run(null, sub, HouseholdRole.GUARDIAN)
        assertNull(result.outcome)
        assertTrue(requests.isEmpty())
    }

    @Test
    fun creationClaimsThenCreatesWithTheToken() {
        val result = round(nov1 + DAY, listOf(tokenStep(nov), get(null), put(201, nov, ms(dec4), ifMatch = null)))
            .run(input(), sub, HouseholdRole.GUARDIAN)
        assertTrue(result.outcome!!.created)
        assertEquals("*", requests[2].headers["If-None-Match"])
        assertEquals(hid, stored.appliedHousehold)
        assertEquals(dec4, stored.entExp)
        assertEquals(emptyList(), stored.tokens)
        assertEquals(false, stored.testHousehold)
    }

    @Test
    fun aCreationRefusedForItsTokenClaimsOnceMoreAndRetriesOnce() {
        val result = round(
            nov1 + DAY,
            listOf(
                tokenStep(nov), get(null), put(402, nov, body = "token-used\n", ifMatch = null),
                tokenStep(dec), get(null), put(201, dec, ms(jan4), ifMatch = null),
            ),
        ).run(input(), sub, HouseholdRole.GUARDIAN)
        assertEquals(SyncStatus.State.OK, result.outcome!!.status.state)
        assertEquals(jan4, stored.entExp)
        assertEquals(hid, stored.appliedHousehold)

        // Refused again after the retry: no third attempt.
        stored = ClaimState()
        val again = round(
            nov1 + DAY,
            listOf(
                tokenStep(nov), get(null), put(402, nov, body = "token-used\n", ifMatch = null),
                tokenStep(nov), get(null), put(402, nov, body = "token-used\n", ifMatch = null),
            ),
        ).run(input(), sub, HouseholdRole.GUARDIAN)
        assertEquals(SyncRefusal.TOKEN_USED, again.outcome!!.refusal)
    }

    @Test
    fun renewalInTheWindowForcesOneWrite() {
        stored = ClaimState(appliedHousehold = hid, entExp = dec4)
        // Before the window: nothing to claim, nothing changed, nothing written.
        round(dec4 - 12 * DAY, listOf(get(household, expires = ms(dec4)))).run(input(), sub, HouseholdRole.GUARDIAN)
        assertEquals(listOf("GET"), requests.map { it.method })
        assertEquals(dec4 - 7.5 * DAY, stored.windowAt, "the drawn time is kept")

        // random 0.5: the first attempt at E − 7.5 days; it is now E − 7 days.
        val result = round(
            dec4 - 7 * DAY,
            listOf(tokenStep(dec), get(household, expires = ms(dec4)), put(200, dec, ms(jan4))),
        ).run(input(), sub, HouseholdRole.GUARDIAN)
        assertIs<ClaimOutcome.Token>(result.claim)
        assertEquals(jan4, stored.entExp)
        assertEquals(emptyList(), stored.tokens)
        assertEquals(dec, stored.forcedToken)
        assertEquals(dec4, stored.windowFor)
    }

    @Test
    fun aLapseClaimsWithCurrentAndReopens() {
        // The device's clock still says E is ahead; the server answers 402 lapsed.
        stored = ClaimState(appliedHousehold = hid, entExp = dec4, windowFor = dec4, windowAt = dec4 - 6 * DAY)
        val changed = household.copy(rev = 4, updatedAt = 4000.0)
        val result = round(
            dec4 - 8 * DAY,
            listOf(
                get(household, expires = ms(dec4)), put(402, null, ms(dec4 - 9 * DAY), "lapsed\n"),
                tokenStep(dec, current = true), get(household, expires = ms(dec4 - 9 * DAY)), put(200, dec, ms(jan4)),
            ),
        ).run(input(changed), sub, HouseholdRole.GUARDIAN)
        assertEquals(SyncStatus.State.OK, result.outcome!!.status.state)
        assertEquals(false, stored.lapsed)
        assertEquals(false, stored.lapseClaimed)
        assertEquals(jan4, stored.entExp)

        // E passed by the clock: one claim with current: true before the round.
        stored = ClaimState(appliedHousehold = hid, entExp = dec4)
        round(dec4 + DAY, listOf(tokenStep(dec, current = true), get(household, expires = ms(dec4)), put(200, dec, ms(jan4))))
            .run(input(), sub, HouseholdRole.GUARDIAN)
        assertEquals(jan4, stored.entExp)
        assertEquals(false, Entitlement.forcesWrite(stored))
    }

    @Test
    fun boundElsewhereMakesNoClaimWhileEIsAhead() {
        stored = ClaimState(appliedHousehold = hid, entExp = dec4, lastRefusal = ClaimReason.BOUND_TO_OTHER_DEVICE)
        for (now in listOf(dec4 - 7 * DAY, dec4 - DAY)) {
            round(now, listOf(get(household, expires = ms(dec4)))).run(input(), sub, HouseholdRole.GUARDIAN)
        }
        // Not by rule (b) in another household either.
        stored = stored.copy(appliedHousehold = "elsewhere")
        round(dec4 - DAY, listOf(get(household, expires = ms(dec4)))).run(input(), sub, HouseholdRole.GUARDIAN)
        assertTrue(requests.none { it.url == claimUrl })
    }

    @Test
    fun aVersionOneServerIsNeverLapsedAndClaimsOnlyWithACode() {
        // No code: no claim, the version 1 token goes on the write.
        val changed = household.copy(rev = 4, updatedAt = 4000.0)
        round(dec4 + 40 * DAY, listOf(get(household), put(200, "sitr-ent-v1.a.b")))
            .run(input(changed, v1 = "sitr-ent-v1.a.b"), null, HouseholdRole.GUARDIAN)
        assertNull(stored.entExp)
        assertEquals(false, stored.lapsed)
        assertEquals("none", Entitlement.notice(stored, dec4 + 40 * DAY, false).wire)

        // With a code: one claim by rule (b), one forced write, then none while the token is held.
        round(nov1 + DAY, listOf(tokenStep(nov), get(household), put(200, nov))).run(input(), sub, HouseholdRole.GUARDIAN)
        assertEquals(listOf(nov), stored.tokens.map { it.raw })
        assertNull(stored.entExp)
        round(nov1 + 2 * DAY, listOf(get(household))).run(input(), sub, HouseholdRole.GUARDIAN)
        assertEquals(listOf(nov), stored.tokens.map { it.raw })
    }

    @Test
    fun aChildDeviceMakesNoClaim() {
        round(dec4 + DAY, listOf(get(household, expires = ms(dec4)))).run(input(), sub, HouseholdRole.CHILD)
        assertTrue(requests.none { it.url == claimUrl })
        assertEquals(dec4, stored.entExp)
    }
}
