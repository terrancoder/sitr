/// Mutation gate — the entire "who may change what, and with what
/// ceremony" policy as one pure, exhaustively testable table.
/// Port of extension/src/lib/gate.ts, pinned EXHAUSTIVELY by
/// apps/shared/fixtures/gate.json (every context × every mutation kind).
///
/// Layers of authority, strongest first:
///   managed lockOptions  → nothing may change on this device
///   child role           → household-level settings are read-only
///   guardian PIN         → sensitive loosening actions require the PIN

public enum HouseholdRole: String {
    case guardian
    case child
}

public enum MutationKind: String, CaseIterable {
    // Loosening actions — these are what the PIN protects.
    case disableCategory
    case removeDeviceBlockRule
    case addDeviceAllowRule
    case removeHouseholdRule
    case leaveHousehold
    // Tightening or neutral actions — never PIN-gated.
    case enableCategory
    case addDeviceBlockRule
    case removeDeviceAllowRule
    case addHouseholdRule
    case changePin
}

public struct GateContext {
    public let managedLockOptions: Bool
    public let role: HouseholdRole?
    public let hasPin: Bool

    public init(managedLockOptions: Bool, role: HouseholdRole?, hasPin: Bool) {
        self.managedLockOptions = managedLockOptions
        self.role = role
        self.hasPin = hasPin
    }
}

public enum MutationVerdict: Equatable {
    case allowed(requiresPin: Bool)
    case refused(reason: RefusalReason)

    public enum RefusalReason: String {
        case managedLocked = "managed-locked"
        case childDevice = "child-device"
    }
}

public enum Gate {
    static let householdOnly: Set<MutationKind> = [
        .removeHouseholdRule,
        .addHouseholdRule,
        .leaveHousehold,
        .changePin,
    ]

    static let loosening: Set<MutationKind> = [
        .disableCategory,
        .removeDeviceBlockRule,
        .addDeviceAllowRule,
        .removeHouseholdRule,
        .leaveHousehold,
    ]

    public static func gateMutation(_ kind: MutationKind, ctx: GateContext) -> MutationVerdict {
        if ctx.managedLockOptions {
            return .refused(reason: .managedLocked)
        }
        if ctx.role == .child {
            // A child device may still tighten its own device rules;
            // everything household-level or loosening is guardian territory.
            if householdOnly.contains(kind) || loosening.contains(kind) {
                return .refused(reason: .childDevice)
            }
            return .allowed(requiresPin: false)
        }
        // Guardian (or no household at all): loosening actions need the PIN
        // when one is set. changePin always requires the current PIN if set.
        let requiresPin = ctx.hasPin && (loosening.contains(kind) || kind == .changePin)
        return .allowed(requiresPin: requiresPin)
    }
}
