package com.sitrshield.core.sync

import com.sitrshield.core.sync.HouseholdEnd.Companion.DAY
import com.sitrshield.core.sync.HouseholdEnd.Companion.HOUR
import com.sitrshield.core.sync.HouseholdEnd.Companion.WAITING_TEXT
import com.sitrshield.core.sync.HouseholdEnd.Companion.endNotice
import com.sitrshield.core.sync.HouseholdEnd.Companion.isLapsed
import com.sitrshield.core.sync.HouseholdEnd.Companion.observeEnd
import com.sitrshield.core.sync.HouseholdEnd.Companion.showsOpen
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Base64
import kotlin.math.abs
import kotlin.math.floor

/**
 * Sitr Family entitlement, version 2, on the client
 * (docs/sync-protocol.md §Entitlement version 2, §What each client must do).
 * Port of extension/src/lib/entitlement.ts, pinned by
 * apps/shared/fixtures/claim.json.
 *
 * Pure: no network, no storage. Time and randomness are passed in. Times
 * are epoch milliseconds as Double, like the reference's numbers and the
 * rest of :core. The claim state is stored as JSON with the reference's
 * field names (ClaimState.toJson / Entitlement.sanitizeClaimState), the
 * same shape on every platform.
 *
 * The caller's part, not expressible here (FamilyRound does it for a sync
 * round): claim only while this device holds a subscription code (a
 * child-role device never does); on token-used / token-expired /
 * token-invalid / token-required at creation, claim once more and retry the
 * creation once (retriesCreate). Entering or removing the code applies
 * forgetClaims; leaving the household starts from ClaimState().
 */

/** A version 2 token as the client reads it. The client never checks the
 * signature and never judges a token by its own clock (§Clocks); it reads
 * `per` and `exp` only to order and retire held tokens. */
data class EntitlementToken(
    val raw: String,
    val plan: String,
    val term: String,
    val per: Double,
    val exp: Double,
    val test: Boolean,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("raw", raw)
        .put("plan", plan)
        .put("term", term)
        .put("per", jsonNumber(per))
        .put("exp", jsonNumber(exp))
        .put("test", test)
}

/** The one input field (§One input field). */
sealed class CodeInput {
    data class Code(val code: String) : CodeInput()
    data class V1Token(val token: String) : CodeInput()
    data object Invalid : CodeInput()
}

/** The claim service's refusal reasons that the client acts on. */
enum class ClaimReason(val wire: String) {
    BOUND_TO_OTHER_DEVICE("bound-to-other-device"),
    REPLACEMENT_USED("replacement-used"),
    PAYMENT_PENDING("payment-pending"),
    INACTIVE("inactive"),
    REVOKED("revoked"),
    UNKNOWN_CODE("unknown-code"),
    WRONG_PRODUCT("wrong-product"),
    INVALID_RECEIPT("invalid-receipt"),
    TEST_PURCHASE("test-purchase"),
    FAMILY_SHARING("family-sharing"),
    BAD_REQUEST("bad-request"),
    /** Any other reason the service sends with a 4xx: stop until the user acts. */
    UNRECOGNIZED("unrecognized");

    companion object {
        fun fromWire(s: String?): ClaimReason? = entries.firstOrNull { it.wire == s }
    }
}

sealed class ClaimOutcome {
    data class Token(val token: EntitlementToken) : ClaimOutcome()

    /** A token whose plan is not `family` (§A code of an Institutions plan):
     * delete the code, the claim secret and the token; create nothing. */
    data class NotFamily(val plan: String) : ClaimOutcome()
    data class Refused(val reason: ClaimReason, val retryAfter: Double?) : ClaimOutcome()

    /** 429, 5xx, no network, or an answer that is not the claim API's JSON:
     * retry at later runs with backoff. */
    data object Unavailable : ClaimOutcome()
}

/** What this device remembers about its household's subscription. Never in
 * the household blob. Field names are the stored JSON names. */
