package com.sitrshield.app

import com.sitrshield.app.data.Settings
import com.sitrshield.app.sync.SyncWorker
import com.sitrshield.core.SitrResult
import com.sitrshield.core.gate.Gate
import com.sitrshield.core.gate.GateContext
import com.sitrshield.core.gate.HouseholdRole
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.gate.MutationVerdict
import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.pin.Pin
import com.sitrshield.core.pin.PinRecord
import com.sitrshield.core.sync.PairingCode
import com.sitrshield.core.sync.SyncCrypto
import com.sitrshield.core.sync.SyncStatus

/**
 * Every settings mutation, gate-checked through the ported authority
 * ladder (managed > child > PIN; the PIN gates loosening actions only)
 * and applied engine-first via SitrApp.update. The UI calls
 * gate() first, collects the PIN when the verdict requires it, then
 * calls the action.
 */
class HouseholdActions(private val app: SitrApp) {
    private fun now() = System.currentTimeMillis().toDouble()

    private fun settings(): Settings = app.repository.current()

    fun gate(kind: MutationKind): MutationVerdict =
        Gate.gateMutation(
            kind,
            GateContext(
                managedLockOptions = app.managedPolicy().lockOptions,
                role = HouseholdRole.fromWire(settings().role),
                hasPin = settings().household?.pin != null,
            ),
        )

    fun verifyPin(pin: String): Boolean {
        val record = settings().household?.pin ?: return false
        return Pin.verify(pin, record)
    }

    /** Household creation — Android carries the neutral token field. */
    fun createHousehold(entitlementToken: String?): SitrResult<Unit> {
        val token = entitlementToken?.trim()?.ifEmpty { null }
        if (token != null && !token.startsWith("sitr-ent-v1.")) {
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
        val secret = when (val decoded = PairingCode.decode(code)) {
            is SitrResult.Err -> return decoded
            is SitrResult.Ok -> decoded.value
        }
        app.secretStore.save(secret)
        app.update(kickSync = true) { s ->
            s.copy(
                household = Household.emptyState(s.deviceId, now()),
                role = role,
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
        // Secret first: a sync still on the network checks for it before
        // writing, so its late result cannot bring the household back.
        app.secretStore.clear()
        SyncWorker.cancel(app)
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
            s.copy(household = Household.bumpRev(transform(household), s.deviceId, now()))
        }
    }
}
