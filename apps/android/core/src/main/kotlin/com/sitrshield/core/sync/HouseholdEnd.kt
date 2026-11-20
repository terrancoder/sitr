package com.sitrshield.core.sync

/**
 * The end date of a Sitr Family household, as every member device sees it
 * (docs/sync-protocol.md §Sync-server rules, §Sync 402). Port of
 * extension/src/lib/householdEnd.ts, pinned by
 * apps/shared/fixtures/claim.json (syncRefusals, the "waiting" notice).
 * Pure: no network, no storage.
 *
 * This is all a device that only belongs to a household needs: the sync
 * server's end date `E`, whether the household is read-only, and the
 * neutral notice. The renewing device's logic is in Entitlement.kt, which
 * builds on this file; this file never uses it.
 */

/** What a member device remembers about its household's end. */
data class HouseholdEnd(
    /** `E`, from X-Sitr-Entitlement-Expires; null: no such header (a
     * version 1 household, never read-only). */
    val entExp: Double?,
    /** A `402 lapsed` was seen and no successful round has shown E > now since. */
    val lapsed: Boolean,
    /** The household was created by a `test: true` token. */
    val testHousehold: Boolean,
) {
    companion object {
        const val DAY = 86_400_000.0
        const val HOUR = 3_600_000.0

        private val END_HEADER = Regex("[0-9]{1,16}")

        /** X-Sitr-Entitlement-Expires: decimal epoch ms (surrounding blanks
         * allowed, at most 16 digits), else null. */
        fun parseEndHeader(value: String?): Double? {
            val v = jsTrim(value ?: return null)
            return if (END_HEADER.matches(v)) v.toDouble() else null
        }

        /** Whether this answer shows the household open: a successful round,
         * not a `402 lapsed`, with E (after the answer) absent or in the future. */
        fun showsOpen(answer: EndAnswer, entExpAfter: Double?, now: Double): Boolean =
            !answer.lapsed && answer.succeeded && (entExpAfter == null || entExpAfter > now)

        /** Folds a sync round's answer in. A successful round without the header
         * is a version 1 household: no E, never read-only. A failed round without
         * it changes nothing about E. */
        fun observeEnd(state: HouseholdEnd, answer: EndAnswer, now: Double): HouseholdEnd {
            var s = state
            if (answer.entExp != null) s = s.copy(entExp = answer.entExp)
            else if (answer.succeeded) s = s.copy(entExp = null)
            if (answer.lapsed) s = s.copy(lapsed = true)
            else if (showsOpen(answer, s.entExp, now)) s = s.copy(lapsed = false)
            return s
        }

        /** Read-only: E has passed, or the server answered `402 lapsed`. */
        fun isLapsed(s: HouseholdEnd, now: Double): Boolean =
            s.lapsed || (s.entExp != null && s.entExp <= now)

        /** The neutral notice: when read-only, or while E is less than 2 days away
         * (not for test households, whose E is always under a day away).
         * Returns "none" or "waiting". */
        fun endNotice(s: HouseholdEnd, now: Double): String {
            val soon = !s.testHousehold && s.entExp != null && s.entExp - now < 2 * DAY
            return if (isLapsed(s, now) || soon) "waiting" else "none"
        }

        /** The version 1 server's 402 bodies (server-hotfix-live), read as reasons. */
        private val V1_BODIES = mapOf(
            "entitlement required" to SyncRefusal.TOKEN_REQUIRED,
            "malformed entitlement token" to SyncRefusal.TOKEN_INVALID,
            "invalid entitlement signature" to SyncRefusal.TOKEN_INVALID,
            "malformed entitlement payload" to SyncRefusal.TOKEN_INVALID,
            "unsupported entitlement version" to SyncRefusal.TOKEN_INVALID,
            "entitlement expired — please renew" to SyncRefusal.TOKEN_EXPIRED,
        )

        /** A sync server 402's reason: the first line of the body, trimmed. Null
         * for any other status or an unknown first line. */
        fun parseSyncRefusal(status: Int, body: String): SyncRefusal? {
            if (status != 402) return null
            val first = jsTrim(body.split("\n")[0])
            return SyncRefusal.fromWire(first) ?: V1_BODIES[first]
        }

        /** The neutral sentence for "waiting" and for a `402 lapsed`. */
        const val WAITING_TEXT =
            "Waiting for renewal on the guardian device that renews the Family plan. Filtering continues; changes will sync after renewal."

        /** JavaScript's String.prototype.trim: its WhiteSpace and LineTerminator
         * set exactly (Kotlin's trim() also strips U+001C–U+001F and keeps U+FEFF). */
        internal fun jsTrim(s: String): String = s.trim {
            it in "\t\n\u000B\u000C\r \u00A0\u1680\u2028\u2029\u202F\u205F\u3000\uFEFF" || it in '\u2000'..'\u200A'
        }
    }
}

/** A sync round's answer: `entExp` the header (null when absent), `lapsed`
 * a `402 lapsed`, `succeeded` a 200/201 round. */
data class EndAnswer(val entExp: Double?, val lapsed: Boolean, val succeeded: Boolean)

enum class SyncRefusal(val wire: String) {
    LAPSED("lapsed"),
    TOKEN_REQUIRED("token-required"),
    TOKEN_INVALID("token-invalid"),
    TOKEN_EXPIRED("token-expired"),
    PLAN_NOT_ACCEPTED("plan-not-accepted"),
    TOKEN_USED("token-used"),
    V1_ENDED("v1-ended");

    companion object {
        fun fromWire(s: String?): SyncRefusal? = entries.firstOrNull { it.wire == s }
    }
}
