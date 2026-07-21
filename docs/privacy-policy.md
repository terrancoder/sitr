# Sitr privacy policy

*Effective: 2026-07-21. This file is the source of the published policy; the
store listing, data-safety form, in-app text, website, and public statements
must all agree with it.*

## The short version

All filtering happens on your device. Your browsing history never leaves
your browser. We run no ad network and we don't sell your data.

## What Sitr collects and transmits

Sitr transmits **no data about you**: no browsing history, no URLs, no
identifiers, no device information, no usage analytics, no crash reports.

With no household configured, the extension makes no network requests at
all. The rulesets ship in the extension package and are **identical for
every user** — so we have no way to see which sites you visit.

**Sitr Family sync (optional).** If you create or join a household, the
extension contacts exactly one endpoint, which stores a single
end-to-end-encrypted blob of household *settings* (shared allow/block
lists, category configuration, the guardian PIN hash — never browsing
data). Encryption keys are derived on your devices from a secret that is
never transmitted; the server cannot read the blob, keeps no request logs,
stores credentials only hashed, and rounds timestamps to the day. The full
wire protocol and the server's source code are public:
[sync-protocol.md](sync-protocol.md), [data-flow.md](data-flow.md),
[`server/sync/`](../server/sync/). Any future endpoint will be documented
in [data-flow.md](data-flow.md) before it ships.

## What Sitr stores on your device

Your settings: which optional categories you disabled, which sites you
personally allowed or blocked, and — if you use Sitr Family — your
household's shared lists, its key material, and the guardian PIN (as a
salted hash). These stay in your browser's local extension storage, are
never uploaded except as the encrypted household blob described above, and
are deleted when you uninstall the extension. On devices managed by an
organization (Sitr for Institutions), the administrator's policy is
delivered read-only through the browser's own enterprise mechanism; it can
force filtering on but cannot make Sitr report anything about you —
nothing in Sitr reports browsing, in any tier.

## Analytics and third parties

Analytics are off by default — in fact, none exist. Sitr contains no
advertising, attribution, analytics, or session-replay SDKs, and no
third-party code that transfers data. The extension is open source; you can
verify every one of these statements against the code, and reproducible
builds let you confirm the published package matches the source.

## Children

Sitr is a content filter and may be installed for family use. Because we
collect no personal information from anyone, we collect none from children.
Sitr Family is built to protect without surveilling: there is no browsing
report, no screenshot feed, and no location tracking of any family member,
and the household sync blob contains settings only, unreadable by us. If a
future feature ever collects personal information from children, it will
require verifiable parental consent and a revision of this policy first
(COPPA).

## Your rights (GDPR/CCPA)

We hold no personal data about you — the household blob is ciphertext we
cannot read, tied to no account, name, or email — so there is nothing for
us to access, export, correct, or delete beyond what you control directly:
leaving a household deletes its data from your device, and a household can
delete its server blob at any time. We do not sell or share personal
information as defined by the CCPA. For questions:
support@sitrshield.com (product & support) or privacy@dooplin.com
(privacy & legal).

## Changes

Policy changes are made in the public repository, so every change is visible
with its full history and rationale.
