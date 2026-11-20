import SitrCore
import SwiftUI

/// Every user-visible sentence about the DNS filter, in one place so the
/// docs and the store listing can quote them. Sentences used elsewhere in
/// the app are true in every filter state; ones that are not depend on
/// `DnsFilterText.available` (compile time) or the live status.
enum DnsFilterText {
    #if SITR_DNS_FILTER
        static let available = true
    #else
        static let available = false
    #endif

    /// Exactly what safesearch-hosts.json maps.
    static let safeSearchScope = "Google, Bing and DuckDuckGo use SafeSearch, and YouTube uses Restricted Mode"

    static func rowValue(_ s: DnsFilterStatus) -> (text: String, color: Color) {
        switch s {
        case .unavailable, .off: return ("off — optional", Theme.inkSoft)
        case .starting: return ("starting…", Theme.inkSoft)
        case .on: return ("on", Theme.green)
        case .noResolver: return ("on, but this network's DNS server could not be read", Theme.alert)
        case .switchedOff: return ("on, but switched off in iOS Settings", Theme.alert)
        case .removed: return ("removed in iOS Settings", Theme.alert)
        case .otherVPN: return ("off — another VPN is in use", Theme.alert)
        case .stopped: return ("stopped — tap for the reason", Theme.alert)
        }
    }

    /// Why it is not running, for the red status card on Home.
    static func cardReason(_ s: DnsFilterStatus) -> String {
        switch s {
        case .switchedOff: return "it was switched off in iOS Settings"
        case .removed: return "its VPN configuration was removed in iOS Settings"
        case .otherVPN: return "another VPN is in use"
        case .stopped(let reason):
            return "it stopped (\(reason.hasSuffix(".") ? String(reason.dropLast()) : reason))"
        case .unavailable, .off, .starting, .on, .noResolver: return "it is not on"
        }
    }

    static func detail(_ s: DnsFilterStatus) -> String {
        switch s {
        case .unavailable, .off:
            return "Off. Turn it on to filter the sites that other apps on this device look up, not only Safari, and to enforce SafeSearch."
        case .starting:
            return "Starting. iOS is bringing the filter up."
        case .on:
            return "On. Sites that apps on this device look up are filtered. \(safeSearchScope)."
        case .noResolver:
            return "On, but the filter could not read this network's DNS server, so sites will not load on this network: the filter blocks lookups rather than let them through unfiltered. It keeps trying for about 16 minutes, and after that only when the network changes. To use this network without the filter, turn it off."
        case .switchedOff:
            return "The DNS filter was switched off in iOS Settings, so other apps are not filtered and SafeSearch is not enforced. Turn it back on here, or stop using it."
        case .removed:
            return "The DNS filter's VPN configuration was removed in iOS Settings, so other apps are not filtered and SafeSearch is not enforced. Turning it back on asks iOS's permission again."
        case .otherVPN:
            return "Another VPN is in use. iOS allows one VPN at a time, so the DNS filter is off. Turning it back on here switches the other VPN off."
        case .stopped(let reason):
            return "The DNS filter is not running (\(reason.hasSuffix(".") ? String(reason.dropLast()) : reason)). Turn it back on here, or stop using it."
        }
    }

    /// The disclosure shown before iOS's permission prompt and under
    /// "About the DNS filter" (App Review 5.4).
    static let disclosure: [(heading: String, body: String)] = [
        (
            "What it does",
            "The DNS filter extends Sitr beyond Safari. When an app on this device looks up a site's name, the filter checks it against the same lists and settings as Sitr's Safari blocker, and blocked sites don't load. \(safeSearchScope)."
        ),
        (
            "What it sees",
            "The names of the sites that apps on this device look up — names only, never what is on the pages. It decides on this device. It logs and stores none of them, and sends none to Sitr or to any other company; allowed lookups go to your network's DNS server (below)."
        ),
        (
            "Where lookups go",
            "Allowed lookups, and the filter's own lookups of the SafeSearch addresses, go to your network's own DNS server, unencrypted, so your network operator can see the names — as it can whenever a device uses the network's DNS. The filter involves no Sitr server and no other company's server."
        ),
        (
            "Why iOS says VPN",
            "Apple's VPN interface is the only way an app can filter lookups on iOS. So iOS asks your permission to add a VPN configuration, lists the filter under VPN in Settings, and shows a VPN badge in Control Center while the filter is on. Only lookups go through it, and it ends on this device: there is no VPN server."
        ),
    ]

