/// "Wait before loosening" — an optional, device-local delay in front of
/// every loosening change. Port of extension/src/lib/delay.ts, pinned by
/// apps/shared/fixtures/delay.json. Pure: no clock reads; the app supplies
/// the time and persists whatever `evaluate` hands back.
///
/// The one rule: a misbehaving clock may open the window LATE, never EARLY.

public enum DelayPhase: String {
    case off, idle, waiting, open
}

public struct DelayRequest: Equatable {
    public let at: Int64
    public init(at: Int64) { self.at = at }
}

public struct DelayEvaluation: Equatable {
    public let phase: DelayPhase
    public let remainingMs: Int64
    /// The request to persist: may be restarted (clock went back) or cleared.
    public let request: DelayRequest?
}

/// A gate kind, or the delay's one action of its own: making the delay
/// shorter (or off). Making it longer (or turning it on) is free.
public enum DelayAction: Equatable {
    case kind(MutationKind)
    case shortenDelay

    public init?(rawValue: String) {
        if rawValue == "shortenDelay" {
            self = .shortenDelay
        } else if let kind = MutationKind(rawValue: rawValue) {
            self = .kind(kind)
        } else {
            return nil
        }
    }
}

public enum MutationStep: Equatable {
    case refused(MutationVerdict.RefusalReason)
    case wait
    case pin
    case go
}

public enum Delay {
    /// Allowed delays in minutes; 0 = off.
    public static let minutesAllowed: [Int] = [0, 5, 30, 60, 360, 1440]
    /// How long changes stay open once the wait has run out.
    public static let windowMs: Int64 = 10 * 60_000
    /// The gate has no row for the delay (gate.json stays as it is), so
    /// shortening it is gated exactly like disabling a category.
    public static let shortenDelayGatedAs: MutationKind = .disableCategory
    /// Joining a household brings its settings in by sync (on iOS its
    /// category list replaces this device's), so joining waits exactly
    /// like disabling a category. The delay only: the gate never covered
    /// joining.
    public static let joinHouseholdWaitsAs: MutationKind = .disableCategory

    public static func sanitizeMinutes(_ raw: Int) -> Int {
        minutesAllowed.contains(raw) ? raw : 0
    }

    public static func evaluate(
        delayMinutes: Int, request: DelayRequest?, now: Int64
    ) -> DelayEvaluation {
        if delayMinutes <= 0 { return DelayEvaluation(phase: .off, remainingMs: 0, request: nil) }
        guard let request else { return DelayEvaluation(phase: .idle, remainingMs: 0, request: nil) }
        let delayMs = Int64(delayMinutes) * 60_000
        // Clock went backwards (reboot on a monotonic clock, wall clock set
        // back): restart the wait from now rather than guess.
        if now < request.at {
            return DelayEvaluation(phase: .waiting, remainingMs: delayMs, request: DelayRequest(at: now))
        }
        // Via elapsed, never `at + delay`: no overflow near the top of the range.
        let elapsed = now - request.at
        if elapsed < delayMs {
            return DelayEvaluation(phase: .waiting, remainingMs: delayMs - elapsed, request: request)
        }
        if elapsed - delayMs < windowMs {
            return DelayEvaluation(
                phase: .open, remainingMs: windowMs - (elapsed - delayMs), request: request)
        }
        return DelayEvaluation(phase: .idle, remainingMs: 0, request: nil)
    }

    /// True when `action` must wait for the open window before it may run.
    public static func needsWait(_ action: DelayAction, _ phase: DelayPhase) -> Bool {
        if phase == .off || phase == .open { return false }
        switch action {
        case .shortenDelay: return true
        case .kind(let kind): return Gate.loosening.contains(kind)
        }
    }

    /// Changing the setting: `.shortenDelay` when shorter or off, else free (nil).
    public static func changeAction(from: Int, to: Int) -> DelayAction? {
        to < from ? .shortenDelay : nil
    }

    /// The whole order in one place: gate first, then the delay, then the
    /// PIN. After a correct PIN the caller checks `needsWait` AGAIN — the
    /// PIN sheet can sit open past the window.
    public static func decide(
        _ action: DelayAction, ctx: GateContext, phase: DelayPhase
    ) -> MutationStep {
        let kind: MutationKind
        switch action {
        case .shortenDelay: kind = shortenDelayGatedAs
        case .kind(let k): kind = k
        }
        switch Gate.gateMutation(kind, ctx: ctx) {
        case .refused(let reason): return .refused(reason)
        case .allowed(let requiresPin):
            if needsWait(action, phase) { return .wait }
            return requiresPin ? .pin : .go
        }
    }

