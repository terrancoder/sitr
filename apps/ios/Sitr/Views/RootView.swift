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
            PinSheet(title: request.title) { pin in
                if model.verifyPin(pin) {
                    PinAttemptsStore.reset()
                    pinRequest = nil
                    request.action()
                    return nil
                }
                return "Wrong PIN."
            } onCancel: {
                pinRequest = nil
            }
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
    /// Returns nil on success, or an error message to display.
    let onSubmit: (String) -> String?
    let onCancel: () -> Void

    @State private var pin = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                SecureField("Guardian PIN", text: $pin)
                if let error {
                    Text(error).foregroundStyle(.red)
                }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Confirm") {
                        let now = Date().timeIntervalSince1970 * 1000
                        let attempts = PinAttemptsStore.load()
                        if case .failure = Pin.isLockedOut(attempts, now: now) {
                            let seconds = max(1, Int((attempts.lockedUntil - now) / 1000))
                            error = "Too many attempts — try again in \(seconds)s."
                            return
                        }
                        // Persist the failure BEFORE rendering it.
                        if let message = onSubmit(pin) {
                            PinAttemptsStore.save(
                                Pin.backoffAfterFailure(count: attempts.count, now: now))
                            error = message
                            pin = ""
                        }
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
