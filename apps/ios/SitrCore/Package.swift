// swift-tools-version: 6.0
// SitrCore — the dependency-free shared core of the Sitr iOS app.
//
// Faithful Swift port of extension/src/lib (the reference TypeScript
// implementation). Every ported behavior is pinned by the conformance
// fixtures in apps/shared/fixtures — see docs/mobile.md. Uses ONLY Apple
// system frameworks (CryptoKit, CommonCrypto, Foundation): zero third-party
// dependencies, same bar as the extension (threat-model.md T4).
import PackageDescription

let package = Package(
    name: "SitrCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "SitrCore", targets: ["SitrCore"])
    ],
    targets: [
        .target(name: "SitrCore", swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(
            name: "SitrCoreTests",
            dependencies: ["SitrCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
