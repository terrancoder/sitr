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
nothing (§4 of the working agreement).

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

### T8: A malicious or compromised institution admin
Managed policy can force categories ON, add domain rules, and lock the
options page — it cannot observe browsing (nothing in the extension
reports anything, in any tier) and cannot weaken the always-on protections
for other users. The admin-trust boundary is the browser's enterprise
contract: an admin who controls the device could install anything anyway.
Sitr keeps its own promise inside that boundary: applied policy is always
visible on the options page ("Managed by X", locked rows), and a policy
that fails to apply turns the badge red.

## Out of scope / honest limitations

- **A determined user can bypass Sitr** (disable the extension, another
  browser, DNS). Sitr is a protection for people who *want* it, not a
  warden. The parental/family tier may add friction, never surveillance.
- **DNS fallback option**: a user's chosen DNS filter sees query metadata by
  design — we disclose that tradeoff rather than pretend it away.
- **Content inside allowed sites** (e.g. adult content on a social platform)
  is not visible to DNR and is not filtered at domain level.
