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
public appeals process, and an on-device per-site allow that always wins.

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

The same honesty applies on mobile. On iOS, Screen Time in `.child` mode
(via Family Sharing) is real platform enforcement — a parent's approval is
required to revoke it. `.individual` mode is revocable friction, same as
the PIN. On Android, an unmanaged device offers no legitimate way to
prevent uninstall, and we refuse to abuse Device Admin or Accessibility
APIs to fake one. Real enforcement is a managed device (EMM or Family
Link) applying managed configurations — mirroring how the extension
defers to the browser's force-install policy.

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
build. The bypass surface is disclosed, never hidden: strict Private DNS
(a user-set DoT hostname) bypasses the filter — detected and surfaced as
a red protection status with guidance; a browser's own DoH ("Secure
DNS") cannot be intercepted; and Android's "block connections without
VPN" lockdown is unsupported by design, because DNS-only routes would
break all other traffic.

### T10: iOS platform limits
The Safari Content Blocker protects Safari only. Screen Time's web
filter, when the user authorizes it, extends to WebKit browsers
system-wide — but it is Apple's framework enforcing Apple's algorithmic
filter plus Sitr's deny list — the evaluation is Apple's, not ours.
SafeSearch cannot be enforced on iOS at all. We state each of
these in-app rather than imply full coverage.

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

Media filtering is a browser-extension capability. Android's DNS engine
categorically cannot see resource types; iOS could express the greylist
via content-blocker `resource-type` triggers, but does not today — the
asymmetry is stated in-app rather than papered over.

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
