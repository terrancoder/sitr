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

## Out of scope / honest limitations

- **A determined user can bypass Sitr** (disable the extension, another
  browser, DNS). Sitr is a protection for people who *want* it, not a
  warden. The parental/family tier may add friction, never surveillance.
- **DNS fallback option**: a user's chosen DNS filter sees query metadata by
  design — we disclose that tradeoff rather than pretend it away.
- **Content inside allowed sites** (e.g. adult content on a social platform)
  is not visible to DNR and is not filtered at domain level.
