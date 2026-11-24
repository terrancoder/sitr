package com.sitrshield.core

import com.sitrshield.core.dns.SafeSearchMap
import com.sitrshield.core.dns.StrictSearchHosts
import com.sitrshield.core.domains.DomainInput
import com.sitrshield.core.domainset.DomainSet
import com.sitrshield.core.rules.DecisionSnapshot
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

    /**
     * Every `*.domains` artifact named in checksums.json — discovered, not
     * listed, so a newly emitted list is covered the day it lands.
     */
    @Test
    fun everyDomainsArtifactLoadsWithVerifiedChecksums() {
        val sums = checksums()
        val names = sums.keys().asSequence().filter { it.endsWith(".domains") }.toList()
        assertTrue("adult.domains" in names && names.size >= 3, names.toString())
        for (name in names) {
            val result = DomainSet.load(File(dir, name).readBytes(), sums.getString(name))
            assertTrue(result is SitrResult.Ok, "$name: ${result.errorOrNull()}")
        }
        for (category in listOf("adult", "dating", "gambling")) {
            assertTrue(load("$category.domains").size > 0, category)
        }
    }

    /** Every JSON artifact the engine reads is checksum-listed too. */
    @Test
    fun jsonArtifactsMatchTheirChecksums() {
        val sums = checksums()
        for (name in listOf("safesearch-hosts.json", "strict-search-hosts.json")) {
            val got = java.security.MessageDigest.getInstance("SHA-256")
                .digest(File(dir, name).readBytes()).joinToString("") { "%02x".format(it) }
            assertEquals(sums.getString(name), got, name)
        }
    }

    private fun load(name: String): DomainSet =
        DomainSet.load(File(dir, name).readBytes(), checksums().getString(name)).getOrNull()
            ?: error("$name must load")

    @Test
    fun checksumMismatchRefusesToLoad() {
        val artifact = File(dir, "adult.domains").readBytes()
        val result = DomainSet.load(artifact, "00".repeat(32))
        assertTrue(result is SitrResult.Err)
        assertTrue(result.errorOrNull()!!.contains("checksum"))
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
        // Parity with the extension's header rule, which covers every
        // youtube.com subdomain: YouTube Music must be restricted too.
        assertEquals(
            "restrict.youtube.com",
            assertNotNull(map.ruleFor("music.youtube.com")).target,
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

    @Test
    fun strictSearchHostsLoadAndAreNotInTheBlocklist() {
        val map = StrictSearchHosts.parse(
            File(dir, "strict-search-hosts.json").readText()
        ).getOrNull() ?: error("strict-search-hosts.json must parse")

        assertTrue(map.hosts.isNotEmpty())
        // Every entry is a real hostname the engine can match on.
        for (entry in map.entries) {
            assertTrue(DomainInput.isValidDomain(entry.host), entry.host)
            assertTrue(entry.engine.isNotBlank())
        }
        // The engines with no vendor safe mode are the reason this exists.
        assertTrue(map.enginesWithoutSafeMode.contains("Brave Search"))

        // These must NOT be in the shared blocklist: a general-purpose
        // search engine fails the inclusion policy's primary-purpose test.
        for (category in listOf("adult", "dating", "gambling")) {
            val set = load("$category.domains")
            for (host in map.hosts) {
                assertTrue(
                    !set.contains(host),
                    "$host must not ship in the $category blocklist"
                )
            }
        }
    }

    @Test
    fun siteMediaHostsLoadVerifiedAndSpareTheSitesScripts() {
        // site -> (a media host it must block, the host serving its own JS/CSS)
        val sites = mapOf(
            "x" to ("pbs.twimg.com" to "abs.twimg.com"),
            "reddit" to ("i.redd.it" to "www.redditstatic.com"),
            "tumblr" to ("64.media.tumblr.com" to "assets.tumblr.com"),
            "pinterest" to ("i.pinimg.com" to "s.pinimg.com"),
            "imgur" to ("i.imgur.com" to "s.imgur.com"),
        )
        for ((site, hosts) in sites) {
            val (media, scripts) = hosts
            val name = "$site-media.domains"
            val snapshot = DecisionSnapshot(staticBlock = listOf(load(name)))
            // Android matches a listed domain and every subdomain of it.
            fun blocks(host: String) = snapshot.decide(host) == DecisionSnapshot.Verdict.BLOCK
            assertTrue(blocks(media), "$name must block $media")
            // Blocking a site's scripts would break it, not just its images.
            assertTrue(!blocks(scripts), "$name must not block $scripts")
        }
    }

    @Test
    fun strictSearchRejectsMalformedArtifacts() {
        assertTrue(StrictSearchHosts.parse("not json") is SitrResult.Err)
        assertTrue(StrictSearchHosts.parse("""{"v":2,"hosts":[]}""") is SitrResult.Err)
        assertTrue(StrictSearchHosts.parse("""{"v":1}""") is SitrResult.Err)
        assertTrue(
            StrictSearchHosts.parse("""{"v":1,"hosts":[{"engine":"X"}]}""") is SitrResult.Err
        )
    }
}
