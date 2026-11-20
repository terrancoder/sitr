package com.sitrshield.core.gate

import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState

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
    LOOSEN_MEDIA_MODE("loosenMediaMode"),
    ADD_IMAGE_ALLOW_RULE("addImageAllowRule"),

    // Tightening or neutral actions — never PIN-gated.
    ENABLE_CATEGORY("enableCategory"),
    ADD_DEVICE_BLOCK_RULE("addDeviceBlockRule"),
    REMOVE_DEVICE_ALLOW_RULE("removeDeviceAllowRule"),
    ADD_HOUSEHOLD_RULE("addHouseholdRule"),
    CHANGE_PIN("changePin"),
    TIGHTEN_MEDIA_MODE("tightenMediaMode"),
    REMOVE_IMAGE_ALLOW_RULE("removeImageAllowRule");

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
    /**
     * "Refresh device list" has no row of its own (gate.json
     * "refreshDeviceListGatedAs"): gated exactly like changing the PIN —
     * refused on a managed lock or a child device, PIN when one is set, no
     * wait (it loosens nothing).
     */
    val REFRESH_DEVICE_LIST_GATED_AS = MutationKind.CHANGE_PIN

    /**
     * Leaving a household this device never received (gate.json
     * "leaveJoinPlaceholderGatedAs"): the STORED state is a join
     * placeholder with no PIN in it. Gated exactly like enabling a
     * category — refused on a managed lock, otherwise allowed for any
     * role, no PIN, no wait. A synced household's leave stays LEAVE_HOUSEHOLD.
     */
    val LEAVE_JOIN_PLACEHOLDER_GATED_AS = MutationKind.ENABLE_CATEGORY

    /** The kind "Leave household" is gated as, from the state read from storage now. */
    fun leaveKind(stored: HouseholdState?): MutationKind =
        if (Household.isPinlessPlaceholder(stored)) LEAVE_JOIN_PLACEHOLDER_GATED_AS
        else MutationKind.LEAVE_HOUSEHOLD

    /** A child device's leave refused for want of a household PIN (gate.json note). */
    const val CHILD_LEAVE_NEEDS_PIN =
        "Leaving needs the guardian PIN. Ask your guardian to set one in the household."

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
        // Media filter (T12) — browser-extension feature today; the kinds
        // exist here so the exhaustive gate fixture stays cross-platform.
        MutationKind.LOOSEN_MEDIA_MODE,
        MutationKind.ADD_IMAGE_ALLOW_RULE,
    )

    fun gateMutation(kind: MutationKind, ctx: GateContext): MutationVerdict {
        if (ctx.managedLockOptions) {
            return MutationVerdict.Refused(MutationVerdict.Reason.MANAGED_LOCKED)
        }
        if (ctx.role == HouseholdRole.CHILD) {
            // A child device leaves only with the household's guardian PIN;
            // with no PIN set it cannot leave (no other proof is accepted).
            if (kind == MutationKind.LEAVE_HOUSEHOLD) {
                return if (ctx.hasPin) MutationVerdict.Allowed(requiresPin = true)
                else MutationVerdict.Refused(MutationVerdict.Reason.CHILD_DEVICE)
            }
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
