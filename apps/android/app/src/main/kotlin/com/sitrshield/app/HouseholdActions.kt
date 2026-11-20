package com.sitrshield.app

import android.os.SystemClock
import com.sitrshield.app.data.Settings
import com.sitrshield.app.sync.Endpoints
import com.sitrshield.app.sync.SyncHttp
import com.sitrshield.app.sync.SyncWorker
import com.sitrshield.core.SitrResult
import com.sitrshield.core.gate.Delay
import com.sitrshield.core.gate.DelayAction
import com.sitrshield.core.gate.DelayClockReading
import com.sitrshield.core.gate.DelayPhase
import com.sitrshield.core.gate.DelayStamp
import com.sitrshield.core.gate.Gate
import com.sitrshield.core.gate.GateContext
import com.sitrshield.core.gate.HouseholdRole
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.gate.MutationStep
import com.sitrshield.core.gate.Pause
import com.sitrshield.core.gate.PauseRecord
import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.pin.Pin
import com.sitrshield.core.pin.PinRecord
import com.sitrshield.core.sync.ClaimClient
import com.sitrshield.core.sync.ClaimOutcome
import com.sitrshield.core.sync.ClaimReason
import com.sitrshield.core.sync.ClaimState
import com.sitrshield.core.sync.CodeInput
import com.sitrshield.core.sync.Entitlement
import com.sitrshield.core.sync.FamilyPlan
import com.sitrshield.core.sync.HouseholdEnd
import com.sitrshield.core.sync.PairingCode
import com.sitrshield.core.sync.Subscription
import com.sitrshield.core.sync.SyncClient
import com.sitrshield.core.sync.SyncCrypto
import com.sitrshield.core.sync.SyncInput
import com.sitrshield.core.sync.SyncRun
import com.sitrshield.core.sync.SyncStatus
import com.sitrshield.engine.EngineController
import com.sitrshield.engine.SitrVpnService
import java.text.DateFormat
import java.util.Date
import java.util.TimeZone
import kotlin.concurrent.thread

/**
 * Every settings mutation, gate-checked through the ported authority
 * ladder (managed > child > PIN; the PIN gates loosening actions only)
 * and applied engine-first via SitrApp.update. The UI calls
 * decide() first (gate, then "wait before loosening", then the PIN),
 * then calls the action.
 */
class HouseholdActions(private val app: SitrApp) {
    companion object {
        private const val LOCKED = "turn off the child lock first"

        /** A date the claim service or sync server set (00:00 UTC), as a
         * UTC calendar date, so it never shows the day before. */
        fun date(ms: Double): String =
            DateFormat.getDateInstance(DateFormat.LONG).apply { timeZone = TimeZone.getTimeZone("UTC") }
                .format(Date(ms.toLong()))
        const val WAITING_FOR_FIRST_SYNC =
            "Waiting for the first sync with your household. Connect to the " +
                "internet and tap Sync now. The household's PIN and lists " +
                "appear here after that."
    }

    private fun now() = System.currentTimeMillis().toDouble()

    private fun settings(): Settings = app.repository.current()

    /**
     * Gate first, then "wait before loosening", then the PIN. Leaving a
     * household never received is gated from the stored state, read now.
     */
    fun decide(action: DelayAction, phase: DelayPhase): MutationStep {
        val s = settings()
        val asked =
            if (action == DelayAction.Kind(MutationKind.LEAVE_HOUSEHOLD)) DelayAction.Kind(Gate.leaveKind(s.household))
            else action
        return Delay.decide(
            asked,
            GateContext(
                managedLockOptions = app.managedPolicy().lockOptions,
                role = HouseholdRole.fromWire(s.role),
                hasPin = s.household?.pin != null,
            ),
            phase,
        )
    }

    /** Read just before gating a leave; passed on to leaveHousehold. */
    fun leavesAsJoinPlaceholder(): Boolean = Household.isPinlessPlaceholder(settings().household)

    // --- Wait before loosening (device-local; see Repository) ---

    data class DelayState(val minutes: Int, val phase: DelayPhase, val remainingMs: Long)

    /** elapsedRealtime counts during sleep and restarts at boot. */
    private fun clocks() = DelayClockReading(SystemClock.elapsedRealtime(), System.currentTimeMillis())

