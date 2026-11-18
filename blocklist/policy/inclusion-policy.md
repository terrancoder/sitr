# Sitr blocklist inclusion policy

The blocklist is public. Every rule is visible in this repository, and every
rule can be contested through the [appeals process](appeals-process.md).

## Categories

| Category | Included | Not included |
|---|---|---|
| `adult` | Pornographic sites, live-cam platforms, adult content marketplaces | Sex education, medical/health resources, news reporting |
| `gambling` | Casinos, sports betting, online poker, lottery sales | News about gambling, addiction-recovery resources |
| `dating` | Dating/hookup apps and sites | Matrimonial services are under discussion — file an issue |

## Two tiers per list

Each category directory holds up to two files:

- `domains.txt` — the **curated tier**, written by hand.
- `imported.txt` — the **imported tier**, written only by the import tool
  (`tools/import`) from vetted open lists declared in
  [`blocklist/imports/sources.json`](../imports/sources.json). Never edited
  by hand.

The compiler merges the two. An entry in both is kept once, as curated.

### Criteria for adding a domain to the curated tier

1. The domain's **primary purpose** matches the category. Sites with incidental
   or user-generated adult content are not blocked at domain level.
2. Evidence is recorded in the pull request (what the site is, why it qualifies).
3. Domains are listed at the **registrable domain** level; subdomains are
   covered automatically. Over-broad entries (e.g. a shared hosting domain)
   are rejected.

### The imported tier

- The evidence is the named upstream list, its licence, and the snapshot's
  SHA-256 and retrieval date. All of these are recorded in the header of
  each `imported.txt`, and the sources are credited in
  [`blocklist/imports/ATTRIBUTION.md`](../imports/ATTRIBUTION.md).
- Only public lists under MIT, CC BY 4.0 or CC BY-SA 4.0 are imported
  (the blocklist data is CC BY-SA 4.0; the import tool refuses any other
  licence). No GPL sources and no sources with unclear terms. No
  private, paid or premium lists: everything Sitr blocks stays in this
  repository, identical for every user on a platform.
- Imported entries may be **hostnames** rather than registrable domains
  (`cdn.example.com`), exactly as the upstream lists them. The import never
  widens an entry to its registrable domain; the one change it makes is
  dropping a leading `www.`.
- Every imported entry passes the guards below. The import tool drops and
  counts what fails, and the counts are in the file header.
- The imported tier has a stricter never-block rule than the curated tier:
  no imported entry may be a never-block name, contain one, or sit under
  one (`boards.4chan.org`, a `*.fc2.com` blog, a `cloudfront.net`
  distribution). Only a human, in the curated tier and with evidence, may
  list a specific subdomain of a never-block platform.
- An imported list of doubtful precision may be narrowed by a public name
  rule recorded in `sources.json` (`requireNameMatch`): only names
  containing one of its terms are kept. UT1's gambling list is narrowed
  this way, because many of its names are expired domains with no sign of
  gambling in them.
- A false positive is removed by adding it to
  [`import-exclusions.txt`](import-exclusions.txt) through the
  [appeals process](appeals-process.md) and re-running the import.

## Guards on every list

The compiler fails the build, naming the file and line, when:

- an entry is a **public suffix** (`co.uk`, `github.io`, `blogspot.com`)
  or has one beneath it (`kawasaki.jp`, where every `*.kawasaki.jp` is a
  suffix), using a checked-in snapshot of the Public Suffix List;
- an entry is an IP address;
- an entry would block a name on the [never-block list](never-block.txt):
  search engines, the platforms named above as not blocked, app stores,
  operating-system vendors, CDNs, email, payment, messaging, health and
  education sites;
- an entry is listed in more than one category or optional list.

An entry under another entry of the same list (`cdn.example.com` next to
`example.com`) adds nothing and is dropped at compile time.

## Optional lists

Lists under `blocklist/optional/` (the
[encrypted-DNS hosts](doh-hosts-policy.md), and the
[violence list](violence-list-policy.md): gore and shock-video sites plus
mostly old hate sites, imported only) are
**off by default** and ship
as separate artifacts, never merged into a category. Each has its own
policy, and the same guards apply.

## Criteria for removing a domain

Only genuine **false positives** — over-broad rules catching legitimate
content — get unblocked. Content that is deliberately targeted by a category
stays blocked; "I disagree with the category existing" is not a false positive.

## Maintainers

- Founding maintainer — support@sitrshield.com
- (additional maintainers listed here as they join)

All additions and removals happen via reviewed pull requests. No rule enters
the shipped ruleset except through this public repository and the
deterministic compiler in `tools/compiler/`.
