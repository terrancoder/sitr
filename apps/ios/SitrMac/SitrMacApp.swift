/// macOS host app for the Sitr Safari Web Extension.
///
/// Deliberately thin: Safari's DNR engine does all filtering inside the
/// extension; this app exists because Apple requires extensions to ship
/// inside one, and it earns its place by doing the two things only a host
/// app can do — prove whether the extension is enabled (fail-visible: red
/// until proven) and walk the user through enabling it.
///
/// No network code. The single-call-site invariant (data-flow.md) is
/// carried by the extension's sync client; this app adds nothing.
import SafariServices
import SwiftUI

let extensionBundleId = "com.sitrshield.sitr.mac.webext"

@main
struct SitrMacApp: App {
    @AppStorage("appearance") private var appearance = Appearance.system.rawValue

    var body: some Scene {
        WindowGroup {
            StatusView()
                .frame(minWidth: 420, idealWidth: 460, minHeight: 340)
                .preferredColorScheme(
                    (Appearance(rawValue: appearance) ?? .system).colorScheme)
        }
        .windowResizability(.contentSize)
    }
}

/// Mirrors the extension's fail-visible contract: anything less than proof
/// that the extension is enabled renders as "not verified", never green.
enum ExtensionStatus: Equatable {
    case unknown(reason: String?)
    case enabled
    case disabled
}

@MainActor
final class StatusModel: ObservableObject {
    @Published var status: ExtensionStatus = .unknown(reason: nil)

    func refresh() {
        SFSafariExtensionManager.getStateOfSafariExtension(
            withIdentifier: extensionBundleId
        ) { state, error in
            Task { @MainActor in
                if let state {
                    self.status = state.isEnabled ? .enabled : .disabled
                } else {
                    self.status = .unknown(reason: error?.localizedDescription)
                }
            }
        }
    }

    func openSafariSettings() {
        SFSafariApplication.showPreferencesForExtension(
            withIdentifier: extensionBundleId
        ) { _ in }
    }
}

struct StatusView: View {
    @StateObject private var model = StatusModel()
    @AppStorage("appearance") private var appearance = Appearance.system.rawValue
    @Environment(\.colorScheme) private var scheme
    private let timer = Timer.publish(every: 2, on: .main, in: .common)
        .autoconnect()

    var body: some View {
        let theme = Theme.current(scheme)
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Circle()
                    .fill(model.status == .enabled ? theme.green : theme.alert)
                    .frame(width: 12, height: 12)
                Text(headline)
                    .font(.headline)
                    .foregroundStyle(theme.ink)
            }
            Text(detail)
                .font(.callout)
                .foregroundStyle(theme.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Safari Extension Settings") {
                model.openSafariSettings()
            }
            .tint(theme.green)
            Divider().overlay(theme.rule)
            Text(
                """
                All filtering happens inside Safari, on this Mac. Sitr cannot \
                see your browsing — the extension uses Safari's own content \
                rules, makes no network requests unless you set up Family \
                sync, and its full source is public at github.com/terrancoder/sitr.
                """
            )
            .font(.footnote)
            .foregroundStyle(theme.inkSoft)
            .fixedSize(horizontal: false, vertical: true)
            HStack {
                Text("Appearance")
                    .font(.footnote)
                    .foregroundStyle(theme.inkSoft)
                Picker("Appearance", selection: $appearance) {
                    ForEach(Appearance.allCases) { a in
                        Text(a.label).tag(a.rawValue)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .frame(maxWidth: 220)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(theme.paper)
        .onAppear { model.refresh() }
        .onReceive(timer) { _ in model.refresh() }
    }

    private var headline: String {
        switch model.status {
        case .enabled: return "Protection active in Safari"
        case .disabled: return "Extension is OFF in Safari"
        case .unknown: return "Not verified yet"
        }
    }

    private var detail: String {
        switch model.status {
        case .enabled:
            return
                "The Sitr extension is enabled. Manage per-site access and "
                + "settings from the Sitr toolbar item in Safari."
        case .disabled:
            return
                "Open Safari's settings and turn on the Sitr extension, then "
                + "allow it for the sites it protects (SafeSearch needs the "
                + "search engines)."
        case .unknown(let reason):
            return reason
                ?? "Safari has not reported the extension's state yet."
        }
    }
}