    /** Evaluates on both clocks and persists a restarted or cleared request. */
    fun delayState(): DelayState {
        val repo = app.repository
        val minutes = repo.loosenDelayMinutes
        val stored = repo.loosenDelayStamp
        val ev = Delay.evaluate(minutes, stored, clocks())
        // Off clears nothing: the stored request is cleared on every setting change.
        if (ev.phase != DelayPhase.OFF && ev.stamp != stored) repo.loosenDelayStamp = ev.stamp
        return DelayState(minutes, ev.phase, ev.remainingMs)
    }

    /** Starting or cancelling never waits. */
    fun startDelayRequest() {
        if (app.repository.loosenDelayMinutes > 0) app.repository.loosenDelayStamp = DelayStamp(clocks())
    }

    fun cancelDelayRequest() {
        app.repository.loosenDelayStamp = null
    }

    /** Ms until each pause length fits the 15-in-60 allowance (0 = now). */
    fun pauseWaits(): Map<Int, Long> {
        val now = clocks()
        val stored = app.repository.pauseRecords
        val live = Pause.live(stored, now)
        if (live != stored) app.repository.pauseRecords = live
        return Pause.MINUTES_ALLOWED.associateWith { Pause.waitFor(it, live, now) }
    }

    /**
     * Call only after decide() let Pause.GATED_AS through. Re-checks the
     * allowance (the PIN dialog may have sat open), records the WHOLE
     * pause before it starts, then takes the tun down.
     */
    fun startPause(minutes: Int): Boolean {
        val now = clocks()
        val live = Pause.live(app.repository.pauseRecords, now)
        if (minutes !in Pause.MINUTES_ALLOWED || Pause.waitFor(minutes, live, now) > 0) return false
        // The service refuses a pause under lockdown; never charge for one it won't run.
        if (EngineController.facts.value.lockdown == true) return false
        app.repository.pauseRecords = live + PauseRecord(DelayStamp(now), minutes * 60_000L)
        SitrVpnService.pause(app, minutes * 60_000L)
        return true
    }

    /** Call only after decide() let a shortening through; lengthening is free. */
    fun setDelayMinutes(minutes: Int) = app.repository.setLoosenDelayMinutes(minutes)

    fun verifyPin(pin: String): Boolean {
        val record = settings().household?.pin ?: return false
        return Pin.verify(pin, record)
    }

    sealed class CreateOutcome {
        data object Created : CreateOutcome()

        /** The subscription is bound to another claim secret (another
         * device, or this phone before it left a household): ask, then call
         * createHousehold again with replace = true. */
        data object ConfirmMove : CreateOutcome()
        data class Refused(val message: String) : CreateOutcome()
    }

    /**
     * Household creation from the one input field (docs/sync-protocol.md
     * §One input field): a version 1 token (or nothing) creates as before;
     * a subscription code claims first (rule (a)) and creates with the
     * token, which the next sync round sends (FamilyRound applies
     * created()). With a code this makes a network request: call it off
     * the main thread, after decide() let Gate.SUBSCRIPTION_GATED_AS
     * through. `replace`: the move the user agreed to after ConfirmMove.
     */
    fun createHousehold(codeOrV1Token: String?, replace: Boolean = false): CreateOutcome {
        // A locked phone must not get a new household, and with it a new PIN.
        if (settings().childLock) return CreateOutcome.Refused(LOCKED)
        Household.joinRefusal(settings().household)?.let { return CreateOutcome.Refused(it) }
        val input = codeOrV1Token?.trim()?.ifEmpty { null }
        if (input == null || input.startsWith("sitr-ent-v1")) {
            // The token goes out as an HTTP header: nothing but its own alphabet.
            if (input != null && !Regex("sitr-ent-v1\\.[A-Za-z0-9._-]+").matches(input)) {
                return CreateOutcome.Refused("that doesn't look like a Sitr Family token")
            }
            // A code left from a creation that did not finish stays out.
            app.secretStore.clearSubscription()
            create(input, ClaimState())
            return CreateOutcome.Created
        }
        val code = (Entitlement.classifyCodeInput(input) as? CodeInput.Code)?.code
            ?: return CreateOutcome.Refused(Entitlement.TEXTS.getValue("input-invalid"))
        codeRefusal()?.let { return CreateOutcome.Refused(it) }
        // The claim secret is kept with the code before the request leaves.
        val held = app.secretStore.loadSubscription()
        val sub = Subscription(code, held?.takeIf { it.code == code }?.claimSecret ?: ClaimClient.newClaimSecret())
        app.secretStore.saveSubscription(sub)
        val outcome = claimForCreate(sub, replace)
        if (outcome is ClaimOutcome.Token) {
            // Checked again: the claim took a moment. The code stays (it
            // is bound to this phone's claim secret now).
            if (settings().childLock) return CreateOutcome.Refused(LOCKED)
            Household.joinRefusal(settings().household)?.let { return CreateOutcome.Refused(it) }
            create(null, Entitlement.record(ClaimState(), outcome, current = false, now = now()))
            return CreateOutcome.Created
        }
        val bound = outcome is ClaimOutcome.Refused && outcome.reason == ClaimReason.BOUND_TO_OTHER_DEVICE
        if (bound && !replace) return CreateOutcome.ConfirmMove
        // Nothing created: keep the code only for a retry after no answer.
        if (outcome != ClaimOutcome.Unavailable) app.secretStore.clearSubscription()
        return CreateOutcome.Refused(FamilyPlan.claimText(outcome, ::date)!!)
    }

