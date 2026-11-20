import SitrCore
import SwiftUI

/// About & privacy — mirrors docs/data-flow.md and privacy-policy.md in
/// substance (six-way consistency rule). No purchase links anywhere.
struct SettingsAboutView: View {
    @AppStorage(Theme.appearanceKey) private var appearance = "system"

    /// Read from the bundle: the hardcoded string had already drifted from
    /// the build's real version.
    private let version =
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"

    var body: some View {
        List {
            Section("Appearance") {
                Picker("Appearance", selection: $appearance) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                .pickerStyle(.segmented)
            }
            .sitrRows()
            Section("Privacy") {
                Text(DnsFilterText.available ? Self.privacyWithDnsFilter : Self.privacy)
                    .foregroundStyle(Theme.ink)
            }
            .sitrRows()
            Section("Honest limits on iOS") {
                Text(DnsFilterText.available ? Self.limitsWithDnsFilter : Self.limits)
                    .foregroundStyle(Theme.ink)
            }
            .sitrRows()
            // Points at the one filter that can see pictures; Sitr can't
            // check whether it is on, so this stays plain advice.
            Section("Also turn on") {
                Text(
                    """
                    Sitr can't see pictures inside apps. Apple's Communication \
                    Safety blurs nude photos and videos in Messages, AirDrop, \
                    FaceTime and some other apps: Settings → Screen Time → your \
                    child → Communication Safety. It is on by default for Child \
                    Accounts under 18.
                    """
                )
                .foregroundStyle(Theme.ink)
            }
            .sitrRows()
            Section("Open source") {
                Text(
                    """
                    Sitr is open source (MPL-2.0). The blocklist is public, \
                    with a written inclusion policy and an appeals process. \
                    The bundled rulesets are byte-verifiable against the \
                    published compiler checksums. Version \(version).
                    """
                )
                .foregroundStyle(Theme.ink)
                Text(
                    "The app's code is MPL-2.0. The blocklist data is CC BY-SA 4.0, built in part from public lists credited here:"
                )
                .foregroundStyle(Theme.ink)
                NavigationLink("Licence and credits (offline)") { NoticeView() }
                Link("Blocklist sources and credits", destination: SupportLinks.attribution)
            }
            .sitrRows()
        }
        .navigationTitle("About & privacy")
        .sitrScreenBackground()
    }

    private static let privacy = """
        Filtering happens entirely on this device, using Safari's \
        content-blocker engine — which is structurally incapable \
        of seeing your browsing. Sitr transmits no browsing \
        history, no URLs, no identifiers, no telemetry, no crash \
        reports — in every tier.

        If you use Sitr Family, the only network request is an \
        end-to-end encrypted settings blob to sync.sitrshield.com \
        — unreadable by the server, tied to no account or email. \
        Without a household, the app makes zero network requests.
        """

    /// True whether the DNS filter is on or off.
    private static let privacyWithDnsFilter = """
        Filtering happens entirely on this device. In Safari it uses \
        Safari's content-blocker engine, which is structurally \
        incapable of seeing your browsing. Sitr transmits no browsing \
        history, no URLs, no identifiers, no telemetry, no crash \
        reports — in every tier.

        The optional DNS filter, when you turn it on, sees the names \
        of the sites that apps on this device look up. It decides on \
        this device; it logs and stores none of them, and sends none \
        to Sitr or to any other company.

        If you use Sitr Family, the only network request is an \
        end-to-end encrypted settings blob to sync.sitrshield.com \
        — unreadable by the server, tied to no account or email. \
        Without a household, the app makes zero network requests. \
        With the DNS filter on, allowed lookups go on to your \
        network's own DNS server, unencrypted, so your network \
        operator can see the names; that is not a request to Sitr or \
        to anyone else.
        """

    private static let limits = """
        The Safari blocker protects Safari. The optional Screen \
        Time filter extends to WebKit browsers system-wide. \
        SafeSearch cannot be enforced on iOS at all — we say so \
        rather than imply otherwise. In individual mode, Screen \
        Time can be revoked by the device owner: friction, not a \
        lock. Child mode (Family Sharing) requires parent \
        approval to revoke — the strongest protection iOS offers.
        """

    private static let limitsWithDnsFilter = """
        The Safari blocker protects Safari. The optional DNS filter \
        extends filtering to other apps by the site names they look \
        up, and is the only way Sitr can enforce SafeSearch: with it \
        on, \(DnsFilterText.safeSearchScope); without it, SafeSearch \
        is not enforced. It does not cover apps that use their own \
        encrypted DNS, lookups are not filtered for about half a \
        second when the network changes (up to a few seconds if the new \
        network is slow to announce its DNS server, and up to about two \
        seconds each time it reads that server again on the same \
        network), another VPN app switches it \
        off, and anyone with the device passcode can switch it off in \
        iOS Settings (Sitr then shows it as off).

        The optional Screen Time filter extends to WebKit browsers \
        system-wide. In individual mode, Screen Time can be revoked \
        by the device owner: friction, not a lock. Child mode (Family \
        Sharing) requires parent approval to revoke — the strongest \
        protection iOS offers.
        """
}

