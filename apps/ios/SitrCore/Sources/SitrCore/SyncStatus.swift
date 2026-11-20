/// Sync status — settings-screen visibility ONLY.
/// Port of extension/src/lib/sync/status.ts.
///
/// INVARIANT: sync state never touches protection status. Filtering is
/// local; a broken sync leaves protection fully intact, so it must not
/// paint anything red. It IS surfaced here, never swallowed.
import Foundation

public struct SyncStatus: Equatable {
    public enum State: String {
        case never
        case ok
        case error
        case offline
        /// A device that joined found no household for its code.
        case notFound = "not-found"
    }

    public static let noHouseholdForCode =
        "No household found for this code yet. Check the code with the person who created the household. If the code is right, sync that device first; otherwise leave and join again."

    public let state: State
    public let lastSuccessAt: Double?
    public let error: String?

    public init(state: State, lastSuccessAt: Double? = nil, error: String? = nil) {
        self.state = state
        self.lastSuccessAt = lastSuccessAt
        self.error = error
    }

    public static let neverSynced = SyncStatus(state: .never)

    public var describe: String {
        switch state {
        case .never:
            return "Sync: not yet synced on this device."
        case .ok:
            if let at = lastSuccessAt {
                let date = Date(timeIntervalSince1970: at / 1000)
                let formatted = date.formatted(date: .abbreviated, time: .shortened)
                return "Sync: up to date (last synced \(formatted))."
            }
            return "Sync: up to date."
        case .offline:
            return "Sync: offline — filtering still fully active on this device."
        case .notFound:
            return Self.noHouseholdForCode
        case .error:
            return "Sync: failed (\(error ?? "unknown error")) — filtering still fully active on this device."
        }
    }
}