    /** The claim of rule (a), creating a household: never `current`. */
    fun claimForCreate(sub: Subscription, replace: Boolean): ClaimOutcome =
        ClaimClient(SyncHttp(), Endpoints.claim(app)).claim(sub.code, sub.claimSecret, replace, current = false)

    private fun create(v1Token: String?, claims: ClaimState) {
        app.secretStore.save(SyncCrypto.generateRootSecret())
        app.update(kickSync = true) { s ->
            s.copy(
                household = Household.emptyState(s.deviceId, now()),
                role = "guardian",
                entitlementToken = v1Token,
                claims = claims,
                planNotAccepted = false,
                maxSeenRev = 0,
                syncStatus = SyncStatus.NEVER_SYNCED,
            )
        }
    }

    fun joinHousehold(code: String, role: String): SitrResult<Unit> {
        if (settings().childLock) return SitrResult.Err(LOCKED)
        Household.joinRefusal(settings().household)?.let { return SitrResult.Err(it) }
        val secret = when (val decoded = PairingCode.decode(code)) {
            is SitrResult.Err -> return decoded
            is SitrResult.Ok -> decoded.value
        }
        app.secretStore.save(secret)
        // A code left from a creation that did not finish stays out of
        // this household; and a child-role device never holds one.
        app.secretStore.clearSubscription()
        app.update(kickSync = true) { s ->
            s.copy(
                // Authored at epoch 0 (as the extension does), so the real
                // household always wins the first merge. With `now` it beat
                // a never-edited rev-1 household and overwrote its devices.
                household = Household.emptyState(s.deviceId, 0.0),
                role = role,
                // A child device keeps no allow rules of its own: they
                // outrank every category and no guardian screen shows them.
                userAllow = if (role == "child") emptyList() else s.userAllow,
                maxSeenRev = 0,
                syncStatus = SyncStatus.NEVER_SYNCED,
            )
        }
        return SitrResult.Ok(Unit)
    }

    /** Shown guardian-only and PIN-gated: possession IS membership. */
    fun pairingCode(): String? =
        app.secretStore.load()?.let { PairingCode.encode(it) }

    /**
     * `asJoinPlaceholder`: the gate let this leave through as a household
     * never received (no PIN asked); refused if it has arrived since.
     */
    fun leaveHousehold(asJoinPlaceholder: Boolean = false): SitrResult<Unit> {
        var refusal: String? = null
        var left: Settings? = null
        var secret: ByteArray? = null
        // Checked and cleared under the settings lock: a sync result is
        // written under it too, so it cannot land between the two.
        app.update { s ->
            // Leaving takes the PIN with it; the lock would have no key left.
            if (s.childLock) return@update s
            refusal = Household.leaveRefusal(asJoinPlaceholder, s.household)
            if (refusal != null) return@update s
            left = s
            secret = app.secretStore.load()
            // Secret first: a sync still on the network checks for it before
            // writing, so its late result cannot bring the household back.
            app.secretStore.clear()
            s.copy(
                household = null,
                role = null,
                maxSeenRev = 0,
                entitlementToken = null,
                // The code and claim secret went with clear() above.
                claims = ClaimState(),
                planNotAccepted = false,
                syncStatus = SyncStatus.NEVER_SYNCED,
            )
        }
        refusal?.let { return SitrResult.Err(it) }
        val before = left ?: return SitrResult.Ok(Unit)
        SyncWorker.cancel(app)
        // Free this device's fair-use place, off the main thread, with the
        // secret held only in memory. Offline, the place stays taken. A
        // placeholder sends nothing (SyncClient.unenroll).
        val key = secret
        val household = before.household
        if (key != null && household != null) {
            thread(name = "sitr-unenroll") {
                SyncClient(SyncHttp(), ::now, Endpoints.sync(app)).unenroll(
                    SyncInput(key, household, before.maxSeenRev, before.deviceId, before.entitlementToken)
                )
            }
        }
        return SitrResult.Ok(Unit)
    }

