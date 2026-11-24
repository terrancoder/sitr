# Sitr mobile

Sitr ships as two native mobile apps alongside the extension:
`apps/ios/` (Swift/SwiftUI, iOS 16+) and `apps/android/` (Kotlin/Compose).
This document is the mobile companion to [architecture.md](architecture.md).
Mobile-specific threats are covered in [threat-model.md](threat-model.md)
(T9, T10, T14).

## Overview

The apps are new clients of the existing system, not a new system.

**Shared, unchanged:**

- Blocklist sources (`blocklist/sources/`, both tiers, and the opt-in
  lists in `blocklist/optional/`) and the one compiler
  (`tools/compiler`) — every platform's rules come from the same lists.
  The one platform-specific list is the encrypted-DNS hosts list, used
  only by the DNS filters (Android, and iOS when its DNS filter is on).
- The sync protocol ([sync-protocol.md](sync-protocol.md)). iOS and
  Android are additional clients of the same single endpoint; nothing on
  the wire changes.
- Gate semantics: the layer ladder (the adult list first, which no allow
  entry opens; then managed > household > device user > the other static
  lists; Android also puts the gambling and dating lists first, with no
  switch to turn them off)
  and the guardian PIN as **friction, not security** — except on an
  Android phone under the child lock, where it is the boundary
  ([threat-model.md](threat-model.md) T7, [child-lock.md](child-lock.md)). On Android, managed
  configurations (`RestrictionsManager`) deliver the managed layer — the
  strongest gate.
- Fail-visible discipline: anything less than proof of protection renders
  red. On Android that is a persistent notification (the badge's
  equivalent); on iOS, the status screen.
- The working-agreement constraints: zero third-party runtime
  dependencies (Apple system frameworks / AndroidX only), no analytics,
  no crash reporting, one HTTP call site per client codebase (the sync
  client), sync failures never affect protection status, engine-first —
  persist-after (a setting is applied to the engine before it is recorded
  as applied), and the 20-device fair-use cap.

**Per-platform: the filtering engine.** Chrome has DNR; iOS has a Safari
content blocker plus optional Screen Time and an optional DNS-only packet
tunnel; Android has a local DNS-only `VpnService`. Summaries below.

Households work over the unchanged protocol. iOS is **join-only**: it has
no entitlement token UI at all — the server checks entitlement tokens only
on household *creation*, and joining needs none (this also keeps the app
entirely clear of App Store rule 3.1.1). Android has a neutral "paste your
Sitr Family token" field for household creation — no purchase links, no
steering. QR codes (displayed on both platforms; scanned on iOS via
`DataScannerViewController`, Android scanning deferred) are a presentation
of the existing pairing code, not a protocol change.

Both apps are MPL-2.0 source (the blocklist data is CC BY-SA 4.0). The
Android app is free on Google Play. What a user can actually verify is
below (§Verifiability).

## Artifact pipeline

One compiler invocation produces every platform's artifact. If any emitter
fails, nothing is written.

```
blocklist/sources/{adult,gambling,dating}/{domains,imported}.txt
blocklist/optional/{violence,doh}/
        |
        v
  tools/compiler            one invocation, all emitters,
        |                   all-or-nothing
        +--> extension/rulesets/                Chrome DNR JSON
        +--> apps/shared/blocklists/safari/     Safari content-blocker JSON
        +--> apps/shared/blocklists/android/    domain lists
        |         (each output directory has its own checksums.json)
        v
  bundled into each app at build time
```

The existing CLI gains two flags, `--safari-out` and `--android-out`,
alongside `--out` (Chrome). The mobile artifacts are **committed** at
`apps/shared/blocklists/{safari,android}/`, exactly like
`extension/rulesets/`, and each app's build copies them into its bundle.
CI recompiles from sources and diffs against the committed artifacts — the
same determinism guarantee as the extension
([architecture.md](architecture.md), §Determinism and verification).

## Update cadence

Blocklists update by shipping a new store build, exactly as the extension
updates by republishing through the browser store. There is no
list-download endpoint. The apps' filtering contacts no Sitr server,
same as the extension's; the DNS filters (Android, and iOS when turned
on) relay the device's own DNS lookups to the network's resolvers and
look up SafeSearch hosts there — see Engine summaries.

**Reserved future design — not built: over-the-air list updates.** If
store-release cadence ever becomes a real problem, the design is: static
hosting at `https://sitrshield.com/blocklists/v1/` of the same committed
artifacts, plus `checksums.json`, plus a detached Ed25519 signature over
the manifest. Clients verify the signature, then every checksum, then
apply all-or-nothing. The artifact is identical for every user and carries
nothing user-specific. Its row in [data-flow.md](data-flow.md) must land
before any code does — data-flow.md already reserves exactly this.

