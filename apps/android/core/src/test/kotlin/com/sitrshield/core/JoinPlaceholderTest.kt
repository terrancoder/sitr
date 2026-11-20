package com.sitrshield.core

import com.sitrshield.core.gate.Delay
import com.sitrshield.core.gate.DelayAction
import com.sitrshield.core.gate.DelayPhase
import com.sitrshield.core.gate.Gate
import com.sitrshield.core.gate.GateContext
import com.sitrshield.core.gate.HouseholdRole
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.gate.MutationStep
import com.sitrshield.core.gate.MutationVerdict
import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.pin.PinRecord
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** A device that joined but never received its household (gate.json leaveJoinPlaceholderGatedAs). */
class JoinPlaceholderTest {
    private val placeholder = Household.emptyState("me", 0.0)
    private val withPin = placeholder.copy(pin = PinRecord(600_000, "c2FsdA==", "aGFzaA=="))
    private val synced = placeholder.copy(rev = 4, updatedAt = 1_700_000_000_000.0)

    private fun leave(stored: HouseholdState?, role: HouseholdRole, phase: DelayPhase) =
        Delay.decide(
            DelayAction.Kind(Gate.leaveKind(stored)),
            GateContext(managedLockOptions = false, role = role, hasPin = stored?.pin != null),
            phase,
        )

    @Test
    fun pinlessPlaceholderLeavesFreeForGuardianAndChild() {
        for (role in HouseholdRole.entries) {
            for (phase in DelayPhase.entries) {
                assertEquals(MutationStep.Go, leave(placeholder, role, phase), "$role $phase")
            }
        }
        // A rev-1 / updatedAt-0 state that holds a PIN is not free.
        assertEquals(MutationKind.LEAVE_HOUSEHOLD, Gate.leaveKind(withPin))
        assertEquals(MutationStep.Pin, leave(withPin, HouseholdRole.CHILD, DelayPhase.OFF))
        assertEquals(MutationStep.Pin, leave(withPin, HouseholdRole.GUARDIAN, DelayPhase.OFF))
        // A synced child device without a household PIN still cannot leave.
        assertEquals(
            MutationStep.Refused(MutationVerdict.Reason.CHILD_DEVICE),
            leave(synced, HouseholdRole.CHILD, DelayPhase.OFF),
        )
    }

    @Test
    fun placeholderLeaveRefusedWhenTheHouseholdArrivedMeanwhile() {
        assertNull(Household.leaveRefusal(asJoinPlaceholder = true, stored = placeholder))
        assertEquals(Household.HOUSEHOLD_ARRIVED, Household.leaveRefusal(asJoinPlaceholder = true, stored = synced))
        assertEquals(Household.HOUSEHOLD_ARRIVED, Household.leaveRefusal(asJoinPlaceholder = true, stored = withPin))
        // A leave that went through the full gate is not re-checked.
        assertNull(Household.leaveRefusal(asJoinPlaceholder = false, stored = synced))
    }

    @Test
    fun joinAndCreateRefusedWhileAHouseholdIsStored() {
        // HouseholdActions.joinHousehold and createHousehold both ask this.
        assertNull(Household.joinRefusal(null))
        assertEquals(Household.ALREADY_IN_HOUSEHOLD, Household.joinRefusal(placeholder))
        assertEquals(Household.ALREADY_IN_HOUSEHOLD, Household.joinRefusal(synced))
    }
}
