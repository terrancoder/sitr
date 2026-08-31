import SwiftUI

/// Three honest steps: what Sitr is; how to enable the Safari blocker
/// (with a live re-check when the app foregrounds); optional household
/// join. No purchase links anywhere — iOS is join-only.
struct OnboardingView: View {
    @EnvironmentObject var model: AppModel
    @State private var step = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch step {
            case 0:
                Text("Sitr — سِتْر").font(.largeTitle.bold())
                    .foregroundStyle(Theme.green)
                Rectangle().fill(Theme.gold).frame(width: 48, height: 3)
                Text(
                    """
                    A halal/family content filter whose privacy you can \
                    verify, not just trust.

                    Sitr blocks adult, gambling and dating sites in Safari — \
                    entirely on this device. No accounts. No analytics. No \
                    crash reports. Your browsing never leaves this phone, in \
                    any tier. The blocklist is public and identical for every \
                    user, and the app is open source, so this is verifiable — \
                    not a promise.
                    """
                )
                .foregroundStyle(Theme.ink)
                Button("Continue") { step = 1 }
                    .buttonStyle(.borderedProminent)
            case 1:
                Text("Enable the blocker").font(.title.bold())
                    .foregroundStyle(Theme.green)
                Rectangle().fill(Theme.gold).frame(width: 48, height: 3)
                Text(
                    """
                    Safari needs your permission to use Sitr's rules:

                    1. Open Settings → Apps → Safari → Extensions
                    2. Tap Sitr
                    3. Turn on Allow Extension

                    Come back here — the status updates automatically.
                    """
                )
                .foregroundStyle(Theme.ink)
                statusHint
                Button("Continue") { step = 2 }
                    .buttonStyle(.borderedProminent)
            default:
                Text("Sitr Family (optional)").font(.title.bold())
                    .foregroundStyle(Theme.green)
                Rectangle().fill(Theme.gold).frame(width: 48, height: 3)
                Text(
                    """
                    A household shares its allow/block lists and settings \
                    across devices, end-to-end encrypted — the sync server \
                    cannot read them. Join anytime from the Sitr Family \
                    screen with a pairing code from your family's guardian \
                    device.
                    """
                )
                .foregroundStyle(Theme.ink)
                Button("Finish") {
                    var next = model.settings
                    next.onboarded = true
                    Task { await model.apply(next) }
                }
                .buttonStyle(.borderedProminent)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.paper.ignoresSafeArea())
        .task { await model.refreshStatus() }
        .onChange(of: step) { _ in
            Task { await model.refreshStatus() }
        }
    }

    @ViewBuilder private var statusHint: some View {
        switch model.blockerStatus {
        case .active, .stale:
            Label("Blocker enabled", systemImage: "checkmark.circle.fill")
                .foregroundStyle(Theme.green)
        case .disabled:
            Label("Not enabled yet", systemImage: "circle")
                .foregroundStyle(Theme.inkSoft)
        case .unknown:
            Label("Checking…", systemImage: "circle.dotted")
                .foregroundStyle(Theme.inkSoft)
        }
    }
}
