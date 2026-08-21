import Foundation
import Security

/// Local persistence: settings in the App Group's UserDefaults (mirroring
/// the extension's storage.local keys, docs/data-flow.md), and the
/// household root secret in the Keychain — the blocker extension never
/// needs the secret, so it deliberately does NOT live in the group
/// container. At-rest hygiene, not a security boundary (threat-model T7).
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

    static func saveRootSecret(_ secret: Data) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: secretAccount,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = secret
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
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