    /// After a correct PIN: `.wait` or `.go`. The PIN sheet can sit open
    /// past the window, so the delay is checked again at this point.
    public static func afterPin(_ action: DelayAction, phase: DelayPhase) -> MutationStep {
        needsWait(action, phase) ? .wait : .go
    }
}

// MARK: - Two clocks

/// One reading of both clocks, in milliseconds. `mono` keeps counting
/// while the device sleeps and restarts from zero at boot; `wall` is the
/// user-settable time of day.
public struct DelayClockReading: Equatable {
    public let mono: Int64
    public let wall: Int64
    public init(mono: Int64, wall: Int64) {
        self.mono = mono
        self.wall = wall
    }
}

/// A stored request: when it was made, on both clocks.
public struct DelayStamp: Equatable {
    public let atMono: Int64
    public let atWall: Int64
    public init(atMono: Int64, atWall: Int64) {
        self.atMono = atMono
        self.atWall = atWall
    }
    public init(_ now: DelayClockReading) { self.init(atMono: now.mono, atWall: now.wall) }
}

public struct DelayTwoClockEvaluation: Equatable {
    public let phase: DelayPhase
    public let remainingMs: Int64
    /// Persist whenever it differs from the stamp passed in.
    public let stamp: DelayStamp?
}

extension Delay {
    /// Evaluate on both clocks and keep the STRICTER answer:
    ///   - either clock went back → the wait restarts on both;
    ///   - either clock is past the window → closed, request cleared (it
    ///     can never open, so a countdown would be a lie);
    ///   - the two clocks' windows can never overlap → cleared, same reason;
    ///   - either clock still waiting → waiting, for the longer remainder;
    ///   - open only when both say open, for the shorter remainder.
    ///
    /// Why this holds:
    ///   - Wall clock set forward: the monotonic clock is still waiting.
    ///   - Reboot: the monotonic clock restarts at zero, so afterwards
    ///     `nowMono − atMono ≤ nowMono ≤ real time since the request` (the
    ///     boot came after the request). It can only run late — or go
    ///     "backwards" and restart the wait.
    ///   - Backup restored onto another device: that device's uptime is
    ///     unrelated, so its monotonic reading may run early — but the wall
    ///     clock still counts honestly from the request.
    ///
    /// ponytail: two faults at once open it early — a backup restored onto a
    /// device whose uptime lands in the open band AND a wall clock set
    /// forward. Upgrade path: keep the request in a this-device-only
    /// Keychain item, or stamp a boot id, so a restored request restarts.
    public static func evaluate(
        delayMinutes: Int, stamp: DelayStamp?, now: DelayClockReading
    ) -> DelayTwoClockEvaluation {
        if delayMinutes <= 0 { return DelayTwoClockEvaluation(phase: .off, remainingMs: 0, stamp: nil) }
        guard let stamp else { return DelayTwoClockEvaluation(phase: .idle, remainingMs: 0, stamp: nil) }
        let mono = evaluate(delayMinutes: delayMinutes, request: DelayRequest(at: stamp.atMono), now: now.mono)
        let wall = evaluate(delayMinutes: delayMinutes, request: DelayRequest(at: stamp.atWall), now: now.wall)
        if now.mono < stamp.atMono || now.wall < stamp.atWall {
            return DelayTwoClockEvaluation(
                phase: .waiting, remainingMs: Int64(delayMinutes) * 60_000, stamp: DelayStamp(now))
        }
        let both = [mono, wall]
        if both.contains(where: { $0.phase == .idle }) {
            return DelayTwoClockEvaluation(phase: .idle, remainingMs: 0, stamp: nil)
        }
        // Each clock's open window, in ms from now. If the two never
        // overlap (one still waits longer than the other stays open), it
        // can never open: clear rather than count down to nothing.
        let spans = both.map { e in
            e.phase == .open ? (start: Int64(0), end: e.remainingMs) : (start: e.remainingMs, end: e.remainingMs + windowMs)
        }
        if spans.map(\.start).max()! >= spans.map(\.end).min()! {
            return DelayTwoClockEvaluation(phase: .idle, remainingMs: 0, stamp: nil)
        }
        let waiting = both.filter { $0.phase == .waiting }
        if !waiting.isEmpty {
            return DelayTwoClockEvaluation(
                phase: .waiting, remainingMs: waiting.map(\.remainingMs).max()!, stamp: stamp)
        }
        return DelayTwoClockEvaluation(
            phase: .open, remainingMs: min(mono.remainingMs, wall.remainingMs), stamp: stamp)
    }
}
