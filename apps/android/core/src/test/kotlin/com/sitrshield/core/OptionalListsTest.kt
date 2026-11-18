package com.sitrshield.core

import com.sitrshield.core.categories.OptionalLists
import com.sitrshield.core.domainset.DomainSet
import com.sitrshield.core.rules.DecisionSnapshot
import com.sitrshield.core.rules.DecisionSnapshot.Verdict
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The opt-in lists: loaded from the real artifacts, folded into the static layer. */
class OptionalListsTest {
    private val dir: File = File(FixtureTest.fixturesDir.parentFile, "blocklists/android")
    private val sums = JSONObject(File(dir, "checksums.json").readText())
    private fun real(name: String) = File(dir, name).readBytes()

    /** A domain the artifact really lists, read from it rather than hard-coded. */
    private fun firstEntry(id: String) = File(dir, "$id.domains").useLines { it.first() }

    @Test
    fun everyTableRowShipsAVerifiedNonEmptyList() {
        val loaded = OptionalLists.load(sums, ::real)
        assertEquals(OptionalLists.ALL.map { it.id }.toSet(), loaded.keys)
    }

    @Test
    fun enabledListBlocksDisabledDoesNotAllowOverrides() {
        val loaded = OptionalLists.load(sums, ::real)
        val adult = DomainSet.load(real("adult.domains"), sums.getString("adult.domains")).getOrNull()!!
        for (id in loaded.keys) {
            val host = firstEntry(id)
            fun snap(enabled: Set<String>, allow: Set<String> = emptySet()) = DecisionSnapshot(
                userAllow = allow,
                staticBlock = listOf(adult) + OptionalLists.enabledSets(enabled, loaded),
            )
            assertEquals(Verdict.BLOCK, snap(setOf(id)).decide(host), "$id on")
            assertEquals(Verdict.BLOCK, snap(setOf(id)).decide("www.$host"), "$id on, subdomain")
            assertEquals(Verdict.FORWARD, snap(emptySet()).decide(host), "$id off")
            assertEquals(Verdict.FORWARD, snap(setOf(id), allow = setOf(host)).decide(host), "$id allow")
            // The category list is untouched either way.
            val adultHost = firstEntry("adult")
            assertEquals(Verdict.BLOCK, snap(setOf(id)).decide(adultHost))
            assertEquals(Verdict.BLOCK, snap(emptySet()).decide(adultHost))
        }
        // Unknown ids (a newer app's setting) are ignored, not an error.
        assertTrue(OptionalLists.enabledSets(setOf("nope"), loaded).isEmpty())
    }

    @Test
    fun missingOrCorruptListDropsOnlyItself() {
        val ids = OptionalLists.ALL.map { it.id }
        val (missing, corrupt) = ids[0] to ids[1]
        val loaded = OptionalLists.load(sums) { name ->
            when (name) {
                "$missing.domains" -> throw FileNotFoundException(name)
                "$corrupt.domains" -> real(name).also { it[0] = 'Z'.code.toByte() }
                else -> real(name)
            }
        }
        assertTrue(loaded.isEmpty(), loaded.keys.toString())

        // Only one broken: the other still loads.
        val oneBroken = OptionalLists.load(sums) { name ->
            if (name == "$missing.domains") throw FileNotFoundException(name) else real(name)
        }
        assertEquals(setOf(corrupt), oneBroken.keys)

        // No checksum entry at all counts as unverified, not as a skip.
        val noSums = OptionalLists.load(JSONObject(), ::real)
        assertTrue(noSums.isEmpty())
    }
}
