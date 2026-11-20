import SitrCore
import SwiftUI

/// Navigation shell + the shared ceremony machinery: every mutating tap
/// goes through `attempt`, which consults the gate and collects the PIN
/// when the verdict requires it. The PIN sheet persists the attempt
/// counter BEFORE showing failure (pin.ts parity).
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @State private var pinRequest: PinRequest?
    @State private var gateMessage: String?
    @State private var hold: AppModel.DelayState?
    /// A hold found after the PIN: shown once the sheet has gone, or the
    /// alert is dropped mid-dismissal.
    @State private var holdAfterSheet: AppModel.DelayState?

    struct PinRequest: Identifiable {
        let id = UUID()
        let title: String
        let kind: DelayAction
        let action: () -> Void
    }

    func attempt(_ kind: MutationKind, _ title: String, _ action: @escaping () -> Void) {
        attemptAction(.kind(kind), title, action)
    }

    /// Gate, then "wait before loosening", then the PIN (Delay.decide).
    func attemptAction(_ kind: DelayAction, _ title: String, _ action: @escaping () -> Void) {
        let delay = model.delayState()
        switch model.decide(kind, phase: delay.phase) {
        case .refused(let reason):
            switch reason {
            case .managedLocked: gateMessage = "Settings are locked by your organization."
            case .childDevice where kind == .kind(.leaveHousehold):
                // Only when the household has no PIN: with one, the gate asks for it.
                gateMessage = "Leaving needs the guardian PIN. Ask your guardian to set one in the household."
            case .childDevice: gateMessage = "This is managed by your guardian."
            }
        case .wait:
            showHold(delay)
        case .pin:
            pinRequest = PinRequest(title: title, kind: kind, action: action)
        case .go:
            action()
        }
    }

    /// The change does not happen. Re-render so a switch that was flipped
    /// snaps back to the stored value, and offer the next move.
    private func showHold(_ delay: AppModel.DelayState) {
        model.objectWillChange.send()
        hold = delay
    }

    /// Joining a household: the delay alone, as `Delay.joinHouseholdWaitsAs`.
    /// No gate and no PIN — neither ever applied to joining.
    func attemptJoin(_ action: @escaping () -> Void) {
        let delay = model.delayState()
        if Delay.needsWait(.kind(Delay.joinHouseholdWaitsAs), delay.phase) {
            showHold(delay)
        } else {
            action()
        }
    }

    /// For sensitive reveals (pairing code) that aren't gate kinds.
    func requirePin(_ title: String, _ action: @escaping () -> Void) {
        if model.settings.household?.pin != nil {
            // Not a gate kind and not loosening: no delay.
            pinRequest = PinRequest(title: title, kind: .kind(.changePin), action: action)
        } else {
            action()
        }
    }

    var body: some View {
        NavigationStack {
            if model.settings.onboarded {
                HomeStatusView(
                    attempt: attempt, attemptAction: attemptAction, attemptJoin: attemptJoin,
                    requirePin: requirePin)
            } else {
                OnboardingView()
            }
        }
        .sheet(
            item: $pinRequest,
            onDismiss: {
                hold = holdAfterSheet
                holdAfterSheet = nil
            }
        ) { request in
            // Sheets are separate presentations — re-apply the user's
            // appearance choice so a forced scheme reaches them too.
            PinSheet(title: request.title) { pin in
                if await model.verifyPin(pin) {
                    PinAttemptsStore.reset()
                    pinRequest = nil
                    // The sheet can sit open past the window: check again.
                    let after = model.delayState()
                    if Delay.afterPin(request.kind, phase: after.phase) == .wait {
                        model.objectWillChange.send()
                        holdAfterSheet = after
                    } else {
                        request.action()
                    }
                    return nil
                }
                return "Wrong PIN."
            } onCancel: {
                pinRequest = nil
            }
            .sitrAppearance()
            .tint(Theme.green)
        }
        .alert(
            "Not allowed", isPresented: .init(
                get: { gateMessage != nil },
                set: { if !$0 { gateMessage = nil } })
        ) {
            Button("OK") { gateMessage = nil }
        } message: {
            Text(gateMessage ?? "")
        }
        .alert(
            "Wait before loosening", isPresented: .init(
                get: { hold != nil },
                set: { if !$0 { hold = nil } }),
            presenting: hold
        ) { held in
            if held.phase == .idle {
                Button("Start the wait") { model.startDelayRequest() }
                Button("Cancel", role: .cancel) {}
            } else {
                // Close only: cancelling a running request lives in the
                // wait's settings, never one habitual tap away here.
                Button("Close", role: .cancel) {}
            }
        } message: { held in
            Text(DelayText.hold(held))
        }
        .alert(
            "Something went wrong", isPresented: .init(
                get: { model.lastError != nil },
                set: { if !$0 { model.lastError = nil } })
        ) {
            Button("OK") { model.lastError = nil }
        } message: {
            Text(model.lastError ?? "")
        }
    }
}

/// Lockout persisted before failure is shown — an app kill cannot reset it.
enum PinAttemptsStore {
    static func load() -> PinAttempts {
        let stored = PinAttempts(
            count: Storage.defaults.integer(forKey: "pinAttemptCount"),
            lockedUntil: Storage.defaults.double(forKey: "pinLockedUntil")
        )
        // A deadline set while the clock was moved ahead: stored clamped,
        // or the next load would clamp it to a fresh wait again.
        let clamped = Pin.clamp(stored, now: Date().timeIntervalSince1970 * 1000)
        if clamped != stored { save(clamped) }
        return clamped
    }

    static func save(_ attempts: PinAttempts) {
        Storage.defaults.set(attempts.count, forKey: "pinAttemptCount")
        Storage.defaults.set(attempts.lockedUntil, forKey: "pinLockedUntil")
    }

    static func reset() { save(Pin.noAttempts) }
}

struct PinSheet: View {
    let title: String
    /// Returns nil on success, or an error message to display. Async: the
    /// check is a 600,000-iteration hash and runs off the main actor.
    let onSubmit: (String) async -> String?
    let onCancel: () -> Void

    @State private var pin = ""
    @State private var error: String?
    @State private var checking = false

    var body: some View {
        NavigationStack {
            Form {
                SecureField("Guardian PIN", text: $pin)
                    .foregroundStyle(Theme.ink)
                    .sitrRows()
                if let error {
                    Text(error).foregroundStyle(Theme.alert)
                        .sitrRows()
                }
            }
            .sitrScreenBackground()
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(checking ? "Checking…" : "Confirm") {
                        let now = Date().timeIntervalSince1970 * 1000
                        let attempts = PinAttemptsStore.load()
                        if case .failure = Pin.isLockedOut(attempts, now: now) {
                            let seconds = max(1, Int((attempts.lockedUntil - now) / 1000))
                            error = "Too many attempts — try again in \(seconds)s."
                            return
                        }
                        // Count the attempt as failed BEFORE the slow check
                        // starts; success resets the counter. Dismissing
                        // the sheet mid-check must not become a way to
                        // guess without being counted.
                        PinAttemptsStore.save(
                            Pin.backoffAfterFailure(count: attempts.count, now: now))
                        let entered = pin
                        checking = true
                        error = nil
                        Task {
                            let message = await onSubmit(entered)
                            checking = false
                            if let message {
                                error = message
                                pin = ""
                            }
                        }
                    }
                    .disabled(checking)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
