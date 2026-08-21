import SwiftUI

/// About & privacy — mirrors docs/data-flow.md and privacy-policy.md in
/// substance (six-way consistency rule). No purchase links anywhere.
struct SettingsAboutView: View {
    var body: some View {
        List {
            Section("Privacy") {
                Text(
                    """
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
                )
            }
            Section("Honest limits on iOS") {
                Text(
                    """
                    The Safari blocker protects Safari. The optional Screen \
                    Time filter extends to WebKit browsers system-wide. \
                    SafeSearch cannot be enforced on iOS at all — we say so \
                    rather than imply otherwise. In individual mode, Screen \
                    Time can be revoked by the device owner: friction, not a \
                    lock. Child mode (Family Sharing) requires parent \
                    approval to revoke — the strongest protection iOS offers.
                    """
                )
            }
            Section("Open source") {
                Text(
                    """
                    Sitr is open source (MPL-2.0). The blocklist is public, \
                    with a written inclusion policy and an appeals process. \
                    The bundled rulesets are byte-verifiable against the \
                    published compiler checksums. Version 0.1.0.
                    """
                )
            }
        }
        .navigationTitle("About & privacy")
    }
}
