import Foundation
import SitrCore

/// "Is this name on Sitr's adult list?" in the app process: the add
/// screens refuse such an allow entry, and the Screen Time filter does not
/// pass one to Apple's filter as an exception. The same sorted,
/// checksum-verified list the DNS filter uses (`adult.domains`, bundled in
/// the app too), and the same parent walk: a listed parent covers its
/// subdomains.
enum AdultList {
    static let refusal =
        "This site is on the adult list and cannot be allowed. If it is listed by mistake, report it."

    /// nil when the bundled list is missing or fails verification.
    static let set: DomainSet? = {
        guard let listURL = Bundle.main.url(forResource: "adult", withExtension: "domains"),
            let sumsURL = Bundle.main.url(forResource: "checksums", withExtension: "json"),
            let list = try? Data(contentsOf: listURL),
            let sums = try? JSONSerialization.jsonObject(with: Data(contentsOf: sumsURL)) as? [String: String],
            let expected = sums["adult.domains"]
        else { return nil }
        return try? DomainSet(artifact: list, expectedSha256Hex: expected)
    }()

    /// Fails closed: with the list unavailable every name counts as listed,
    /// so nothing is allowed past it.
    static func covers(_ name: String) -> Bool {
        guard let set else { return true }
        return DecisionSnapshot.covers(set, name)
    }
}