    /**
     * Sitr Family subscription code (docs/sync-protocol.md §Extension and
     * Android). Call only after decide() let Gate.SUBSCRIPTION_GATED_AS
     * through (refused under a managed lock and on a child device, then
     * the PIN when set, no wait). Refused here too under the child lock and
     * on a child-role device. A new code gets a new claim secret; the same
     * code entered again keeps its secret, or this device would find the
     * subscription bound to its own old one. Either way the claim state
     * forgets this device's claims (Entitlement.forgetClaims), and the next
     * sync run claims. Accepts a subscription code only: a version 1 token
     * goes to createHousehold.
     */
    fun saveSubscriptionCode(input: String): SitrResult<Unit> {
        codeRefusal()?.let { return SitrResult.Err(it) }
        val code = when (val parsed = Entitlement.classifyCodeInput(input)) {
            is CodeInput.Code -> parsed.code
            else -> return SitrResult.Err(Entitlement.TEXTS.getValue("input-invalid"))
        }
        val held = app.secretStore.loadSubscription()
        val claimSecret = held?.takeIf { it.code == code }?.claimSecret ?: ClaimClient.newClaimSecret()
        app.secretStore.saveSubscription(Subscription(code, claimSecret))
        app.update(kickSync = true) {
            it.copy(claims = Entitlement.forgetClaims(it.claims), planNotAccepted = false)
        }
        return SitrResult.Ok(Unit)
    }

    /**
     * Gated as saveSubscriptionCode. The code and the claim secret are
     * deleted together; the household runs until its end date
     * (settings.claims.entExp), and this device no longer renews it.
     */
    fun removeSubscriptionCode(): SitrResult<Unit> {
        codeRefusal()?.let { return SitrResult.Err(it) }
        app.secretStore.clearSubscription()
        app.update { it.copy(claims = Entitlement.forgetClaims(it.claims)) }
        return SitrResult.Ok(Unit)
    }

    /**
     * "Renew on this phone": the claim with replace = true (plus current
     * when the household is lapsed), only while Entitlement.offersReplace
     * allows it. The screen asks first (a move is possible once in 180
     * days), then gates it as saveSubscriptionCode. Network and the round
     * lock: call it off the main thread.
     */
    fun renewHere(): SitrResult<Unit> = SyncRun.exclusive {
        codeRefusal()?.let { return@exclusive SitrResult.Err(it) }
        val sub = app.secretStore.loadSubscription()
            ?: return@exclusive SitrResult.Err("there is no subscription code on this phone")
        val now = now()
        val claims = settings().claims
        if (!Entitlement.offersReplace(claims, now)) {
            return@exclusive SitrResult.Err("renewing on this phone is not offered now")
        }
        val current = HouseholdEnd.isLapsed(claims.end, now)
        val outcome = ClaimClient(SyncHttp(), Endpoints.claim(app)).claim(sub.code, sub.claimSecret, replace = true, current = current)
        recordClaim(sub, outcome, current, now)
        FamilyPlan.claimText(outcome, ::date)?.let { SitrResult.Err(it) } ?: SitrResult.Ok(Unit)
    }

    /** "Try again": lifts the waits and stops (Entitlement.userRetry) and
     * syncs now. Gated as saveSubscriptionCode; takes the round lock, so
     * call it off the main thread. */
    fun tryAgain(): SitrResult<Unit> = SyncRun.exclusive {
        codeRefusal()?.let { return@exclusive SitrResult.Err(it) }
        app.update(kickSync = true) { it.copy(claims = Entitlement.userRetry(it.claims)) }
        SitrResult.Ok(Unit)
    }

    /** Folds a claim made from the screen into the claim state, as the
     * worker does; an Institutions answer drops the code and sets the flag. */
    private fun recordClaim(sub: Subscription, outcome: ClaimOutcome, current: Boolean, now: Double) {
        val dropped = outcome is ClaimOutcome.NotFamily
        app.update(kickSync = true) { s ->
            if (app.secretStore.loadSubscription() != sub) return@update s // changed meanwhile
            if (dropped) app.secretStore.clearSubscription()
            s.copy(
                claims = Entitlement.record(s.claims, outcome, current, now),
                planNotAccepted = s.planNotAccepted || dropped,
            )
        }
    }

