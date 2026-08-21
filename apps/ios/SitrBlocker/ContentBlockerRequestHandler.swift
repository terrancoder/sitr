import Foundation
import UniformTypeIdentifiers

/// Safari asks this extension for its rule list on every reload.
///
/// The app regenerates `blockerList.json` in the shared App Group
/// container (engine-first apply in BlockerController) and calls
/// SFContentBlockerManager.reloadContentBlocker; this handler serves that
/// file, falling back to the bundled compiler-emitted default (every
/// category on, no dynamic rules) so the blocker protects from first
/// launch, before the app has ever run.
class ContentBlockerRequestHandler: NSObject, NSExtensionRequestHandling {
    static let appGroup = "group.com.sitrshield.sitr"

    func beginRequest(with context: NSExtensionContext) {
        let url = rulesURL()
        let attachment = NSItemProvider(contentsOf: url)!
        let item = NSExtensionItem()
        item.attachments = [attachment]
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }

    private func rulesURL() -> URL {
        if let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroup
        ) {
            let generated = container.appendingPathComponent("blockerList.json")
            if FileManager.default.fileExists(atPath: generated.path) {
                return generated
            }
        }
        return Bundle.main.url(
            forResource: "blockerList.default", withExtension: "json"
        )!
    }
}
