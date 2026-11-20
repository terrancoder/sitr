import CoreImage.CIFilterBuiltins
import SitrCore
import StoreKit
import SwiftUI
import VisionKit

/// Sitr Family: join a household by pairing code (or with the key found in
/// iCloud Keychain), or subscribe in the app and create one. Pairing code
/// entry is forgiving; scanning uses the system camera scanner. The
/// pairing code reveal is guardian-only and PIN-gated (except right after
/// this device created the household): possession IS membership.
struct HouseholdView: View {
    @EnvironmentObject var model: AppModel
    let attempt: (MutationKind, String, @escaping () -> Void) -> Void
    let attemptJoin: (@escaping () -> Void) -> Void
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
        .sitrScreenBackground()
        .task { await model.refreshFamily() }
        .alert("Renew on this device?", isPresented: $model.askReplace) {
            Button("Renew here") { Task { await model.createHousehold(replace: true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(Self.replaceWarning)
        }
        .alert("Renew on this device?", isPresented: $confirmRenewHere) {
            Button("Renew here") { Task { await model.renewOnThisDevice() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(Self.replaceWarning)
        }
        .sheet(isPresented: $showScanner) {
            QRScannerView(
                onScan: { scanned in
                    code = scanned
                    showScanner = false
                },
                onFailure: {
                    // A blank sheet with no explanation otherwise.
                    showScanner = false
                    model.lastError =
                        "The camera could not start. Allow camera access for Sitr in Settings, or type the code."
                }
            )
            .sitrAppearance()
        }
    }

    // MARK: - Not in a household

    @State private var code = ""
    @State private var asChild = false
    @State private var showScanner = false
    @State private var confirmRenewHere = false

    static let replaceWarning =
        "Another device renews this subscription. Moving the renewal here can be done only once in 180 days."
    static let privacyURL = URL(string: "https://sitrshield.com/privacy")!
    /// Apple's standard licence agreement until Sitr publishes its own terms.
    static let termsURL = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!

    @ViewBuilder private var joinSections: some View {
        Section {
            Text(
                """
                A household shares its allow/block lists and settings across \
                every device, end-to-end encrypted — the sync server cannot \
                read them.
                """
            )
            .foregroundStyle(Theme.ink)
        }
        .sitrRows()
        Section("Join a household") {
            TextField("Pairing code (XXXX-XXXX-…)", text: $code)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .foregroundStyle(Theme.ink)
            if DataScannerViewController.isSupported {
                Button("Scan QR code") { showScanner = true }
            }
            Picker("This device is for", selection: $asChild) {
                Text("A guardian").tag(false)
                Text("A child").tag(true)
            }
            .foregroundStyle(Theme.ink)
            Button("Join") {
                // Held by "wait before loosening": the household's settings
                // arrive by sync and may be looser than this device's.
                attemptJoin {
                    Task { await model.joinHousehold(code: code, asChild: asChild) }
                }
            }
            .disabled(code.isEmpty)
        }
        .sitrRows()
        Section {
            Text("To join, ask the household's guardian for its pairing code.")
                .font(.caption)
                .foregroundStyle(Theme.inkSoft)
        }
        .sitrRows()
        if model.iCloudKeyFound {
            Section("Household key in iCloud Keychain") {
                Text("A household key from your other Apple devices is on this device.")
                    .foregroundStyle(Theme.ink)
                Button("Join this household") {
                    attemptJoin {
                        Task { await model.joinFromICloudKey(asChild: asChild) }
                    }
                }
            }
            .sitrRows()
        }
        subscribeSection
        familyMessageSection
        iCloudSection
    }

    // MARK: - Subscribe (Sitr Family)

    @ViewBuilder private var subscribeSection: some View {
        Section("Create a household") {
            if model.subscribed {
                Text("Your Sitr Family subscription is active.")
                    .foregroundStyle(Theme.ink)
                Button(model.familyBusy ? "Creating household…" : "Create household") {
                    Task { await model.createHousehold() }
                }
                .disabled(model.familyBusy)
            } else {
                Text("Sitr Family: one household, its lists and settings on all its devices, end-to-end encrypted.")
                    .foregroundStyle(Theme.ink)
                if model.products.isEmpty {
                    Text("Subscriptions are not available right now.")
                        .font(.caption)
                        .foregroundStyle(Theme.inkSoft)
                }
                ForEach(model.products, id: \.id) { product in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(product.displayPrice + Self.perPeriod(product))
                            .font(.title3.bold())
                            .foregroundStyle(Theme.ink)
                        Text(product.displayName).foregroundStyle(Theme.ink)
                        Text(Self.length(product)).font(.caption).foregroundStyle(Theme.inkSoft)
                        Button("Subscribe") { Task { await model.subscribe(product) } }
                            .disabled(model.familyBusy)
                            .accessibilityIdentifier("subscribe.\(product.id)")
                    }
                }
            }
            Button("Restore Purchases") { Task { await model.restorePurchases() } }
            Text(
                "Sitr keeps no account. Apple holds the purchase; this device keeps a random renewal key and "
                    + "the current monthly token, and the sync server never learns who paid."
            )
            .font(.caption)
            .foregroundStyle(Theme.inkSoft)
            HStack {
                Link("Privacy policy", destination: Self.privacyURL)
                Spacer()
                Link("Terms of use", destination: Self.termsURL)
            }
            .font(.caption)
        }
        .sitrRows()
    }

    @ViewBuilder private var familyMessageSection: some View {
        if let message = model.familyMessage {
            Section {
                Text(message).foregroundStyle(Theme.alert)
            }
            .sitrRows()
        }
    }

    @ViewBuilder private var iCloudSection: some View {
        Section {
            Toggle(
                "Keep the household key in iCloud Keychain",
                isOn: Binding(
                    get: { model.keychainInICloud },
                    set: { on in Task { await model.setKeychainInICloud(on) } })
            )
            .foregroundStyle(Theme.ink)
            Text(
                model.keychainInICloud
                    ? "Your other Apple devices get the household key and the renewal key, so they can rejoin and renew."
                    : "The keys stay on this device only. Turning this off removes the iCloud copies from your other devices too."
            )
            .font(.caption)
            .foregroundStyle(Theme.inkSoft)
        }
        .sitrRows()
    }

    static func perPeriod(_ product: Product) -> String {
        switch product.subscription?.subscriptionPeriod.unit {
        case .month: return " / month"
        case .year: return " / year"
        default: return ""
        }
    }

    static func length(_ product: Product) -> String {
        guard let period = product.subscription?.subscriptionPeriod else { return "" }
        let unit: String
        switch period.unit {
        case .day: unit = period.value == 1 ? "day" : "days"
        case .week: unit = period.value == 1 ? "week" : "weeks"
        case .month: unit = period.value == 1 ? "month" : "months"
        case .year: unit = period.value == 1 ? "year" : "years"
        @unknown default: unit = ""
        }
        return "Renews automatically every \(period.value == 1 ? "" : "\(period.value) ")\(unit) until cancelled."
    }

    // MARK: - In a household

    @State private var revealedCode: String?
    @State private var newPin = ""

    static let waitingForFirstSync =
        "Waiting for the first sync with your household. Connect to the internet and tap "
        + "Sync now. The household's PIN and lists appear here after that."

    @ViewBuilder private var memberSections: some View {
        let household = model.settings.household!
        let isGuardian = model.settings.role == "guardian"
        let waiting = Household.isJoinPlaceholder(household)

        Section("This household") {
            LabeledContent("This device", value: model.settings.role ?? "—")
                .foregroundStyle(Theme.ink)
            LabeledContent(
                "Devices",
                value: "\(household.devices.count)/\(Household.maxHouseholdDevices) (fair use)"
            )
            .foregroundStyle(Theme.ink)
            Text(model.settings.syncStatus.describe)
                .font(.caption)
                .foregroundStyle(Theme.inkSoft)
            if waiting {
                Text(Self.waitingForFirstSync).foregroundStyle(Theme.ink)
            }
            if let end = model.familyEnd {
                LabeledContent(
                    "Household runs until",
                    value: Date(timeIntervalSince1970: end / 1000).formatted(date: .abbreviated, time: .shortened)
                )
                .foregroundStyle(Theme.ink)
            }
            if let notice = Family.text(model.familyNotice) {
                Text(notice).foregroundStyle(Theme.alert).accessibilityIdentifier("family.notice")
            }
            if model.offersReplace {
                Button("Renew on this device") { confirmRenewHere = true }
            }
            if model.familyStopped {
                Button("Try the subscription again") { Task { await model.retryFamilyClaim() } }
            }
            Button("Sync now") {
                Task {
                    await model.runSync()
                    await model.refreshFamily()
                }
            }
        }
        .sitrRows()
        familyMessageSection

        if isGuardian && !waiting {
            Section("Pairing") {
                if let revealed = revealedCode ?? model.newPairingCode {
                    Text(revealed)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .foregroundStyle(Theme.gold)
                        .accessibilityIdentifier("pairing.code")
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
                        .foregroundStyle(Theme.alert)
                    Button("Hide") {
                        revealedCode = nil
                        model.newPairingCode = nil
                    }
                } else {
                    Button("Show pairing code") {
                        requirePin("Show the pairing code") {
                            revealedCode = model.pairingCode()
                        }
                    }
                }
            }
            .sitrRows()

            Section("Guardian PIN") {
                Text(
                    household.pin != nil
                        ? "A PIN is set. It gates loosening actions on every household device."
                        : "No PIN set. A PIN adds friction against casual loosening — it is not a security boundary."
                )
                .font(.caption)
                .foregroundStyle(Theme.inkSoft)
                HStack {
                    SecureField("New PIN (4–32 chars)", text: $newPin)
                        .foregroundStyle(Theme.ink)
                    Button("Set") {
                        attempt(.changePin, "Change the guardian PIN") {
                            Task {
                                await model.setPin(newPin)
                                newPin = ""
                            }
                        }
                    }
                }
                .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            }
            .sitrRows()

            Section("Household allow list") {
                HouseholdListEditor(allow: true, attempt: attempt)
            }
            .sitrRows()
            Section("Household block list") {
                HouseholdListEditor(allow: false, attempt: attempt)
            }
            .sitrRows()
        }

        iCloudSection

        Section {
            Button("Leave household", role: .destructive) {
                attempt(.leaveHousehold, "Leave the household") {
                    Task { await model.leaveHousehold() }
                }
            }
            Text(
                "Leaving removes this device from the household's device list. "
                    + "If the sync server cannot be reached, the other devices will still list it.")
                .font(.caption)
                .foregroundStyle(Theme.inkSoft)
        }
        .sitrRows()
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
                .foregroundStyle(Theme.ink)
            Button("Add") {
                switch DomainInput.normalize(input) {
                case .failure(let e):
                    error = e.message
                case .success(let domain):
                    error = nil
                    // An allow rule beats every category block except adult
                    // on every device, so adding one is loosening: the kind
                    // the extension gates it with (PIN when set). An adult-
                    // listed name is refused before the gate.
                    if allow, let refusal = model.allowRefusal(domain) {
                        error = refusal
                        return
                    }
                    attempt(
                        allow ? .addDeviceAllowRule : .addHouseholdRule,
                        allow ? "Allow \(domain) on every household device" : ""
                    ) {
                        Task { await model.addHouseholdDomain(allow: allow, domain: domain) }
                        input = ""
                    }
                }
            }
        }
        .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
        if let error {
            Text(error).foregroundStyle(Theme.alert).font(.caption)
            if error == AdultList.refusal {
                Link("Report a wrongly blocked site", destination: SupportLinks.unblockRequest)
            }
        }
        if allow {
            Text(ListsView.allowExplainer).font(.caption).foregroundStyle(Theme.inkSoft)
        }
        ForEach(domains, id: \.self) { domain in
            HStack {
                Text(domain).foregroundStyle(Theme.ink)
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
            Text("None yet.").foregroundStyle(Theme.inkSoft).font(.caption)
        }
    }
}

/// System camera scanner for pairing QR codes (iOS 16+, guarded by
/// isSupported at the call site). Camera use is on-tap only — the usage
/// string in App.xcconfig says exactly that.
struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onFailure: () -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        do {
            try scanner.startScanning()
        } catch {
            // Camera denied or restricted. Report after this view update.
            DispatchQueue.main.async(execute: onFailure)
        }
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
