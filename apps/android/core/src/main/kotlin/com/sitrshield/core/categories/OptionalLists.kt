package com.sitrshield.core.categories

import com.sitrshield.core.domainset.DomainSet
import org.json.JSONObject

/**
 * Opt-in lists (blocklist/optional/lists.json): off unless the user turns
 * them on, device-local (never household state — older apps erase fields
 * they don't know), and never part of protection status. This table is the
 * only place a list is named: loading, the stored set, the switches and the
 * decision snapshot all read it, so a new list is one row here plus its
 * `<id>.domains` artifact.
 */
object OptionalLists {
    data class Entry(val id: String, val title: String, val description: String)

    val ALL = listOf(
        Entry(
            "violence",
            "Violent and hateful sites",
            "Blocks a list of gore sites and extremist hate sites. The list is " +
                "old and incomplete: plenty of such sites are not on it. Off " +
                "unless you turn it on.",
        ),
        Entry(
            "doh",
            "Block encrypted-DNS bypass",
            // Wording from what was observed on the API 35 emulator with
            // Chrome 124 (2026-11), not from documentation.
            "Some browsers have a \"secure DNS\" setting that sends lookups to " +
                "an outside encrypted DNS service, which skips Sitr's filter. With " +
                "this on, Sitr refuses to look up the addresses of well-known " +
                "services of that kind, so that setting stops working instead of " +
                "quietly skipping the filter. In Chrome, every page then fails to " +
                "load with an error about the secure DNS setting, until that " +
                "setting is set back to automatic. A connection the browser " +
                "already has open can keep working for some minutes after you " +
                "turn this on.\n\nIt cannot stop a service entered as an IP " +
                "address (such as https://1.1.1.1/dns-query) or one that is not on " +
                "the list. Android's own Private DNS set to a fixed host " +
                "conflicts with Sitr whether this is on or off: protection is not " +
                "active and Sitr shows red until Private DNS is set to Automatic " +
                "or Off.",
        ),
    )

    /**
     * Each list that is present, matches checksums.json and is non-empty.
     * One that is missing or fails verification is simply absent — its
     * switch shows why — and never stops the filter or the other lists.
     */
    fun load(checksums: JSONObject, open: (String) -> ByteArray): Map<String, DomainSet> =
        ALL.mapNotNull { e ->
            val name = "${e.id}.domains"
            runCatching { DomainSet.load(open(name), checksums.getString(name)).getOrNull() }
                .getOrNull()?.takeIf { it.size > 0 }?.let { e.id to it }
        }.toMap()

    /** The loaded lists the user turned on, for DecisionSnapshot.staticBlock. */
    fun enabledSets(enabled: Set<String>, loaded: Map<String, DomainSet>): List<DomainSet> =
        ALL.filter { it.id in enabled }.mapNotNull { loaded[it.id] }
}
