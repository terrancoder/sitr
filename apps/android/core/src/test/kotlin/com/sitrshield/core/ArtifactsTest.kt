package com.sitrshield.core

import com.sitrshield.core.dns.SafeSearchMap
import com.sitrshield.core.domainset.DomainSet
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The committed compiler artifacts (apps/shared/blocklists/android) must
 * load through the same code paths the engine uses — checksum verification
 * included.
 */
class ArtifactsTest {
    private val dir: File = File(FixtureTest.fixturesDir.parentFile, "blocklists/android")

    private fun checksums(): JSONObject = JSONObject(File(dir, "checksums.json").readText())

    @Test
    fun domainSetsLoadWithVerifiedChecksums() {
        val sums = checksums()
        for (category in listOf("adult", "dating", "gambling")) {
            val name = "$category.domains"
            val artifact = File(dir, name).readBytes()
            val set = DomainSet.load(artifact, sums.getString(name)).getOrNull()
                ?: error("$name must load")
            assertTrue(set.size > 0, name)
        }
    }

    @Test
    fun checksumMismatchRefusesToLoad() {
        val artifact = File(dir, "adult.domains").readBytes()
        val result = DomainSet.load(artifact, "00".repeat(32))
        assertTrue(result is SitrResult.Err)
        assertTrue(result.errorOrNull()!!.contains("checksum"))
    }

    @Test
    fun invalidLineIsAHardError() {
        val result = DomainSet.load("ok.example\nNOT A DOMAIN\n".toByteArray(), null)
        assertTrue(result is SitrResult.Err)
        assertTrue(result.errorOrNull()!!.contains("line 2"))
    }

    @Test
    fun safesearchMapLoadsAndMatches() {
        val map = SafeSearchMap.parse(File(dir, "safesearch-hosts.json").readText())
            .getOrNull() ?: error("safesearch-hosts.json must parse")
        assertEquals(4, map.rules.size)

        // Exact hosts.
        assertEquals("strict.bing.com", assertNotNull(map.ruleFor("bing.com")).target)
        assertEquals("strict.bing.com", assertNotNull(map.ruleFor("www.bing.com")).target)
        assertEquals(
            "safe.duckduckgo.com",
            assertNotNull(map.ruleFor("duckduckgo.com")).target,
        )
        assertEquals(
            "restrict.youtube.com",
            assertNotNull(map.ruleFor("m.youtube.com")).target,
        )

        // Google ccTLD wildcard: 1–2 trailing labels.
        assertEquals(
            "forcesafesearch.google.com",
            assertNotNull(map.ruleFor("www.google.com")).target,
        )
        assertEquals(
            "forcesafesearch.google.com",
            assertNotNull(map.ruleFor("google.de")).target,
        )
        assertEquals(
            "forcesafesearch.google.com",
            assertNotNull(map.ruleFor("www.google.co.uk")).target,
        )

        // Non-matches: unrelated subdomains and lookalikes.
        assertNull(map.ruleFor("maps.google.com"))
        assertNull(map.ruleFor("evilgoogle.com"))
        assertNull(map.ruleFor("google.a.b.c"))
        assertNull(map.ruleFor("youtube.com.evil.example"))
    }

    @Test
    fun wildcardMatcherEdgeCases() {
        assertTrue(SafeSearchMap.matches("google.*", "google.de"))
        assertTrue(SafeSearchMap.matches("google.*", "google.co.uk"))
        assertTrue(!SafeSearchMap.matches("google.*", "google.a.b.c"))
        assertTrue(!SafeSearchMap.matches("google.*", "google."))
        assertTrue(!SafeSearchMap.matches("google.*", "google"))
        assertTrue(!SafeSearchMap.matches("google.*", "notgoogle.de"))
        assertTrue(SafeSearchMap.matches("bing.com", "bing.com"))
        assertTrue(!SafeSearchMap.matches("bing.com", "www.bing.com"))
    }
}
