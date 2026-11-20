# Sitr threat model

What we defend against, what we deliberately cannot do, and what remains.

## Assets

1. **User browsing privacy** — the product's reason to exist.
2. **Filtering integrity** — the filter must actually be on when it says it is.
3. **User trust** — consistency between claims and behavior.

## Threats and mitigations

### T1: Sitr itself spying on users (the category's defining failure)
The primary threat is *us* — a filtering product is perfectly positioned to
surveil. Mitigations are structural, not promises: DNR cannot read request
contents; there is no per-user server; the blocklist is identical for all;
the code is open source with reproducible builds. See
[design-lessons.md](design-lessons.md).

### T2: Malicious or compromised blocklist update
A poisoned ruleset could block legitimate sites or (worse) redirect traffic.
Mitigations: rulesets ship in the store-reviewed package; the compiler
validates every domain; "unsafe" rules (redirect/header) are hand-reviewed
and never generated from list sources; checksums published; any future
remote update must be checksum/signature-verified before applying, all-or-
nothing (§4 of the working agreement). The mobile apps inherit this
unchanged: their blocklists ship inside the store-reviewed app binary and
update via store releases, exactly like the extension.

Most of the list (about 100,000 of its names) is now imported from public
third-party lists, which moves part of this risk upstream. Mitigations: each
source is pinned to a fixed snapshot (a commit, where the upstream has one)
whose SHA-256 and retrieval date are recorded in the `imported.txt` header;
an import is a reviewed pull request with a visible diff, never an automatic
fetch at build or run time; the import tool accepts only MIT, CC BY 4.0 and
CC BY-SA 4.0 sources; and every imported name passes compile-time guards
(no public suffixes, nothing on, containing or under a name in the public
never-block list, nothing in the public `import-exclusions.txt`, and a name
rule for one gambling source). Imported names are block-only "safe" rules
like the rest of the list; they cannot redirect anything. A poisoned
upstream can still add wrong blocks; see T5.

### T3: Silent filter failure
A filter that silently stops working is worse than none. Mitigation: the
service worker verifies the expected rulesets are enabled and shows a red
"Protection INACTIVE" badge on any failure or uncertainty — never optimistic.

### T4: Supply-chain compromise
Every dependency is attack surface. Mitigations: **zero runtime
dependencies**; three pinned build-time dev dependencies (typescript and two
type packages); lockfile committed; deterministic builds so a tampered
artifact is detectable by rebuild-and-compare.

### T5: Over-blocking as censorship
Moral/religious blocking decisions could be abused or opaque. Mitigations:
public blocklist sources, written inclusion policy, named maintainers,
public appeals process, and an on-device per-site allow that opens a site
any category blocks, except the adult list: no allow entry opens an
adult-listed site, and a wrong adult listing is fixed through the appeals
process.

The imported tier brings risks of its own, stated plainly:

- **False positives at scale.** Imported names were judged by domain name
  only, not visited one by one, so among tens of thousands some will be
  wrong (an expired domain now owned by someone else, a generic name).
  The guards above stop the worst class, blocking a platform or a shared
  suffix, but not a single wrong site.
- **Stale upstreams.** Some sources are old (the violence list's main source
  dates largely from the early web), and a snapshot ages between imports.
- **Reliance on third-party lists.** Sitr inherits the upstream maintainers'
  judgement and mistakes, and cannot fix them upstream.

What exists against them: the per-site allow, which wins at once on the
device for every list except adult; the [appeals process](../blocklist/policy/appeals-process.md), which
removes a wrong imported name by adding it to `import-exclusions.txt` so a
later import cannot bring it back; a public name rule that narrows UT1's
gambling list to names that look like gambling; and every source, licence
and count published in `blocklist/imports/`. Appeals, not prior review,
are how imported mistakes get fixed.

### T6: The sync server operator (Sitr Family only)
The Family tier adds one server (docs/sync-protocol.md) — so the operator
re-enters the threat model. Structural limits on what we *can* do: the
server stores only an E2E-encrypted blob (keys derived on-device from a
root secret that is never transmitted); the household id and bearer
credential are HKDF outputs unlinkable to the encryption key; credentials
are stored only hashed; there are no request logs and timestamps are
day-rounded. Remaining operator powers — refusing service, deleting blobs,
serving stale blobs — are freshness attacks only: clients detect stale
blobs via rev monotonicity and refuse to apply them, and a device that
never syncs again keeps filtering forever. Devices without a household
contact no server at all.

### T7: Guardian PIN bypass (Family)
The guardian PIN is **friction, not security**. It is a salted PBKDF2 hash
in `storage.local`, which a determined user can inspect or clear via
devtools or by uninstalling the extension — consistent with the accepted
limitation below. What it does stop: a child casually loosening the filter
in the options page. What actually prevents uninstall on a managed device
is the browser's own force-install policy (docs/institutions/), not us. We
state this plainly rather than overclaim.

