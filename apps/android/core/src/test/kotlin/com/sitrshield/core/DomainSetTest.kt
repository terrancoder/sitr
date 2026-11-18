package com.sitrshield.core

import com.sitrshield.core.domains.DomainInput
import com.sitrshield.core.domainset.DomainSet
import com.sitrshield.core.rules.DecisionSnapshot
import com.sitrshield.core.rules.DecisionSnapshot.Verdict
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Port of the Swift DomainSetTests (apps/ios/SitrCore/Tests/SitrCoreTests/
 * DnsEngineTests.swift): the byte-backed binary search must match exactly
 * the listed names and nothing that merely sorts next to them.
 */
class DomainSetTest {
    private val dir: File = File(FixtureTest.fixturesDir.parentFile, "blocklists/android")

    private fun sha(b: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    /** Checksum computed over the bytes, so the later checks are what fires. */
    private fun load(s: String) = s.toByteArray().let { DomainSet.load(it, sha(it)) }

    private fun err(s: String) = load(s).errorOrNull() ?: error("\"$s\" must be rejected")

    @Test
    fun realCategoryArtifactsLoadAndMatchExactly() {
        val sums = JSONObject(File(dir, "checksums.json").readText())
        for (category in listOf("adult", "gambling", "dating")) {
            val name = "$category.domains"
            val bytes = File(dir, name).readBytes()
            val d = DomainSet.load(bytes, sums.getString(name)).getOrNull() ?: error("$name must load")
            val all = String(bytes).split("\n").filter { it.isNotEmpty() }
            assertTrue(d.size == all.size && d.size > 0, category)
            val snapshot = DecisionSnapshot(staticBlock = listOf(d))
            val listed = all.toSet()
            for (entry in all) {
                assertTrue(d.contains(entry), entry)
                assertEquals(Verdict.BLOCK, snapshot.decide("www.$entry"), "subdomain of $entry")
                // A string prefix, an extension sorting just after, a byte
                // just before, and a suffix.
                for (miss in listOf(entry.dropLast(1), entry + "a", "$entry-", "0$entry", entry.drop(1))) {
                    if (miss !in listed) assertTrue(!d.contains(miss), "$miss must not match")
                }
                val parent = entry.substringAfter('.')
                if (parent !in listed) {
                    assertTrue(!d.contains(parent), "parent $parent")
                    // The compiler drops entries under a listed ancestor.
                    assertEquals(Verdict.FORWARD, snapshot.decide(parent), "parent $parent")
                }
            }
            assertTrue(d.contains(all.first()) && d.contains(all.last()))
            assertTrue(!d.contains("") && !d.contains("\n") && !d.contains(all[0] + "\n" + all[1]))
        }
    }

    @Test
    fun corruptedByteFailsTheChecksum() {
        val name = "adult.domains"
        val expected = JSONObject(File(dir, "checksums.json").readText()).getString(name)
        val bytes = File(dir, name).readBytes()
        bytes[bytes.size / 2] = (bytes[bytes.size / 2].toInt() xor 1).toByte()
        assertTrue(DomainSet.load(bytes, expected).errorOrNull()!!.contains("checksum"))
    }

    @Test
    fun invalidOrUnsortedFilesAreRejected() {
        assertTrue(err("ok.example\nNOT A DOMAIN\n").contains("line 2"))
        assertTrue(err("a.example\n\nb.example\n").contains("line 2")) // blank line
        assertTrue(err("a.example\nb.example\n\n").contains("line 3")) // trailing blank
        assertTrue(err("example\n").contains("line 1"))
        assertTrue(err("b.example\na.example\n").contains("sorted at line 2"))
        assertTrue(err("a.example\na.example\n").contains("sorted at line 2")) // duplicate
        assertTrue(err("a.example\nab.example\naa.example\n").contains("sorted at line 3"))
        assertEquals(0, load("").getOrNull()?.size)
        assertEquals(0, load("\n").getOrNull()?.size)
        assertEquals(false, load("\n").getOrNull()?.contains(""))
        assertEquals(true, load("a.example\nb.example").getOrNull()?.contains("b.example")) // no final LF
        val d = "a.example\n".toByteArray()
        assertTrue(DomainSet.load(d, sha(d).uppercase()).isOk)
    }

    @Test
    fun ofSortsDedupesAndValidates() {
        val d = DomainSet.of(listOf("b.example", "a.example", "b.example")).getOrNull()!!
        assertEquals(2, d.size)
        assertTrue(d.contains("a.example") && d.contains("b.example") && !d.contains("c.example"))
        assertTrue(DomainSet.of(listOf("Bad.Example")) is SitrResult.Err)
        assertEquals(0, DomainSet.of(emptyList()).getOrNull()?.size)
    }

    @Test
    fun containsFromOffsetMatchesTheSuffixOnly() {
        val d = DomainSet.of(listOf("blocked.example")).getOrNull()!!
        assertTrue(d.contains("www.blocked.example", 4))
        assertTrue(!d.contains("www.blocked.example", 3))
        assertTrue(!d.contains("www.blocked.example", 0))
        assertTrue(!d.contains("blocked.examplé")) // non-ASCII never matches
    }

    @Test
    fun byteValidatorMatchesDomainInput() {
        for (s in listOf(
            "a.b", "example.com", "-a.com", "a-.com", "a..com", ".a.com", "a.com.", "A.com", "a_b.com", "a",
            "xn--bcher-kva.example", "a".repeat(63) + ".com", "a".repeat(64) + ".com",
            "a.".repeat(126) + "a", "a.".repeat(127) + "a", "1.2", "é.com", "",
        )) {
            assertEquals(DomainInput.isValidDomain(s), DomainSet.isValidDomainBytes(s.toByteArray()), s)
        }
    }

    /** 150,000 generated domains: load, then hits and misses with a time bound. */
    @Test
    fun scaleTest150k() {
        val rng = Random(42)
        val alphabet = "abcdefghijklmnopqrstuvwxyz"
        val tlds = listOf(".com", ".net", ".xxx", ".co.uk")
        val names = HashSet<String>()
        while (names.size < 150_000) {
            val label = (0 until 4 + rng.nextInt(14)).map { alphabet[rng.nextInt(26)] }.joinToString("")
            names.add(label + tlds[rng.nextInt(4)])
        }
        val bytes = names.sorted().joinToString("") { "$it\n" }.toByteArray()
        val expected = sha(bytes)

        val loadStart = System.nanoTime()
        val d = DomainSet.load(bytes, expected).getOrNull() ?: error("must load")
        val loadMs = (System.nanoTime() - loadStart) / 1e6
        assertEquals(150_000, d.size)

        val probes = names.take(50_000)
        val start = System.nanoTime()
        var hits = 0
        var misses = 0
        for (n in probes) {
            if (d.contains(n)) hits++
            if (!d.contains(n + "x")) misses++ // sorts right after a hit
            if (!d.contains("q$n")) misses++
        }
        val lookupMs = (System.nanoTime() - start) / 1e6
        assertEquals(probes.size, hits)
        assertTrue(misses >= 2 * probes.size - 10) // a generated "q…" may exist
        println("DomainSet scale: 150000 entries, ${bytes.size} bytes, load %.1f ms, 150000 lookups %.1f ms".format(loadMs, lookupMs))
        // Generous for a shared CI machine; a linear scan would take minutes.
        assertTrue(loadMs < 2_000, "load $loadMs ms")
        assertTrue(lookupMs < 5_000, "lookups $lookupMs ms")
    }
}
