import Foundation
import Security
import SitrCore

/// Local persistence: settings in the App Group's UserDefaults (mirroring
/// the extension's storage.local keys, docs/data-flow.md), and two secrets
/// in the Keychain: the household root secret and the Sitr Family claim
/// secret. The blocker extension never needs either, so they deliberately
/// do NOT live in the group container. At-rest hygiene, not a security
/// boundary (threat-model T7).
///
/// iCloud Keychain (docs/sync-protocol.md §iCloud Keychain): with the
/// switch on (the default) both secrets are synchronizable items, so the
/// buyer's other Apple devices can rejoin and renew; off, they are
/// this-device-only, and the synchronizable copies are deleted. Device
/// backups never carry a this-device-only item; the settings (lists, PIN
/// record) are in the App Group's defaults, which iOS does include in a
/// backup.
enum Storage {
    static let appGroup = "group.com.sitrshield.sitr"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    static var groupContainer: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroup)
    }

    // MARK: - Keychain

    private static let secretAccount = "sitr-household-root-secret"
    private static let claimSecretAccount = "sitr-family-claim-secret"
    private static let iCloudKey = "keychainInICloud"

    /// "Keep the household key in iCloud Keychain" — on unless turned off.
    static var keychainInICloud: Bool {
        defaults.object(forKey: iCloudKey) as? Bool ?? true
    }

    private static func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account]
    }

    /// After first unlock (background refresh needs it); synchronizable or
    /// this-device-only by the switch. Replaces any copy of either kind.
    @discardableResult
    private static func save(_ data: Data, account: String, synced: Bool) -> Bool {
        var any = base(account)
        any[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny
        SecItemDelete(any as CFDictionary)
        var add = base(account)
        add[kSecValueData as String] = data
        add[kSecAttrSynchronizable as String] = synced
        add[kSecAttrAccessible as String] =
            synced ? kSecAttrAccessibleAfterFirstUnlock : kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    /// `synced`: nil = either kind (a synced copy may have arrived from
    /// another device).
    private static func load(account: String, synced: Bool? = nil) -> Data? {
        var query = base(account)
        query[kSecAttrSynchronizable as String] = synced.map { $0 as Any } ?? kSecAttrSynchronizableAny
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    private static func delete(account: String, synced: Bool? = nil) {
        var query = base(account)
        query[kSecAttrSynchronizable as String] = synced.map { $0 as Any } ?? kSecAttrSynchronizableAny
        SecItemDelete(query as CFDictionary)
    }

    /// Off writes this-device-only items and deletes the synchronizable
    /// ones (which removes them from the user's other devices too).
    static func setKeychainInICloud(_ on: Bool) {
        defaults.set(on, forKey: iCloudKey)
        applyKeychainMode()
    }

    /// At launch and on a switch change: every secret is stored the way the
    /// switch says. Replaces the old "pin to this device" migration.
    static func applyKeychainMode() {
        let on = keychainInICloud
        for account in [secretAccount, claimSecretAccount] {
            guard load(account: account, synced: on) == nil, let value = load(account: account) else { continue }
            save(value, account: account, synced: on)
        }
    }

    // MARK: - Root secret

    @discardableResult
    static func saveRootSecret(_ secret: Data) -> Bool {
        save(secret, account: secretAccount, synced: keychainInICloud)
    }

    static func loadRootSecret() -> Data? {
        load(account: secretAccount)
    }

    /// Leaving the household. With iCloud Keychain on, the synced key is
    /// kept: deleting it would take the household away from the user's
    /// other devices. This device then only offers to join again.
    static func clearRootSecret() {
        if keychainInICloud { return }
        delete(account: secretAccount)
    }

    /// A key made for a household whose creation failed: never used, so
    /// removed whichever way it was stored.
    static func forgetRootSecret() {
        delete(account: secretAccount)
    }

    // MARK: - Claim secret (Sitr Family)

    /// 32 random bytes, made before the first claim and sent with every
    /// claim; never to the sync server, never into the household blob.
    static func claimSecret() -> Data? {
        if let existing = load(account: claimSecretAccount) { return existing }
        let fresh = SyncCrypto.generateRootSecret()
        return save(fresh, account: claimSecretAccount, synced: keychainInICloud) ? fresh : nil
    }
}
