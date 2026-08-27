# Sitr for Safari (macOS)

The macOS build ships the **same extension codebase** that runs on
Chrome — same TypeScript, same committed DNR rulesets, byte-identical —
inside the Apple-required wrapper: a thin host app (`SitrMac`) plus a
Safari Web Extension appex (`SitrWebExtension`), both in
`apps/ios/Sitr.xcodeproj`. Threat-model coverage: T13.

## How the pieces fit

| Piece | Source | Job |
|---|---|---|
| Web extension bundle | `tools/pack/stage-safari.mjs` → `build/safari-extension/` | Deterministic staging of manifest + dist JS + rulesets (checksums.json emitted alongside) |
| Safari manifest | derived from `extension/manifest.json` at stage time | The MV3 module service worker is kept unchanged; the Chrome-only `storage.managed_schema` key is dropped; `declarativeNetRequestWithHostAccess` is added (Safari gates redirect/header rules behind it) |
| `SitrWebExtension.appex` | `apps/ios/SitrWebExtension/` | Bundles the staged files at its Resources root via a build-phase copy; native handler is deliberately inert (no native messaging) |
| `SitrMac.app` | `apps/ios/SitrMac/` | Fail-visible status (red until Safari proves the extension enabled) + enablement walkthrough. No network code — the one-call-site invariant lives in the extension's sync client |

## Requirements and floor

Safari **26** or newer (macOS 14+). Older Safari mis-enforced DNR
priorities (T13); the extension refuses to claim protection there.

## Building and running locally

```
npm run stage:safari                      # stage the extension bundle
cd apps/ios
xcodebuild build -project Sitr.xcodeproj -scheme SitrMac
```

Open the built `SitrMac.app` once so macOS registers the extension, then
in Safari: Settings → Extensions → enable **Sitr**, and grant it access
to the search-engine sites (SafeSearch needs them; the extension shows
red until the grants exist). A development build is signed to run
locally only, so Safari additionally needs Develop → Developer Settings →
**Allow unsigned extensions** for the session.

## Distribution channels

- **Developer ID** (notarized, from sitrshield.com): full UI — including
  household creation and the entitlement token, like Android. Default
  staging channel.
- **Mac App Store**: join-only. `stage-safari.mjs --channel mas` excludes
  the full-channel module (household creation + token entry), strips its
  options-page block, and then a grep gate proves the bundle carries no
  purchase-steering strings — a gate failure fails the build
  (`tests/src/stageSafari.test.ts` pins all of this).

## Mac App Store submission runbook

One-time setup (account: see `Udocs/store-accounts-guide.md`):

1. `Configs/Local.xcconfig` (gitignored): `DEVELOPMENT_TEAM = <team id>`.
2. Register both bundle ids on the developer portal:
   `com.sitrshield.sitr.mac` and `com.sitrshield.sitr.mac.webext`.
3. App Store Connect: create the app record; paste the copy from
   `extension/store-listing/mac-app-store.md`; App Privacy answers mirror
   the iOS app's.

Each release:

1. Bump `CURRENT_PROJECT_VERSION` in `Configs/MacShared.xcconfig` (App
   Store Connect requires a strictly increasing build number per upload).
2. Build and archive — the `SITR_REQUIRE_CHANNEL` assertion fails the
   build if the staged bundle is not the join-only mas channel:

```
npm test                                # everything green, artifacts fresh
node tools/pack/stage-safari.mjs --channel mas
cd apps/ios
xcodebuild archive -project Sitr.xcodeproj -scheme SitrMac \
  -archivePath build/SitrMac.xcarchive \
  "SITR_WEBEXT_BUNDLE=$PWD/../../build/safari-extension-mas" \
  SITR_REQUIRE_CHANNEL=mas
```

3. In App Store Connect's PRIVATE review-notes field (never in the repo —
   a pairing code IS a household root secret): a freshly generated
   throwaway household's pairing code so review can test Family join, a
   line that household creation happens on other platforms, and the
   enable-in-Safari + grant-website-access steps (first run shows red by
   design until the grants exist).
4. Before submitting, verify a Family join round-trip on-device in a
   signed build (the appex's `network.client` entitlement carries the
   sync fetch).

then Organizer → Distribute → App Store Connect (or `xcodebuild
-exportArchive` with an app-store-connect export options plist). The
appex's staged resources survive signing byte-identical — verify the
uploaded build against `build/safari-extension-mas/checksums.json`.

Review-day notes: the host app's status window + enablement walkthrough
is its review-facing functionality; `ITSAppUsesNonExemptEncryption` is
declared false (HTTPS + standard WebCrypto only — the exempt category;
revisit if the crypto surface ever changes).

## Verifiability

Apple re-signs distributed builds, so byte-comparing the shipped app
against a local build is not possible (same honesty as iOS,
`docs/mobile.md`). Compensations: the staged extension resources inside
the appex survive signing byte-identical and can be checked against the
published `checksums.json`; the DMG channel is reproducible up to the
signature.