**Wait before loosening** (extension, iOS and Android; optional, off by default,
device-local, never synced) is friction of the same kind. When it is on, a
change that loosens protection is held: the user asks for it, waits the
chosen time (5 minutes to 24 hours), and then has a 10-minute window to make
it. Shortening the wait or turning it off is itself held. It runs after the
gate (a managed lock still refuses outright; a child device refuses
every loosening change except leaving the household, which needs the
household's guardian PIN and is refused when the household has none,
unless the device never received its household) and
before the PIN. Joining a household is held like any loosening change on every
platform (the household's settings replace this device's by sync), and in
the extension it first asks for the browser's own PIN when one is set.
Changes made on another device in the household arrive by sync and are not
held: the wait is local to each device. What it does
not do: it slows changes made inside Sitr only, and cannot stop anyone
disabling or removing the extension or app, or switching off the content
blocker, Screen Time or the DNS filter (iOS) or the VPN (Android) in system settings. In the extension
it relies on the computer's clock, which the user can change. The iOS app
checks two clocks, one of which the user cannot set and which keeps
running in sleep, so changing the clock or restarting the phone on its own
makes the wait longer, never shorter. The one known exception needs two
faults at once: a pending request restored from a backup onto another
device, plus that device's clock set forward. The Android app also checks
two clocks, time since boot and the wall clock, and takes the stricter, so
a clock change cannot open it early and a reboot restarts the wait. On
Android, turning the child lock off deliberately does not wait: anyone can
switch the wait on, even on a child's phone, so it must never be able to
keep the guardian's PIN out of the child-lock screen.

The same honesty applies on mobile. On iOS, Screen Time in `.child` mode
(via Family Sharing) is real platform enforcement — a parent's approval is
required to revoke it. `.individual` mode is revocable friction, same as
the PIN. On Android, the **child lock** (Sitr Family; docs/child-lock.md)
turns the PIN into the boundary on a child's phone. It works on any
phone: an accessibility service closes the screens that would switch
Sitr off, uninstalling included (Device Admin isn't used: Play forbids it
for blocking uninstall, and adb can still remove Sitr). It is bypassable —
safe mode and factory reset (left alone: they are Android's own
recovery tools), settings in a language other
than English, Bengali, Arabic, Turkish or Malay or worded differently by
the phone maker (screens that name Sitr are still closed; in those
languages the network page closes too), a "cleaner" app that force-stops Sitr (which
also stops filtering until Sitr is opened again), and a private space,
work profile or other user that already exists (never filtered, because
an Android VPN covers only the user that started it, and Sitr cannot
detect one; setting up a private space is closed under the lock, but an
existing one still opens from the apps list) — and
says so next to the toggle. The guard reads window text and type on the device
and discards it; it is opt-in by a guardian, behind a disclosure, and
stores and sends nothing. The exit takes the guardian PIN and are refused outright when no PIN exists,
so a cleared app can never be an unlocked one. One limit is structural:
**the pairing code is household membership**. Every device derives the
same keys from it, "child" is a local role, and the merge takes the
highest revision without asking who wrote it. The apps refuse household
edits on a device that has joined but not yet synced (so a joiner cannot
out-revise a household it has never seen) and ask for the PIN afterwards,
but a modified client that holds the code can still replace the household
state, PIN included. A guardian must keep the pairing code as secret as
the PIN. A child device can leave its household only with the
household's guardian PIN (a PIN the device held before joining does not
count); leaving removes it from the household's device list. The one
exception is a device that never received a household: while its stored
state is still the join placeholder (joined, never synced) and holds no
PIN, it may leave without a PIN and without the wait, whatever its role;
a managed lock still refuses. It has no household rules to give up, and
the check is made on the stored state at the moment of leaving, so a
screen opened before the household arrived cannot use it afterwards. Closing this needs loosening changes to be signed with a key only
the PIN holder can derive — a sync-protocol change, not yet made. Without the child lock,
an unmanaged Android phone still can't stop uninstall, and managed
devices (EMM or Family Link) remain the alternative.

### T8: A malicious or compromised institution admin
Managed policy can force categories ON, add domain rules, and lock the
options page — it cannot observe browsing (nothing in the extension
reports anything, in any tier) and cannot weaken the always-on protections
for other users. The admin-trust boundary is the browser's enterprise
contract: an admin who controls the device could install anything anyway.
Sitr keeps its own promise inside that boundary: applied policy is always
visible on the options page ("Managed by X", locked rows), and a policy
that fails to apply turns the badge red.

