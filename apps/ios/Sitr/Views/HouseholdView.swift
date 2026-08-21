import CoreImage.CIFilterBuiltins
import SitrCore
import SwiftUI
import VisionKit

/// Sitr Family — JOIN-ONLY on iOS: households are created on a computer
/// with the Sitr extension or on the Android app (factual, no purchase
/// mention — there is no token UI in this app, by design). Pairing code
/// entry is forgiving; scanning uses the system camera scanner. The
/// pairing code reveal is guardian-only and PIN-gated: possession IS
/// membership.
struct HouseholdView: View {
    @EnvironmentObject var model: AppModel
    let attempt: (MutationKind, String, @escaping () -> Void) -> Void
    let requirePin: (String, @escaping () -> Void) -> Void

    var body: some View {
        List {
            if model.settings.household == nil || model.settings.role == nil {
                joinSections
            } else {
                memberSections
            }
        }
        .navigationTitle("Sitr Family")
        .sheet(isPresented: $showScanner) {
            QRScannerView { scanned in
                code = scanned
                showScanner = false
            }
        }
    }

    // MARK: - Not in a household

    @State private var code = ""
    @State private var asChild = false
    @State private var showScanner = false

    @ViewBuilder private var joinSections: some View {
        Section {
            Text(
                """
                A household shares its allow/block lists and settings across \
                every device, end-to-end encrypted — the sync server cannot \
                read them.
                """
            )
        }
        Section("Join a household") {
            TextField("Pairing code (XXXX-XXXX-…)", text: $code)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            if DataScannerViewController.isSupported {
                Button("Scan QR code") { showScanner = true }
            }
            Picker("This device is for", selection: $asChild) {
                Text("A guardian").tag(false)
                Text("A child").tag(true)
            }
            Button("Join") {
                Task { await model.joinHousehold(code: code, asChild: asChild) }
            }
            .disabled(code.isEmpty)
        }
        Section {
            Text(
                "Households are created on a computer with the Sitr "
                    + "extension, or on the Sitr Android app.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - In a household

    @State private var revealedCode: String?
    @State private var newPin = ""

    @ViewBuilder private var memberSections: some View {
        let household = model.settings.household!
        let isGuardian = model.settings.role == "guardian"

        Section("This household") {
            LabeledContent("This device", value: model.settings.role ?? "—")
            LabeledContent(
                "Devices",
                value: "\(household.devices.count)/\(Household.maxHouseholdDevices) (fair use)"
            )
            Text(model.settings.syncStatus.describe)
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Sync now") { Task { await model.runSync() } }
        }

        if isGuardian {
            Section("Pairing") {
                if let revealed = revealedCode {
                    Text(revealed)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                    if let image = qrImage(for: revealed) {
                        Image(uiImage: image)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: 220)
                    }
                    Text(
                        "Anyone with this code IS a member of your household "
                            + "— treat it like a house key.")
                        .font(.caption)
                        .foregroundStyle(.red)
                    Button("Hide") { revealedCode = nil }
                } else {
                    Button("Show pairing code") {
                        requirePin("Show the pairing code") {
                            revealedCode = model.pairingCode()
                        }
                    }
                }
            }

            Section("Guardian PIN") {
                Text(
                    household.pin != nil
                        ? "A PIN is set. It gates loosening actions on every household device."
                        : "No PIN set. A PIN adds friction against casual loosening — it is not a security boundary."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                HStack {
                    SecureField("New PIN (4–32 chars)", text: $newPin)
                    Button("Set") {
                        attempt(.changePin, "Change the guardian PIN") {
                            Task {
                                await model.setPin(newPin)
                                newPin = ""
                            }
                        }
                    }
                }
            }

            Section("Household allow list") {
                HouseholdListEditor(allow: true, attempt: attempt)
            }
            Section("Household block list") {
                HouseholdListEditor(allow: false, attempt: attempt)
            }
        }

        Section {
            Button("Leave household", role: .destructive) {
                attempt(.leaveHousehold, "Leave the household") {
                    Task { await model.leaveHousehold() }
                }
            }
        }
    }

    private func qrImage(for text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        guard
            let cgImage = CIContext().createCGImage(scaled, from: scaled.extent)
        else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

struct HouseholdListEditor: View {
    @EnvironmentObject var model: AppModel
    let allow: Bool
    let attempt: (MutationKind, String, @escaping () -> Void) -> Void

    @State private var input = ""
    @State private var error: String?

    private var domains: [String] {
        let household = model.settings.household
        return (allow ? household?.allowDomains : household?.blockDomains) ?? []
    }

    var body: some View {
        HStack {
            TextField("example.com", text: $input)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Add") {
                switch DomainInput.normalize(input) {
                case .failure(let e):
                    error = e.message
                case .success(let domain):
                    error = nil
                    attempt(.addHouseholdRule, "") {
                        Task { await model.addHouseholdDomain(allow: allow, domain: domain) }
                        input = ""
                    }
                }
            }
        }
        if let error {
            Text(error).foregroundStyle(.red).font(.caption)
        }
        ForEach(domains, id: \.self) { domain in
            HStack {
                Text(domain)
                Spacer()
                Button("Remove", role: .destructive) {
                    attempt(.removeHouseholdRule, "Remove \(domain)") {
                        Task { await model.removeHouseholdDomain(allow: allow, domain: domain) }
                    }
                }
                .buttonStyle(.borderless)
            }
        }
        if domains.isEmpty {
            Text("None yet.").foregroundStyle(.secondary).font(.caption)
        }
    }
}

/// System camera scanner for pairing QR codes (iOS 16+, guarded by
/// isSupported at the call site). Camera use is on-tap only — the usage
/// string in App.xcconfig says exactly that.
struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void

        init(onScan: @escaping (String) -> Void) {
            self.onScan = onScan
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            for item in addedItems {
                if case .barcode(let barcode) = item,
                    let value = barcode.payloadStringValue
                {
                    onScan(value)
                    return
                }
            }
        }
    }
}
