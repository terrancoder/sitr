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
import com.sitrshield.core.sync.PairingCode
import com.sitrshield.core.sync.SyncCrypto
import com.sitrshield.core.sync.SyncStatus

/**
 * Every settings mutation, gate-checked through the ported authority
 * ladder (managed > child > PIN; the PIN gates loosening actions only)
 * and applied engine-first via SitrApp.applySettings. The UI calls
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
        val secret = SyncCrypto.generateRootSecret()
        app.secretStore.save(secret)
        val s = settings()
        app.applySettings(
            s.copy(
                household = Household.emptyState(s.deviceId, now()),
                role = "guardian",
                entitlementToken = token,
                maxSeenRev = 0,
                syncStatus = SyncStatus.NEVER_SYNCED,
            ),
            kickSync = true,
        )
        return SitrResult.Ok(Unit)
    }

    fun joinHousehold(code: String, role: String): SitrResult<Unit> {
        val secret = when (val decoded = PairingCode.decode(code)) {
            is SitrResult.Err -> return decoded
            is SitrResult.Ok -> decoded.value
        }
        app.secretStore.save(secret)
        val s = settings()
        app.applySettings(
            s.copy(
                household = Household.emptyState(s.deviceId, now()),
                role = role,
                maxSeenRev = 0,
                syncStatus = SyncStatus.NEVER_SYNCED,
            ),
            kickSync = true,
        )
        return SitrResult.Ok(Unit)
    }

    /** Shown guardian-only and PIN-gated: possession IS membership. */
    fun pairingCode(): String? =
        app.secretStore.load()?.let { PairingCode.encode(it) }

    fun leaveHousehold() {
        app.secretStore.clear()
        SyncWorker.cancel(app)
        app.applySettings(
            settings().copy(
                household = null,
                role = null,
                maxSeenRev = 0,
                entitlementToken = null,
                syncStatus = SyncStatus.NEVER_SYNCED,
            )
        )
    }

    fun setPin(newPin: String): SitrResult<Unit> {
        val record = when (val created = Pin.createRecord(newPin)) {
            is SitrResult.Err -> return created
            is SitrResult.Ok -> created.value
        }
        mutateHousehold { it.copy(pin = record) }
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

    fun addHouseholdDomain(allow: Boolean, domain: String) {
        mutateHousehold {
            if (allow) it.copy(allowDomains = (it.allowDomains + domain).distinct().sorted())
            else it.copy(blockDomains = (it.blockDomains + domain).distinct().sorted())
        }
    }

    fun removeHouseholdDomain(allow: Boolean, domain: String) {
        mutateHousehold {
            if (allow) it.copy(allowDomains = it.allowDomains - domain)
            else it.copy(blockDomains = it.blockDomains - domain)
        }
    }

    /** Device-level lists and toggles (no household required). */
    fun setDeviceCategoryDisabled(rulesetId: String, disabled: Boolean) {
        val s = settings()
        app.applySettings(
            s.copy(
                disabledCategories =
                    if (disabled) (s.disabledCategories + rulesetId).distinct()
                    else s.disabledCategories - rulesetId,
            )
        )
    }

    fun addDeviceDomain(allow: Boolean, domain: String) {
        val s = settings()
        app.applySettings(
            if (allow) s.copy(userAllow = (s.userAllow + domain).distinct().sorted())
            else s.copy(userBlock = (s.userBlock + domain).distinct().sorted())
        )
    }

    fun removeDeviceDomain(allow: Boolean, domain: String) {
        val s = settings()
        app.applySettings(
            if (allow) s.copy(userAllow = s.userAllow - domain)
            else s.copy(userBlock = s.userBlock - domain)
        )
    }

    private fun mutateHousehold(transform: (HouseholdState) -> HouseholdState) {
        val s = settings()
        val household = s.household ?: return
        app.applySettings(
            s.copy(household = Household.bumpRev(transform(household), s.deviceId, now())),
            kickSync = true,
        )
    }
}
