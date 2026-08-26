/// Native side of the Safari Web Extension appex.
///
/// Deliberately inert: the extension never uses native messaging (the
/// JavaScript side is the same audited code the Chrome extension ships,
/// and its only I/O is Safari's own storage/DNR APIs plus the one sync
/// call site). This class exists because the extension point requires a
/// principal class; it answers any unexpected message with nothing.
import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: nil)
    }
}
