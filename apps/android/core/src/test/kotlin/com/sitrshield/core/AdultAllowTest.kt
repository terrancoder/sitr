package com.sitrshield.core

import com.sitrshield.core.categories.Categories
import com.sitrshield.core.dns.SafeSearchMap
import com.sitrshield.core.domainset.DomainSet
import com.sitrshield.core.rules.DecisionSnapshot
import com.sitrshield.core.rules.DecisionSnapshot.Verdict
import com.sitrshield.core.rules.NameAction
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The owner's rule: no allow entry of any layer opens a name on the adult
 * list (R1), and on Android not on the gambling or dating list either; no
 * allow entry switches SafeSearch off (R2); every other list and the layer
 * order stay as before (R3); the add screens refuse such an allow entry
 * (R4, the `covers` check).
 */
class AdultAllowTest {
    private fun set(vararg d: String) = DomainSet.of(d.toList()).getOrNull() ?: error("test set must be valid")
    private val adult = set("adult.example", "deep.host.example")
    private val gambling = set("bet.example")

    private fun snap(
        managedAllow: Set<String> = emptySet(), managedBlock: Set<String> = emptySet(),
        householdAllow: Set<String> = emptySet(), householdBlock: Set<String> = emptySet(),
        userAllow: Set<String> = emptySet(), userBlock: Set<String> = emptySet(),
    ) = DecisionSnapshot(
        managedAllow, managedBlock, householdAllow, householdBlock, userAllow, userBlock,
        staticBlock = listOf(gambling), alwaysBlock = listOf(adult),
    )

    @Test
    fun noLayersAllowOpensAnAdultName() {
        val name = setOf("adult.example")
        assertEquals(Verdict.BLOCK, snap(userAllow = name).decide("adult.example"))
        assertEquals(Verdict.BLOCK, snap(householdAllow = name).decide("adult.example"))
        assertEquals(Verdict.BLOCK, snap(managedAllow = name).decide("adult.example"))
        assertEquals(
            Verdict.BLOCK,
            snap(managedAllow = name, householdAllow = name, userAllow = name).decide("ADULT.example."),
        )
    }

    @Test
    fun anAllowOnASubdomainOfAnAdultParentDoesNothing() {
        val s = snap(userAllow = setOf("www.adult.example"), managedAllow = setOf("cdn.adult.example"))
        assertEquals(Verdict.BLOCK, s.decide("www.adult.example"))
        assertEquals(Verdict.BLOCK, s.decide("cdn.adult.example"))
    }

    @Test
    fun anAllowOnAParentOpensItButNotItsAdultListedSubdomain() {
        val s = snap(householdAllow = setOf("host.example"), managedAllow = setOf("host.example"))
        assertEquals(Verdict.FORWARD, s.decide("host.example"))
        assertEquals(Verdict.FORWARD, s.decide("other.host.example"))
        assertEquals(Verdict.BLOCK, s.decide("deep.host.example"))
        assertEquals(Verdict.BLOCK, s.decide("x.deep.host.example"))
    }

    @Test
    fun anAllowNeverSwitchesSafeSearchOff() {
        val map = SafeSearchMap.parse(
            File(FixtureTest.fixturesDir.parentFile, "blocklists/android/safesearch-hosts.json").readText()
        ).getOrNull()!!
        val all = setOf("google.com")
        val s = snap(managedAllow = all, householdAllow = all, userAllow = all)
        assertTrue(NameAction.of("www.google.com", s, map) is NameAction.Rewrite)
        assertTrue(NameAction.of("www.youtube.com", snap(userAllow = setOf("youtube.com")), map) is NameAction.Rewrite)
    }