data class ClaimState(
    /** Rule (b): the household (id) this device has applied a token to. */
    val appliedHousehold: String? = null,
    /** The household was created by a `test: true` token. */
    val testHousehold: Boolean = false,
    /** `E`, from X-Sitr-Entitlement-Expires; null: no such header (a
     * version 1 household). */
    val entExp: Double? = null,
    /** The renewal window's random first-attempt time, and the E it was
     * drawn for. */
    val windowFor: Double? = null,
    val windowAt: Double? = null,
    /** No automatic claim before this time (daily retry, backoff). */
    val notBefore: Double? = null,
    val backoff: Double? = null,
    /** A refusal that waits for the user. */
    val stopped: Boolean = false,
    /** The last refusal this device got; null after a token. */
    val lastRefusal: ClaimReason? = null,
    /** From replacement-used, for its text. */
    val retryAfter: Double? = null,
    /** A `402 lapsed` was seen and no successful round has shown E > now since. */
    val lapsed: Boolean = false,
    /** Rule (d) was answered with a token in this lapse. */
    val lapseClaimed: Boolean = false,
    /** Rule (d) was refused as bound-to-other-device in this lapse. */
    val lapseRefused: Boolean = false,
    /** Tokens held and not yet covered by E. */
    val tokens: List<EntitlementToken> = emptyList(),
    /** The token already written with a forced write (once per token). */
    val forcedToken: String? = null,
    /** An E this device saw more than LEGACY_DAYS away (a legacy household's
     * cut-over date). */
    val legacyEnd: Double? = null,
) {
    /** The member-device view of this state (HouseholdEnd.kt). */
    val end: HouseholdEnd get() = HouseholdEnd(entExp, lapsed, testHousehold)

    /** The stored form: every field present, null as JSON null. */
    fun toJson(): JSONObject = JSONObject()
        .put("appliedHousehold", appliedHousehold ?: JSONObject.NULL)
        .put("testHousehold", testHousehold)
        .put("entExp", jsonNumber(entExp))
        .put("windowFor", jsonNumber(windowFor))
        .put("windowAt", jsonNumber(windowAt))
        .put("notBefore", jsonNumber(notBefore))
        .put("backoff", jsonNumber(backoff))
        .put("stopped", stopped)
        .put("lastRefusal", lastRefusal?.wire ?: JSONObject.NULL)
        .put("retryAfter", jsonNumber(retryAfter))
        .put("lapsed", lapsed)
        .put("lapseClaimed", lapseClaimed)
        .put("lapseRefused", lapseRefused)
        .put("tokens", JSONArray().also { a -> tokens.forEach { a.put(it.toJson()) } })
        .put("forcedToken", forcedToken ?: JSONObject.NULL)
        .put("legacyEnd", jsonNumber(legacyEnd))
}

sealed class Decision {
    /** Nothing to do until an answer or a sync round changes the state. */
    data object None : Decision()
    data class Claim(val current: Boolean) : Decision() {
        val replace: Boolean get() = false
    }

    /** No automatic claim before `until`, unless the state changes first. */
    data class Wait(val until: Double) : Decision()
}

/** next()'s answer: the decision and the state with the window time drawn. */
data class NextStep(val decision: Decision, val state: ClaimState)

/** A sync round's answer. `entExp` is the X-Sitr-Entitlement-Expires value
 * (null when absent), `lapsed` a `402 lapsed`, `succeeded` a 200/201 round,
 * `forced` the token sent by a forced write in this round. */
data class SyncAnswer(
    val entExp: Double?,
    val lapsed: Boolean,
    val succeeded: Boolean,
    val forced: String?,
) {
    val end: EndAnswer get() = EndAnswer(entExp, lapsed, succeeded)
}

enum class Notice(val wire: String) {
    NONE("none"),
    /** The default: waiting for renewal on the subscriber's device. */
    WAITING("waiting"),
    /** Only after a claim on THIS device came back inactive or revoked. */
    ENDED("ended"),
    /** After a claim on this device came back payment-pending. */
    PAYMENT_PROBLEM("payment-problem"),
    /** After a rebind refused as replacement-used, until its retry_after
     * (the date is retryAfter). */
    REPLACEMENT_USED("replacement-used"),
    /** A legacy household after the cut-over is announced, on a device that
     * holds no code; the date is E. */
    ENTER_CODE("enter-code"),
}

