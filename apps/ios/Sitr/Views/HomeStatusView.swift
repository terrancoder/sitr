import SitrCore
import SwiftUI

/// The status home — green only when protection is PROVEN active; every
/// red row carries its reason and the fix. SafeSearch is listed
/// permanently as unavailable on iOS: an honest limitation, stated, not
/// hidden (threat-model T10). Sync state never appears here.
struct HomeStatusView: View {
    @EnvironmentObject var model: AppModel
    let attempt: (MutationKind, String, @escaping () -> Void) -> Void
    let requirePin: (String, @escaping () -> Void) -> Void

    var body: some View {
        List {
            Section {
                statusCard
            }

            Section("Protections") {
                blockerRow
                screenTimeRow
                LabeledContent("SafeSearch") {
                    Text("not available on iOS")
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                NavigationLink("Filter categories") {
                    CategoriesView(attempt: attempt)
                }
                NavigationLink("Allow & block lists") {
                    ListsView(attempt: attempt)
                }
                NavigationLink("Sitr Family") {
                    HouseholdView(attempt: attempt, requirePin: requirePin)
                }
                NavigationLink("About & privacy") {
                    SettingsAboutView()
                }
            }
        }
        .navigationTitle("Sitr")
        .refreshable { await model.refreshStatus() }
        .task { await model.refreshStatus() }
    }

    @ViewBuilder private var statusCard: some View {
        let summary = ProtectionSummary(
            blocker: model.blockerStatus, screenTime: model.screenTimeStatus)
        VStack(alignment: .leading, spacing: 6) {
            if summary.overallActive {
                Label("Protection active", systemImage: "checkmark.shield.fill")
                    .font(.title3.bold())
                    .foregroundStyle(.green)
                    // Stable handle for the smoke test — the assertion
                    // must not depend on user-facing wording.
                    .accessibilityIdentifier("status.active")
                Text("Filtering in Safari on this device. Nothing leaves it.")
                    .font(.subheadline)
            } else {
                Label("PROTECTION INACTIVE", systemImage: "exclamationmark.shield.fill")
                    .font(.title3.bold())
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("status.inactive")
                Text(StatusModel.describe(model.blockerStatus))
                    .font(.subheadline)
                if model.blockerStatus == .stale {
                    Button("Fix — reload rules") {
                        Task { await model.apply(model.settings) }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private var blockerRow: some View {
        LabeledContent("Safari filtering") {
            switch model.blockerStatus {
            case .active:
                Text("enforced").foregroundStyle(.green)
            case .stale:
                Text("needs reload").foregroundStyle(.red)
            case .disabled:
                Text("off — enable in Settings").foregroundStyle(.red)
            case .unknown:
                Text("unverified").foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder private var screenTimeRow: some View {
        switch model.screenTimeStatus {
        case .off:
            NavigationLink {
                ScreenTimeSetupView()
            } label: {
                LabeledContent("Screen Time filter") {
                    Text("off — optional").foregroundStyle(.secondary)
                }
            }
        case .active(let mode):
            LabeledContent("Screen Time filter") {
                Text("enforced (\(mode))").foregroundStyle(.green)
            }
        case .revoked:
            NavigationLink {
                ScreenTimeSetupView()
            } label: {
                LabeledContent("Screen Time filter") {
                    Text("authorization revoked — tap to fix")
                        .foregroundStyle(.red)
                }
            }
        case .unavailable:
            LabeledContent("Screen Time filter") {
                Text("unavailable in this build").foregroundStyle(.secondary)
            }
        }
    }
}

/// Screen Time opt-in with the two modes plainly compared — individual is
/// friction the owner can undo; child mode is the real tamper story.
struct ScreenTimeSetupView: View {
    @EnvironmentObject var model: AppModel
    @State private var working = false

    var body: some View {
        List {
            Section {
                Text(
                    """
                    Screen Time extends filtering beyond Safari to other \
                    WebKit browsers, using Apple's adult filter plus Sitr's \
                    lists. It is optional — the Safari blocker works without it.
                    """
                )
            }
            Section("Choose a mode") {
                Button("Protect this device (mine)") {
                    enable(child: false)
                }
                Text(
                    "You can revoke this yourself in Settings — it adds "
                        + "friction, not a lock.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Protect a child's device (Family Sharing)") {
                    enable(child: true)
                }
                Text(
                    "Enabling and disabling require parent approval — the "
                        + "strongest protection iOS offers.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if case .active = model.screenTimeStatus {
                Section {
                    Button("Turn Screen Time filtering off", role: .destructive) {
                        ScreenTimeController.disable()
                        Task { await model.refreshStatus() }
                    }
                }
            }
        }
        .navigationTitle("Screen Time")
        .disabled(working)
    }

    private func enable(child: Bool) {
        working = true
        Task {
            let household = model.settings.household
            if let error = await ScreenTimeController.enable(
                child: child,
                blockDomains: household?.blockDomains ?? [],
                allowDomains: household?.allowDomains ?? []
            ) {
                model.lastError = error
            }
            await model.refreshStatus()
            working = false
        }
    }
}
