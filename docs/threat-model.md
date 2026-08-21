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

## Out of scope / honest limitations

- **A determined user can bypass Sitr** (disable the extension, another
  browser, DNS). Sitr is a protection for people who *want* it, not a
  warden. The parental/family tier may add friction, never surveillance.
- **DNS fallback option**: a user's chosen DNS filter sees query metadata by
  design — we disclose that tradeoff rather than pretend it away.
- **Content inside allowed sites** (e.g. adult content on a social platform)
  is not visible to DNR and is not filtered at domain level.
