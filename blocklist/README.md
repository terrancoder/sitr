# Sitr public blocklist

This directory is the **public source of truth** for everything Sitr blocks.
It is identical for every user — which is what makes "we can't see your
browsing" true by construction: there is no per-user list to correlate.

- `sources/<category>/domains.txt` — the hand-curated tier: one domain per
  line, `#` comments.
- `sources/<category>/imported.txt` — the imported tier, written only by
  `npm run import` from the open lists in `imports/sources.json`
  (credited in `imports/ATTRIBUTION.md`).
- `optional/<id>/` — opt-in lists, off by default, declared in
  `optional/lists.json` and shipped as separate artifacts.
- `policy/inclusion-policy.md` — what belongs in each category, and who decides.
- `policy/never-block.txt` — names no entry may ever block (a compile guard).
- `policy/import-exclusions.txt` — imported entries removed on appeal or at import review.
- `policy/appeals-process.md` — how to contest a rule.

Rulesets shipped in the extension (`extension/rulesets/`) and the app lists
(`apps/shared/blocklists/`) are **compiled output** of these files via
`tools/compiler` — deterministic, so anyone can
rebuild and byte-compare. Never edit the compiled JSON; change the source here.

## Licence

The blocklist data in this directory and the compiled list artifacts
(`extension/rulesets/`, `apps/shared/blocklists/`) are licensed under
[CC BY-SA 4.0](LICENSE) — separately from Sitr's code, which is MPL-2.0
(root `LICENSE`). The imported tiers include material from open lists
under MIT, CC BY 4.0 and CC BY-SA 4.0; source, author, licence and the
changes Sitr made are recorded in [`imports/ATTRIBUTION.md`](imports/ATTRIBUTION.md).
Only sources under those three licences may be imported.
