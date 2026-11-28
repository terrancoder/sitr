package com.sitrshield.core.household

import org.json.JSONArray
import org.json.JSONObject

/** The latest lock request a guardian sent to the household's child phones. */
data class LockRequest(val on: Boolean, val at: Long)

/**
 * `policy.child` (docs/sync-protocol.md §Guardian-set child settings): what
 * a guardian set for every child phone of the household. Android only so
 * far; the shared fixtures do not cover it. Absent means "no instruction".
 */
data class ChildPolicy(
    val at: Long = 0,
    val strictSearch: Boolean = false,
    val mediaOff: List<String> = emptyList(),
    val optionalLists: List<String> = emptyList(),
    val reelsOff: Boolean = false,
    val lock: LockRequest? = null,
    val lockAcks: Map<String, Long> = emptyMap(),
) {
    companion object {
        const val MAX_KEYS = 32
        const val MAX_ACKS = 20
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0
        private val KEY = Regex("^[a-z0-9-]{1,32}$")

        private fun time(v: Any?): Long? =
            (v as? Number)?.toDouble()
                ?.takeIf { v !is Boolean && it % 1.0 == 0.0 && it >= 0 && it <= MAX_SAFE_INTEGER }
                ?.toLong()

        private fun keys(v: Any?): List<String> {
            val a = v as? JSONArray ?: return emptyList()
            return (0 until a.length()).mapNotNull { a.opt(it) as? String }
                .filter { KEY.matches(it) }.distinct().sorted().take(MAX_KEYS)
        }

        /** Valid entries, the 20 smallest keys kept. */
        fun capAcks(acks: Map<String, Long>): Map<String, Long> =
            acks.filterKeys { it.isNotEmpty() && it.length <= 64 }
                .toSortedMap().entries.take(MAX_ACKS).associate { it.key to it.value }

        /** Total: anything not an object is absent; bad members fall back. */
        fun sanitize(raw: Any?): ChildPolicy? {
            val o = raw as? JSONObject ?: return null
            val lock = (o.opt("lock") as? JSONObject)?.let { l ->
                val on = l.opt("on") as? Boolean
                val at = time(l.opt("at"))
                if (on != null && at != null) LockRequest(on, at) else null
            }
            val acks = (o.opt("lockAcks") as? JSONObject)?.let { a ->
                a.keys().asSequence().mapNotNull { k -> time(a.opt(k))?.let { k to it } }.toMap()
            } ?: emptyMap()
            return ChildPolicy(
                at = time(o.opt("at")) ?: 0,
                strictSearch = o.opt("strictSearch") == true,
                mediaOff = keys(o.opt("mediaOff")),
                optionalLists = keys(o.opt("optionalLists")),
                reelsOff = o.opt("reelsOff") == true,
                lock = lock,
                lockAcks = capAcks(acks),
            )
        }

        fun toJSONObject(p: ChildPolicy): JSONObject = JSONObject().apply {
            put("at", p.at)
            put("strictSearch", p.strictSearch)
            put("mediaOff", JSONArray(p.mediaOff))
            put("optionalLists", JSONArray(p.optionalLists))
            put("reelsOff", p.reelsOff)
            p.lock?.let { put("lock", JSONObject().put("on", it.on).put("at", it.at)) }
            put("lockAcks", JSONObject().apply { p.lockAcks.forEach { (k, v) -> put(k, v) } })
        }

        private fun List<String>.tidy() = distinct().sorted().take(MAX_KEYS)

        /**
         * A guardian's change to the filters; `at` always moves forward.
         * Lists tidied as the sanitizer does, so the written state equals
         * its synced copy (else every sync would push it again).
         */
        fun edited(base: ChildPolicy, now: Long, change: (ChildPolicy) -> ChildPolicy): ChildPolicy =
            change(base).let {
                it.copy(
                    at = maxOf(now, base.at + 1),
                    mediaOff = it.mediaOff.tidy(),
                    optionalLists = it.optionalLists.tidy(),
                    lock = base.lock,
                    lockAcks = base.lockAcks,
                )
            }

        /** The four filter values a child phone copies. */
        fun filters(p: ChildPolicy?): List<Any> =
            (p ?: ChildPolicy()).let { listOf(it.strictSearch, it.mediaOff, it.optionalLists, it.reelsOff) }

        /** A new lock (or unlock) request: a later `lock.at`, acks emptied. */
        fun lockRequested(base: ChildPolicy, on: Boolean, now: Long): ChildPolicy =
            base.copy(
                at = maxOf(now, base.at + 1),
                lock = LockRequest(on, maxOf(now, (base.lock?.at ?: 0) + 1)),
                lockAcks = emptyMap(),
            )

        /** The stored copy after a sync: replaced only by one not older. */
        fun adopt(stored: ChildPolicy?, incoming: ChildPolicy?): ChildPolicy? =
            if (incoming != null && (stored == null || incoming.at >= stored.at)) incoming else stored

        /** Number of child phones that applied the current lock request. */
        fun confirmed(p: ChildPolicy): Int = p.lock?.let { l -> p.lockAcks.values.count { it == l.at } } ?: 0

        /**
         * Guardian write-back: the copy to write when the state lost it or
         * holds an older one, with the acks of both for the copy's request.
         */
        fun writeBack(state: ChildPolicy?, stored: ChildPolicy?): ChildPolicy? {
            if (stored == null || (state != null && state.at >= stored.at)) return null
            val lockAt = stored.lock?.at ?: return stored.copy(lockAcks = emptyMap())
            val acks = (stored.lockAcks + (state?.lockAcks ?: emptyMap())).filterValues { it == lockAt }
            return stored.copy(lockAcks = capAcks(acks))
        }

        /** The request a child phone acts on now, or null (none new). */
        fun newLockRequest(copy: ChildPolicy?, appliedAt: Long): LockRequest? =
            copy?.lock?.takeIf { it.at > appliedAt }

        /**
         * A child phone's ack: the state's `child` with this phone's entry,
         * or null when nothing to write (no matching request, already
         * there, or an entry sanitizing would drop).
         */
        fun withAck(state: ChildPolicy?, deviceId: String, appliedAt: Long): ChildPolicy? {
            val c = state ?: return null
            if (appliedAt == 0L || c.lock?.at != appliedAt || c.lockAcks[deviceId] == appliedAt) return null
            val acks = capAcks(c.lockAcks + (deviceId to appliedAt))
            return if (acks[deviceId] == appliedAt) c.copy(lockAcks = acks) else null
        }
    }
}

