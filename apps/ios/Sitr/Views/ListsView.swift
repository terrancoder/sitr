import SitrCore
import SwiftUI

/// Device allow/block lists — they never leave this device. Adding an
/// allow or removing a block is loosening (PIN-gated); the tightening
/// direction never is. Input runs through the shared normalizer.
struct ListsView: View {
    @EnvironmentObject var model: AppModel
    let attempt: (MutationKind, String, @escaping () -> Void) -> Void

    @State private var allowInput = ""
    @State private var blockInput = ""
    @State private var inputError: String?

    static let allowExplainer =
        "An allowed site opens even when a category blocks it, except sites on the adult list: those stay blocked."

    /// The Add button's check: the normalized domain, or the message to show.
    static func addCheck(_ input: String, in domains: [String]) -> Result<String, SitrError> {
        DomainInput.normalize(input).flatMap {
            domains.contains($0) ? .failure(SitrError("Already in the list.")) : .success($0)
        }
    }

    var body: some View {
        List {
            if model.safariUpdating {
                Section {
                    Label("Updating Safari rules…", systemImage: "arrow.triangle.2.circlepath")
                        .foregroundStyle(Theme.ink)
                    Text(SafariUpdatingText.line(dnsFilterOn: model.dnsFilterStatus == .on))
                        .font(.caption).foregroundStyle(Theme.inkSoft)
                }
                .sitrRows()
            }
            Section("Always allow these sites") {
                editor(
                    input: $allowInput,
                    domains: model.settings.userAllow,
                    onAdd: { domain in
                        if let refusal = model.allowRefusal(domain) {
                            inputError = refusal
                            return
                        }
                        attempt(.addDeviceAllowRule, "Allow \(domain)") {
                            Task { await model.addDeviceDomain(allow: true, domain: domain) }
                            allowInput = ""
                        }
                    },
                    onRemove: { domain in
                        attempt(.removeDeviceAllowRule, "") {
                            Task { await model.removeDeviceDomain(allow: true, domain: domain) }
                        }
                    }
                )
                Text(Self.allowExplainer).font(.caption).foregroundStyle(Theme.inkSoft)
            }
            .sitrRows()
            Section("Always block these sites") {
                editor(
                    input: $blockInput,
                    domains: model.settings.userBlock,
                    onAdd: { domain in
                        attempt(.addDeviceBlockRule, "") {
                            Task { await model.addDeviceDomain(allow: false, domain: domain) }
                            blockInput = ""
                        }
                    },
                    onRemove: { domain in
                        attempt(.removeDeviceBlockRule, "Unblock \(domain)") {
                            Task { await model.removeDeviceDomain(allow: false, domain: domain) }
                        }
                    }
                )
                Text("If a site is in both lists, the allow entry wins.")
                    .font(.caption).foregroundStyle(Theme.inkSoft)
            }
            .sitrRows()
            if let inputError {
                Section {
                    Text(inputError).foregroundStyle(Theme.alert).font(.caption)
                    if inputError == AdultList.refusal {
                        Link("Report a wrongly blocked site", destination: SupportLinks.unblockRequest)
                    }
                }
                .sitrRows()
            }
            // Support links only — they change nothing here, so no gate
            // or PIN, and they carry no domain or setting from the app.
            Section("Report a site") {
                Link("Ask to block a site", destination: SupportLinks.blockRequest)
                Link("Report a wrongly blocked site", destination: SupportLinks.unblockRequest)
                Link("Email instead", destination: SupportLinks.email)
                Text(
                    "These open GitHub or your mail app. A GitHub report is public and needs a GitHub account. Sitr itself sends nothing."
                )
                .font(.caption).foregroundStyle(Theme.inkSoft)
            }
            .sitrRows()
        }
        .navigationTitle("Allow & block lists")
        .sitrScreenBackground()
    }

    @ViewBuilder
    private func editor(
        input: Binding<String>,
        domains: [String],
        onAdd: @escaping (String) -> Void,
        onRemove: @escaping (String) -> Void
    ) -> some View {
        HStack {
            TextField("example.com", text: input)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(Theme.ink)
            Button("Add") {
                switch Self.addCheck(input.wrappedValue, in: domains) {
                case .failure(let error):
                    inputError = error.message
                case .success(let domain):
                    inputError = nil
                    onAdd(domain)
                }
            }
        }
        // The separator otherwise aligns to the first Text in the row —
        // the "Add" label, since a TextField isn't one — leaving a stub.
        .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
        ForEach(domains, id: \.self) { domain in
            HStack {
                Text(domain).foregroundStyle(Theme.ink)
                Spacer()
                Button("Remove", role: .destructive) { onRemove(domain) }
                    .buttonStyle(.borderless)
            }
        }
        if domains.isEmpty {
            Text("None yet.").foregroundStyle(Theme.inkSoft).font(.caption)
        }
    }
}

/// The public report targets — the same ones the Android app and the
/// browser extension use.
enum SupportLinks {
    static let blockRequest = URL(
        string: "https://github.com/terrancoder/sitr/issues/new?template=block-request.yml")!
    static let unblockRequest = URL(
        string: "https://github.com/terrancoder/sitr/issues/new?template=unblock-request.yml")!
    static let email = URL(string: "mailto:support@sitrshield.com?subject=Site%20report")!
    static let attribution = URL(
        string: "https://github.com/terrancoder/sitr/blob/main/blocklist/imports/ATTRIBUTION.md")!
}
