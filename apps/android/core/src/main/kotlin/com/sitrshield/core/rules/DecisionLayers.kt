package com.sitrshield.core.rules

import com.sitrshield.core.dns.SafeSearchMap
import com.sitrshield.core.domainset.DomainSet

/**
 * The DNS decision function — the Android embodiment of the rule ladder
 * in extension/src/lib/ruleLayers.ts: the adult list first (no allow entry
 * of any layer opens it), then managed > household > device-user > the
 * other static lists; allow wins within a layer; a higher layer's block
 * beats a lower layer's allow. Pinned with the other platforms by
 * apps/shared/fixtures/decision.json. See docs/architecture.md §Mobile
 * engines.
 *
 * A snapshot is immutable; the engine swaps a volatile reference on every
 * settings change ("engine first, persist after"). Matching mirrors DNR
 * `requestDomains`: a set entry matches the qname itself and every
 * subdomain of it — so an allow on a parent of an adult-listed name still
 * opens the parent and its other subdomains, but never the listed one.
 */
class DecisionSnapshot(
    val managedAllow: Set<String> = emptySet(),
    val managedBlock: Set<String> = emptySet(),
    val householdAllow: Set<String> = emptySet(),
    val householdBlock: Set<String> = emptySet(),
    val userAllow: Set<String> = emptySet(),
    val userBlock: Set<String> = emptySet(),
    /**
     * The ENABLED static lists (categories, Strict Search, media sites,
     * opt-in lists),
     * searched in turn — never unioned into a copy, so a settings change
     * only assembles a list of references.
     */
    val staticBlock: List<DomainSet> = emptyList(),
    /** Lists checked BEFORE every allow entry: on Android the adult,
     *  gambling and dating lists. No allow of any layer opens a name on them. */
    val alwaysBlock: List<DomainSet> = emptyList(),
) {
    enum class Verdict { BLOCK, FORWARD }

    companion object {
        const val ADULT_ALLOW_REFUSAL =
            "This site is on the adult, gambling or dating list and cannot be allowed. If it is listed by mistake, report it."

        /** Whether `set` lists `name` itself or a parent of it: the decision's own walk. */
        fun covers(set: DomainSet, name: String): Boolean {
            val n = name.lowercase().trimEnd('.')
            return n.isNotEmpty() && matches(n, set)
        }

        /** Suffix walk by offset: no substring per label. */
        private fun matches(qname: String, set: DomainSet): Boolean {
            if (set.size == 0) return false
            var from = 0
            while (true) {
                if (set.contains(qname, from)) return true
                val dot = qname.indexOf('.', from)
                if (dot < 0) return false
                from = dot + 1
            }
        }
    }

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
        for (set in alwaysBlock) if (matches(name, set)) return Verdict.BLOCK
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
        for (set in staticBlock) if (matches(name, set)) return Verdict.BLOCK
        return Verdict.FORWARD
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
