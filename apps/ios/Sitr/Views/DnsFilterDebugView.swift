#if DEBUG && SITR_DNS_FILTER
import NetworkExtension
import SitrCore
import SwiftUI

/// DEBUG-ONLY: the DNS filter's diagnostics file, for device testing.
/// Read-only on purpose: turning the filter on and off goes through the
/// real DNS filter screen (gate, wait, PIN). Reached from that screen.
struct DnsFilterDebugView: View {
    @EnvironmentObject var model: AppModel
    @State private var status: NEVPNStatus = .invalid
    @State private var diag: TunnelDiagnostics?
    @State private var baseline: TunnelDiagnostics?
    @State private var message: String?
    private let timer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        List {
            Section("Debug build only") {
                LabeledContent("VPN status", value: Self.describe(status))
                LabeledContent("Last Safari apply", value: model.lastSafariApplyMs.map { "\($0) ms" } ?? "none yet")
                LabeledContent("App status reads (10 s)", value: "\(DnsFilterController.refreshTimes.filter { $0.timeIntervalSinceNow > -10 }.count)")
                if let message { Text(message).foregroundStyle(.red) }
            }
            .sitrRows()
            if let d = diag {
                Section("Tunnel diagnostics") {
                    LabeledContent("State", value: d.state)
                    LabeledContent("Updated", value: d.updatedAt.formatted(date: .omitted, time: .standard))
                    LabeledContent("Upstreams", value: d.upstreams.isEmpty ? "none" : d.upstreams.joined(separator: ", "))
                    if let m = d.memoryLast {
                        LabeledContent("Memory (peak)", value: "\(m.footprintBytes >> 20) MB (\(d.peakFootprintBytes >> 20) MB)")
                    }
                    if let p = d.paths.last {
                        LabeledContent("Last network", value: "\(p.interfaces.joined(separator: ", ")) via \(p.method ?? "pending")")
                        LabeledContent("First answer after resume", value: p.firstAnswerMs.map { "\($0) ms" } ?? "none yet")
                        LabeledContent(
                            "Failed: timeout / send / distinct",
                            value: "\(p.failedTimeout ?? 0) / \(p.failedSendError ?? 0) / \(p.failedQueryHashes?.count ?? 0)")
                    }
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
    }

    private func load() async {
        DnsFilterDebug.writeBaseline()
        refresh()
    }

    private func refresh() {
        diag = TunnelDiagnostics.url("tunnel.json").flatMap(TunnelDiagnostics.read)
        baseline = TunnelDiagnostics.url("app-baseline.json").flatMap(TunnelDiagnostics.read)
        Task {
            guard let m = try? await NETunnelProviderManager.loadAllFromPreferences().first else {
                status = .invalid
                return
            }
            status = m.connection.status
            if status == .disconnected {
                m.connection.fetchLastDisconnectError { error in
                    if let error { Task { @MainActor in message = "Last disconnect: \(error.localizedDescription)" } }
                }
            }
        }
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
}
#endif