object Entitlement {
    /** Backoff after 429, 5xx, no network: 5 minutes, doubling, at most 6 hours. */
    const val FIRST_BACKOFF_MS = 5 * 60_000.0
    const val MAX_BACKOFF_MS = 6 * HOUR

    /** A household whose E is further away than this is a legacy household
     * after the cut-over is announced (no token reaches further). */
    const val LEGACY_DAYS = 41

    /* -------------------------------- token ------------------------------- */

    private val B64URL = Regex("[A-Za-z0-9_-]+")

    private fun decodeB64urlJson(part: String): Any? {
        if (!B64URL.matches(part) || part.length % 4 == 1) return null
        return try {
            val bytes = Base64.getUrlDecoder().decode(part)
            val text = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
            // TextDecoder drops a leading byte order mark.
            parseJson(text.removePrefix(BOM))
        } catch (_: Exception) {
            null
        }
    }

    /** `sitr-ent-v2.<payload>.<signature>` with `v: 2`, string `plan` and
     * `term`, integer `per` and `exp`; `test` is true only when it is `true`.
     * Anything else: null. */
    fun parseToken(raw: String): EntitlementToken? {
        val parts = raw.split(".")
        if (parts.size != 3 || parts[0] != "sitr-ent-v2") return null
        val o = decodeB64urlJson(parts[1]) as? JSONObject ?: return null
        val v = o.opt("v")
        val plan = o.opt("plan")
        val term = o.opt("term")
        val per = safeInteger(o.opt("per"))
        val exp = safeInteger(o.opt("exp"))
        if (v !is Number || v.toDouble() != 2.0 || plan !is String || term !is String ||
            per == null || exp == null
        ) return null
        return EntitlementToken(raw, plan, term, per, exp, o.opt("test") == true)
    }

    private val V1_TOKEN = Regex("sitr-ent-v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")

    /** A version 1 token by its shape alone: `sitr-ent-v1.<payload>.<signature>`. */
    fun isVersion1Token(raw: String): Boolean = V1_TOKEN.matches(raw)

    /** The claim service's own check (server/sync/src/claim.ts UUID_RE): any
     * UUID version, canonical 36-character form, RFC 4122 variant, any case. */
    private val UUID_RE = Regex(
        "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        RegexOption.IGNORE_CASE,
    )

    /** The subscription code in lower case, or null when it is not one. */
    fun normalizeSubscriptionCode(input: String): String? =
        if (UUID_RE.matches(input)) input.lowercase() else null

    /** The one input field (§One input field): a subscription code or a version
     * 1 token, told apart by shape after trimming; anything else is refused on
     * the device and sends nothing. */
    fun classifyCodeInput(input: String): CodeInput {
        val s = HouseholdEnd.jsTrim(input)
        normalizeSubscriptionCode(s)?.let { return CodeInput.Code(it) }
        if (isVersion1Token(s)) return CodeInput.V1Token(s)
        return CodeInput.Invalid
    }

    /* ---------------------------- claim answers --------------------------- */

    /** "Show the reason and stop until the user acts." */
    private val STOPS = setOf(
        ClaimReason.UNKNOWN_CODE,
        ClaimReason.WRONG_PRODUCT,
        ClaimReason.INVALID_RECEIPT,
        ClaimReason.TEST_PURCHASE,
        ClaimReason.FAMILY_SHARING,
        ClaimReason.BAD_REQUEST,
        ClaimReason.UNRECOGNIZED,
    )