## Engine summaries

### iOS: content blocker, Screen Time and DNS filter

Three layers, each with its own reach: the Safari content blocker covers
Safari; optional Screen Time covers WebKit browsers, with Apple's own
adult filter; the optional DNS filter covers every app that uses the
system resolver.

- One Safari Content Blocker extension. Rules are generated by the
  compiler from the same sources; layer precedence is expressed through
  rule ordering plus `ignore-previous-rules`, since Safari has no
  priority numbers. Every rule is request-level — one host-anchored
  `url-filter` per domain — so a blocked site is blocked as a page *and*
  as content embedded in another page, the same as DNR `requestDomains`
  and the Android engine. (`if-domain` would match the top-level page
  only.)
- One rule per domain means the list size is capped by WebKit, which
  rejects a whole list above 150,000 rules. The compiler fails the build
  unless every Safari list, opt-in lists included, plus a 5,000-rule
  reserve for the user's and household's own rules fits within 145,000
  (today about 100,500 with everything on); `SafariRules.swift` enforces
  the same cap in the app. The app assembles the active list on the
  device. Until it has been opened once, the content blocker serves the
  bundled fallback `blockerList.default.json`: the hand-curated tier only
  (about 500 rules), without the imported names.
- Optional Screen Time integration (FamilyControls / ManagedSettings):
  Apple's algorithmic adult filter applied system-wide in WebKit
  browsers, plus the first 40 sites of the user's own block lists and
  their allow exceptions, except sites on Sitr's adult list. ManagedSettings accepts only a small domain
  set, so Sitr's gambling and dating lists are **not** carried there:
  outside Safari those categories get Apple's filter only. In
  `.individual` mode the user can revoke authorization at any time —
  revocable friction. In `.child` mode (via Family Sharing) revoking
  requires parent approval — the only real tamper resistance on iOS.
- Screen Time requires Apple's Family Controls distribution entitlement.
  Approval is pending; if it is late, the app ships without the feature,
  gated at runtime.
- Optional DNS filter (off by default): a local packet tunnel
  (`NEPacketTunnelProvider`, target `apps/ios/SitrTunnel`, engine in
  `SitrCore/Sources/SitrCore/Dns/`) with the Android engine's design. It
  routes **only** the same two synthetic resolver addresses, so
  exclusively DNS packets enter it. It answers blocked names itself
  (`0.0.0.0` / `::`, an empty answer for other record types), rewrites
  the same SafeSearch hosts as Android by CNAME (HTTPS, SVCB and ANY
  queries for them get an empty answer), and forwards every other lookup
  in plain UDP (TCP for a truncated answer) to the network's own
  resolvers, read with libresolv's `res_ninit`. No remote server. It
  applies the same settings as the Safari blocker — the adult list, the
  gambling and dating lists unless switched off, the per-site
  image-and-video switches, the opt-in violence list when switched on —
  plus an iOS opt-in encrypted-DNS list (off by default, device-local,
  effective only while the DNS filter is on) and the user's and
  household's own lists, from the same checksum-verified
  `apps/shared/blocklists/android/` files. iOS has no Strict Search
  setting. Settings changes, including household changes arriving by
  sync, reach the running filter at once. The user turns it on from the
  DNS filter row on Home, after Sitr's disclosure; the first time, iOS
  asks permission to add a VPN configuration, lists the filter under VPN
  in Settings, and shows a VPN badge in Control Center while the filter
  runs. On demand, iOS starts the filter again after a
  restart or after iOS stopped it, while the configuration is enabled.
  Turning the filter off in Sitr, or turning the encrypted-DNS list off,
  is a loosening change (refused on a child device, then wait before
  loosening, then the PIN). A settings change is saved at once and the
  running filter applies it at once (0.5 to 2.3 s after the tap on a
  test phone), while Safari loads its new rules in the background and
  Home shows "Updating Safari rules…" (32 to 40 s on that phone); if
  Safari refuses the rules, the setting stays as chosen and Home turns
  red with the reason. What Sitr records as Safari's rules is what Safari
  actually holds, so a change reverted while Safari is still loading is
  reloaded afterwards. When the filter is not running (for example
  switched off in iOS Settings, or replaced by another VPN), Home turns
  red with the reason and the SafeSearch row says it is not enforced.
  Sitr never re-enables a configuration that was disabled or removed;
  iOS's own Connect On Demand can restart the filter after its status
  switch is flipped off (T14). While it is starting, Home shows a grey
  "starting" card, never green, and after 15 seconds without success it
  shows the filter as stopped (red). If the filter cannot read a
  network's DNS server after three tries, it blocks lookups that need
  that server rather than let them through (except for about two
  seconds during each new try) and keeps trying for about
  16 minutes, and after that only when the network changes; until a try
  works, sites do not load on that network and Home shows a gold "Sites
  can't load on this network" card. Home shows exactly one status card, in this
  order of precedence: red "Protection inactive" (anything failing), gold
  "Sites can't load on this network", grey "DNS filter starting…", grey
  "Updating Safari rules…", green "Protection active"; a Safari update
  never hides a failure. Data flow:
  [data-flow.md](data-flow.md); limits, including the
  short unfiltered window at each network change and what is not yet
  tested: [threat-model.md](threat-model.md) T14.
