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
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * C1: a child device leaves only with the household's guardian PIN.
 * C2: "Refresh device list", guardian-only, gated as gate.json's
 * refreshDeviceListGatedAs. C3: every other loosening on a child device
 * stays refused.
 */
class ChildLeaveAndRefreshTest {
    private fun ctx(role: HouseholdRole?, pin: Boolean, locked: Boolean = false) =
        GateContext(managedLockOptions = locked, role = role, hasPin = pin)

    private val leave = DelayAction.Kind(MutationKind.LEAVE_HOUSEHOLD)

    @Test
    fun aChildLeavesOnlyWithTheHouseholdPin() {
        assertEquals(
            MutationVerdict.Allowed(requiresPin = true),
            Gate.gateMutation(MutationKind.LEAVE_HOUSEHOLD, ctx(HouseholdRole.CHILD, pin = true)),
        )
        assertEquals(
            MutationVerdict.Refused(MutationVerdict.Reason.CHILD_DEVICE),
            Gate.gateMutation(MutationKind.LEAVE_HOUSEHOLD, ctx(HouseholdRole.CHILD, pin = false)),
        )
        assertEquals(
            "Leaving needs the guardian PIN. Ask your guardian to set one in the household.",
            Gate.CHILD_LEAVE_NEEDS_PIN,
        )
        // A managed lock still refuses first.
        assertEquals(
            MutationVerdict.Refused(MutationVerdict.Reason.MANAGED_LOCKED),
            Gate.gateMutation(MutationKind.LEAVE_HOUSEHOLD, ctx(HouseholdRole.CHILD, pin = true, locked = true)),
        )
    }

    @Test
    fun aChildsLeaveRunsGateThenWaitThenPin() {
        val child = ctx(HouseholdRole.CHILD, pin = true)
        assertEquals(MutationStep.Wait, Delay.decide(leave, child, DelayPhase.IDLE))
        assertEquals(MutationStep.Pin, Delay.decide(leave, child, DelayPhase.OPEN))
        assertEquals(MutationStep.Pin, Delay.decide(leave, child, DelayPhase.OFF))
        assertEquals(
            MutationStep.Refused(MutationVerdict.Reason.CHILD_DEVICE),
            Delay.decide(leave, ctx(HouseholdRole.CHILD, pin = false), DelayPhase.OFF),
        )
    }

    @Test
    fun aGuardianLeavesAsBefore() {
        assertEquals(MutationVerdict.Allowed(true), Gate.gateMutation(MutationKind.LEAVE_HOUSEHOLD, ctx(HouseholdRole.GUARDIAN, true)))
        assertEquals(MutationVerdict.Allowed(false), Gate.gateMutation(MutationKind.LEAVE_HOUSEHOLD, ctx(HouseholdRole.GUARDIAN, false)))
    }

    @Test
    fun everyOtherLooseningStaysRefusedOnAChild() {
        val tighten = setOf(
            MutationKind.ENABLE_CATEGORY, MutationKind.ADD_DEVICE_BLOCK_RULE,
            MutationKind.REMOVE_DEVICE_ALLOW_RULE, MutationKind.TIGHTEN_MEDIA_MODE,
            MutationKind.REMOVE_IMAGE_ALLOW_RULE,
        )
        for (kind in MutationKind.entries - MutationKind.LEAVE_HOUSEHOLD - tighten) {
            for (pin in listOf(true, false)) {
                assertEquals(
                    MutationVerdict.Refused(MutationVerdict.Reason.CHILD_DEVICE),
                    Gate.gateMutation(kind, ctx(HouseholdRole.CHILD, pin)),
                    "${kind.wire} pin=$pin",
                )
            }
        }
    }

    @Test
    fun refreshIsGatedAsTheFixtureSays() {
        val fx = JSONObject(File(FixtureTest.fixturesDir, "gate.json").readText())
        assertEquals(fx.getString("refreshDeviceListGatedAs"), Gate.REFRESH_DEVICE_LIST_GATED_AS.wire)
        val refresh = DelayAction.Kind(Gate.REFRESH_DEVICE_LIST_GATED_AS)
        assertEquals(
            MutationStep.Refused(MutationVerdict.Reason.CHILD_DEVICE),
            Delay.decide(refresh, ctx(HouseholdRole.CHILD, true), DelayPhase.OFF),
        )
        // Guardian: PIN when set, and never a wait (it loosens nothing).
        assertEquals(MutationStep.Pin, Delay.decide(refresh, ctx(HouseholdRole.GUARDIAN, true), DelayPhase.IDLE))
        assertEquals(MutationStep.Go, Delay.decide(refresh, ctx(HouseholdRole.GUARDIAN, false), DelayPhase.IDLE))
    }

    @Test
    fun refreshLeavesThisDeviceAloneAsANewRevision() {
        val s = Household.emptyState("me", 1000.0).copy(devices = listOf("a", "gone", "me"), rev = 7)
        val r = Household.refreshDevices(s, "me", 2000.0)
        assertEquals(listOf("me"), r.devices)
        assertEquals(8, r.rev)
        assertEquals("me", r.updatedBy)
        assertEquals(2000.0, r.updatedAt)
        assertEquals(s.pin, r.pin)
        assertEquals(s.allowDomains, r.allowDomains)
    }

    @Test
    fun liveDevicesEnrolAgainAfterARefresh() {
        val refreshed = Household.refreshDevices(
            Household.emptyState("me", 1000.0).copy(devices = listOf("a", "gone", "me")), "me", 2000.0,
        )
        val back = Household.enrolDevice(refreshed, "a", 3000.0).getOrNull()!!
        assertEquals(listOf("a", "me"), back.devices)
        assertEquals(refreshed.rev + 1, back.rev)
        assertNull(Household.enrolDevice(back, "a", 4000.0).getOrNull()) // already listed
        val full = refreshed.copy(devices = (1..Household.MAX_HOUSEHOLD_DEVICES).map { "d$it" })
        val err = Household.enrolDevice(full, "new", 5000.0).errorOrNull()!!
        assertTrue(err.contains("reset the device list from a guardian device"), err)
    }
}