    /** Maps a claim answer to an outcome. `body` is null when no answer came
     * (no network, no such host). */
    fun claimOutcome(status: Int, body: String?): ClaimOutcome {
        if (body == null || status == 429 || status >= 500) return ClaimOutcome.Unavailable
        val json = parseJson(body) as? JSONObject
        if (status == 200) {
            val token = (json?.opt("token") as? String)?.let(::parseToken)
                ?: return ClaimOutcome.Unavailable
            return if (token.plan == "family") ClaimOutcome.Token(token)
            else ClaimOutcome.NotFamily(token.plan)
        }
        val error = json?.opt("error") as? String ?: return ClaimOutcome.Unavailable
        val reason = ClaimReason.fromWire(error) ?: ClaimReason.UNRECOGNIZED
        val retryAfter = (json.opt("retry_after") as? Number)?.toDouble()
        return ClaimOutcome.Refused(reason, retryAfter)
    }

    /* --------------------------- sync 402 reasons ------------------------- */

    /** On create: claim once more, then retry the creation once. */
    fun retriesCreate(refusal: SyncRefusal): Boolean =
        refusal == SyncRefusal.TOKEN_USED ||
            refusal == SyncRefusal.TOKEN_EXPIRED ||
            refusal == SyncRefusal.TOKEN_INVALID ||
            refusal == SyncRefusal.TOKEN_REQUIRED

    /* ----------------------------- claim state ---------------------------- */

    private class Malformed : Exception()

    /** Reads stored JSON (a JSONObject, or anything else for "nothing"). A
     * missing field takes its empty value; a field of the wrong type, or a
     * token that does not parse, yields the empty state. Tokens are re-read
     * from `raw`. */
    fun sanitizeClaimState(raw: Any?): ClaimState {
        val o = raw as? JSONObject ?: return ClaimState()
        fun present(key: String): Any? = o.opt(key)?.takeIf { it != JSONObject.NULL }
        fun str(key: String): String? = when (val v = present(key)) {
            null -> null
            is String -> v
            else -> throw Malformed()
        }
        fun bool(key: String): Boolean = when (val v = present(key)) {
            null -> false
            is Boolean -> v
            else -> throw Malformed()
        }
        fun num(key: String): Double? = when (val v = present(key)) {
            null -> null
            is Number -> v.toDouble().takeIf { it.isFinite() } ?: throw Malformed()
            else -> throw Malformed()
        }
        return try {
            ClaimState(
                appliedHousehold = str("appliedHousehold"),
                testHousehold = bool("testHousehold"),
                entExp = num("entExp"),
                windowFor = num("windowFor"),
                windowAt = num("windowAt"),
                notBefore = num("notBefore"),
                backoff = num("backoff"),
                stopped = bool("stopped"),
                lastRefusal = present("lastRefusal")?.let {
                    ClaimReason.fromWire(it as? String) ?: throw Malformed()
                },
                retryAfter = num("retryAfter"),
                lapsed = bool("lapsed"),
                lapseClaimed = bool("lapseClaimed"),
                lapseRefused = bool("lapseRefused"),
                tokens = when (val v = present("tokens")) {
                    null -> emptyList()
                    is JSONArray -> (0 until v.length()).map { i ->
                        val raw = (v.opt(i) as? JSONObject)?.opt("raw") as? String
                        raw?.let(::parseToken) ?: throw Malformed()
                    }
                    else -> throw Malformed()
                },
                forcedToken = str("forcedToken"),
                legacyEnd = num("legacyEnd"),
            )
        } catch (_: Malformed) {
            ClaimState()
        }
    }

    /** The stored text (ClaimState.toJson().toString()) read back; null,
     * empty or unreadable text is the empty state. */
    fun loadClaimState(text: String?): ClaimState = sanitizeClaimState(text?.let(::parseJson))

    /** The bound-to-other-device answer is remembered (replacement-used is
     * also an answer that the subscription is bound elsewhere). */
    internal fun boundElsewhere(s: ClaimState): Boolean =
        s.lastRefusal == ClaimReason.BOUND_TO_OTHER_DEVICE ||
            s.lastRefusal == ClaimReason.REPLACEMENT_USED

    /* ----------------------------- when to claim -------------------------- */

