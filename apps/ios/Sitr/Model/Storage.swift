import Foundation
import Security

/// Local persistence: settings in the App Group's UserDefaults (mirroring
/// the extension's storage.local keys, docs/data-flow.md), and the
/// household root secret in the Keychain — the blocker extension never
/// needs the secret, so it deliberately does NOT live in the group
/// container. At-rest hygiene, not a security boundary (threat-model T7).
///
/// Backups: the key is this-device-only. The settings (lists, PIN record)
/// are in the App Group's defaults, which iOS does include in a device
/// backup; a device restored from one has the household's settings but no
/// key, and AppModel.runSync says so until it re-joins.
enum Storage {
    static let appGroup = "group.com.sitrshield.sitr"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    static var groupContainer: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroup)
    }

    // MARK: - Keychain (root secret)

    private static let secretAccount = "sitr-household-root-secret"

    /// After first unlock (background refresh needs it) and THIS DEVICE
    /// ONLY: the household key must not travel to another device inside a
    /// backup. Returns false when the Keychain refused the item.
    @discardableResult
    static func saveRootSecret(_ secret: Data) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: secretAccount,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = secret
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    /// Keys stored by earlier builds were allowed into backups; move them
    /// to this-device-only. One attribute update, harmless to repeat.
    static func pinRootSecretToThisDevice() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: secretAccount,
        ]
        let update: [String: Any] = [
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        SecItemUpdate(query as CFDictionary, update as CFDictionary)
    }

    static func loadRootSecret() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: secretAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess
        else { return nil }
        return result as? Data
    }

    static func clearRootSecret() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: secretAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