/** What a phone does with `policy.child` after a sync or on coming to the front. */
data class ChildStep(
    /** The household to keep: the same object when nothing is written. */
    val household: HouseholdState,
    val stored: ChildPolicy?,
    /** A child phone copies these filters into its own switches. */
    val copyFilters: ChildPolicy?,
    /** A child phone sets its child lock to this. */
    val setLock: Boolean?,
    val lockAppliedAt: Long,
)

object ChildSync {
    /**
     * The whole client rule set in one place. `ready`: the guard is on,
     * Sitr is the always-on VPN and the household has a PIN. Writes bump
     * the revision; the caller syncs again when `household` changed.
     */
    fun step(
        isChild: Boolean,
        household: HouseholdState,
        stored: ChildPolicy?,
        lockAppliedAt: Long,
        ready: Boolean,
        deviceId: String,
        now: Double,
    ): ChildStep {
        if (Household.isJoinPlaceholder(household)) return ChildStep(household, stored, null, null, lockAppliedAt)
        val copy = ChildPolicy.adopt(stored, household.child)
        if (!isChild) {
            val back = ChildPolicy.writeBack(household.child, copy)
                ?: return ChildStep(household, copy, null, null, lockAppliedAt)
            return ChildStep(
                Household.bumpRev(household.copy(child = back), deviceId, now), back, null, null, lockAppliedAt,
            )
        }
        // Only when the filters changed: a lock request moves `at` too, and
        // must not reset what the child phone has (defaults on a first lock).
        val copyFilters = copy?.takeIf { ChildPolicy.filters(it) != ChildPolicy.filters(stored) }
        val request = ChildPolicy.newLockRequest(copy, lockAppliedAt)?.takeIf { !it.on || ready }
        val applied = request?.at ?: lockAppliedAt
        val acked = ChildPolicy.withAck(household.child, deviceId, applied)
        return ChildStep(
            household = acked?.let { Household.bumpRev(household.copy(child = it), deviceId, now) } ?: household,
            stored = copy,
            copyFilters = copyFilters,
            setLock = request?.on,
            lockAppliedAt = applied,
        )
    }
}
