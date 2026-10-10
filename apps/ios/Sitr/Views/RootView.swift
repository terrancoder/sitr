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

    struct PinRequest: Identifiable {
        let id = UUID()
        let title: String
        let action: () -> Void
    }

    func attempt(_ kind: MutationKind, _ title: String, _ action: @escaping () -> Void) {
        switch model.gate(kind) {
        case .refused(let reason):
            gateMessage =
                reason == .managedLocked
                ? "Settings are locked by your organization."
                : "This is managed by your guardian."
        case .allowed(let requiresPin):
            if requiresPin {
                pinRequest = PinRequest(title: title, action: action)
            } else {
                action()
            }
        }
    }

    /// For sensitive reveals (pairing code) that aren't gate kinds.
    func requirePin(_ title: String, _ action: @escaping () -> Void) {
        if model.settings.household?.pin != nil {
            pinRequest = PinRequest(title: title, action: action)
        } else {
            action()
        }
    }

    var body: some View {
        NavigationStack {
            if model.settings.onboarded {
                HomeStatusView(attempt: attempt, requirePin: requirePin)
            } else {
                OnboardingView()
            }
        }
        .sheet(item: $pinRequest) { request in
            // Sheets are separate presentations — re-apply the user's
            // appearance choice so a forced scheme reaches them too.
            PinSheet(title: request.title) { pin in
                if await model.verifyPin(pin) {
                    PinAttemptsStore.reset()
                    pinRequest = nil
                    request.action()
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
        PinAttempts(
            count: Storage.defaults.integer(forKey: "pinAttemptCount"),
            lockedUntil: Storage.defaults.double(forKey: "pinLockedUntil")
        )
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
