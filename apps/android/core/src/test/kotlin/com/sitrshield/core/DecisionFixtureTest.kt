package com.sitrshield.core

import com.sitrshield.core.dns.SafeSearchMap
import com.sitrshield.core.domainset.DomainSet
import com.sitrshield.core.rules.DecisionSnapshot
import com.sitrshield.core.rules.NameAction
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * apps/shared/fixtures/decision.json (tools/conformance): the decision
 * order every platform must give. R1: no allow entry opens an adult-listed
 * name. R2: an allow entry never switches SafeSearch off. R3: the other
 * lists and the layer order as before. Replayed on NameAction.of with the
 * builder's split (SitrApp.rebuildEngine): the adult list in alwaysBlock,
 * the others in staticBlock.
 */
class DecisionFixtureTest {
    private val fx = JSONObject(File(FixtureTest.fixturesDir, "decision.json").readText())

    private fun strings(o: JSONObject?, key: String): Set<String> {
        val a = o?.optJSONArray(key) ?: return emptySet()
        return (0 until a.length()).map { a.getString(it) }.toSet()
    }

    @Test
    fun decisionMatchesTheSharedFixture() {
        val raw = fx.getJSONObject("lists")
        val lists = raw.keys().asSequence().associateWith { stem ->
            DomainSet.of(strings(raw, stem)).getOrNull() ?: error("list $stem must load")
        }
        val safeSearch = SafeSearchMap.parse(
            File(FixtureTest.fixturesDir.parentFile, "blocklists/android/safesearch-hosts.json").readText()
        ).getOrNull() ?: error("the real SafeSearch map must parse")
        assertNotNull(safeSearch.ruleFor(fx.getString("searchEngine")), "the real map covers the search engine")

        val cases = fx.getJSONArray("cases")
        assertTrue(cases.length() >= 25)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val (m, h, u) = listOf("managed", "household", "user").map { c.optJSONObject(it) }
            val snapshot = DecisionSnapshot(
                managedAllow = strings(m, "allow"), managedBlock = strings(m, "block"),
                householdAllow = strings(h, "allow"), householdBlock = strings(h, "block"),
                userAllow = strings(u, "allow"), userBlock = strings(u, "block"),
                staticBlock = lists.filterKeys { it != "adult" }.values.toList(),
                alwaysBlock = listOfNotNull(lists["adult"]),
            )
            val got = when (NameAction.of(c.getString("host"), snapshot, safeSearch)) {
                NameAction.Block -> "block"
                is NameAction.Rewrite -> "safesearch"
                NameAction.Forward -> "forward"
            }
            assertEquals(c.getString("expected"), got, c.getString("name"))
        }
    }
}
