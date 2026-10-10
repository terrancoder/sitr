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
            .sitrRows()

            Section("Protections") {
                blockerRow
                screenTimeRow
                LabeledContent("SafeSearch") {
                    Text("not available on iOS")
                        .foregroundStyle(Theme.inkSoft)
                }
                .foregroundStyle(Theme.ink)
            }
            .sitrRows()

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
            .foregroundStyle(Theme.ink)
            .sitrRows()
        }
        .navigationTitle("Sitr")
        .sitrScreenBackground()
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
                    .foregroundStyle(Theme.green)
                    // Stable handle for the smoke test — the assertion
                    // must not depend on user-facing wording.
                    .accessibilityIdentifier("status.active")
                Text("Filtering in Safari on this device. Nothing leaves it.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.inkSoft)
            } else {
                Label("PROTECTION INACTIVE", systemImage: "exclamationmark.shield.fill")
                    .font(.title3.bold())
                    .foregroundStyle(Theme.alert)
                    .accessibilityIdentifier("status.inactive")
                // Say which protection failed: with Safari filtering fine and
                // only Screen Time revoked, this card used to read
                // "PROTECTION INACTIVE — Safari filtering enforced".
                Text(
                    model.blockerStatus == .active
                        ? "Screen Time access was revoked. Open the Screen Time row below to restore it or stop using it."
                        : StatusModel.describe(model.blockerStatus)
                )
                .font(.subheadline)
                .foregroundStyle(Theme.ink)
                if model.blockerStatus == .stale {
                    Button("Fix — reload rules") {
                        Task { await model.mutate { _ in } }
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
                Text("enforced").foregroundStyle(Theme.green)
            case .stale:
                Text("needs reload").foregroundStyle(Theme.alert)
            case .disabled:
                Text("off — enable in Settings").foregroundStyle(Theme.alert)
            case .unknown:
                Text("unverified").foregroundStyle(Theme.alert)
            }
        }
        .foregroundStyle(Theme.ink)
    }

    @ViewBuilder private var screenTimeRow: some View {
        screenTimeRowContent.foregroundStyle(Theme.ink)
    }

    @ViewBuilder private var screenTimeRowContent: some View {
        switch model.screenTimeStatus {
        case .off:
            NavigationLink {
                ScreenTimeSetupView(attempt: attempt)
            } label: {
                LabeledContent("Screen Time filter") {
                    Text("off — optional").foregroundStyle(Theme.inkSoft)
                }
            }
        case .active(let mode):
            // A link like the other states: this row is the only way back
            // to the screen that can switch the filter off again.
            NavigationLink {
                ScreenTimeSetupView(attempt: attempt)
            } label: {
                LabeledContent("Screen Time filter") {
                    Text("enforced (\(mode))").foregroundStyle(Theme.green)
                }
            }
        case .revoked:
            NavigationLink {
                ScreenTimeSetupView(attempt: attempt)
            } label: {
                LabeledContent("Screen Time filter") {
                    Text("authorization revoked — tap to fix")
                        .foregroundStyle(Theme.alert)
                }
            }
        case .unavailable:
            LabeledContent("Screen Time filter") {
                Text("unavailable in this build").foregroundStyle(Theme.inkSoft)
            }
        }
    }
}

/// Screen Time opt-in with the two modes plainly compared — individual is
/// friction the owner can undo; child mode is the real tamper story.
struct ScreenTimeSetupView: View {
    @EnvironmentObject var model: AppModel
    let attempt: (MutationKind, String, @escaping () -> Void) -> Void
    @State private var working = false

    var body: some View {
        List {
            Section {
                Text(
                    """
                    Screen Time extends filtering beyond Safari to other \
                    browsers, using Apple's adult filter plus the first \
                    \(ScreenTimeController.domainCap) sites on your block lists. \
                    Sitr's gambling and dating lists are too large for it, so \
                    those categories are filtered in Safari only. It is \
                    optional — the Safari blocker works without it.
                    """
                )
                .foregroundStyle(Theme.ink)
            }
            .sitrRows()
            Section("Choose a mode") {
                Button("Protect this device (mine)") {
                    enable(child: false)
                }
                Text(
                    "You can revoke this yourself in Settings — it adds "
                        + "friction, not a lock.")
                    .font(.caption).foregroundStyle(Theme.inkSoft)
                Button("Protect a child's device (Family Sharing)") {
                    enable(child: true)
                }
                Text(
                    "Enabling and disabling require parent approval — the "
                        + "strongest protection iOS offers.")
                    .font(.caption).foregroundStyle(Theme.inkSoft)
            }
            .sitrRows()
            if case .active("child") = model.screenTimeStatus {
                Section {
                    Text(
                        "To turn this off, remove Sitr's Screen Time access in iOS "
                            + "Settings. On a child's device that needs the parent's approval.")
                        .font(.caption).foregroundStyle(Theme.inkSoft)
                }
                .sitrRows()
            }
            // Shown while active AND while revoked: after the user revokes
            // access in iOS Settings this is the only way to tell Sitr the
            // filter is no longer wanted — without it Home stayed red for
            // good. Switching it off loosens protection, so it takes the
            // same gate as switching a category off (refused on a child
            // device, PIN when one is set).
            if canSwitchOffHere {
                Section {
                    Button(
                        model.screenTimeStatus == .revoked
                            ? "Stop using Screen Time filtering"
                            : "Turn Screen Time filtering off",
                        role: .destructive
                    ) {
                        attempt(.disableCategory, "Turn off Screen Time filtering") {
                            ScreenTimeController.disable()
                            Task { await model.refreshStatus() }
                        }
                    }
                }
                .sitrRows()
            }
        }
        .navigationTitle("Screen Time")
        .sitrScreenBackground()
        .disabled(working)
    }

    /// Child mode is ended in iOS Settings, where it needs the parent's
    /// approval — an in-app switch would be a way around exactly that.
    /// Once access HAS been revoked there, the button below only tells
    /// Sitr to stop expecting it.
    private var canSwitchOffHere: Bool {
        switch model.screenTimeStatus {
        case .revoked: return true
        case .active(let mode): return mode != "child"
        case .off, .unavailable: return false
        }
    }

    private func enable(child: Bool) {
        working = true
        Task {
            if let error = await ScreenTimeController.enable(
                child: child, settings: model.settings)
            {
                model.lastError = error
            }
            await model.refreshStatus()
            working = false
        }
    }
}
