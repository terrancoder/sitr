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
| Safari manifest | derived from `extension/manifest.json` at stage time | Two deliberate diffs: event-page background (`persistent: false`) instead of a service worker; the Chrome-only `storage.managed_schema` key dropped |
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
  household creation and the entitlement token, like Android.
- **Mac App Store**: must ship join-only with the purchase-steering
  strings stripped (`store-review-risk-register.md`); the stager refuses
  `--channel mas` until that stripping step exists, so an App Store
  bundle cannot be produced by accident.

## Verifiability

Apple re-signs distributed builds, so byte-comparing the shipped app
against a local build is not possible (same honesty as iOS,
`docs/mobile.md`). Compensations: the staged extension resources inside
the appex survive signing byte-identical and can be checked against the
published `checksums.json`; the DMG channel is reproducible up to the
signature.