    /**
     * Rules (b), (c), (d) and the bound-to-other-device rule of §When to claim,
     * for a device that holds a subscription code and is in household
     * `householdId`. `random` is uniform in [0, 1). Returns the decision and the
     * state with the window time drawn.
     */
    fun next(state: ClaimState, now: Double, householdId: String, random: () -> Double): NextStep {
        var s = state
        fun done(d: Decision) = NextStep(d, s)
        if (s.stopped) return done(Decision.None)
        val lapsed = isLapsed(s.end, now)
        // Bound elsewhere and E in the future (or no E): no automatic claim at all.
        if (boundElsewhere(s) && !lapsed) return done(Decision.None)
        val notBefore = s.notBefore
        if (lapsed) {
            // (d). Wait for the held current token to reach the server; an early
            // token alone, or none (it expired unused), asks again.
            if (s.lapseClaimed && s.tokens.any { it.per <= now }) return done(Decision.None)
            if (notBefore != null && now < notBefore) return done(Decision.Wait(notBefore))
            return done(Decision.Claim(current = true))
        }
        if (notBefore != null && now < notBefore) return done(Decision.Wait(notBefore))
        // (b): no token applied to this household yet. With no E header this is
        // also the only rule: one claim, then none while the token is held.
        if (s.appliedHousehold != householdId) {
            return done(if (s.tokens.isEmpty()) Decision.Claim(current = false) else Decision.None)
        }
        val e = s.entExp ?: return done(Decision.None)
        // A held token that moves E reaches the server at the next write.
        if (s.tokens.any { it.exp > e }) return done(Decision.None)
        // (c) the renewal window.
        // A test household: when E is less than an hour away.
        if (s.testHousehold) {
            return done(if (e - now < HOUR) Decision.Claim(current = false) else Decision.Wait(e - HOUR + 1))
        }
        val opens = e - 10 * DAY
        val fast = e - 5 * DAY
        if (s.windowFor != e) s = s.copy(windowFor = e, windowAt = opens + random() * (fast - opens))
        val at = minOf(s.windowAt ?: fast, fast)
        return done(if (now >= at) Decision.Claim(current = false) else Decision.Wait(at))
    }

    /** Folds a claim's answer into the state (§Claim errors). `current` is the
     * flag the claim was sent with. */
    fun record(state: ClaimState, outcome: ClaimOutcome, current: Boolean, now: Double): ClaimState =
        when (outcome) {
            is ClaimOutcome.Token -> {
                val t = outcome.token
                val s = state.copy(
                    tokens = if (state.tokens.any { it.raw == t.raw }) state.tokens else state.tokens + t,
                    stopped = false,
                    lastRefusal = null,
                    retryAfter = null,
                    backoff = null,
                    notBefore = null,
                    lapseRefused = false,
                    lapseClaimed = state.lapseClaimed || current,
                )
                // A token that does not move E (a monthly renewal still ahead):
                // try again a day later.
                val e = s.entExp
                if (e != null && t.exp <= e) s.copy(notBefore = now + DAY) else s
            }
            is ClaimOutcome.NotFamily -> forgetClaims(state)
            is ClaimOutcome.Refused -> {
                val r = outcome.reason
                val s = state.copy(lastRefusal = r, backoff = null)
                when {
                    r in STOPS -> s.copy(stopped = true)
                    // Still bound elsewhere (next() checks lastRefusal); the date is
                    // for the text.
                    r == ClaimReason.REPLACEMENT_USED -> s.copy(retryAfter = outcome.retryAfter)
                    // Refused while lapsed: at most once a day. Otherwise no retry at
                    // all while E is in the future (next() checks lastRefusal).
                    r == ClaimReason.BOUND_TO_OTHER_DEVICE -> s.copy(
                        notBefore = if (current) now + DAY else null,
                        lapseRefused = s.lapseRefused || current,
                    )
                    // payment-pending, inactive, revoked: at most once a day.
                    else -> s.copy(notBefore = now + DAY)
                }
            }
            ClaimOutcome.Unavailable -> {
                val b = minOf(maxOf((state.backoff ?: 0.0) * 2, FIRST_BACKOFF_MS), MAX_BACKOFF_MS)
                state.copy(backoff = b, notBefore = now + b)
            }
        }

