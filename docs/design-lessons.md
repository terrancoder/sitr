# Design lessons — why "trust us" filters fail

A leading product in this category — a filter marketed to Muslim families
with strong privacy language — had its browser extension removed from the
Chrome Web Store in 2024 for a policy violation. Independent analysis of the
vendor's apps reported, among other things:

- an **advertising SDK** inside a privacy product,
- **undisclosed session-replay analytics** capturing user interactions,
- **silent uploads of device app inventories**,
- marketing claims ("no tracking") that contradicted observed behavior.

Sitr exists as the deliberate anti-thesis. Each failure mode maps to a
structural countermeasure — this checklist is re-checked before every release:

| Category failure mode | Sitr countermeasure |
|---|---|
| Ad SDK in a privacy product | Zero third-party SDKs of any kind; zero runtime dependencies; user-funded revenue only |
| Session-replay analytics | No analytics at all; no code path that transmits user data |
| Silent app/data uploads | Extension makes **no network requests**; any future request must be documented in [data-flow.md](data-flow.md) before shipping |
| Server-side filtering that sees traffic | On-device DNR only; no per-user server exists |
| Claims contradicting behavior | Five-way consistency rule (listing = policy = data-safety form = UI = marketing), open source, reproducible builds |
| Absolutist marketing ("zero tracking") | Only specific, substantiated claims |
| Opaque blocklist decisions | Public sources, written inclusion policy, named maintainers, appeals process |

The one-sentence lesson: **a privacy promise you can't verify is a marketing
claim; an architecture that can't betray you is a guarantee.** Every design
decision in Sitr chooses the second kind.