    static let limits = [
        "Apps that use their own encrypted DNS are not covered.",
        "For about half a second when the network changes (for example, from Wi-Fi to mobile data), and for up to a few seconds if the new network is slow to announce its DNS server, lookups are not filtered.",
        "iOS allows only one VPN at a time: turning on another VPN app switches this filter off.",
        "Anyone with this device's passcode can switch it off in iOS Settings. Sitr then shows it as off.",
    ]

    static let dohTitle = "Block encrypted-DNS bypass"
    static let dohNote =
        "Some browsers and apps have a \"secure DNS\" setting that sends lookups to an outside encrypted DNS service, which skips the DNS filter. With this on, the DNS filter refuses to look up the addresses of well-known services of that kind, so that setting stops working instead of quietly skipping the filter: pages may then fail to load until it is set back to automatic or off. A connection already open can keep working for some minutes. It cannot stop a service entered as an IP address, or one that is not on the list. Off unless you turn it on; it works only while the DNS filter is on."

    /// Where Safari-blocker lists also apply: appended to notes that used
    /// to say "Safari only".
    static let reach =
        available
        ? "It applies in Safari, and in other apps while the DNS filter is on."
        : "On iOS it works in Safari only."
}

#if SITR_DNS_FILTER
/// The disclosure text: what it does, what it sees, where lookups go, the
/// VPN prompt, and the limits.
struct DnsFilterAboutText: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(DnsFilterText.disclosure, id: \.heading) { part in
                VStack(alignment: .leading, spacing: 4) {
                    Text(part.heading).font(.headline).foregroundStyle(Theme.ink)
                        .accessibilityAddTraits(.isHeader)
                    Text(part.body).foregroundStyle(Theme.ink)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Limits").font(.headline).foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
                ForEach(DnsFilterText.limits, id: \.self) { limit in
                    Text("• \(limit)").foregroundStyle(Theme.ink)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 4)
    }
}

/// A disclosure row whose chevron matches the navigation rows' (small,
/// grey) instead of the default bold, tinted one.
struct SitrDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation { configuration.isExpanded.toggle() }
            } label: {
                HStack {
                    configuration.label
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color(uiColor: .tertiaryLabel))
                        .rotationEffect(.degrees(configuration.isExpanded ? 90 : 0))
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
            if configuration.isExpanded { configuration.content }
        }
    }
}

/// Shown before iOS's VPN permission prompt can appear; only its explicit
/// "Turn on" proceeds.
struct DnsFilterDisclosureSheet: View {
    let onTurnOn: () -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    DnsFilterAboutText()
                }
                .sitrRows()
                Section {
                    Button(action: onTurnOn) {
                        Text("Turn on").bold().frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("dnsfilter.disclosure.turnOn")
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                    .accessibilityHint("iOS then asks permission to add the VPN configuration.")
                    Text("Next, iOS asks permission to add a VPN configuration named \"Sitr DNS filter\".")
                        .font(.caption).foregroundStyle(Theme.inkSoft)
                }
                .sitrRows()
            }
            .navigationTitle("DNS filter")
            .navigationBarTitleDisplayMode(.inline)
            .sitrScreenBackground()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now", action: onCancel)
                }
            }
        }
    }
}

/// The DNS filter screen: honest status, on/off, the opt-in encrypted-DNS
/// list, and the disclosure. Turning it on is free; turning it off (or
/// "stop using it" after iOS switched it off) and turning the encrypted-
/// DNS list off are loosening changes and go through `attempt`
/// (.disableCategory: refused on a child device, then the wait, then the
/// PIN), exactly like Android's "Turn off protection".
struct DnsFilterView: View {
    @EnvironmentObject var model: AppModel
    let attempt: (MutationKind, String, @escaping () -> Void) -> Void
    @State private var showDisclosure = false
    @State private var working = false

