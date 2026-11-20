package com.sitrshield.app

import android.os.SystemClock
import com.sitrshield.app.data.Settings
import com.sitrshield.app.sync.SyncHttp
import com.sitrshield.app.sync.SyncWorker
import com.sitrshield.core.SitrResult
import com.sitrshield.core.gate.Delay
import com.sitrshield.core.gate.DelayAction
import com.sitrshield.core.gate.DelayClockReading
import com.sitrshield.core.gate.DelayPhase
import com.sitrshield.core.gate.DelayStamp
import com.sitrshield.core.gate.GateContext
import com.sitrshield.core.gate.HouseholdRole
import com.sitrshield.core.gate.MutationStep
import com.sitrshield.core.gate.Pause
import com.sitrshield.core.gate.PauseRecord
import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.pin.Pin
import com.sitrshield.core.pin.PinRecord
import com.sitrshield.core.sync.PairingCode
import com.sitrshield.core.sync.SyncClient
import com.sitrshield.core.sync.SyncCrypto
import com.sitrshield.core.sync.SyncInput
import com.sitrshield.core.sync.SyncStatus
import com.sitrshield.engine.EngineController
import com.sitrshield.engine.SitrVpnService
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
        const val WAITING_FOR_FIRST_SYNC =
            "Waiting for the first sync with your household. Connect to the " +
                "internet and tap Sync now. The household's PIN and lists " +
                "appear here after that."
    }

    private fun now() = System.currentTimeMillis().toDouble()

    private fun settings(): Settings = app.repository.current()

    /** Gate first, then "wait before loosening", then the PIN. */
    fun decide(action: DelayAction, phase: DelayPhase): MutationStep =
        Delay.decide(
            action,
            GateContext(
                managedLockOptions = app.managedPolicy().lockOptions,
                role = HouseholdRole.fromWire(settings().role),
                hasPin = settings().household?.pin != null,
            ),
            phase,
        )

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

    /** Household creation — Android carries the neutral token field. */
    fun createHousehold(entitlementToken: String?): SitrResult<Unit> {
        // A locked phone must not get a new household, and with it a new PIN.
        if (settings().childLock) return SitrResult.Err(LOCKED)
        val token = entitlementToken?.trim()?.ifEmpty { null }
        // The token goes out as an HTTP header: nothing but its own alphabet.
        if (token != null && !Regex("sitr-ent-v1\\.[A-Za-z0-9._-]+").matches(token)) {
            return SitrResult.Err("that doesn't look like a Sitr Family token")
        }
        app.secretStore.save(SyncCrypto.generateRootSecret())
        app.update(kickSync = true) { s ->
            s.copy(
                household = Household.emptyState(s.deviceId, now()),
                role = "guardian",
                entitlementToken = token,
                maxSeenRev = 0,
                syncStatus = SyncStatus.NEVER_SYNCED,
            )
        }
        return SitrResult.Ok(Unit)
    }

    fun joinHousehold(code: String, role: String): SitrResult<Unit> {
        if (settings().childLock) return SitrResult.Err(LOCKED)
        val secret = when (val decoded = PairingCode.decode(code)) {
            is SitrResult.Err -> return decoded
            is SitrResult.Ok -> decoded.value
        }
        app.secretStore.save(secret)
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

    fun leaveHousehold() {
        val before = settings()
        // Leaving takes the PIN with it; the lock would have no key left.
        if (before.childLock) return
        val secret = app.secretStore.load()
        // Secret first: a sync still on the network checks for it before
        // writing, so its late result cannot bring the household back.
        app.secretStore.clear()
        SyncWorker.cancel(app)
        // Free this device's fair-use place, off the main thread, with the
        // secret held only in memory. Offline, the place stays taken.
        val household = before.household
        if (secret != null && household != null) {
            thread(name = "sitr-unenroll") {
                SyncClient(SyncHttp(), ::now).unenroll(
                    SyncInput(secret, household, before.maxSeenRev, before.deviceId, before.entitlementToken)
                )
            }
        }
        app.update {
            it.copy(
                household = null,
                role = null,
                maxSeenRev = 0,
                entitlementToken = null,
                syncStatus = SyncStatus.NEVER_SYNCED,
            )
        }
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
