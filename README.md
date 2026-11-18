# Sitr — سِتْر

**A halal/family content filter whose privacy you can verify, not just trust.**

Sitr is a Manifest V3 browser extension that blocks adult, gambling and dating
sites (about 100,000 domains from a public list) and enforces SafeSearch (Google, Bing, DuckDuckGo) and YouTube
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

See [docs/architecture.md](docs/architecture.md) and
[docs/threat-model.md](docs/threat-model.md) for the full architecture and
trust model.

## Repository layout

| Path | What |
|---|---|
| `extension/` | The MV3 extension (manifest, service worker, popup) |
| `extension/rulesets/` | **Generated** DNR JSON — never hand-edit |
| `blocklist/` | Public blocklist sources + inclusion policy + appeals process |
| `tools/compiler/` | Deterministic list → DNR ruleset compiler |
| `server/sync/` | Sitr Family sync server — a blind mailbox for E2E-encrypted blobs ([protocol](docs/sync-protocol.md)) |
| `tests/` | Golden compilation, validation, and fail-visible tests |
| `docs/` | Architecture, [data flow](docs/data-flow.md) (every endpoint — currently one, the opt-in Family sync), [privacy policy](docs/privacy-policy.md), [threat model](docs/threat-model.md), [design lessons](docs/design-lessons.md) |

## Build

```sh
npm ci
npm test          # builds compiler + rulesets + extension, then runs tests
npm run smoke     # real-browser end-to-end test (blocking + SafeSearch)
```

The smoke test needs a Chromium-based browser that honors `--load-extension`
(branded Chrome/Edge stopped supporting it in 137). Download
[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)
into `~/.cache/chrome-for-testing/` or point `SITR_CHROME` at a binary.

Load `extension/` as an unpacked extension in Chrome (`chrome://extensions`,
Developer mode → "Load unpacked") after a build.

## Contributing to the blocklist

The list has two tiers per category: a hand-curated tier (`domains.txt`,
evidence for each domain in its pull request) and an imported tier
(`imported.txt`, about 100,000 names in all, written only by `tools/import`
from public lists named in
[`blocklist/imports/sources.json`](blocklist/imports/sources.json)).
Imported entries were judged by domain name only, not site by site, so
some will be wrong; the appeals process is how those get fixed.

Read [`blocklist/policy/inclusion-policy.md`](blocklist/policy/inclusion-policy.md),
then open a pull request editing the relevant `domains.txt`. Wrongly blocked?
See the [appeals process](blocklist/policy/appeals-process.md). You can also
use the issue forms: [ask to block a site](https://github.com/terrancoder/sitr/issues/new?template=block-request.yml)
or [report a wrongly blocked site](https://github.com/terrancoder/sitr/issues/new?template=unblock-request.yml).
The "Report a site" links in the extension and apps open these same forms,
or your mail app; Sitr sends nothing itself. A GitHub issue is public.

## Licence

The code is licensed under the [Mozilla Public License 2.0](LICENSE). The
blocklist data (everything under `blocklist/`) and the compiled list
artifacts (`extension/rulesets/`, `apps/shared/blocklists/`) are licensed
separately under [CC BY-SA 4.0](blocklist/LICENSE); the open lists they
include are credited in
[`blocklist/imports/ATTRIBUTION.md`](blocklist/imports/ATTRIBUTION.md). A
generated `NOTICE.txt` with the same credits ships inside the packed
extension and the iOS and Android apps.
