# Mac App Store listing copy

*Must stay consistent with docs/privacy-policy.md, the App Privacy label,
the in-app UI, and all public statements (the six-way consistency rule —
this listing is one of its surfaces). App Store descriptions render as
PLAIN TEXT: strip the markdown ** markers when pasting into App Store
Connect. No absolutist claims — only specific,
substantiated ones. This is the JOIN-ONLY channel: no household creation,
no token entry, and NO text about where Sitr Family access is obtained
(App Store guideline 3.1.1; enforced mechanically by
`tools/pack/stage-safari.mjs --channel mas` and its grep gate).*

## Name (30 chars max)

Sitr — Family Content Filter

## Subtitle (30 chars max)

Halal filtering, on-device

## Description

Sitr (سِتْر — "covering, protection") brings on-device adult, gambling and
dating-site blocking plus SafeSearch enforcement to Safari — built for
Muslim families, useful for anyone who wants a cleaner internet without
being watched.

**Private by design, not by promise**

Most content filters route your traffic through their servers or phone home
about what you visit. Sitr does neither — and you don't have to take our
word for it:

• All filtering happens inside Safari, using Safari's own content-rules
  engine. Sitr cannot read the contents of pages you visit.
• The blocklist is identical for every user and maintained in public, so
  there is structurally no way for us to see which sites you visit — and
  every rule can be contested through a public appeals process.
• No ad networks, no analytics, no telemetry. None.
• The full source code is public, and the shipped rulesets carry published
  checksums anyone can verify.

**What it does**

• Blocks adult, gambling and dating sites (gambling and dating are
  optional categories you can toggle — adult filtering and SafeSearch are
  always on; they are what Sitr is for)
• Enforces SafeSearch on Google, Bing and DuckDuckGo, and YouTube
  Restricted Mode
• Optional media filtering: hide images and media on a public list of
  mixed-content sites (greylist), or everywhere except sites you allow
• Per-site allow and block lists — loosening ones is gated by the
  optional guardian PIN
• Sitr Family: join a household from a pairing code to share family
  settings across devices — synced only as an end-to-end-encrypted blob
  our server cannot read

**Honest limits**

A determined user can disable the extension — Sitr is a protection for
people who want it, not a warden. If protection is not provably active,
Sitr shows red and says so.

## Keywords (100 chars max)

halal,family,content filter,safesearch,parental,muslim,adult blocker,privacy,blocker

## App Privacy label

Same answers as the iOS app (identical sync protocol; keep the two label
surfaces in lockstep — Udocs/store-review-risk-register.md):

- Without Sitr Family: **Data Not Collected** in every category.
- With Sitr Family (optional, off by default): the app transmits ONE
  end-to-end-encrypted settings blob (allow/block lists, category
  choices, PIN hash) the server cannot read, keyed by a random household
  id. Declare as **User Content → App Functionality, not linked to the
  user's identity, not used for tracking**. Nothing else is ever
  transmitted — no analytics or telemetry of any kind.

## App Review notes (paste into App Store Connect's PRIVATE notes field)

Never commit a pairing code to this repo — a code IS a household's root
secret. For each submission, generate a fresh throwaway household on a
full-channel device and include:

- the throwaway pairing code, so review can exercise "join a household"
- "Household creation is available on other Sitr platforms; this app
  joins an existing household."
- setup steps: launch the app once → Safari → Settings → Extensions →
  enable Sitr → grant website access ("other websites: Allow"). Until
  the grants exist the app and popup show red BY DESIGN (the product
  never claims protection it can't prove).

## Copyright

© 2026 Dooplin Apps. Source available under MPL-2.0.

## Support / Marketing URLs

- Support: https://github.com/terrancoder/sitr/issues
- Marketing: https://sitrshield.com
- Privacy policy: https://sitrshield.com/privacy/