    private var status: DnsFilterStatus { model.dnsFilterStatus }

    var body: some View {
        List {
            Section {
                let value = DnsFilterText.rowValue(status)
                LabeledContent("DNS filter") {
                    Text(value.text).foregroundStyle(value.color)
                }
                .foregroundStyle(Theme.ink)
                .accessibilityIdentifier("dnsfilter.status")
                Text(DnsFilterText.detail(status))
                    .foregroundStyle(status.isFailing ? Theme.alert : Theme.ink)
            }
            .sitrRows()

            Section {
                switch status {
                case .unavailable, .off:
                    Button("Turn on the DNS filter…") { beginTurnOn() }
                        .accessibilityHint("Shows what the filter does before iOS asks permission.")
                case .on, .starting, .noResolver:
                    Button("Turn off the DNS filter", role: .destructive) { turnOff() }
                case .switchedOff, .removed, .otherVPN, .stopped:
                    Button("Turn the DNS filter back on") { beginTurnOn() }
                    // Someone who switched it off on purpose must be able to
                    // tell Sitr so, with the same gate as turning it off.
                    Button("Stop using the DNS filter", role: .destructive) { turnOff() }
                }
            }
            .sitrRows()

            if status.isWanted {
                Section("Encrypted DNS") {
                    Toggle(
                        DnsFilterText.dohTitle,
                        isOn: .init(
                            get: { model.settings.optionalOn.contains("doh") },
                            set: { on in
                                let set: () -> Void = {
                                    Task {
                                        await model.mutate {
                                            if on { $0.optionalOn.insert("doh") } else { $0.optionalOn.remove("doh") }
                                        }
                                    }
                                }
                                if on {
                                    attempt(.enableCategory, "", set)
                                } else {
                                    attempt(.disableCategory, "Turn off \(DnsFilterText.dohTitle)", set)
                                }
                            })
                    )
                    .foregroundStyle(Theme.ink)
                    Text(DnsFilterText.dohNote).font(.caption).foregroundStyle(Theme.inkSoft)
                }
                .sitrRows()
            }

            Section {
                DisclosureGroup {
                    DnsFilterAboutText()
                } label: {
                    Text("About the DNS filter").foregroundStyle(Theme.ink)
                }
                .disclosureGroupStyle(SitrDisclosureStyle())
            }
            .sitrRows()

            #if DEBUG && SITR_DNS_FILTER
                Section("Debug builds only") {
                    NavigationLink("Diagnostics") { DnsFilterDebugView() }
                        .foregroundStyle(Theme.ink)
                }
                .sitrRows()
            #endif
        }
        .navigationTitle("DNS filter")
        .sitrScreenBackground()
        .disabled(working)
        .task { await model.refreshDnsFilter() }
        .onReceive(NotificationCenter.default.publisher(for: DnsFilterController.statusDidChange)) { note in
            guard DnsFilterController.isOurStatusChange(note) else { return }
            Task { await model.refreshDnsFilter() }
        }
        .sheet(isPresented: $showDisclosure) {
            DnsFilterDisclosureSheet(
                onTurnOn: {
                    showDisclosure = false
                    turnOn()
                },
                onCancel: { showDisclosure = false }
            )
            .sitrAppearance()
            .tint(Theme.green)
        }
    }

    /// The disclosure comes first whenever iOS would ask permission.
    private func beginTurnOn() {
        Task {
            if await DnsFilterController.needsPermission() {
                showDisclosure = true
            } else {
                turnOn()
            }
        }
    }

    private func turnOn() {
        working = true
        Task {
            await model.turnDnsFilterOn()
            working = false
        }
    }

    private func turnOff() {
        attempt(.disableCategory, "Turn off the DNS filter") {
            working = true
            Task {
                await model.turnDnsFilterOff()
                working = false
            }
        }
    }
}
#endif
