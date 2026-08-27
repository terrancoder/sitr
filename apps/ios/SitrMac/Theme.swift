/// sitrshield.com design tokens for the mac host app — the exact palette
/// the site defines for its light and dark themes, switched by the same
/// tri-state the site uses: follow the system, or force either mode.
import SwiftUI

enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

struct Theme {
    let paper: Color
    let paper2: Color
    let ink: Color
    let inkSoft: Color
    let green: Color
    let gold: Color
    let rule: Color
    /// Fail-visible red — semantic, never softened toward the brand hues.
    let alert: Color

    static let light = Theme(
        paper: Color(hex: 0xF4EFE4), paper2: Color(hex: 0xECE5D4),
        ink: Color(hex: 0x1D2A24), inkSoft: Color(hex: 0x51604F),
        green: Color(hex: 0x0F5C46), gold: Color(hex: 0xA37E2C),
        rule: Color(hex: 0xC9BFA6), alert: Color(hex: 0xC62828))

    static let dark = Theme(
        paper: Color(hex: 0x121A16), paper2: Color(hex: 0x0D1411),
        ink: Color(hex: 0xE4DDC9), inkSoft: Color(hex: 0x94A093),
        green: Color(hex: 0x3AA886), gold: Color(hex: 0xC9A558),
        rule: Color(hex: 0x2C3A32), alert: Color(hex: 0xE05D5D))

    static func current(_ scheme: ColorScheme) -> Theme {
        scheme == .dark ? .dark : .light
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255)
    }
}