### T9: The Android DNS engine can see query names
Unlike DNR, which is structurally incapable of observing requests, a
VpnService DNS filter must read query names to filter them. This is a
real capability expansion and we say so plainly; we chose it because
Android offers no DNR equivalent. The mitigations stay structural: the
tunnel routes **only** the synthetic resolver addresses, so exclusively
DNS packets enter it — the engine cannot see non-DNS traffic even in
principle; allowed queries are forwarded only to the network's own
resolvers, so no network path exists from the engine to anywhere else;
the one-HTTP-call-site rule and data-flow.md remain the enforcement
surface; and the code is open source with a byte-reproducible unsigned
build. A privacy cost is disclosed too: forwarded queries leave in plain
UDP (the engine resets Private-DNS :853 probes so Android falls back to
cleartext), so Android's automatic encrypted DNS is lost while Sitr runs
and the network operator can read the names it could already read
without Private DNS. The bypass surface is disclosed, never hidden. A
fixed Private DNS hostname (a user-set DoT host) conflicts with Sitr: on
the Android 15 and 16 devices tested, the phone could not look up any
name while both were on; Sitr detects the setting and shows protection as
not active, with the fix (set Private DNS to Automatic or Off). We do not
claim that outcome for every Android version or phone maker. A browser's
own DoH ("Secure DNS") cannot be intercepted (Sitr answers Firefox's
canary name so its default DoH stays off, which does nothing for a user
who switches it on). An optional, off-by-default list of 65 well-known
public encrypted-DNS hostnames
([doh-hosts-policy.md](../blocklist/policy/doh-hosts-policy.md)) answers
those hosts as blocked. Tested with Chrome on Android 15: with secure DNS
on "automatic" (the default) Sitr filters normally either way; with a
built-in provider chosen, Chrome silently bypasses Sitr when the switch is
off, and with it on every page fails with Chrome's secure-DNS error until
secure DNS is set back to automatic — Chrome did not fall back to the
system resolver. A connection the browser already had open kept working
for a few minutes after the switch was turned on. The switch cannot stop
a provider entered as an IP address or one not on the list, has no effect
on Private DNS, and does nothing about VPNs, proxies or Tor. Other
browsers and versions are untested.
An app that sends its lookups to its own DNS server is not filtered,
because only the system resolver's addresses are routed into the tunnel; and Android's "block connections without
VPN" lockdown is unsupported by design, because DNS-only routes would
break all other traffic. Android runs one VPN at a time, so **another
VPN app** (a privacy VPN, or one a child installs) silently replaces
Sitr's — surfaced red as "replaced by another app". Setting Sitr as the
always-on VPN stops other apps taking the slot until someone changes
that setting; the child lock (T7) is what stops the change.
Protection can be paused for 5 or 15 minutes, at most 15 minutes in any
60, and comes back by itself; nothing is filtered during a pause. It
exists because some banking apps refuse to run while any VPN is on, and
leaving such an app out of the VPN does not help, since it detects the
VPN on the phone, not in its own traffic. A pause is gated exactly like
turning protection off: refused on a child device or under a
managed lock, then the wait before loosening, then the PIN.

### T10: iOS platform limits
iOS has three layers, each with its own reach. The Safari Content
Blocker protects Safari only. Screen Time's web filter, when the user
authorizes it, extends to WebKit browsers system-wide — but it is
Apple's framework enforcing Apple's algorithmic filter plus a small part
of the user's own block lists (the framework's domain set is too small
for Sitr's category lists) — the evaluation is Apple's, not ours. The
optional DNS filter (T14) covers every app that uses the system
resolver, with the limits listed there.
Without the DNS filter, SafeSearch cannot be enforced on iOS at all;
with it, SafeSearch is enforced by DNS for Google, Bing, DuckDuckGo and
YouTube (T11). We state each of these in-app rather than imply full
coverage.

Two Safari limits shape the list. WebKit rejects a whole content-blocker
list above 150,000 rules, and Sitr uses one rule per domain, so the
compiler fails the build unless every list, opt-in ones included, plus a
5,000-rule reserve for the user's and household's own rules fits within
145,000; the app enforces the same cap. And until the app has been opened
once, the content blocker has only the bundled fallback list: the
hand-curated tier (about 500 domains), not the imported names. The app
writes the full list the first time it runs.

### T11: search engines without a DNS safe-mode endpoint
SafeSearch is enforced by answering DNS for a search engine's hostname
with the address of a "force safe" endpoint the vendor publishes:
`forcesafesearch.google.com`, `strict.bing.com`, `safe.duckduckgo.com`,
`restrict.youtube.com`. That technique only exists where the vendor
provides such an endpoint.

**Brave Search publishes none**, and neither do most smaller engines.
Their safe-search settings live in cookies or query parameters, which a
DNS filter cannot reach. So on those engines explicit *results* — most
visibly image thumbnails, served from the engine's own domains — are not
filtered. Destination sites in the blocklist remain blocked when
followed, but the results page itself is not.

We do not "solve" this by blocking the engines: a general-purpose search
engine fails the inclusion policy's primary-purpose test, and blocking
one would be exactly the over-broad entry that policy exists to prevent.
The honest position is that Sitr filters domains, and enforces
SafeSearch only where a vendor makes it possible.

**Strict Search** (optional, off by default) narrows the gap without
crossing that line. Search engines serve result thumbnails from their
own hostnames, so blocking those hosts suppresses explicit imagery while
text search keeps working — surgical, and it degrades an engine rather
than breaking it. Those hosts ship as a separate artifact behind a user
toggle, never in the shared blocklist. The setting is disclosed in-app
for what it is: image results on the affected engines will look broken,
and text listings are untouched.

It covers only engines with no vendor safe mode. Google, Bing and
DuckDuckGo already have SafeSearch forced, so blocking their thumbnail
hosts filtered nothing extra and merely broke the image search people
use most — tried, and reverted on that evidence.

A related point users meet sooner: Sitr blocks *domains*, so searching
for a blocked site still returns a result listing. The link fails to
load; the listing is not removed. Editing page contents would require
the traffic inspection this product is built not to have.

### T12: explicit imagery on mixed-content platforms
Domain blocking cannot touch adult content on general-purpose platforms
(Reddit, X, Tumblr, imgur, Pinterest): blocking the domain breaks all
legitimate use, and a general-purpose platform fails the inclusion
policy's primary-purpose test the same way a search engine does (T11).

