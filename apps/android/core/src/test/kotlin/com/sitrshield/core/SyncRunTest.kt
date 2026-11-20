package com.sitrshield.core

import com.sitrshield.core.gate.HouseholdRole
import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.sync.ClaimState
import com.sitrshield.core.sync.FamilyRound
import com.sitrshield.core.sync.Subscription
import com.sitrshield.core.sync.SyncCrypto
import com.sitrshield.core.sync.SyncHttpResponse
import com.sitrshield.core.sync.SyncInput
import com.sitrshield.core.sync.SyncRun
import com.sitrshield.core.sync.SyncStatus
import com.sitrshield.core.sync.SyncTransport
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals

/** SyncRun: what a background run sends, with and without a code, and an
 * Institutions code dropped before the enrolment round. */
class SyncRunTest {
    private val secret = ByteArray(32) { (it + 3).toByte() }
    private val keys = SyncCrypto.deriveKeys(secret).getOrNull()!!
    private val claimUrl = "https://claim.sitrshield.com/v1/entitlement/claim"
    private val now = 1_796_342_400_000.0
    private val sub = Subscription("3f2b8c4e-9d1a-4e7b-a6c5-0f1e2d3c4b5a", "A".repeat(43))

    private fun token(plan: String): String {
        val p = """{"v":2,"plan":"$plan","term":"month","per":${now.toLong() - 1},"exp":${now.toLong() + 86_400_000L}}"""
        return "sitr-ent-v2." + Base64.getUrlEncoder().withoutPadding().encodeToString(p.toByteArray()) + ".c2ln"
    }

    /** Answers GET with `remote`, PUT with 200, POST (claim) with `claimBody`. */
    private inner class Fake(val remote: HouseholdState, val claimBody: String = "") : SyncTransport {
        val sent = mutableListOf<String>()
        override fun request(method: String, url: String, headers: Map<String, String>, body: ByteArray?): SyncHttpResponse {
            sent.add("$method ${if (url == claimUrl) "claim" else "sync"}")
            return when (method) {
                "GET" -> SyncHttpResponse(200, "\"3\"", Household.sealState(remote, keys.encKey).getOrNull()!!)
                "PUT" -> SyncHttpResponse(200, "\"4\"", ByteArray(0))
                else -> SyncHttpResponse(200, null, claimBody.toByteArray())
            }
        }
    }

    private fun household(vararg devices: String) =
        HouseholdState(rev = 3, updatedAt = 3000.0, updatedBy = "device-b", devices = devices.toList())

    private fun run(fake: Fake, subscription: Subscription?, onDrop: () -> Unit = {}): SyncStatus.State {
        var stored = ClaimState()
        val round = FamilyRound(fake, { now }, { 0.5 }, { stored }, { stored = it })
        val input = SyncInput(secret, fake.remote, maxSeenRev = 3, deviceId = "device-a")
        return SyncRun.run(round, input, subscription, HouseholdRole.GUARDIAN, now, onDrop).status.state
    }

    @Test
    fun noCodeSendsNothingToTheClaimHost() {
        val fake = Fake(household("device-a", "device-b"))
        assertEquals(SyncStatus.State.OK, run(fake, null))
        assertEquals(listOf("GET sync"), fake.sent)
    }

    @Test
    fun anInstitutionsCodeIsDroppedBeforeTheEnrolmentRoundAndClaimedOnce() {
        val fake = Fake(household("device-b"), """{"token":"${token("inst-starter")}"}""")
        var drops = 0
        assertEquals(SyncStatus.State.OK, run(fake, sub) { drops++ })
        assertEquals(1, drops)
        assertEquals(listOf("POST claim", "GET sync", "GET sync", "PUT sync"), fake.sent)
    }

    @Test
    fun aFamilyCodeIsKeptAndTheEnrolmentRoundClaimsNoMore() {
        val fake = Fake(household("device-b"), """{"token":"${token("family")}"}""")
        var drops = 0
        assertEquals(SyncStatus.State.OK, run(fake, sub) { drops++ })
        assertEquals(0, drops)
        assertEquals(1, fake.sent.count { it == "POST claim" })
    }
}
