# Sitr privacy policy

*Effective: 2026-07-21. This policy covers the Sitr browser extension and
the Sitr apps for iOS and Android. This file is the source of the published
policy; the store listings, the Chrome data-safety form, the Google Play
Data safety form, the Apple App Privacy labels, in-app text, website, and
public statements must all agree
with it.*

## The short version

All filtering happens on your device. Your browsing history never leaves
it. We run no ad network and we don't sell your data.

## What Sitr collects and transmits

Sitr transmits **no data about you**: no browsing history, no URLs, no
identifiers, no device information, no usage analytics, no crash reports.

With no household configured, the extension makes no network requests at
all, and the apps contact no server of ours (the Android app relays your
device's own DNS traffic, described below, but originates nothing). The
rulesets ship inside the extension and app packages and are **identical
for every user** — so we have no way to see which sites you visit.

**Sitr Family sync (optional).** If you create or join a household, the
extension or app contacts exactly one endpoint, which stores a single
end-to-end-encrypted blob of household *settings* (shared allow/block
lists, category configuration, the guardian PIN hash — never browsing
data). Encryption keys are derived on your devices from a secret that is
never transmitted; the server cannot read the blob, keeps no request logs,
stores credentials only hashed, and rounds timestamps to the day. The full
wire protocol and the server's source code are public:
[sync-protocol.md](sync-protocol.md), [data-flow.md](data-flow.md),
[`server/sync/`](../server/sync/). Any future endpoint will be documented
in [data-flow.md](data-flow.md) before it ships.

## The iOS and Android apps

The apps inherit every commitment in this policy verbatim: no analytics,
no crash reports, no accounts, no advertising, no third-party code, no
browsing data transmitted, ever. Sitr Family sync works the same way in
the apps and talks to the same single endpoint.

**Android.** The app filters by DNS. It reads DNS query names on your
device — the hostnames your apps look up — to decide whether to block,
allow, or rewrite them (for SafeSearch). Those names are never
transmitted, logged, or stored; the decision happens in memory and the
name is discarded. Allowed queries are forwarded to the resolver your
device's network already uses — never to a Sitr resolver or any
third-party resolver — so your DNS traffic goes where it would have gone
without Sitr.

**iOS.** Filtering uses Safari content-blocker rules and, when you enable
it, Apple's Screen Time framework. Both apply rules on the device without
reporting anything back; neither gives Sitr any visibility into your
browsing.

Our answers on the Google Play Data safety form and the Apple App Privacy
labels mirror this policy exactly.

## What Sitr stores on your device

Your settings: which optional categories you disabled, which sites you
personally allowed or blocked, and — if you use Sitr Family — your
household's shared lists, its key material, and the guardian PIN (as a
salted hash). These stay in your browser's local extension storage — or,
in the apps, in the app's private local storage — are never uploaded
except as the encrypted household blob described above, and are deleted
when you uninstall the extension or app. On devices managed by an
organization (Sitr for Institutions), the administrator's policy is
delivered read-only through the browser's own enterprise mechanism; it can
force filtering on but cannot make Sitr report anything about you —
nothing in Sitr reports browsing, in any tier.

## Analytics and third parties

Analytics are off by default — in fact, none exist. Sitr contains no
advertising, attribution, analytics, or session-replay SDKs, and no
third-party code that transfers data. Sitr is open source — extension and
apps — so you can verify every one of these statements against the code.
The extension and the Android app's unsigned APK build reproducibly, so
you can confirm the shipped package matches the source; Apple's re-signing
makes a byte-for-byte iOS check impossible for anyone, so there we publish
tagged source, archive checksums, and byte-identical bundled rulesets you
can verify ([mobile.md](mobile.md) §Verifiability).

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
