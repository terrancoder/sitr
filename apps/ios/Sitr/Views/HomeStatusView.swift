import SitrCore
import SwiftUI

/// The status home — green only when protection is PROVEN active; every
/// red row carries its reason and the fix. SafeSearch is enforced only
/// through the opt-in DNS filter; without it the row says it is not
/// available, stated, not hidden (threat-model T10). Sync state never
/// appears here.
struct HomeStatusView: View {
    @EnvironmentObject var model: AppModel
    let attempt: (MutationKind, String, @escaping () -> Void) -> Void
    let attemptAction: (DelayAction, String, @escaping () -> Void) -> Void
    let attemptJoin: (@escaping () -> Void) -> Void
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
                #if SITR_DNS_FILTER
                if model.dnsFilterStatus != .unavailable {
                    NavigationLink {
                        DnsFilterView(attempt: attempt)
                    } label: {
                        let value = DnsFilterText.rowValue(model.dnsFilterStatus)
                        LabeledContent("DNS filter") {
                            Text(value.text).foregroundStyle(value.color)
                        }
                    }
                    .foregroundStyle(Theme.ink)
                    .accessibilityIdentifier("home.dnsFilter")
                }
                #endif
                safeSearchRow
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
                    HouseholdView(attempt: attempt, attemptJoin: attemptJoin, requirePin: requirePin)
                }
                NavigationLink("Wait before loosening") {
                    DelaySettingsView(attemptAction: attemptAction)
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
        .onReceive(NotificationCenter.default.publisher(for: DnsFilterController.statusDidChange)) { note in
            guard DnsFilterController.isOurStatusChange(note) else { return }
            Task { await model.refreshDnsFilter() }
        }
        // iOS posts nothing while a start hangs: look again after the limit.
        .task(id: model.dnsFilterStatus) {
            guard model.dnsFilterStatus == .starting else { return }
            try? await Task.sleep(nanoseconds: UInt64((DnsFilterController.startingLimit + 1) * 1_000_000_000))
            await model.refreshDnsFilter()
        }
    }

    static func activeLine(household: Bool, dnsFilterOn: Bool) -> String {
        switch (household, dnsFilterOn) {
        case (false, false): return "Filtering in Safari on this device. Nothing leaves it."
        case (true, false): return "Filtering in Safari on this device. Your household's settings sync in encrypted form; your browsing never leaves the device."
        case (false, true): return "Filtering in Safari and, through the DNS filter, in other apps on this device. Nothing is sent to Sitr; lookups go, unencrypted, to your network's own DNS."
        case (true, true): return "Filtering in Safari and, through the DNS filter, in other apps on this device. Your household's settings sync in encrypted form; lookups go, unencrypted, to your network's own DNS, never to Sitr."
        }
    }

    /// Enforced only by the DNS filter (safesearch-hosts.json).
    @ViewBuilder private var safeSearchRow: some View {
        let s = model.dnsFilterStatus
        LabeledContent("SafeSearch") {
            switch s {
            case .unavailable:
                Text("not available on iOS").foregroundStyle(Theme.inkSoft)
            case .off:
                Text("not available on iOS without the DNS filter").foregroundStyle(Theme.inkSoft)
            case .starting:
                Text("starting with the DNS filter").foregroundStyle(Theme.inkSoft)
            case .on, .noResolver:
                Text("enforced by the DNS filter").foregroundStyle(Theme.green)
            case .switchedOff, .removed, .otherVPN, .stopped:
                Text("not enforced — the DNS filter is off").foregroundStyle(Theme.alert)
            }
        }
        .foregroundStyle(Theme.ink)
    }

    @ViewBuilder private var statusCard: some View {
        let summary = ProtectionSummary(
            blocker: model.blockerStatus, screenTime: model.screenTimeStatus,
            dnsFilter: model.dnsFilterStatus, safariUpdating: model.safariUpdating)
        // Wanted, not merely running: the card is green only once it is
        // proven on (or fails closed), so this never claims Safari-only
        // while the filter forwards lookups.
        let dnsOn = model.dnsFilterStatus.isWanted
        VStack(alignment: .leading, spacing: 6) {
            switch summary.card {
            case .active:
                Label("Protection active", systemImage: "checkmark.shield.fill")
                    .font(.title3.bold())
                    .foregroundStyle(Theme.green)
                    // Stable handle for the smoke test — the assertion
                    // must not depend on user-facing wording.
                    .accessibilityIdentifier("status.active")
                // In a household the encrypted household blob is synced
                // (docs/data-flow.md), so "nothing leaves" would be false.
                // With the DNS filter on, allowed lookups still go to the
                // network's DNS in the clear, so say where they go and what Sitr sends.
                Text(Self.activeLine(household: model.settings.household != nil, dnsFilterOn: dnsOn))
                    .font(.subheadline)
                    .foregroundStyle(Theme.inkSoft)
            case .noResolver:
                Label("Sites can't load on this network", systemImage: "exclamationmark.shield")
                    .font(.title3.bold())
                    .foregroundStyle(Theme.gold)
                    .accessibilityIdentifier("status.noResolver")
                Text("The DNS filter is on but could not read this network's DNS server, so it blocks lookups rather than let them through unfiltered. It tries again when the network changes. To use this network without it, open the DNS filter row below and turn the filter off.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink)
            case .dnsStarting:
                Label("DNS filter starting…", systemImage: "shield")
                    .font(.title3.bold())
                    .foregroundStyle(Theme.inkSoft)
                    .accessibilityIdentifier("status.starting")
                Text("Safari filtering is on. The DNS filter is starting; this turns green once iOS reports it running.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.inkSoft)
            case .safariUpdating:
                // Saved already; Safari is compiling. Not green (not yet
                // proven), not red (nothing failed).
                Label("Updating Safari rules…", systemImage: "arrow.triangle.2.circlepath")
                    .font(.title3.bold())
                    .foregroundStyle(Theme.inkSoft)
                    .accessibilityIdentifier("status.updating")
                Text(SafariUpdatingText.line(dnsFilterOn: model.dnsFilterStatus == .on))
                    .font(.subheadline)
                    .foregroundStyle(Theme.inkSoft)
            case .failing:
                Label("PROTECTION INACTIVE", systemImage: "exclamationmark.shield.fill")
                    .font(.title3.bold())
                    .foregroundStyle(Theme.alert)
                    .accessibilityIdentifier("status.inactive")
                // Say which protection failed: with Safari filtering fine and
                // only Screen Time revoked, this card used to read
                // "PROTECTION INACTIVE — Safari filtering enforced". A Safari
                // update in progress shows on the Safari row, not here.
                Text(
                    summary.blockerOK
                        ? (model.dnsFilterStatus.isFailing
                            ? "The DNS filter is not running: \(DnsFilterText.cardReason(model.dnsFilterStatus)). Open the DNS filter row below to turn it back on or stop using it."
                            : "Screen Time access was revoked. Open the Screen Time row below to restore it or stop using it.")
                        : StatusModel.describe(model.blockerStatus)
                            + (model.blockerStatus == .stale
                                ? model.reloadError.map { "\nSafari said: \($0)" } ?? "" : "")
                )
                .font(.subheadline)
                .foregroundStyle(Theme.ink)
                if model.blockerStatus == .stale, !model.safariUpdating {
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
            case _ where model.safariUpdating && (model.blockerStatus == .active || model.blockerStatus == .stale):
                Text("updating rules…").foregroundStyle(Theme.inkSoft)
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
                    Screen Time does not carry those categories. It is \
                    optional — the Safari blocker works without it.
                    """
                    + (DnsFilterText.available
                        ? " Gambling and dating are filtered in Safari, and in other apps while the DNS filter is on."
                        : " Those categories are filtered in Safari only.")
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

/// "Updating Safari rules…": shown on Home, Filter categories and Allow &
/// block lists while Safari compiles a change that is already saved.
enum SafariUpdatingText {
    /// "Uses them already" only when the filter is actually running.
    static func line(dnsFilterOn: Bool) -> String {
        "Your change is saved. Safari is loading the new rules, which can take several seconds."
            + (dnsFilterOn ? " The DNS filter uses them already." : "")
    }
}
