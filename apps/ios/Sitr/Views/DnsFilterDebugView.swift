#if DEBUG
import NetworkExtension
import SitrCore
import SwiftUI

/// DEBUG-ONLY: installs, starts and inspects the experimental DNS filter
/// (SitrTunnel packet tunnel). No on-demand rules on purpose: a broken
/// tunnel stops all DNS on the phone and must not restart itself; the
/// owner turns it off here or in Settings → VPN.
struct DnsFilterDebugView: View {
    @State private var manager: NETunnelProviderManager?
    @State private var status: NEVPNStatus = .invalid
    @State private var diag: TunnelDiagnostics?
    @State private var baseline: TunnelDiagnostics?
    @State private var message: String?
    private let timer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        List {
            Section("Experimental: DNS filter") {
                Text("Prototype. Filters every app's DNS through an on-device VPN. Not part of any release.")
                    .foregroundStyle(Theme.ink)
                LabeledContent("VPN status", value: Self.describe(status))
                if let message { Text(message).foregroundStyle(.red) }
                Button(manager == nil ? "Install and start" : "Start") { Task { await start() } }
                    .disabled(status == .connected || status == .connecting)
                Button("Stop") { manager?.connection.stopVPNTunnel() }
                    .disabled(status != .connected && status != .connecting)
                if manager != nil {
                    Button("Remove VPN configuration", role: .destructive) { Task { await remove() } }
                }
            }
            .sitrRows()
            if let d = diag {
                Section("Tunnel diagnostics") {
                    LabeledContent("State", value: d.state)
                    LabeledContent("Updated", value: d.updatedAt.formatted(date: .omitted, time: .standard))
                    LabeledContent("Upstreams", value: d.upstreams.isEmpty ? "none" : d.upstreams.joined(separator: ", "))
                    let c = d.counters
                    LabeledContent("Seen / blocked / SafeSearch", value: "\(c.seen) / \(c.blocked) / \(c.rewritten)")
                    LabeledContent("Forwarded / cache / failed", value: "\(c.forwarded) / \(c.cacheHits) / \(c.failed)")
                    LabeledContent("Dropped / overloaded / TCP RST", value: "\(c.dropped) / \(c.overloaded) / \(c.tcpReset)")
                    if let e = d.lastError { LabeledContent("Last error", value: e) }
                    ForEach(Array(d.probes.suffix(8).reversed().enumerated()), id: \.offset) { _, p in
                        Text("\(p.name) [\(p.qtype)]: \(p.decision), \(p.ms) ms").font(.caption)
                    }
                }
                .sitrRows()
            }
            if let b = baseline, let last = b.discovery.last {
                Section("App-side resolver reading") {
                    Text("\(last.raw.joined(separator: ", ")) at \(last.at.formatted(date: .omitted, time: .standard))")
                        .font(.caption)
                }
                .sitrRows()
            }
        }
        .navigationTitle("DNS filter (debug)")
        .sitrScreenBackground()
        .task { await load() }
        .onReceive(timer) { _ in refresh() }
        .onReceive(NotificationCenter.default.publisher(for: .NEVPNStatusDidChange)) { _ in refresh() }
    }

    private func load() async {
        DnsFilterDebug.writeBaseline()
        manager = try? await NETunnelProviderManager.loadAllFromPreferences().first
        refresh()
    }

    private func refresh() {
        status = manager?.connection.status ?? .invalid
        diag = TunnelDiagnostics.url("tunnel.json").flatMap(TunnelDiagnostics.read)
        baseline = TunnelDiagnostics.url("app-baseline.json").flatMap(TunnelDiagnostics.read)
        if status == .disconnected, let m = manager {
            m.connection.fetchLastDisconnectError { error in
                if let error { Task { @MainActor in message = "Last disconnect: \(error.localizedDescription)" } }
            }
        }
    }

    private func start() async {
        message = nil
        do {
            let m = manager ?? NETunnelProviderManager()
            let proto = NETunnelProviderProtocol()
            proto.providerBundleIdentifier = "com.sitrshield.sitr.tunnel"
            proto.serverAddress = "On-device DNS filter"
            m.protocolConfiguration = proto
            m.localizedDescription = "Sitr DNS filter (experimental)"
            m.isEnabled = true
            m.isOnDemandEnabled = false
            try await m.saveToPreferences()  // first time: the system permission sheet
            try await m.loadFromPreferences()  // required before starting a fresh config
            try m.connection.startVPNTunnel()
            manager = m
        } catch {
            message = error.localizedDescription
        }
        refresh()
    }

    private func remove() async {
        try? await manager?.removeFromPreferences()
        manager = nil
        refresh()
    }

    static func describe(_ s: NEVPNStatus) -> String {
        switch s {
        case .invalid: return "not installed"
        case .disconnected: return "disconnected"
        case .connecting: return "connecting"
        case .connected: return "connected"
        case .reasserting: return "reasserting"
        case .disconnecting: return "disconnecting"
        @unknown default: return "unknown"
        }
    }
}

enum DnsFilterDebug {
    /// What res_ninit reports to the APP (outside the tunnel provider),
    /// written at launch so the Mac can pull a reading without a human:
    /// with no tunnel running this is the network's own resolvers.
    static func writeBaseline() {
        guard let url = TunnelDiagnostics.url("app-baseline.json") else { return }
        var d = TunnelDiagnostics.read(from: url) ?? TunnelDiagnostics(writer: "app")
        let raw = SystemResolvers.read()
        d.record(.init(at: Date(), trigger: "app launch", method: "res_ninit in app", raw: raw, usable: SystemResolvers.usable(raw), ms: 0))
        d.write(to: url)
    }

    /// Tells a running tunnel to rebuild its snapshot from the App Group settings.
    static func postSettingsChanged() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(tunnelSettingsChangedNotification as CFString), nil, nil, true)
    }
}
#endif
