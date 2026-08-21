package com.sitrshield.core.gate

/**
 * Mutation gate — the entire "who may change what, and with what
 * ceremony" policy as one pure, exhaustively testable table.
 * Port of extension/src/lib/gate.ts, pinned EXHAUSTIVELY by
 * apps/shared/fixtures/gate.json (every context × every mutation kind).
 *
 * Layers of authority, strongest first:
 *   managed lockOptions  → nothing may change on this device
 *   child role           → household-level settings are read-only
 *   guardian PIN         → sensitive loosening actions require the PIN
 */

enum class HouseholdRole(val wire: String) {
    GUARDIAN("guardian"),
    CHILD("child");

    companion object {
        fun fromWire(s: String?): HouseholdRole? = entries.firstOrNull { it.wire == s }
    }
}

enum class MutationKind(val wire: String) {
    // Loosening actions — these are what the PIN protects.
    DISABLE_CATEGORY("disableCategory"),
    REMOVE_DEVICE_BLOCK_RULE("removeDeviceBlockRule"),
    ADD_DEVICE_ALLOW_RULE("addDeviceAllowRule"),
    REMOVE_HOUSEHOLD_RULE("removeHouseholdRule"),
    LEAVE_HOUSEHOLD("leaveHousehold"),

    // Tightening or neutral actions — never PIN-gated.
    ENABLE_CATEGORY("enableCategory"),
    ADD_DEVICE_BLOCK_RULE("addDeviceBlockRule"),
    REMOVE_DEVICE_ALLOW_RULE("removeDeviceAllowRule"),
    ADD_HOUSEHOLD_RULE("addHouseholdRule"),
    CHANGE_PIN("changePin");

    companion object {
        fun fromWire(s: String?): MutationKind? = entries.firstOrNull { it.wire == s }
    }
}

data class GateContext(
    val managedLockOptions: Boolean,
    val role: HouseholdRole?,
    val hasPin: Boolean,
)

sealed class MutationVerdict {
    data class Allowed(val requiresPin: Boolean) : MutationVerdict()
    data class Refused(val reason: Reason) : MutationVerdict()

    enum class Reason(val wire: String) {
        MANAGED_LOCKED("managed-locked"),
        CHILD_DEVICE("child-device"),
    }
}

object Gate {
    private val HOUSEHOLD_ONLY = setOf(
        MutationKind.REMOVE_HOUSEHOLD_RULE,
        MutationKind.ADD_HOUSEHOLD_RULE,
        MutationKind.LEAVE_HOUSEHOLD,
        MutationKind.CHANGE_PIN,
    )

    private val LOOSENING = setOf(
        MutationKind.DISABLE_CATEGORY,
        MutationKind.REMOVE_DEVICE_BLOCK_RULE,
        MutationKind.ADD_DEVICE_ALLOW_RULE,
        MutationKind.REMOVE_HOUSEHOLD_RULE,
        MutationKind.LEAVE_HOUSEHOLD,
    )

    fun gateMutation(kind: MutationKind, ctx: GateContext): MutationVerdict {
        if (ctx.managedLockOptions) {
            return MutationVerdict.Refused(MutationVerdict.Reason.MANAGED_LOCKED)
        }
        if (ctx.role == HouseholdRole.CHILD) {
            // A child device may still tighten its own device rules;
            // everything household-level or loosening is guardian territory.
            if (kind in HOUSEHOLD_ONLY || kind in LOOSENING) {
                return MutationVerdict.Refused(MutationVerdict.Reason.CHILD_DEVICE)
            }
            return MutationVerdict.Allowed(requiresPin = false)
        }
        // Guardian (or no household at all): loosening actions need the PIN
        // when one is set. changePin always requires the current PIN if set.
        val requiresPin = ctx.hasPin && (kind in LOOSENING || kind == MutationKind.CHANGE_PIN)
        return MutationVerdict.Allowed(requiresPin)
    }
}
