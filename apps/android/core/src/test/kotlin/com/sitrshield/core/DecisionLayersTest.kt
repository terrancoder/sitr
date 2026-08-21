package com.sitrshield.core

import com.sitrshield.core.rules.DecisionSnapshot
import com.sitrshield.core.rules.DecisionSnapshot.Verdict
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The ladder-precedence matrix from tests/src/ruleLayers.test.ts, applied
 * to the DNS decision function: managed > household > device-user >
 * static; allow wins within a layer; a higher layer's block beats a lower
 * layer's allow.
 */
class DecisionLayersTest {
    @Test
    fun staticBlocklistBlocks() {
        val snapshot = DecisionSnapshot(staticBlock = setOf("blocked.example"))
        assertEquals(Verdict.BLOCK, snapshot.decide("blocked.example"))
        assertEquals(Verdict.BLOCK, snapshot.decide("sub.blocked.example"))
        assertEquals(Verdict.FORWARD, snapshot.decide("fine.example"))
        assertEquals(Verdict.FORWARD, snapshot.decide("notblocked.example"))
    }

    @Test
    fun userAllowBeatsStaticBlock() {
        val snapshot = DecisionSnapshot(
            staticBlock = setOf("blocked.example"),
            userAllow = setOf("blocked.example"),
        )
        assertEquals(Verdict.FORWARD, snapshot.decide("blocked.example"))
        assertEquals(Verdict.FORWARD, snapshot.decide("www.blocked.example"))
    }

    @Test
    fun allowWinsOverBlockWithinALayer() {
        val snapshot = DecisionSnapshot(
            userAllow = setOf("site.example"),
            userBlock = setOf("site.example"),
        )
        assertEquals(Verdict.FORWARD, snapshot.decide("site.example"))
    }

    @Test
    fun householdBlockBeatsUserAllow() {
        val snapshot = DecisionSnapshot(
            householdBlock = setOf("site.example"),
            userAllow = setOf("site.example"),
        )
        assertEquals(Verdict.BLOCK, snapshot.decide("site.example"))
    }

    @Test
    fun householdAllowBeatsUserBlock() {
        val snapshot = DecisionSnapshot(
            householdAllow = setOf("site.example"),
            userBlock = setOf("site.example"),
        )
        assertEquals(Verdict.FORWARD, snapshot.decide("site.example"))
    }

    @Test
    fun managedBlockBeatsHouseholdAllow() {
        val snapshot = DecisionSnapshot(
            managedBlock = setOf("site.example"),
            householdAllow = setOf("site.example"),
            userAllow = setOf("site.example"),
        )
        assertEquals(Verdict.BLOCK, snapshot.decide("site.example"))
    }

    @Test
    fun managedAllowBeatsEveryBlock() {
        val snapshot = DecisionSnapshot(
            managedAllow = setOf("site.example"),
            householdBlock = setOf("site.example"),
            userBlock = setOf("site.example"),
            staticBlock = setOf("site.example"),
        )
        assertEquals(Verdict.FORWARD, snapshot.decide("site.example"))
    }

    @Test
    fun subdomainMatchingMirrorsRequestDomains() {
        val snapshot = DecisionSnapshot(staticBlock = setOf("blocked.example"))
        assertEquals(Verdict.BLOCK, snapshot.decide("a.b.c.blocked.example"))
        // A parent of the entry does NOT match.
        assertEquals(Verdict.FORWARD, snapshot.decide("example"))
        // Case and trailing dot are normalized.
        assertEquals(Verdict.BLOCK, snapshot.decide("BLOCKED.example."))
    }

    @Test
    fun allowScopedToSubdomainDoesNotUnblockParent() {
        val snapshot = DecisionSnapshot(
            staticBlock = setOf("blocked.example"),
            userAllow = setOf("ok.blocked.example"),
        )
        assertEquals(Verdict.FORWARD, snapshot.decide("ok.blocked.example"))
        assertEquals(Verdict.BLOCK, snapshot.decide("blocked.example"))
        assertEquals(Verdict.BLOCK, snapshot.decide("other.blocked.example"))
    }
}
