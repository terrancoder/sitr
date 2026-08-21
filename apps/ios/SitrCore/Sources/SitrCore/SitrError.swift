/// Error type for every fallible SitrCore operation — the Swift analogue of
/// the reference implementation's `Result<T, string>` (extension/src/lib/
/// result.ts): errors are user-readable messages, matched by tests only on
/// success/failure, never on wording.
public struct SitrError: Error, Equatable, CustomStringConvertible {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}