    /** Folds a sync round's answer into the state. A successful round without
     * the header is a version 1 household: no E, never lapsed. A failed round
     * without it changes nothing about E. */
    fun observe(state: ClaimState, answer: SyncAnswer, householdId: String, now: Double): ClaimState {
        val end = observeEnd(state.end, answer.end, now)
        var s = state.copy(entExp = end.entExp, lapsed = end.lapsed)
        if (answer.succeeded && answer.forced != null) s = s.copy(forcedToken = answer.forced)
        val e = answer.entExp
        if (e != null) {
            // "Delete it once a response shows E ≥ its exp."
            val kept = s.tokens.filter { it.exp > e }
            if (kept.size < s.tokens.size) s = s.copy(appliedHousehold = householdId)
            s = s.copy(tokens = kept)
            if (e - now > LEGACY_DAYS * DAY) s = s.copy(legacyEnd = e)
        }
        if (showsOpen(answer.end, s.entExp, now)) s = s.copy(lapseClaimed = false, lapseRefused = false)
        // An unused token simply expires; the same claim gets it again.
        return s.copy(tokens = s.tokens.filter { it.exp > now })
    }

    /** The household was just created with `token` (201); `entExp` from the
     * answer's header, null when it had none. */
    fun created(state: ClaimState, token: EntitlementToken, householdId: String, entExp: Double?): ClaimState =
        state.copy(
            tokens = state.tokens.filter { it.raw != token.raw },
            appliedHousehold = householdId,
            testHousehold = token.test,
            entExp = entExp,
            lapsed = false,
            lapseClaimed = false,
            lapseRefused = false,
        )

    /** The subscription code was entered, entered again or removed, or a token
     * of another plan came back: everything this device knew about its own
     * claims goes; what the sync server said about the household stays. */
    fun forgetClaims(state: ClaimState): ClaimState = ClaimState(
        testHousehold = state.testHousehold,
        entExp = state.entExp,
        lapsed = state.lapsed,
        legacyEnd = state.legacyEnd,
    )

    /** The user asked (Try again): lift waits and stops. The memory of a
     * bound-to-other-device answer stays (§Claim errors). */
    fun userRetry(state: ClaimState): ClaimState =
        state.copy(stopped = false, notBefore = null, backoff = null, lapseClaimed = false)

    /** The token to send on the next PUT: the earliest period first, so an
     * early token goes at the following write. */
    fun tokenToSend(s: ClaimState): EntitlementToken? = s.tokens.minByOrNull { it.per }

    /** Whether the next round writes even when nothing changed: once per token. */
    fun forcesWrite(s: ClaimState): Boolean {
        val t = tokenToSend(s)
        return t != null && t.raw != s.forcedToken
    }

    /* ----------------------------- what to show --------------------------- */

    /** The Family screen's notice (§Sync 402; §A legacy household after the
     * cut-over is announced). Shown when lapsed, or while E is less than 2 days
     * away (not for test households, whose E is always under a day away). */
    fun notice(s: ClaimState, now: Double, holdsCode: Boolean): Notice {
        val e = s.entExp
        if (!holdsCode && e != null && e > now && (e - now > LEGACY_DAYS * DAY || s.legacyEnd == e)) {
            return Notice.ENTER_CODE
        }
        if (endNotice(s.end, now) == "none") return Notice.NONE
        return when (s.lastRefusal) {
            ClaimReason.INACTIVE, ClaimReason.REVOKED -> Notice.ENDED
            ClaimReason.PAYMENT_PENDING -> Notice.PAYMENT_PROBLEM
            else -> {
                val until = s.retryAfter
                if (until != null && now < until) Notice.REPLACEMENT_USED else Notice.WAITING
            }
        }
    }

