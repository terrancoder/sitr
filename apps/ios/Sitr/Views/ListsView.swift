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

    var body: some View {
        List {
            Section("Always allow these sites") {
                editor(
                    input: $allowInput,
                    domains: model.settings.userAllow,
                    onAdd: { domain in
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
            }
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
            }
            if let inputError {
                Text(inputError).foregroundStyle(.red).font(.caption)
            }
        }
        .navigationTitle("Allow & block lists")
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
            Button("Add") {
                switch DomainInput.normalize(input.wrappedValue) {
                case .failure(let error):
                    inputError = error.message
                case .success(let domain):
                    inputError = nil
                    onAdd(domain)
                }
            }
        }
        ForEach(domains, id: \.self) { domain in
            HStack {
                Text(domain)
                Spacer()
                Button("Remove", role: .destructive) { onRemove(domain) }
                    .buttonStyle(.borderless)
            }
        }
        if domains.isEmpty {
            Text("None yet.").foregroundStyle(.secondary).font(.caption)
        }
    }
}
