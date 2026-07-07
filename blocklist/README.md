# Sitr public blocklist

This directory is the **public source of truth** for everything Sitr blocks.
It is identical for every user — which is what makes "we can't see your
browsing" true by construction: there is no per-user list to correlate.

- `sources/<category>/domains.txt` — one domain per line, `#` comments.
- `policy/inclusion-policy.md` — what belongs in each category, and who decides.
- `policy/appeals-process.md` — how to contest a rule.

Rulesets shipped in the extension (`extension/rulesets/`) are **compiled
output** of these files via `tools/compiler` — deterministic, so anyone can
rebuild and byte-compare. Never edit the compiled JSON; change the source here.
