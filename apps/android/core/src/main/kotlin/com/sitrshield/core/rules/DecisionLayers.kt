package com.sitrshield.core.rules

import com.sitrshield.core.dns.SafeSearchMap

/**
 * The DNS decision function — the Android embodiment of the rule ladder
 * in extension/src/lib/ruleLayers.ts (managed > household > device-user >
 * static; allow wins within a layer; a higher layer's block beats a lower
 * layer's allow). See docs/architecture.md §Mobile engines.
 *
 * A snapshot is immutable; the engine swaps a volatile reference on every
 * settings change ("engine first, persist after"). Matching mirrors DNR
 * `requestDomains`: a set entry matches the qname itself and every
 * subdomain of it.
 */
class DecisionSnapshot(
    val managedAllow: Set<String> = emptySet(),
    val managedBlock: Set<String> = emptySet(),
    val householdAllow: Set<String> = emptySet(),
    val householdBlock: Set<String> = emptySet(),
    val userAllow: Set<String> = emptySet(),
    val userBlock: Set<String> = emptySet(),
    /** Union of the ENABLED static category sets. */
    val staticBlock: Set<String> = emptySet(),
) {
    enum class Verdict { BLOCK, FORWARD }

    private fun matches(qname: String, set: Set<String>): Boolean {
        if (set.isEmpty()) return false
        var suffix = qname
        while (true) {
            if (suffix in set) return true
            val dot = suffix.indexOf('.')
            if (dot < 0) return false
            suffix = suffix.substring(dot + 1)
        }
    }

    fun decide(qname: String): Verdict {
        val name = qname.lowercase().trimEnd('.')
        // Strongest layer first; within a layer allow wins; the first
        // layer that matches at all decides.
        for ((allow, block) in listOf(
            managedAllow to managedBlock,
            householdAllow to householdBlock,
            userAllow to userBlock,
        )) {
            if (matches(name, allow)) return Verdict.FORWARD
            if (matches(name, block)) return Verdict.BLOCK
        }
        return if (matches(name, staticBlock)) Verdict.BLOCK else Verdict.FORWARD
    }
}

/**
 * The engine's whole decision for one name, in priority order.
 *
 * The rule ladder runs FIRST: a block — device, household, managed or
 * category — must win even for a host that has a SafeSearch rewrite.
 * (Checking the rewrite first skipped the ladder for every search host:
 * blocking `google.co.uk` left `www.google.co.uk` reachable.) Anything not
 * blocked then gets the rewrite, so an ALLOW rule can never switch
 * SafeSearch off.
 */
sealed class NameAction {
    object Block : NameAction()
    data class Rewrite(val rule: SafeSearchMap.Rule) : NameAction()
    object Forward : NameAction()

    companion object {
        fun of(
            qname: String,
            snapshot: DecisionSnapshot,
            safeSearch: SafeSearchMap,
        ): NameAction {
            if (snapshot.decide(qname) == DecisionSnapshot.Verdict.BLOCK) return Block
            return safeSearch.ruleFor(qname)?.let { Rewrite(it) } ?: Forward
        }
    }
}
