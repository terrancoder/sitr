/// C1: a child device may leave with the guardian's PIN, and only with it.
/// C2: "Refresh device list" for guardians: this device alone, a new
/// revision. C3: nothing else changes for a child. gate.json carries C1 in
/// its exhaustive table (FixtureTests) and C2 as `refreshDeviceListGatedAs`
/// (checked here).
import Foundation
import Testing

@testable import SitrCore

@Suite struct HouseholdLeaveRefreshTests {
    func ctx(_ role: HouseholdRole?, pin: Bool, locked: Bool = false) -> GateContext {
        GateContext(managedLockOptions: locked, role: role, hasPin: pin)
    }

    @Test func childLeavesOnlyWithThePin() {
        #expect(Gate.gateMutation(.leaveHousehold, ctx: ctx(.child, pin: true)) == .allowed(requiresPin: true))
        // No household PIN: refused as child-device (the UI words it as
        // "Leaving needs the guardian PIN…").
        #expect(Gate.gateMutation(.leaveHousehold, ctx: ctx(.child, pin: false)) == .refused(reason: .childDevice))
        // Managed lock still wins over everything.
        #expect(Gate.gateMutation(.leaveHousehold, ctx: ctx(.child, pin: true, locked: true)) == .refused(reason: .managedLocked))
    }

    @Test func guardianLeavesAsToday() {
        #expect(Gate.gateMutation(.leaveHousehold, ctx: ctx(.guardian, pin: true)) == .allowed(requiresPin: true))
        #expect(Gate.gateMutation(.leaveHousehold, ctx: ctx(.guardian, pin: false)) == .allowed(requiresPin: false))
    }

    @Test func childLeaveGoesThroughTheWaitThenThePin() {
        let child = ctx(.child, pin: true)
        #expect(Delay.decide(.kind(.leaveHousehold), ctx: child, phase: .idle) == .wait, "leaving is loosening")
        #expect(Delay.decide(.kind(.leaveHousehold), ctx: child, phase: .open) == .pin)
        #expect(Delay.decide(.kind(.leaveHousehold), ctx: child, phase: .off) == .pin)
        #expect(Delay.decide(.kind(.leaveHousehold), ctx: ctx(.child, pin: false), phase: .off) == .refused(.childDevice))
    }

    @Test func refreshIsGatedAsTheFixtureSays() throws {
        let fx = try fixture("gate.json")
        #expect(fx["refreshDeviceListGatedAs"] as? String == Gate.refreshDeviceListGatedAs.rawValue)
        let k = Gate.refreshDeviceListGatedAs
        #expect(Gate.gateMutation(k, ctx: ctx(.guardian, pin: true)) == .allowed(requiresPin: true))
        #expect(Gate.gateMutation(k, ctx: ctx(.guardian, pin: false)) == .allowed(requiresPin: false))
        #expect(Gate.gateMutation(k, ctx: ctx(.child, pin: true)) == .refused(reason: .childDevice))
        #expect(Gate.gateMutation(k, ctx: ctx(.child, pin: false)) == .refused(reason: .childDevice))
        // Loosens nothing: no "wait before loosening".
        #expect(Delay.decide(.kind(k), ctx: ctx(.guardian, pin: true), phase: .idle) == .pin)
    }

    @Test func everyOtherChildLooseningStaysRefused() {
        for kind in MutationKind.allCases where kind != .leaveHousehold {
            let v = Gate.gateMutation(kind, ctx: ctx(.child, pin: true))
            if Gate.householdOnly.contains(kind) || Gate.loosening.contains(kind) {
                #expect(v == .refused(reason: .childDevice), "\(kind)")
            } else {
                #expect(v == .allowed(requiresPin: false), "\(kind)")
            }
        }
    }

    @Test func refreshKeepsOnlyThisDeviceAsANewRevision() {
        var s = HouseholdState(rev: 7, updatedAt: 1000, updatedBy: "other")
        s.devices = ["a", "gone-1", "gone-2", "me"]
        s.blockDomains = ["kept.example"]
        let next = Household.withOnlyThisDevice(s, deviceId: "me", now: 5000)
        #expect(next.devices == ["me"])
        #expect(next.rev == 8 && next.updatedAt == 5000 && next.updatedBy == "me")
        #expect(next.blockDomains == ["kept.example"], "nothing else changes")
        // It wins the merge on every device (newer rev), so each one finds
        // itself missing and re-enrols (SyncScheduler.syncNow).
        #expect(Household.merge(s, next) == next)
    }
}