- **SafeSearch on iOS needs the DNS filter.** With it on, SafeSearch is
  enforced for Google, Bing, DuckDuckGo and YouTube, as on Android.
  Without it, SafeSearch is not enforceable on iOS: the content blocker
  and Screen Time have no way to rewrite search traffic.

Tamper story: [threat-model.md](threat-model.md) T7; platform limits: T10,
T14.

### Android: DNS-only VPN

- A local `VpnService`. The tun routes **only** the synthetic resolver
  addresses (`10.111.222.1/32` and an `fd66::` ULA `/128`), so
  exclusively DNS packets enter the tunnel — the engine structurally
  cannot see non-DNS traffic. No TLS interception, ever.
- Blocked hosts: A/AAAA answered `NOERROR` with `0.0.0.0` / `::`.
  HTTPS/SVCB (type 65) queries for blocked and SafeSearch-mapped hosts
  are answered NODATA, so ECH cannot carry the real hostname past the
  filter.
- SafeSearch by DNS rewriting: Google → `forcesafesearch.google.com`,
  Bing → `strict.bing.com`, DuckDuckGo → `safe.duckduckgo.com`,
  YouTube → `restrict.youtube.com`. Rewrite targets are resolved at
  runtime through the upstream; compiled-in published VIP addresses are a
  last-resort fallback only.
- Allowed queries are forwarded to the **network's own resolvers** (from
  the default network's `LinkProperties`) — never to a Sitr resolver
  or any third party, and there is no hardcoded public-resolver fallback.
  Sitr excludes itself from its own tunnel, so the resolvers it reads
  always belong to the network its queries leave by. A reply is accepted
  only from the resolver that was asked and only if it echoes the query;
  a truncated answer is fetched again over TCP and returned whole.
- A block rule (device, household, managed or category) is checked
  before the SafeSearch rewrite, so blocking a search engine's own domain
  works; an allow rule never switches SafeSearch off, and no allow rule
  of any layer opens a name on the adult, gambling or dating list. On
  Android those three lists are always on and have no switch. In a mixed
  household, a gambling or dating switch set on the extension or an
  iPhone does not apply to Android.
- Honest limitations: a fixed Private DNS hostname (a user-set DoT host)
  conflicts with Sitr. On the Android 15 and 16 devices tested, the phone
  could not look up any name while both were on; Sitr detects the setting
  and shows protection as not active, with the fix: set Private DNS to
  Automatic or Off. A browser's own DoH ("Secure DNS") cannot be
  intercepted. An optional, off-by-default list of 65 well-known public
  encrypted-DNS hostnames
  ([doh-hosts-policy.md](../blocklist/policy/doh-hosts-policy.md)) answers
  those hosts as blocked. Tested with Chrome on Android 15: with secure
  DNS on "automatic" (the default) nothing changes; with a built-in
  provider chosen, the switch turns a silent bypass into every page
  failing to load until secure DNS is set back to automatic (Chrome did
  not fall back to the system resolver), and a connection already open
  kept working for a few minutes. It cannot stop a provider entered as an
  IP address or one not on the list, and has no effect on Private DNS.
- "Wait before loosening" (optional, device-local) works as on the other
  platforms, with two clocks (time since boot and the wall clock; the
  stricter wins), so a clock change cannot open it early and a reboot
  restarts the wait. It cannot stop the VPN being switched off in
  Android's settings or the app being uninstalled. Turning the child lock
  off deliberately does not wait, so the wait can never keep the
  guardian's PIN out of the child-lock screen. Joining a household is
  held like any loosening change; changes made on another household
  device arrive by sync and are not held. Threat model: T7.