/// The compiler-generated NOTICE.txt bundled next to the lists: CC BY /
/// CC BY-SA attribution has to travel with the data the app ships.
struct NoticeView: View {
    private let text = Bundle.main.url(forResource: "NOTICE", withExtension: "txt")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
        ?? "The licence notice is missing from this build."

    var body: some View {
        ScrollView {
            Text(text)
                .font(.footnote.monospaced())
                .foregroundStyle(Theme.ink)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
        .navigationTitle("Licence and credits")
        .sitrScreenBackground()
    }
}

/// Wording shared by the settings section and RootView's hold alert.
enum DelayText {
    static func label(_ minutes: Int) -> String {
        switch minutes {
        case 0: return "Off"
        case 60: return "1 hour"
        case let m where m < 60: return "\(m) minutes"
        default: return "\(minutes / 60) hours"
        }
    }

    static func remaining(_ ms: Int64) -> String {
        let total = (ms + 999) / 1000
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, s)
            : String(format: "%d:%02d", m, s)
    }

    static func status(_ d: AppModel.DelayState) -> String {
        switch d.phase {
        case .off: return "Off. Changes apply straight away."
        case .idle:
            return "On (\(label(d.minutes))). No request: changes that loosen protection are held until you start the wait and it runs out."
        case .waiting: return "Ready in \(remaining(d.remainingMs))."
        case .open: return "Changes open for \(remaining(d.remainingMs))."
        }
    }

    static func hold(_ d: AppModel.DelayState) -> String {
        d.phase == .idle
            ? "Changes that loosen protection are set to wait \(label(d.minutes)). Start the wait?"
            : "Ready in \(remaining(d.remainingMs)). Then changes stay open for \(Delay.windowMs / 60_000) minutes. Try the change again then."
    }
}

/// "Wait before loosening": device-local, never synced. Shortening the
/// wait (or turning it off) goes through the gate and the wait itself;
/// lengthening it is free.
struct DelaySettingsView: View {
    @EnvironmentObject var model: AppModel
    let attemptAction: (DelayAction, String, @escaping () -> Void) -> Void

    var body: some View {
        // Re-evaluated every second: the status line is the only signal
        // that the wait has ended (no notification, no new permission).
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let d = model.delayState()
            List {
                Section {
                    Picker(
                        "Wait",
                        selection: .init(
                            get: { d.minutes },
                            set: { to in
                                guard to != d.minutes else { return }
                                let save = { model.setDelayMinutes(to) }
                                if let action = Delay.changeAction(from: d.minutes, to: to) {
                                    attemptAction(action, "Shorten the wait", save)
                                } else {
                                    save()
                                }
                            })
                    ) {
                        ForEach(Delay.minutesAllowed, id: \.self) { m in
                            Text(DelayText.label(m)).tag(m)
                        }
                    }
                    .foregroundStyle(Theme.ink)
                    Text(DelayText.status(d))
                        .foregroundStyle(d.phase == .open ? Theme.alert : Theme.ink)
                        .accessibilityIdentifier("delay.status")
                    Button("Start the wait") { model.startDelayRequest() }
                        .disabled(d.phase != .idle)
                    Button("Cancel request", role: .destructive) { model.cancelDelayRequest() }
                        .disabled(d.phase != .waiting && d.phase != .open)
                }
                .sitrRows()
                Section {
                    Text(
                        """
                        When this is on, a change that loosens protection — \
                        turning a category\(DnsFilterText.available ? " or the DNS filter" : "") off, \
                        allowing or unblocking a site, \
                        leaving a household, shortening this wait — is held. \
                        Start the wait; when it runs out, changes stay open for \
                        \(Delay.windowMs / 60_000) minutes. Restarting the device \
                        or changing its clock can restart or cancel the wait. There \
                        is no notification when it ends: check back here. The wait \
                        is local to this device: changes made on another device in \
                        your household arrive by sync and are not held.
                        """
                    )
                    .foregroundStyle(Theme.ink)
                }
                .sitrRows()
                Section("What it cannot do on iOS") {
                    Text(
                        """
                        It slows down changes made inside Sitr. It cannot stop \
                        anyone switching the Sitr content blocker\(DnsFilterText.available ? " or the DNS filter" : "") \
                        off in iOS Settings, or deleting the app. For a child's device, \
                        use a household with a guardian PIN, and Screen Time.
                        """
                    )
                    .foregroundStyle(Theme.ink)
                }
                .sitrRows()
            }
        }
        .navigationTitle("Wait before loosening")
        .sitrScreenBackground()
    }
}