**Media filtering** (optional, off by default) narrows the gap without
weakening the structural guarantee: it blocks requests by *resource
type* (`image`, `media`) in DNR — no content scripts, no new
permissions, and the bytes never reach the device. Two modes: a
**greylist** blocks images and media on a public list of mixed-content
hosts (a separate artifact behind a user toggle, never in the shared
blocklist — the T11/Strict Search template, with its own inclusion
policy under `blocklist/policy/`); **allowlist-only images** blocks
images and media everywhere except sites the user explicitly allows.

The layer has no idea whether it blocked a nude or a bar chart, and the
UI says so: "images and media off on these sites", never "explicit
content detected". Images on affected sites will look broken — that is
the setting working. It is discipline infrastructure, not parental
controls: a determined user turns it off in two clicks (T7 applies).

What it structurally cannot catch, disclosed rather than patched:

- **Streaming survives.** `media` covers `<video>`/`<audio>` element
  loads; HLS/DASH players fetch segments as `fetch`/XHR, and blocking
  that type would break most modern sites outright. Blocking `media`
  also silences legitimate audio (podcasts) on affected hosts.
- **Cross-origin iframes.** A request made inside an embedded frame
  carries the *frame's* origin as initiator, so greylisting a host
  misses media rendered through third-party embeds. Blocking
  `sub_frame` would break all embeds; we disclose instead.
- **Direct navigation.** An image URL opened in its own tab is a
  `main_frame` load, not an `image` — "open image in new tab" defeats
  the filter for that image.
- **`data:`/`blob:` URLs** never produce a network request for DNR to
  match.
- Text (erotica) is out of scope by design; text is not the gap.

Media filtering by resource type is a browser-extension capability.
The DNS engines (Android, and the iOS DNS filter) categorically cannot
see resource types; the iOS content blocker could
express the greylist via content-blocker `resource-type` triggers, but
does not today — the asymmetry is stated in-app rather than papered over.