- "Pause" on Home and on the status notification turns protection off
  for 5 or 15 minutes; it comes back by itself, at most 15 minutes of
  pause in any 60, and an early resume gives nothing back. Nothing is
  filtered while paused. It exists because some banking apps refuse to
  run while any VPN is on, and Sitr's filter is a VPN to Android;
  leaving such an app out of the VPN does not help, because it detects
  the VPN on the phone, not in its own traffic. A pause is gated exactly
  like turning protection off (refused on a child device or under a
  managed lock, then the wait, then the PIN) and is not offered while
  "block connections without VPN" is on. iOS has no pause (what other
  apps see of the iOS DNS filter: T14).
- "Block Reels in the Facebook app" (optional, off by default,
  device-local) uses the accessibility service to leave Facebook's Reels
  tab and reels opened full screen. DNS cannot do this, because Reels
  shares Facebook's hostnames. Reel previews in the feed, Stories,
  Facebook in a browser, Facebook Lite, Instagram and TikTok are not
  covered, and the labels are known in English and Bengali only. Turning
  it off is gated like other loosening changes. Privacy:
  [reels-blocking-privacy.md](reels-blocking-privacy.md); threat model:
  T12.
- Android filters per user: Sitr in the main user does not cover a
  private space, work profile or second user, and cannot detect one.
- Android's "block connections without VPN" lockdown is
  unsupported — DNS-only routes would break all other traffic — so
  always-on VPN *without* lockdown is the recommended persistence; it
  also stops another VPN app taking the slot. On a child's phone the
  child lock ([child-lock.md](child-lock.md)) stops the setting being
  changed.

Bypass analysis: [threat-model.md](threat-model.md) T9.

## A note on Android permissions

The app declares six permissions. The **merged** manifest ships two
more, contributed by libraries: `WAKE_LOCK` from androidx.work, and
androidx.core's signature-level, self-scoped
`DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. Neither grants access to
anything about the user, but any public claim about permissions — the
Play listing, the data-safety form, this documentation — has to
describe what a build actually requests, which is the merged list:

```sh
adb shell dumpsys package com.sitrshield.sitr \
  | sed -n '/requested permissions/,/install permissions/p'
```

Absent by design, and to stay that way: QUERY_ALL_PACKAGES, camera,
location, storage, Device Admin. An Accessibility service ("Sitr
guard") has two uses, each off until switched on in Sitr: the child lock,
which a guardian turns on ([child-lock.md](child-lock.md)), and Reels
blocking in the Facebook app, which the user turns on
([reels-blocking-privacy.md](reels-blocking-privacy.md)). It reads no
app other than Facebook and the system screens the child lock uses.

## Testing on a device

Fixtures and unit tests pin the shared logic; the engines still have
to be exercised on real hardware, where carrier DNS, captive portals
and other VPNs behave in ways no emulator reproduces. The runbook and
the scenario matrix live in [device-testing.md](device-testing.md).

## Conformance fixtures

`apps/shared/fixtures/` holds test vectors generated from the TypeScript
reference implementation: HKDF derivations (root secret → household id,
auth credential, encryption key), blob encrypt/decrypt round-trips,
last-writer-wins merge cases, and rule-layer precedence decisions.
Fixtures are regenerated from the reference, never hand-edited.

The rule: a Swift or Kotlin port must pass every fixture before it is
allowed to sync against the real server.

## Verifiability

Open source only means something if a user can check that the store
binary matches the source. The two stores allow different
amounts of that, and we say so rather than promise the same on both.

| | Android | iOS |
|---|---|---|
| Byte-for-byte binary check | **Yes.** The unsigned APK builds reproducibly; we publish its SHA-256 per release. Bundletool code transparency adds a signed record of the code that survives Play's re-signing. | **No — for anyone.** Apple re-signs the app and FairPlay-encrypts the executable, so no byte comparison against a local build is possible. |
| What we promise instead | — | Tagged source for every build, published archive checksums, and resource-level verification: the bundled ruleset JSON, and the domain lists and SafeSearch host map the DNS filter uses, survive re-signing byte-identical and can be checked against the compiler's published checksums. |

## List format and the escape hatch

The sources and the Android artifact are plain-text domain lists, one
domain per line, sorted in byte order — inspectable by anyone with a text
editor. The Android app keeps each verified file as one byte array and looks names
up by binary search over its lines, with no per-domain objects; loading
checks the SHA-256, every line, strict sort order and the absence of blank
or duplicate lines, and refuses the list on any failure. A 150,000-line
list loads in tens of milliseconds on the Android emulator, so plain text
stays; if it ever does not, the designated successor is a length-prefixed
binary format, an emitter swap in the compiler, not a redesign.