    @Test
    fun otherListsAndTheLayerOrderStayAsBefore() {
        assertEquals(Verdict.BLOCK, snap().decide("bet.example"))
        assertEquals(Verdict.FORWARD, snap(userAllow = setOf("bet.example")).decide("bet.example"))
        assertEquals(Verdict.FORWARD, snap(managedAllow = setOf("bet.example")).decide("bet.example"))
        assertEquals(
            Verdict.BLOCK,
            snap(householdBlock = setOf("bet.example"), userAllow = setOf("bet.example")).decide("bet.example"),
        )
        assertEquals(
            Verdict.BLOCK,
            snap(managedBlock = setOf("site.example"), householdAllow = setOf("site.example")).decide("site.example"),
        )
        // A user block still blocks a name the adult list does not have.
        assertEquals(Verdict.BLOCK, snap(userBlock = setOf("site.example")).decide("site.example"))
    }

    @Test
    fun coversIsTheRefusalCheck() {
        assertTrue(DecisionSnapshot.covers(adult, "adult.example"))
        assertTrue(DecisionSnapshot.covers(adult, "www.adult.example"))
        assertTrue(DecisionSnapshot.covers(adult, "Deep.Host.Example."))
        assertFalse(DecisionSnapshot.covers(adult, "host.example")) // parent of a listed subdomain
        assertFalse(DecisionSnapshot.covers(adult, "notadult.example"))
        assertFalse(DecisionSnapshot.covers(adult, ""))
        assertEquals(
            "This site is on the adult, gambling or dating list and cannot be allowed. If it is listed by mistake, report it.",
            DecisionSnapshot.ADULT_ALLOW_REFUSAL,
        )
    }

    @Test
    fun theRealListsHoldTheRuleToo() {
        val dir = File(FixtureTest.fixturesDir.parentFile, "blocklists/android")
        val sums = JSONObject(File(dir, "checksums.json").readText())
        fun load(n: String) = DomainSet.load(File(dir, n).readBytes(), sums.getString(n)).getOrNull()!!
        val realAdult = load("adult.domains")
        // Built the way SitrApp.rebuildEngine builds it on Android.
        val always = Categories.ANDROID_ALWAYS_BLOCKED.map { load("$it.domains") }
        val s = DecisionSnapshot(
            userAllow = setOf("pornhub.com", "yoo7.com", "1xbet.com"),
            alwaysBlock = always,
        )
        assertEquals(Verdict.BLOCK, s.decide("pornhub.com"))
        assertEquals(Verdict.BLOCK, s.decide("x9.pornhub.com"))
        assertEquals(Verdict.BLOCK, s.decide("2mateckn.yoo7.com")) // listed subdomain under an allowed parent
        assertEquals(Verdict.FORWARD, s.decide("yoo7.com"))
        assertEquals(Verdict.BLOCK, s.decide("1xbet.com"))
        assertTrue(DecisionSnapshot.covers(realAdult, "www.pornhub.com"))
        assertFalse(DecisionSnapshot.covers(realAdult, "yoo7.com"))
    }

    @Test
    fun onAndroidNoAllowOpensGamblingOrDating() {
        val dir = File(FixtureTest.fixturesDir.parentFile, "blocklists/android")
        val sums = JSONObject(File(dir, "checksums.json").readText())
        fun load(n: String) = DomainSet.load(File(dir, n).readBytes(), sums.getString(n)).getOrNull()!!
        val always = Categories.ANDROID_ALWAYS_BLOCKED.map { load("$it.domains") }
        val names = setOf("1xbet.com", "tinder.com")
        for (s in listOf(
            DecisionSnapshot(userAllow = names, alwaysBlock = always),
            DecisionSnapshot(householdAllow = names, alwaysBlock = always),
            DecisionSnapshot(managedAllow = names, alwaysBlock = always),
        )) {
            assertEquals(Verdict.BLOCK, s.decide("1xbet.com"))
            assertEquals(Verdict.BLOCK, s.decide("www.1xbet.com"))
            assertEquals(Verdict.BLOCK, s.decide("tinder.com"))
        }
        // The add screens refuse both (SitrApp.alwaysBlocked).
        for (name in names) assertTrue(always.any { DecisionSnapshot.covers(it, name) })
    }
}
