import CryptoKit
import Foundation
import os
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
    static let blockerOffReason = "the Safari blocker is switched off"

    /// Writing the rules file IS the apply; asking Safari to reload is a
    /// separate step that fails when the user hasn't enabled the blocker in
    /// Settings yet — or, on current iOS, reports success without compiling
    /// anything. Those are different outcomes from a failed write: the
    /// write must block persistence, the reload must NOT (or a user who
    /// hasn't enabled the extension could never change a setting) — but it
    /// must never be reported as active either.
    enum ApplyOutcome {
        /// Written AND reloaded while the blocker was enabled: checksum is
        /// what Safari now enforces.
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

    /// The fragments the settings enable — ONE definition shared by
    /// apply and expectedChecksum so the freshness check can't drift.
    /// An optional list switched on whose fragment is no longer bundled
    /// (dropped in a later version) is skipped, not a failed apply; one
    /// that is bundled but fails verification still fails visibly.
    static func enabledFragments(
        disabledCategories: [String], mediaOff: Set<String>, optionalOn: Set<String>
    ) -> [String] {
        ["adult"]
            + (disabledCategories.contains("sitr_gambling") ? [] : ["gambling"])
            + (disabledCategories.contains("sitr_dating") ? [] : ["dating"])
            + mediaOff.sorted().map { "\($0)-media" }
            + optionalOn.sorted().filter {
                Bundle.main.url(
                    forResource: "\($0).safari", withExtension: "json", subdirectory: "safari") != nil
            }
    }

    /// Whether an optional list's fragment is bundled AND verifies — the
    /// UI offers a switch only for those.
    static func fragmentAvailable(_ name: String) -> Bool {
        if case .success = loadFragments(categories: [name]) { return true }
        return false
    }

    /// The full apply pipeline. Runs the reload via Safari and reports the
    /// checksum of what is now enforced. nil: Safari already holds exactly
    /// these rules (`held`), so nothing is written or reloaded. The list is
    /// built at most once, and not at all when the memo already knows it.
    static func apply(
        disabledCategories: [String],
        mediaOff: Set<String>,
        optionalOn: Set<String>,
        userAllow: [String],
        userBlock: [String],
        householdAllow: [String],
        householdBlock: [String],
        unlessHeld held: String?
    ) async -> Result<ApplyOutcome, ApplyError>? {
        let names = enabledFragments(
            disabledCategories: disabledCategories, mediaOff: mediaOff, optionalOn: optionalOn)
        let key = memoKey(names, userAllow, userBlock, householdAllow, householdBlock)
        if let held, case .success(held)? = memoized(key) { return nil }
        let json: Data
        let checksum: String
        switch build(
            names: names, key: key, userAllow: userAllow, userBlock: userBlock,
            householdAllow: householdAllow, householdBlock: householdBlock)
        {
        case .failure(let e): return .failure(e)
        case .success(let b): (json, checksum) = b
        }
        if checksum == held { return nil }

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
        // "Reload succeeded" is only proof when the blocker is ON. With it
        // off the call can still return cleanly, and Safari then keeps
        // whatever it compiled last — recording a checksum here showed
        // green over rules that were not in force.
        guard await StatusModel.isBlockerEnabled() == true else {
            return .success(.pendingReload(reason: blockerOffReason))
        }
        return .success(.applied(checksum: checksum))
    }

    /// One write-then-reload at a time, process-wide: the foreground
    /// (AppModel) and background (SyncScheduler) paths both come through
    /// here, so their file writes and Safari reloads cannot interleave.
    private static let applyGate = InFlightGate(limit: 1, queueLimit: .max)

    /// What Safari holds after `result` (SafariHeld in SitrCore).
    static func held(after result: Result<ApplyOutcome, ApplyError>) -> SafariHeld.Outcome {
        switch result {
        case .success(.applied(let checksum)): return .applied(checksum: checksum)
        case .success(.pendingReload): return .pendingReload
        case .failure: return .failed
        }
    }

    /// Both paths (AppModel.applySafari, SyncScheduler.syncAndApply): reload
    /// Safari only if what it holds differs from what `s` needs, and record
    /// what it holds afterwards (SafariHeld; only that key, never the whole
    /// settings). nil: it already held them, nothing done.
    static func applyIfNeeded(_ s: AppSettings) async -> (result: Result<ApplyOutcome, ApplyError>, held: String?)? {
        _ = await applyGate.enter()
        let before = SettingsStore.appliedChecksum
        let result = await applyInputs(s, unlessHeld: before)
        let held = result.map { SafariHeld.after(Self.held(after: $0), before: before) } ?? before
        if result != nil { SettingsStore.appliedChecksum = held }
        await applyGate.leave()
        return result.map { ($0, held) }
    }

    /// The rule inputs of a settings value: the household's lists and
    /// category choices win over the device's when joined.
    private static func applyInputs(_ s: AppSettings, unlessHeld held: String?) async -> Result<ApplyOutcome, ApplyError>? {
        await apply(
            disabledCategories: s.household?.disabledCategories ?? s.disabledCategories,
            mediaOff: s.mediaOff,
            optionalOn: s.optionalOn,
            userAllow: s.userAllow,
            userBlock: s.userBlock,
            householdAllow: s.household?.allowDomains ?? [],
            householdBlock: s.household?.blockDomains ?? [],
            unlessHeld: held)
    }

    /// Everything in `s` that shapes the rules; two settings with the same
    /// key produce the same blocker list.
    static func ruleInputsKey(_ s: AppSettings) -> String {
        memoKey(
            enabledFragments(
                disabledCategories: s.household?.disabledCategories ?? s.disabledCategories,
                mediaOff: s.mediaOff, optionalOn: s.optionalOn),
            s.userAllow, s.userBlock, s.household?.allowDomains ?? [],
            s.household?.blockDomains ?? [])
    }

    static func expectedChecksum(_ s: AppSettings) -> Result<String, ApplyError> {
        expectedChecksum(
            disabledCategories: s.household?.disabledCategories ?? s.disabledCategories,
            mediaOff: s.mediaOff,
            optionalOn: s.optionalOn,
            userAllow: s.userAllow,
            userBlock: s.userBlock,
            householdAllow: s.household?.allowDomains ?? [],
            householdBlock: s.household?.blockDomains ?? [])
    }

    /// The checksum the CURRENT settings should produce — compared with
    /// the persisted applied checksum for the freshness half of status. A
    /// failure carries the reason (a fragment that fails verification, or
    /// rules over the cap) so status can say which.
    static func expectedChecksum(
        disabledCategories: [String],
        mediaOff: Set<String>,
        optionalOn: Set<String>,
        userAllow: [String],
        userBlock: [String],
        householdAllow: [String],
        householdBlock: [String]
    ) -> Result<String, ApplyError> {
        let names = enabledFragments(
            disabledCategories: disabledCategories, mediaOff: mediaOff, optionalOn: optionalOn)
        let key = memoKey(names, userAllow, userBlock, householdAllow, householdBlock)
        if let hit = memoized(key) { return hit }
        return build(
            names: names, key: key, userAllow: userAllow, userBlock: userBlock,
            householdAllow: householdAllow, householdBlock: householdBlock
        ).map(\.checksum)
    }

    /// What Safari should hold for these inputs: the blocker list and its
    /// checksum. The one pipeline behind apply and expectedChecksum; the
    /// result (checksum or failure) goes into the memo.
    private static func build(
        names: [String], key: String, userAllow: [String], userBlock: [String],
        householdAllow: [String], householdBlock: [String]
    ) -> Result<(json: Data, checksum: String), ApplyError> {
        let result = loadFragments(categories: names).flatMap { fragments in
            SafariRules.build(
                staticRules: fragments,
                userBlock: userBlock,
                userAllow: userAllow,
                householdBlock: householdBlock,
                householdAllow: householdAllow
            )
            .mapError { ApplyError.fragments($0.message) }
            .map { rules -> (json: Data, checksum: String) in
                let json = SafariRules.serialize(rules)
                return (json, SHA256.hash(data: json).map { String(format: "%02x", $0) }.joined())
            }
        }
        remember(key, result.map(\.checksum))
        return result
    }

    // MARK: - Memo
    // Parsing ~100k bundled rules and serializing them takes a few hundred
    // ms, and one toggle asked for the same checksum three times on the
    // main actor (precheck, apply, status). The bundle cannot change while
    // the app runs, so the inputs fully determine the answer.
    // ponytail: one entry; a status check for other settings evicts it.

    private static let memo = OSAllocatedUnfairLock<(key: String, value: Result<String, ApplyError>)?>(
        initialState: nil)

    private static func memoKey(_ parts: [String]...) -> String {
        parts.map { $0.joined(separator: ",") }.joined(separator: "|")
    }

    private static func remember(_ key: String, _ value: Result<String, ApplyError>) {
        memo.withLock { $0 = (key, value) }
    }

    private static func memoized(_ key: String) -> Result<String, ApplyError>? {
        memo.withLock { $0 }.flatMap { $0.key == key ? $0.value : nil }
    }
}
