/// Domain validation and free-text normalization.
/// Port of isValidDomain / normalizeDomainInput from
/// extension/src/lib/userRules.ts — the same conservative check the
/// blocklist compiler uses.
import Foundation

public enum DomainInput {
    /// Lowercase ASCII LDH labels, ≥2 labels, ≤253 chars — identical to the
    /// reference's per-label regex `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`.
    public static func isValidDomain(_ domain: String) -> Bool {
        if domain.isEmpty || domain.count > 253 { return false }
        let labels = domain.split(separator: ".", omittingEmptySubsequences: false)
        if labels.count < 2 { return false }
        return labels.allSatisfy { label in
            guard label.count >= 1 && label.count <= 63 else { return false }
            let chars = Array(label.unicodeScalars)
            func alnum(_ c: Unicode.Scalar) -> Bool {
                (c >= "a" && c <= "z") || (c >= "0" && c <= "9")
            }
            guard alnum(chars.first!), alnum(chars.last!) else { return false }
            return chars.allSatisfy { alnum($0) || $0 == "-" }
        }
    }

    /// Normalize free-text user input ("HTTPS://Example.com/x") to a domain.
    public static func normalize(_ input: String) -> Result<String, SitrError> {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        s = s.replacingOccurrences(
            of: "^[a-z][a-z0-9+.-]*://", with: "", options: .regularExpression)
        s = s.replacingOccurrences(
            of: "[/?#].*$", with: "", options: .regularExpression)
        s = s.replacingOccurrences(
            of: ":\\d+$", with: "", options: .regularExpression)
        s = s.replacingOccurrences(
            of: "^www\\.", with: "", options: .regularExpression)
        guard isValidDomain(s) else {
            return .failure(
                SitrError(
                    "\"\(input.trimmingCharacters(in: .whitespacesAndNewlines))\" is not a valid domain"
                ))
        }
        return .success(s)
    }
}