    /** Offer "Renew on this device" (replace: true, plus current: true when
     * lapsed; ask first) in a household: another device holds the binding and
     * E is less than 2 days away; once E has passed, only after the claim
     * without replace was refused; never before a replacement-used answer's
     * retry_after. The creation flow offers it on any bound-to-other-device
     * answer. */
    fun offersReplace(s: ClaimState, now: Double): Boolean {
        val e = s.entExp
        if (!boundElsewhere(s) || e == null) return false
        val until = s.retryAfter
        if (until != null && now < until) return false
        if (isLapsed(s.end, now)) return s.lapseRefused
        return e - now < 2 * DAY
    }

    /* -------------------------------- texts ------------------------------- */

    /**
     * One English sentence per code, keyed by the wire name: a Notice other
     * than none, a ClaimReason, a SyncRefusal other than lapsed (a `402
     * lapsed` shows the notice instead), "code-removed" and "input-invalid".
     * `{date}` is filled in by the caller (E for enter-code and code-removed,
     * retryAfter for replacement-used). Sentences in quotes in the
     * specification are used as written.
     */
    val TEXTS: Map<String, String> = mapOf(
        "waiting" to WAITING_TEXT,
        "ended" to "Family has ended. Renew the subscription to sync changes again. Filtering continues.",
        "payment-problem" to "Payment problem. Update the payment method to keep the household syncing. Filtering continues.",
        "enter-code" to "Enter your subscription code on one guardian device before {date}.",
        "code-removed" to "This device no longer renews the subscription. The household runs until {date}.",
        "input-invalid" to "That is neither a subscription code nor a token.",
        "bound-to-other-device" to "Another device renews this subscription.",
        "replacement-used" to "The renewing device was moved recently. It can be moved again on {date}.",
        "payment-pending" to "The payment is being retried. Update the payment method.",
        "inactive" to "The subscription is not active. Renew it to keep Sitr Family.",
        "revoked" to "The purchase was refunded or revoked.",
        "unknown-code" to "No subscription has this code. Check it and enter it again.",
        "wrong-product" to "This code is not for Sitr Family.",
        "invalid-receipt" to "The subscription could not be confirmed (invalid-receipt).",
        "test-purchase" to "The subscription could not be confirmed (test-purchase).",
        "family-sharing" to "The subscription could not be confirmed (family-sharing).",
        "bad-request" to "The subscription could not be confirmed (bad-request).",
        "unrecognized" to "The subscription could not be confirmed.",
        "token-required" to "The subscription could not be confirmed (token-required).",
        "token-invalid" to "The subscription could not be confirmed (token-invalid).",
        "token-expired" to "The subscription could not be confirmed (token-expired).",
        "token-used" to "The subscription could not be confirmed (token-used).",
        "plan-not-accepted" to "This is a code for Sitr for Institutions.",
        "v1-ended" to "Tokens are no longer accepted. Enter your subscription code.",
    )

    /* ------------------------------- helpers ------------------------------ */

    /** JSON.parse: one value and nothing after it, else null. org.json is
     * more lenient than JSON.parse inside a value (unquoted keys and strings,
     * single quotes); the servers never send those. */
    internal fun parseJson(text: String): Any? = try {
        val tokener = JSONTokener(text)
        val value = tokener.nextValue()
        if (tokener.nextClean() == 0.toChar()) value else null
    } catch (_: Exception) {
        null
    }

    /** Number.isSafeInteger, as a Double. */
    private fun safeInteger(v: Any?): Double? =
        (v as? Number)?.toDouble()?.takeIf { it.isFinite() && it == floor(it) && abs(it) <= MAX_SAFE_INTEGER }

    private const val BOM = "\uFEFF"
}

/** JavaScript's Number.MAX_SAFE_INTEGER. */
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

/** Integral times as JSON integers (as JSON.stringify writes them), null as JSON null. */
private fun jsonNumber(d: Double?): Any = when {
    d == null -> JSONObject.NULL
    d == floor(d) && abs(d) <= MAX_SAFE_INTEGER -> d.toLong()
    else -> d
}