The apps do have a narrower lever: **images and video off, per site**,
for the greylist's sites — X, Reddit, Tumblr, Pinterest and Imgur
(optional, each off by default). Each site serves media from hosts of
its own (X: `pbs`, `video`, `ton.twimg.com`; Reddit: `i`, `v`,
`preview.redd.it`, `thumbs.redditmedia.com`; Tumblr: `media.tumblr.com`;
Pinterest: `i`, `v1.pinimg.com`; Imgur: `i.imgur.com`; full lists in
`tools/compiler/src/greylist.ts`), so blocking those hosts — by DNS on
Android and in the iOS DNS filter, by content-blocker rule in Safari on
iOS — removes the site's pictures and
video while posts still load. A host that also serves the site's scripts
or styles is never listed (a unit test checks each site's script host). It is all-or-nothing
for the same reason as above: X marks sensitive media only inside its API
responses, never in these URLs, so nothing outside the X app can pick
out just the explicit items. The in-app text says so and points to X's
own sensitive-content setting, the only filter that does know. On iOS,
without the DNS filter it reaches Safari only, not the X app; with the
DNS filter on it also reaches apps that use the system resolver (T14).
Media X has already cached on the
device stays visible, and a blocked host's earlier DNS answer can outlive
the toggle by up to the record's TTL (Sitr caps answer TTLs at 60 s).

Facebook, Instagram and TikTok get no switch, deliberately: they prohibit
nudity and moderate for it (greylist criterion 1), and Instagram and
TikTok are built around their media, so withholding it breaks them
rather than degrading them (criterion 3). The apps say this and point to
those platforms' own teen controls and the OS's app limits instead.

### T13: Safari Web Extension (macOS) platform limits
The macOS build runs the extension codebase inside Safari, which
translates DNR rules into its own in-process content-blocker engine —
the structural-blindness claim (T1) carries over: no content scripts, no
webRequest, no page access. What does NOT carry over, stated rather than
patched:

- **Safari older than 26 mis-enforces DNR priorities** (blocks overrode
  higher-priority redirects; numeric order was mishandled — fixed in
  Safari 26). On older Safari the extension renders a red "Safari too
  old" status and claims nothing.
- **Host permissions are per-site, user-revocable grants.** An ungranted
  search-engine host silently disables its SafeSearch redirect while the
  ruleset still reports enabled — so the protection check verifies the
  grants themselves (`permissions.contains`) and renders red without
  them. The sync origin is requested explicitly during the household
  create/join ceremony, since users never "visit" it.
- **The badge loses its color channel** (Safari ignores badge colors).
  The popup and the host app's status window are the red/green surfaces;
  the badge shows `!`/`?` text only.
- **No managed layer.** Safari has no `storage.managed`; the
  institutions feature does not exist on Safari (same honest posture as
  iOS/Android v1).
- **Session rules are pooled with dynamic rules** (30,000 combined) and
  a known WebKit bug breaks session-over-static precedence — the media
  filter's "just this once" session escape hatch is therefore
  Chrome-only, hidden on Safari rather than shown broken.
- **Residual verification gap:** an extension cannot test its own
  redirects from inside Safari (`testMatchOutcome` does not exist
  there). Rule behavior is verified by the repo's Safari smoke checks on
  real page loads, not claimed from `getEnabledRulesets` alone.
- **Silent rule-drop quirk (worked around):** Safari 26.6 silently
  drops any DNR rule whose `resourceTypes` include `object` or
  `csp_report` in a realistic list — no error, no console output,
  `getEnabledRulesets` still reports the ruleset enabled. Established
  by on-device bisection (2026-08-26). Both values are excluded from
  every rule Sitr emits, on all engines, so this cannot recur; the cost
  (plugin-element and CSP-report blocking) is negligible.

### T14: The iOS DNS filter (optional)
The iOS app's DNS filter, off by default, is the Android design (T9) as
an iOS packet tunnel (`apps/ios/SitrTunnel`), and it brings the same
capability expansion: it must read query names to filter them. The
mitigations are the same and stay structural: the tunnel routes **only**
two synthetic resolver addresses, so exclusively DNS packets enter it;
allowed lookups go only to the resolvers the current network supplies
(plain UDP, TCP for a truncated answer), with no fallback resolver;
names are neither stored nor logged; the flow is listed in
[data-flow.md](data-flow.md). It covers every app that uses the system
resolver, not only Safari and WebKit browsers, and with it on SafeSearch
is enforced by DNS for Google, Bing, DuckDuckGo and YouTube (T11). It
applies the adult list, the gambling and dating lists unless switched
off (the household's choice wins when joined), the per-site
image-and-video switches (T12), the opt-in violence list and the opt-in
encrypted-DNS list when each is switched on, and the user's and
household's own lists; iOS has no Strict Search setting. Turning it off
inside Sitr is a loosening change, and so is turning the encrypted-DNS
list off: the gate (refused outright on a child device), then wait
before loosening, then the PIN (T7). When the filter is not running,
Home turns red and says why. Sitr never re-enables a VPN configuration
that was disabled or removed in iOS Settings, or replaced by another
VPN.

Its limits (the figures were measured on an iPhone 13 Pro Max with iOS
27.2.1 on Wi-Fi on 18 November 2026):

- **A short unfiltered window at every network change.** iOS has no
  supported way to read the network's resolver while a tunnel is up, so
  when the network in use changes the tunnel removes its settings, reads
  the new network's resolver (`res_ninit`) and applies its settings
  again. Lookups in that window go around the filter, straight to the
  network's resolver. Only a change of the network in use counts: a
  secondary connection appearing or disappearing (mobile data while on
  Wi-Fi) causes no window. If the read finds nothing the tunnel tries
  again, at most three times per network, each try a window of its own
  and each reading for longer (0.1, 0.5 and then 1.5 seconds), so if a
  new network is slow to announce its DNS server the unfiltered time can
  add up to a few seconds instead of about half a second. After
  three failed tries it fails closed: lookups that need the network's
  resolver are dropped, so sites do not load, and Sitr shows the filter
  as on but unable to read this network's DNS server, with the option to
  turn it off through the usual gate, wait and PIN. It then tries five
  more times on that network, 60, 60, 120, 240 and 480 seconds after
  each failed try (about 16 minutes of awake time in all), each try a
  window of its own (reading for up to 1.5 seconds); if they all fail,
  the filter stays on and keeps dropping those lookups, so sites do not
  load on that network until the network changes. The same message shows
  from the first give-up through every retry and after them. (The retries and the 15-second limit below are from the code; not yet tested on a device.) If every lookup keeps failing for 30 seconds
  on one unchanged network, the tunnel re-reads the resolver (one more
  window). It does so again on that network only after a lookup sent
  since the last re-read has been answered, so a resolver that never
  answers gets one re-read. Cached answers are dropped at every network
  change and when a re-read finds another resolver list. Only two failures stop the tunnel itself (fail closed; Connect On
  Demand starts it again): iOS failing to restore its DNS settings after
  a read, or not finishing the change within 15 seconds beyond the read. Whatever the trigger, there are at most
  three windows in any minute. The price of that limit: after three
  network changes in a minute, a fourth leaves lookups that need the
  network's resolver dropped (not unfiltered) for up to about a minute,
  so sites do not load in that time while Sitr still shows the filter as
  on (from the code; not yet tested on a device). With the final build, across 10 Wi-Fi
  off/on cycles, there was exactly one window per change, lasting 493 to
  571 ms, and none while the network was unchanged; no lookup failed
  after reconnecting. A test client making several lookups a second got
  one to three real answers per change, all inside the window, none
  after (an earlier build: no real answer stayed cached once the filter
  was back). A connection opened in that window stays open. The filter
  adds about half a second to a reconnect: from Wi-Fi coming on to the
  first answer for a new name took a median 8.9 s with it and 8.3 s
  without.
- **Apps and browsers that use their own encrypted DNS are not covered.**
  Their lookups never reach the tunnel. The optional, off-by-default
  encrypted-DNS list (the same list as Android's, T9; it works only
  while the DNS filter is on) is meant to turn the well-known providers
  into visible failures instead of a silent bypass; on iOS that effect
  is not yet tested. A provider reached by IP address, or one not on the
  list, stays open.
- **One VPN at a time.** iOS allows one active VPN: another VPN app, or a
  device-management profile, displaces the filter.
- **Other apps can see a VPN.** While the filter is on, iOS shows a VPN
  badge in Control Center, and an app that checks for a VPN the usual
  way (a utun interface with an IPv4 address) finds one. Some banking
  apps refuse to run while a VPN is active. One banking app that refuses
  on Android while Sitr's VPN is on showed no VPN message on its first
  iPhone screen, with the filter on or off (20 November 2026); its later
  screens were not tried. iOS has no pause:
  the filter is turned off through the usual gate, wait and PIN.
- **Switching it off in iOS Settings is friction, not a lock.** Flipping
  the VPN status switch alone did not keep it off in our test: Sitr
  showed red, and iOS's Connect On Demand restarted the filter by itself
  after 11 s and 57 s in two tries. A person with the device passcode
  can still keep it off by also switching off Connect On Demand,
  deleting the VPN configuration, or deleting the app. Sitr shows the
  state but cannot prevent any of these; Screen Time in `.child` mode
  (T7) is still the only real lock on iOS.
- **DNS answers larger than 4,096 bytes do not get through.** The filter
  fetches a truncated answer again over TCP and passes on answers up to
  4,096 bytes. For a larger one the client gets a truncated reply, and
  its retry over TCP is refused, because the filter refuses DNS over TCP
  to itself. Tested on the iPhone: answers of 1,176 and 2,138 bytes
  arrived; a 4,771-byte answer did not arrive with the filter on and did
  with it off. A client that asks the DNS server directly got the
  failure in 0.3 s. A client that asks through the system resolver (as
  most apps do) had no answer after 60 s, where the test stopped
  waiting: iOS kept asking again (4 times over UDP, 8 times over TCP),
  so such an app gets no answer and no error from the resolver.
- **Before the first unlock after a restart** the app's settings cannot
  be read. Until then the filter applies only the built-in adult,
  gambling and dating lists (re-reading every 10 seconds); the user's
  and household's lists, the opt-in lists and the image-and-video
  switches apply once the device has been unlocked.
- **Apple documents this use as unsupported.** Technote TN3120 says
  packet tunnels are meant to carry traffic to a remote server, and that
  intercepting system DNS "can result in endless edge cases". App Review
  guideline 5.4 permits parental-control and content-blocking apps from
  organisation developer accounts to use the VPN API. A future iOS
  release may change or break the behaviour. One developer has reported
  intermittent bypass on iOS 27; our tests did not reproduce it: 0 leaks
  in 25 minutes of steady state (1,771 lookups and 1,507 HTTPS requests),
  with the "Connectivity Assist" Wi-Fi setting both on and off, and 0 in
  5 minutes of continuous lookups on the final build. Those tests used a
  test app, not Safari, and on the test network only two of its six test
  names could show a leak, because the network gives no answer for the
  other four.
- **Memory.** Peak 4.9 MB across all test runs, with all lists loaded,
  of the 50 MB the system allows a packet tunnel extension.
- **Restart and update.** After a restart of the phone (on Wi-Fi, 18
  November 2026), with Sitr not opened, the filter started again by
  itself and was running 55 seconds after the last log entry before the
  shutdown; it read the user's settings 4 seconds after starting. What
  it applies before the first unlock was not observed separately. After
  an app update or reinstall it came back by itself in 21 to 29 seconds,
  with no prompt.

**Mobile data (tested 19 November 2026, one mobile network with IPv4
DNS servers).** The filter worked as on Wi-Fi: blocked names answered
for IPv4 and IPv6 lookups, SafeSearch enforced, and one unfiltered time
of 460 to 543 ms at each change between Wi-Fi and mobile data (11
changes), with the DNS server of the network in use accepted each time
and no failed lookups after the change.

**A run of several hours (tested 19 November 2026, 5 h 22 min in normal
use on one Wi-Fi network).** The filter ran without a restart and used
4.1 to 5.5 MB. Open fault: in one period of that run no lookup that
needed the network's resolver got an answer (215 timeouts) while Sitr
showed the filter as on and the network had not changed. Nothing was
unfiltered in that period. It ended when the re-read above ran (one
window of 518 ms); the test cannot tell if the re-read ended it. At the
time the re-read ran only once per network. The same day the rule was
changed to the one described above (again after an answered lookup), so
a second such period on the same network gets another re-read. A second
run (19 November 2026, 3 h 35 min on battery, the changed build) had no
such period and no error. A third run (19 to 20 November 2026, 13 h 47
min, mostly asleep) had one: lookups on Wi-Fi were not answered (not:
went unfiltered) for about 20 minutes. Apart from the one unfiltered
window of 499 ms when the re-read ran, the filter held every lookup in
that period, so none is known to have bypassed it. The re-read ran on a
device for the first time but found the same private DNS server it
already had; the first answer came about 9 minutes later, just before
the phone left that Wi-Fi network. The Wi-Fi network was then gone for
more than six hours (the log shows it, and the tester confirmed that the
network was off), so the 20 minutes are read as the network going down.
That is a reading, not a proof. The
re-read is shown to run, to cost one unfiltered window of about 0.5 s
and to do no harm; it is not shown to restore lookups. The period in
the first run, on a Wi-Fi network that stayed, is still unexplained.

**Not yet tested (as of 19 November 2026).** A mobile network that gives
only IPv6 DNS servers; a fourth network change within a minute (it could
not be produced by switching Wi-Fi, which takes about 15 seconds to
rejoin); Wi-Fi with a sign-in page (captive portal); a second VPN app (the filter is expected not to come back
by itself after it disconnects); whether the encrypted-DNS list on iOS
turns providers into visible failures; iCloud Private Relay; an
encrypted-DNS profile or app. We make no claim for these cases until
they are tested.

### T15: The Family entitlement and the claim service (planned, not yet in effect)
Written 20 November 2026 for entitlement version 2
([sync-protocol.md](sync-protocol.md) §Entitlement version 2 (planned)).
Nothing here is built. Version 2 adds a claim service that sees proof of
payment (a Polar subscription ID, or Apple's signed transaction) and issues a
single-use token per UTC calendar month; the sync server records each
household's end date and the hashes of used tokens. The assets at risk
are the buyer's privacy (T6 extended to payments) and the rule that one
subscription backs one household.

**The operator.** Structural limits: the claim service stores only a
keyed hash of each subscription ID (the marker), a keyed hash of the
claim secret it is bound to (the binder) and the last month it claimed
for, while the subscription renews; plus, while needed, the day of the
last rebind, a keyed hash and the expiry of each refunded or revoked
Apple transaction, and, until the cut-over, a keyed hash of each
checkout redeemed on the version 1 route with its token's expiry. It
stores no token, token ID, claim secret, raw transaction ID, name, email
or IP address, and from Polar's
answers, which carry the buyer's details, it keeps only the status,
product, interval and paid end. The sync server stores no subscription
data. They run as two services with two volumes (on Railway, two
services and two hostnames) and share no key, table or file; the sync
service's settings hold no private key, claim key or Polar or Apple
setting. The token ID is an HMAC
output that neither database can link to a marker. Every non-test
household that renewed in a month has the same end date (the 4th of the
next month), so the date no longer points to a subscription. What
remains, stated plainly: an operator holding the claim key who already
knows a subscription ID can test for its marker and learn whether it is
bound, claimed this month or was rebound in the last 180 days, and one
who knows an Apple transaction ID can test whether it was refunded. For
website purchases the operator knows every subscription ID
(Polar's dashboard and API list them with the buyers' names), so every
website marker can be matched to a named buyer; for Apple purchases the
operator has no transaction IDs (that would need an API key). In both
cases the marker still does not lead to a household. An operator who compares copies of both databases taken over
time can see when a household first appeared and in which month it
stopped renewing, and when a marker appeared and stopped claiming; with
few subscribers these moments can be matched, and Polar's dashboard
shows the operator when each named website buyer bought and cancelled.
Test households carry their creation day. An operator who logged
requests could match a claim to the write that follows it, as with
version 1 today; and because the claim secret is sent every month, one
logged claim would let the operator compute that subscription's future
token IDs. The servers log nothing per request.

**A network observer.** Sees TLS connections and their timing and
sizes. The claim service has its own hostname, `claim.sitrshield.com`,
so an observer of the connection or of its DNS lookup can tell that a
device contacts it: in practice, that this device renews a subscription,
about once a month. A claim followed by a write to the sync host looks
like two short exchanges with two hosts. The credential and the token are
inside TLS.

**A dishonest buyer.** A subscription is bound to one claim secret, so
one device renews it. That device gets one token per calendar month, and
each token extends one household once (its ID is burned at first use).
The bounds:

- **Replacement rule (rebind).** Another claim secret can take over a
  subscription once in any 180 days (`SITR_REPLACEMENT_DAYS`), and gets
  the token the period rule gives at that moment even if the old one
  already got it. Made on the first day of a renewal window, that token
  runs to the 4th of the month after next, at most about 41 days, so at
  worst a second household lives about 41 of every 180 days (under a
  quarter of the time). A binding whose newest token has expired is
  stale, and any claim secret can then bind without using the rebind;
  that gives no second household, because the old token is dead.
- **Renewal window and early tokens.** Next month's token can be
  claimed from the 24th or 25th, while this month's token keeps its
  household until the 4th. Such a token is early until the 1st: it may
  create a household or extend one that has not lapsed, but it cannot
  reopen a lapsed one (it is then not burned and works from the 1st). So
  a buyer who alternates tokens between two existing households keeps
  both alive together for at most the 3-day grace each month, as before
  the window. The only way to hold two households longer is to create a
  fresh one each month, which starts empty and loses every pairing.
- **Unpaid tail.** A token is issued while the paid end is ahead (for
  next month's token, while the paid end is after the 1st) and lasts to
  the 4th of the month after. A buyer who cancels, or whose renewal
  fails, keeps the household up to about 34 days (paid end just after
  00:00 UTC on the 1st of a 31-day month), about 18 days on average,
  without paying. Owner's decision, accepted for the simpler, more
  private rule.
- **Until the cut-over.** Version 1 tokens minted before version 2 is
  deployed are unchanged (owner's decision D3): each still creates any
  number of legacy households, as today, until the cut-over. That
  includes tokens already handed out, for example in store review notes,
  and any token the owner mints later with `mint.js --old-style-token`
  (the CLI defaults to 7 days and needs that flag for more).
  Only in its own last 8 days does such a token fall under the
  single-use rule. Version 1 tokens minted after deployment (by the
  version 1 route, which the welcome page still calls for the builds in
  use, at most once per checkout and only while its subscription is
  active, with a 7-day deadline) are single-use. Households created
  before the deployment stay, and a legacy household has no end until
  the cut-over, even if its subscription lapses.
- **Sharing an Apple ID or a code.** Every holder of the credential can
  try, but only the bound claim secret renews (devices that share it
  through iCloud Keychain compute the same token, usable once), so sharing
  gives no more households than the bounds above.
- **Sandbox.** A Sandbox purchase (App Review, TestFlight, where
  purchases are free) gets a token marked as a test for the current UTC
  day, valid at most 25 hours, on any device: Sandbox has no binding,
  because App Review uses several devices. So anyone with a Sandbox
  purchase can make test households, each lapsing within 25 hours unless
  renewed daily and deleted after 7 days. Xcode receipts are always
  refused. The Sandbox switch should be on only while a review or test
  needs it.

**The refund window.** A refund stops new tokens, not the current one.
Apple's `REFUND` notification marks the refunded transaction, so its
receipt gets no further token; the household stays writable until its
current end date, the next 4th or, if next month's token was already
claimed, the 4th after that: at most about 41 days. A later renewal or a
new purchase is a different transaction and is not blocked; whether Apple
stops auto-renewal after a refund is to confirm, and if it does not, the
next renewal gets tokens, which is the intended reading. On Polar a
refund does not end a subscription: the owner
must also revoke it, or it keeps getting tokens. If Apple's
notification never arrives, a receipt signed before the refund can still
be claimed until its own expiry, by the bound device or after a rebind:
about a month for a monthly plan, up to the end of the paid year for a
yearly one. Closing that needs Apple's server API and an API key, which
version 2 avoids.

**Exhausting the Polar allowance.** Refused claims (`bound-to-other-device`,
`replacement-used`, `revoked`) do not count against the per-marker limit,
so a holder of the code without the claim secret cannot use up the bound
device's allowance. But each refused website claim still costs one call
to Polar, bounded only per IP address. An attacker with many addresses
could push the organisation's Polar allowance (500 requests a minute)
towards its limit and cause `billing-unavailable` for every buyer for as
long as they keep it up. Households keep working until `E` meanwhile.
Apple refusals cost no outbound call.

**Who holds a website subscription code.** The code is Polar's
subscription ID, which Polar does not present as a secret: besides the
buyer, the owner (Polar's dashboard), every webhook consumer of the
organisation and anyone holding the organisation token can read it, and
the welcome page shows it to whoever holds the checkout URL. Any of them
can do what a thief of the code can do, below, and no more.

**A thief of a subscription code or of a copy of a receipt.** Once the
buyer has claimed, the thief is refused (`bound-to-other-device`): the
thief does not have the buyer's claim secret, which never leaves the
buyer's devices except to the claim service (and, on iOS, to the buyer's
own iCloud Keychain). A thief who claims before the buyer ever does binds
the subscription, and the buyer then needs the rebind. The rebind is a
bearer power too: a thief who also uses it takes the subscription back,
and the buyer cannot rebind again for 180 days, so a persistent thief can
hold a subscription for up to 180 days at a time. A thief can also bind
when the buyer's device missed a whole renewal window (about 10 days
offline), because the binding is then stale. The thief cannot reach the
owner's household (that needs the pairing code) and gets no buyer data
from Sitr: the token has no identity, and errors never name the plan or
paid end. A Polar subscription ID cannot be rotated; the remedy is to cancel
and buy again. A copy of an Apple receipt works only until its
`expiresDate`; later receipts reach only the buyer's devices.

**The keyed marker.** The marker is HMAC-SHA-256 under a key only the
claim process holds. A leak of the claim database alone gives hashes that
cannot be read back or tested without the key. A leak of the key and the
database lets the holder test known subscription IDs, as the operator
can. The key never enters the sync service, which parses untrusted
blob traffic, for the same reason the signing key does not; that holds
only if neither key is set on the sync service or as a project-wide
shared variable, which the deployment steps forbid.

**Apple receipts are checked with the standard library.** The claim
service verifies Apple's certificate chain and signature with Node's
`node:crypto` against a pinned root, with no runtime dependency, so a
mistake there would be ours. The steps are listed for review in the
spec, and the tests compare results with Apple's own library. Apple's
certificates are not checked for revocation, which would be an online
check. The pinned root is a certificate file downloaded from Apple's
certificate authority page; a person compares its fingerprint with the
value on that page before the first deployment. The trust anchor is a
constructor argument that no setting can change, so tests can use their
own chains while production can accept only Apple's.

## Out of scope / honest limitations

- **A determined user can bypass Sitr** (disable the extension, another
  browser, DNS). Sitr is a protection for people who *want* it, not a
  warden. The parental/family tier may add friction, never surveillance.
- **DNS fallback option**: a user's chosen DNS filter sees query metadata by
  design — we disclose that tradeoff rather than pretend it away.
- **Content inside allowed sites** (e.g. adult content on a social platform)
  is not visible to DNR and is not filtered at domain level. The optional
  media-filtering layer (T12) narrows this for images and media by resource
  type; what remains (streaming, embedded frames, text) is listed there.
- **The opt-in lists are partial.** The violence list (off by default)
  blocks a few hundred known gore and hate sites, many of them old, not
  such content in general; the encrypted-DNS list (Android, and the iOS
  DNS filter) covers
  well-known providers only. Sitr has no drugs list and no phishing list.
