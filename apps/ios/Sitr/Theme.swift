import SwiftUI
import UIKit

/// Sitr's visual identity — the sitrshield.com design tokens, expressed
/// as dynamic colors that follow the effective color scheme. Code-only
/// on purpose: no asset catalog, no dependencies.
///
/// Semantics matter more than aesthetics here: `green` means PROVEN
/// active and `alert` (red) means inactive/unknown — the fail-visible
/// status contract. Never soften the red.
enum Theme {
    // MARK: - Palette (light / dark, exact site values)

    /// Page background.
    static let paper = dynamic(light: 0xF4EFE4, dark: 0x121A16)
    /// Card / row background.
    static let paper2 = dynamic(light: 0xECE5D4, dark: 0x0D1411)
    /// Primary text.
    static let ink = dynamic(light: 0x1D2A24, dark: 0xE4DDC9)
    /// Secondary text.
    static let inkSoft = dynamic(light: 0x51604F, dark: 0x94A093)
    /// Brand + proven-active status.
    static let green = dynamic(light: 0x0F5C46, dark: 0x3AA886)
    /// Deep brand green (emphasis).
    static let greenDeep = dynamic(light: 0x0A3F30, dark: 0x2C8168)
    /// Highlight accent.
    static let gold = dynamic(light: 0xA37E2C, dark: 0xC9A558)
    /// Soft highlight accent.
    static let goldSoft = dynamic(light: 0xC4A45C, dark: 0xA3873F)
    /// Hairlines / dividers.
    static let rule = dynamic(light: 0xC9BFA6, dark: 0x2C3A32)
    /// Fail-visible red — NOT a site token; deliberately alarming in
    /// both schemes. Used for inactive/unknown/stale protection status.
    static let alert = dynamic(light: 0xC62828, dark: 0xE05D5D)

    // MARK: - Appearance setting

    /// Values stored under the "appearance" @AppStorage key.
    static let appearanceKey = "appearance"

    /// "system" | "light" | "dark" → the scheme to force (nil = system).
    static func colorScheme(for appearance: String) -> ColorScheme? {
        switch appearance {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    // MARK: - Navigation chrome

    /// Paints the navigation bar with the palette (dynamic colors, so a
    /// forced scheme or a system switch both repaint it). Called once at
    /// app start.
    static func applyChrome() {
        let ink = uiDynamic(light: 0x1D2A24, dark: 0xE4DDC9)
        let titleAttributes: [NSAttributedString.Key: Any] = [.foregroundColor: ink]

        let scrolled = UINavigationBarAppearance()
        scrolled.configureWithOpaqueBackground()
        scrolled.backgroundColor = uiDynamic(light: 0xECE5D4, dark: 0x0D1411)
        scrolled.shadowColor = uiDynamic(light: 0xC9BFA6, dark: 0x2C3A32)
        scrolled.titleTextAttributes = titleAttributes
        scrolled.largeTitleTextAttributes = titleAttributes

        let edge = UINavigationBarAppearance()
        edge.configureWithTransparentBackground()
        edge.titleTextAttributes = titleAttributes
        edge.largeTitleTextAttributes = titleAttributes

        UINavigationBar.appearance().standardAppearance = scrolled
        UINavigationBar.appearance().compactAppearance = scrolled
        UINavigationBar.appearance().scrollEdgeAppearance = edge
    }

    // MARK: - Helpers

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiDynamic(light: light, dark: dark))
    }

    private static func uiDynamic(light: UInt32, dark: UInt32) -> UIColor {
        UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
        }
    }
}

extension UIColor {
    fileprivate convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

// MARK: - Shared view styling

/// Applies the user's appearance choice ("system"|"light"|"dark") as a
/// preferred color scheme. Used at the window root and re-applied on
/// sheet roots (sheets are separate presentations).
struct SitrAppearance: ViewModifier {
    @AppStorage(Theme.appearanceKey) private var appearance = "system"

    func body(content: Content) -> some View {
        content.preferredColorScheme(Theme.colorScheme(for: appearance))
    }
}

extension View {
    func sitrAppearance() -> some View {
        modifier(SitrAppearance())
    }

    /// Paper page background behind a List/Form (hides the system
    /// grouped background).
    func sitrScreenBackground() -> some View {
        self
            .scrollContentBackground(.hidden)
            .background(Theme.paper.ignoresSafeArea())
    }

    /// Row chrome shared by every list section: paper2 cards, rule
    /// hairlines.
    func sitrRows() -> some View {
        self
            .listRowBackground(Theme.paper2)
            .listRowSeparatorTint(Theme.rule)
    }
}
