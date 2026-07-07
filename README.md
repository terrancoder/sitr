# Sitr — سِتْر

**A halal/family content filter whose privacy you can verify, not just trust.**

Sitr is a Manifest V3 browser extension that blocks adult, gambling and dating
sites and enforces SafeSearch (Google, Bing, DuckDuckGo) and YouTube
Restricted Mode — entirely **on your device**, using the browser's
`declarativeNetRequest` engine.

## Why it's private by construction

- **All filtering happens on your device.** Your browsing history never leaves
  your browser. The extension makes no per-request server calls and cannot
  read page contents.
- **The blocklist is identical for every user** and lives publicly in
  [`blocklist/`](blocklist/) — so there is structurally no way for us to see
  which sites you visit, and you can see and contest every rule.
- **No ad networks, no analytics SDKs, no telemetry.** None. Not opt-out —
  absent.
- **Deterministic builds.** [`tools/compiler`](tools/compiler/) turns the
  public domain lists into the shipped DNR rulesets byte-reproducibly; CI
  publishes SHA-256 checksums so anyone can rebuild and compare.
- **Failures are visible.** If protection isn't provably active, the extension
  shows a red "Protection INACTIVE" badge — it never pretends.

See [CLAUDE.md](CLAUDE.md) for the full trust contract and architecture.

## Repository layout

| Path | What |
|---|---|
| `extension/` | The MV3 extension (manifest, service worker, popup) |
| `extension/rulesets/` | **Generated** DNR JSON — never hand-edit |
| `blocklist/` | Public blocklist sources + inclusion policy + appeals process |
| `tools/compiler/` | Deterministic list → DNR ruleset compiler |
| `tests/` | Golden compilation, validation, and fail-visible tests |
| `docs/` | Architecture, [data flow](docs/data-flow.md) (every endpoint — currently zero), [privacy policy](docs/privacy-policy.md), [threat model](docs/threat-model.md), [why competitor failed](docs/why-competitor-failed.md) |

## Build

```sh
npm ci
npm test          # builds compiler + rulesets + extension, then runs tests
```

Load `extension/` as an unpacked extension in Chrome (`chrome://extensions`,
Developer mode → "Load unpacked") after a build.

## Contributing to the blocklist

Read [`blocklist/policy/inclusion-policy.md`](blocklist/policy/inclusion-policy.md),
then open a pull request editing the relevant `domains.txt`. Wrongly blocked?
See the [appeals process](blocklist/policy/appeals-process.md).
