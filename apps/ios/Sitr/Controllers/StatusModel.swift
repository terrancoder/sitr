import Foundation
import SafariServices

/// Fail-visible protection status — the iOS twin of the extension's
/// badge derivation (status.ts semantics): derived from PROVEN facts,
/// never assumed; any uncertainty is red. Sync state is structurally
/// excluded — this type has no sync inputs.
enum BlockerStatus: Equatable {
    case active
    /// Enabled in Safari but the applied rules don't match the current
    /// settings — "needs reload", with a retry affordance.
    case stale
    case disabled
    /// The API errored — never optimistic.
    case unknown(String)
}

enum ScreenTimeStatus: Equatable {
    /// Never enabled by the user — a protection they didn't ask for
    /// isn't a failure (grey, not red).
    case off
    case active(mode: String)
    /// Was enabled, authorization since revoked — red, tap to fix.
    case revoked
    case unavailable
}

struct ProtectionSummary: Equatable {
    let blocker: BlockerStatus
    let screenTime: ScreenTimeStatus

    /// Green only when the user-required protections are proven.
    var overallActive: Bool {
        if blocker != .active { return false }
        if case .revoked = screenTime { return false }
        return true
    }
}

enum StatusModel {
    /// Safari's state query is completion-handler based; wrap it once
    /// here. A nil state is "we cannot verify" — surfaced as red, never
    /// optimistically treated as enabled.
    private static func isBlockerEnabled() async -> Bool? {
        await withCheckedContinuation { continuation in
            SFContentBlockerManager.getStateOfContentBlocker(
                withIdentifier: BlockerController.blockerIdentifier
            ) { state, _ in
                continuation.resume(returning: state?.isEnabled)
            }
        }
    }

    /// Query Safari for the blocker's enablement + compare the persisted
    /// applied checksum against what current settings should produce.
    static func blockerStatus(settings: AppSettings) async -> BlockerStatus {
        guard let enabled = await isBlockerEnabled() else {
            return .unknown("Safari did not report the blocker's state")
        }
        guard enabled else { return .disabled }

        let household = settings.household
        let expected = BlockerController.expectedChecksum(
            disabledCategories: household?.disabledCategories
                ?? settings.disabledCategories,
            userAllow: settings.userAllow,
            userBlock: settings.userBlock,
            householdAllow: household?.allowDomains ?? [],
            householdBlock: household?.blockDomains ?? []
        )
        guard let expected else { return .unknown("rulesets failed verification") }
        return settings.appliedRulesChecksum == expected ? .active : .stale
    }

    static func describe(_ status: BlockerStatus) -> String {
        switch status {
        case .active:
            return "Safari filtering enforced"
        case .stale:
            return "Safari filtering needs a reload — tap Fix"
        case .disabled:
            return "Blocker is off. Enable it: Settings → Apps → Safari → "
                + "Extensions → Sitr Blocker"
        case .unknown(let reason):
            return "Cannot verify Safari filtering (\(reason))"
        }
    }
}
