# Sitr blocklist inclusion policy

The blocklist is public. Every rule is visible in this repository, and every
rule can be contested through the [appeals process](appeals-process.md).

## Categories

| Category | Included | Not included |
|---|---|---|
| `adult` | Pornographic sites, live-cam platforms, adult content marketplaces | Sex education, medical/health resources, news reporting |
| `gambling` | Casinos, sports betting, online poker, lottery sales | News about gambling, addiction-recovery resources |
| `dating` | Dating/hookup apps and sites | Matrimonial services are under discussion — file an issue |

## Criteria for adding a domain

1. The domain's **primary purpose** matches the category. Sites with incidental
   or user-generated adult content are not blocked at domain level.
2. Evidence is recorded in the pull request (what the site is, why it qualifies).
3. Domains are listed at the **registrable domain** level; subdomains are
   covered automatically. Over-broad entries (e.g. a shared hosting domain)
   are rejected.

## Criteria for removing a domain

Only genuine **false positives** — over-broad rules catching legitimate
content — get unblocked. Content that is deliberately targeted by a category
stays blocked; "I disagree with the category existing" is not a false positive.

## Maintainers

- Founding maintainer - maintainer@terrancoders.com
- (additional maintainers listed here as they join)

All additions and removals happen via reviewed pull requests. No rule enters
the shipped ruleset except through this public repository and the
deterministic compiler in `tools/compiler/`.
