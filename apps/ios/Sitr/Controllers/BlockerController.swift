import CryptoKit
import Foundation
import SafariServices
import SitrCore

/// Builds and applies the Safari content-blocker rules — the iOS filtering
/// engine. ENGINE FIRST, PERSIST AFTER: callers hand this controller a
/// candidate configuration; only when the rules are written and Safari has
/// accepted the reload does the caller persist the settings. On failure
/// the previous rules file is restored — settings never claim a state the
/// engine doesn't have.
enum BlockerController {
    static let blockerIdentifier = "com.sitrshield.sitr.blocker"

    /// Writing the rules file IS the apply; asking Safari to reload is a
    /// separate step that legitimately fails when the user hasn't enabled
    /// the blocker in Settings yet. Those are different outcomes: the
    /// first must block persistence, the second must NOT (or a user who
    /// hasn't enabled the extension could never change a setting) — but
    /// it must never be reported as active either.
    enum ApplyOutcome {
        /// Written AND reloaded: checksum is what Safari now enforces.
        case applied(checksum: String)
        /// Written, but Safari did not reload it. No checksum is
        /// recorded, so status derives red ("needs reload" / "blocker
        /// off") until a reload succeeds — never a false green.
        case pendingReload(reason: String)
    }

    enum ApplyError: Error {
        case fragments(String)
        case write(String)
    }

    /// Load the compiler-emitted category fragments from the bundled
    /// `safari/` folder, checksum-verified against its manifest. A
    /// verification failure is surfaced (status shows red) — never
    /// "filter with whatever loaded".
    static func loadFragments(categories: [String]) -> Result<[SafariRule], ApplyError> {
        guard
            let manifestURL = Bundle.main.url(
                forResource: "checksums", withExtension: "json", subdirectory: "safari"),
            let manifestData = try? Data(contentsOf: manifestURL),
            let manifest = (try? JSONSerialization.jsonObject(with: manifestData))
                as? [String: String]
        else {
            return .failure(.fragments("ruleset manifest is missing"))
        }
        var rules: [SafariRule] = []
        for category in categories.sorted() {
            let name = "\(category).safari"
            guard
                let url = Bundle.main.url(
                    forResource: name, withExtension: "json", subdirectory: "safari"),
                let data = try? Data(contentsOf: url)
            else {
                return .failure(.fragments("ruleset \(name).json is missing"))
            }
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }
                .joined()
            guard manifest["\(name).json"] == digest else {
                return .failure(.fragments("ruleset \(name).json failed verification"))
            }
            switch SafariRules.parseFragment(data) {
            case .failure(let e):
                return .failure(.fragments(e.message))
            case .success(let parsed):
                rules.append(contentsOf: parsed)
            }
        }
        return .success(rules)
    }

    /// The full apply pipeline. Runs the reload via Safari and reports the
    /// checksum of what is now enforced.
    static func apply(
        disabledCategories: [String],
        userAllow: [String],
        userBlock: [String],
        householdAllow: [String],
        householdBlock: [String]
    ) async -> Result<ApplyOutcome, ApplyError> {
        let enabled = ["adult"]
            + (disabledCategories.contains("sitr_gambling") ? [] : ["gambling"])
            + (disabledCategories.contains("sitr_dating") ? [] : ["dating"])

        let fragments: [SafariRule]
        switch loadFragments(categories: enabled) {
        case .failure(let e): return .failure(e)
        case .success(let loaded): fragments = loaded
        }

        let built = SafariRules.build(
            staticRules: fragments,
            userBlock: userBlock,
            userAllow: userAllow,
            householdBlock: householdBlock,
            householdAllow: householdAllow
        )
        let rules: [SafariRule]
        switch built {
        case .failure(let e): return .failure(.fragments(e.message))
        case .success(let b): rules = b
        }
        let json = SafariRules.serialize(rules)
        let checksum = SHA256.hash(data: json).map { String(format: "%02x", $0) }
            .joined()

        guard let container = Storage.groupContainer else {
            return .failure(.write("app group container unavailable"))
        }
        let target = container.appendingPathComponent("blockerList.json")

        // Atomic write: Safari never sees a half-written rule list. The
        // file is kept even when the reload below fails — it is the
        // intended state, and Safari picks it up as soon as the user
        // enables the blocker.
        do {
            try json.write(to: target, options: .atomic)
        } catch {
            return .failure(.write("could not write rules: \(error.localizedDescription)"))
        }

        do {
            try await SFContentBlockerManager.reloadContentBlocker(
                withIdentifier: blockerIdentifier)
        } catch {
            return .success(.pendingReload(reason: error.localizedDescription))
        }
        return .success(.applied(checksum: checksum))
    }

    /// The checksum the CURRENT settings should produce — compared with
    /// the persisted applied checksum for the freshness half of status.
    static func expectedChecksum(
        disabledCategories: [String],
        userAllow: [String],
        userBlock: [String],
        householdAllow: [String],
        householdBlock: [String]
    ) -> String? {
        let enabled = ["adult"]
            + (disabledCategories.contains("sitr_gambling") ? [] : ["gambling"])
            + (disabledCategories.contains("sitr_dating") ? [] : ["dating"])
        guard case .success(let fragments) = loadFragments(categories: enabled),
            case .success(let rules) = SafariRules.build(
                staticRules: fragments,
                userBlock: userBlock,
                userAllow: userAllow,
                householdBlock: householdBlock,
                householdAllow: householdAllow)
        else { return nil }
        return SHA256.hash(data: SafariRules.serialize(rules))
            .map { String(format: "%02x", $0) }.joined()
    }
}