    private fun codeRefusal(): String? {
        val s = settings()
        return FamilyPlan.codeRefusal(
            s.childLock,
            GateContext(app.managedPolicy().lockOptions, HouseholdRole.fromWire(s.role), s.household?.pin != null),
        )
    }

    /**
     * PBKDF2 at 600,000 iterations takes seconds on a budget phone: call
     * this (and verifyPin) off the main thread, then setPin with the result.
     */
    fun createPinRecord(newPin: String): SitrResult<PinRecord> = Pin.createRecord(newPin)

    fun setPin(record: PinRecord) = mutateHousehold { it.copy(pin = record) }

    /**
     * Call only after decide() let Gate.REFRESH_DEVICE_LIST_GATED_AS
     * through (guardian; PIN when set). The device list becomes this device
     * alone, as a normal household change (rev bumped, synced); the others
     * add themselves again as they sync. Refused before the first sync.
     */
    fun refreshDeviceList(): SitrResult<Unit> {
        val household = settings().household ?: return SitrResult.Ok(Unit)
        if (Household.isJoinPlaceholder(household)) return SitrResult.Err(WAITING_FOR_FIRST_SYNC)
        // refreshDevices bumps the revision itself, so not mutateHousehold.
        app.update(kickSync = true) { s ->
            val h = s.household ?: return@update s
            if (Household.isJoinPlaceholder(h)) s
            else s.copy(household = Household.refreshDevices(h, s.deviceId, now()))
        }
        return SitrResult.Ok(Unit)
    }

    fun setHouseholdCategoryDisabled(rulesetId: String, disabled: Boolean) {
        mutateHousehold {
            it.copy(
                disabledCategories =
                    if (disabled) (it.disabledCategories + rulesetId).distinct()
                    else it.disabledCategories - rulesetId,
            )
        }
    }

    /**
     * Refuses at the cap instead of saving a list that Household.sanitize
     * would reject wholesale on every device, this one included.
     */
    fun addHouseholdDomain(allow: Boolean, domain: String): SitrResult<Unit> {
        val list = settings().household?.let { if (allow) it.allowDomains else it.blockDomains }
            ?: return SitrResult.Ok(Unit)
        if (domain !in list && list.size >= Household.MAX_HOUSEHOLD_DOMAINS) {
            return SitrResult.Err(
                "a household list holds at most ${Household.MAX_HOUSEHOLD_DOMAINS} sites"
            )
        }
        mutateHousehold {
            if (allow) it.copy(allowDomains = (it.allowDomains + domain).distinct().sorted())
            else it.copy(blockDomains = (it.blockDomains + domain).distinct().sorted())
        }
        return SitrResult.Ok(Unit)
    }

    fun removeHouseholdDomain(allow: Boolean, domain: String) {
        mutateHousehold {
            if (allow) it.copy(allowDomains = it.allowDomains - domain)
            else it.copy(blockDomains = it.blockDomains - domain)
        }
    }

    /** Device-level lists and toggles (no household required). */
    fun setDeviceCategoryDisabled(rulesetId: String, disabled: Boolean) {
        app.update { s ->
            s.copy(
                disabledCategories =
                    if (disabled) (s.disabledCategories + rulesetId).distinct()
                    else s.disabledCategories - rulesetId,
            )
        }
    }

    fun addDeviceDomain(allow: Boolean, domain: String) {
        app.update { s ->
            if (allow) s.copy(userAllow = (s.userAllow + domain).distinct().sorted())
            else s.copy(userBlock = (s.userBlock + domain).distinct().sorted())
        }
    }

    fun removeDeviceDomain(allow: Boolean, domain: String) {
        app.update { s ->
            if (allow) s.copy(userAllow = s.userAllow - domain)
            else s.copy(userBlock = s.userBlock - domain)
        }
    }

    private fun mutateHousehold(transform: (HouseholdState) -> HouseholdState) {
        app.update(kickSync = true) { s ->
            val household = s.household ?: return@update s
            // Not before the first sync: see Household.isJoinPlaceholder.
            if (Household.isJoinPlaceholder(household)) return@update s
            s.copy(household = Household.bumpRev(transform(household), s.deviceId, now()))
        }
    }
}
