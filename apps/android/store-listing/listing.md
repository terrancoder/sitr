# Google Play listing copy — Sitr for Android

*Must stay consistent with docs/privacy-policy.md, the Chrome listing, the
Chrome data-safety form, the Apple App Privacy label, and in-app text (the
six-way consistency rule). No absolutist claims — only specific,
substantiated ones. Every sentence below describes what the shipped build
does; see docs/mobile.md and docs/threat-model.md T9.*

## App name (30 chars max)

Sitr — Halal & Family Filter

## Short description (80 chars max)

Adult-content filter + SafeSearch, entirely on-device. No account, no tracking.

## Full description (4000 chars max)

Sitr (سِتْر — "covering, protection") blocks adult, gambling and dating
sites and enforces SafeSearch on every app on your phone — built for Muslim
families, useful for anyone who wants a cleaner internet without being
watched.

**Private by design, not by promise**

Most content filters route your traffic through their servers or phone home
about what you visit. Sitr does neither, and you don't have to take our word
for it:

• Filtering happens on your device, by DNS. Sitr looks at the hostname your
  apps ask for, decides in memory, and discards it. Nothing is logged or sent.
• Allowed lookups go to the DNS server your network already uses — never to
  a Sitr server or any third-party resolver.
• The blocklist is identical for every user and published openly, so we have
  no way to see which sites you visit — and you can see and contest every rule.
• No account, no analytics, no crash reporting, no ads, no third-party SDKs.
  Analytics aren't "off by default" — they don't exist in the code.
• Open source with a reproducible build: anyone can rebuild the app and
  compare it against the published checksum.

**Why Android shows a VPN key icon**

Android's only system-wide filtering mechanism is a local VPN. Sitr's VPN is
DNS-only: the tunnel routes nothing but DNS lookups, and the app cannot see,
proxy, or inspect any other traffic. There is no TLS interception and no
Sitr server in the path. The design and its limits are documented in the
public threat model.

**What it does**

• Blocks adult content, gambling, and dating sites (gambling and dating are
  optional categories you can toggle)
• Forces SafeSearch on Google, Bing, and DuckDuckGo, and YouTube Restricted Mode
• Per-site allow and block lists, stored only on your phone
• Optional guardian PIN so settings can't be loosened casually
• Optional Sitr Family household: shares lists across devices, end-to-end
  encrypted, unreadable to us
• Shows a red "protection inactive" warning if filtering ever stops —
  another VPN takes over, Private DNS bypasses it — instead of pretending
• Supports managed configuration for organisations and Family Link

**What it doesn't do**

No monitoring. Sitr never records, reports, or shows anyone what you or your
children browse. No screenshots, no location, no app lists, no accessibility
service. The optional Family plan stores exactly one thing on our server: an
end-to-end-encrypted household-settings blob we cannot decrypt — household
preferences, never browsing.

Honest limits: a user-set strict Private DNS hostname or a browser's own
"Secure DNS" bypasses DNS filtering. Sitr detects the first and warns you.

Source code, blocklist, and appeals: https://github.com/terrancoder/sitr

## Form fields

| Field | Value |
|---|---|
| Category | Tools |
| Tags | Content filter, Parental controls, Privacy |
| Email | dev@dooplin.com (or support@sitrshield.com if it exists) |
| Website | https://sitrshield.com |
| Privacy policy | https://sitrshield.com/privacy |
| Pricing | Free app; no in-app purchases or IAP. Sitr Family is sold externally on sitrshield.com and redeemed by pasting a pairing code/token in-app (Play permits redemption of externally obtained access without in-app purchase steering — see Udocs/mobile-dev-plan.md). |
| Ads | Contains no ads |
| Target audience | 18 and over only. **Do not** select any under-18 group and do not enrol in Designed for Families. |
| App access | **Yes, some functionality is restricted** — Play's Yes-list explicitly includes "payments… access tiers" and "referral codes": creating a household needs an externally purchased Sitr Family token, and joining one needs a pairing code. Everything else works with no login. Provide instructions plus a live test token and a test pairing code (see Review notes). Answering "No" here is a rejection risk if the reviewer opens Sitr Family. |

## Content rating questionnaire

Category: Utility / Productivity / Communication / Other. Answer "no" to
every violence, sexual, drug, gambling, and user-interaction question. The
app *blocks* gambling sites; it does not contain gambling. Expected rating:
Everyone / PEGI 3.

## VpnService declaration (App content → Sensitive permissions and APIs → VPN service)

The section only appears after a build using BIND_VPN_SERVICE has been
uploaded to any track. The form (as of 2026-09) has no free-text field; it
asks:

| Question | Answer |
|---|---|
| Is providing a VPN the core functionality? | **No** (filtering is; the VPN is only the mechanism) |
| Permitted functionality | **Parental control** only |
| General VPN service directly to users? | **No** |
| Does your VPN service collect personal and sensitive user data? | **No** — Play defines "collect" as transmitting off-device; DNS names are inspected in memory, discarded, and forwarded only to the network's own resolver. Must match the Data safety form (Web browsing history: not collected). |
| Redirect/manipulate traffic for monetization? | **No** |
| Video instructions (≤90 s, required) | Unlisted YouTube link to `apps/android/build/review-video/sitr-vpn-review.mp4` (recorded with the scripts beside it) |

Background wording, useful if a reviewer asks for clarification:

> Sitr uses VpnService solely to filter DNS on the device. The tunnel routes
> only two synthetic resolver addresses (10.111.222.1/32 and an fd66:: /128),
> so exclusively DNS packets enter it; the app structurally cannot see,
> proxy, or modify any other traffic. Blocked hostnames are answered locally
> with 0.0.0.0/::; SafeSearch hostnames are rewritten to the search engines'
> own SafeSearch endpoints; every other query is forwarded unchanged to the
> DNS resolvers of the underlying network — never to a server operated by us
> or any third party. There is no TLS interception, no traffic logging, no
> collection or sale of any data, no manipulation of ads, and no remote
> server in the data path. The VPN is user-initiated after an in-app
> disclosure screen and can be turned off at any time. Source:
> https://github.com/terrancoder/sitr (apps/android/engine).

## Data safety form

Same claims as docs/privacy-policy.md and the Chrome data-safety form.

- **Does your app collect or share any of the required user data types?**
  Yes (only because Family sync exists; the default install transmits nothing).
- **Account creation**: "My app does not allow users to create an account"
  (the pairing-code join is not username/password/OAuth account creation).
  "Can users login with accounts created outside the app?" No.
- **Is all collected data encrypted in transit?** Yes.
- **Do you provide a way for users to request deletion?** **Yes** — Delete
  data URL: `https://sitrshield.com/data-deletion` (names the app and
  Dooplin Apps, per-platform steps, what is kept: the encrypted server blob
  until 18 months idle or on email request).
- Data types collected: check exactly **Device or other IDs** — the random
  per-device identifier each device generates for the household. Note:
  Play's form has no "Authentication information"/password category (do
  not look for one); the guardian PIN's salted hash doesn't map to any
  category in Play's fixed data-type list (Location, Personal info,
  Financial info, Health and fitness, Messages, Photos and videos, Audio
  files, Files and docs, Calendar, Contacts, App activity, Web browsing,
  App info and performance, Device or other IDs) and should NOT be forced
  into "Personal info → Other info" (Play defines that narrowly as things
  like date of birth/gender identity — a credential hash isn't that).
- Every other category, including Web browsing history and App activity:
  **not collected**. Sitr reads DNS names in memory and discards them; that
  is on-device processing and is not "collection" under Play's definition
  (never leaves the device).
- Independent security review: No.

## Review notes (App content → App access / notes)

> Sitr is a DNS-based content filter, not a monitoring app. It does not use
> the Accessibility API, Device Admin, or QUERY_ALL_PACKAGES. To test: open
> the app, complete the three onboarding screens (the second explains the
> local DNS-only VPN before any system dialog), tap Turn on, accept the VPN
> prompt, then open Chrome and load https://1xbet.com — it fails to load
> (blocked by DNS; same as in the review video). Load
> https://google.com/search?q=test — the results page shows SafeSearch locked
> on. Sitr Family: joining a household needs a pairing code; creating one
> needs a Sitr Family token purchased on sitrshield.com. Test token: [PASTE
> ON SUBMISSION DAY]. Test pairing code: [PASTE ON SUBMISSION DAY].

## Assets checklist

All in `apps/android/store-listing/assets/` (generated 2026-09-16; the
`.html` files beside each PNG are the sources — re-render with Playwright's
cached Chrome for Testing in headless mode at the exact pixel size):

- `icon-512.png` — 512×512, no alpha (adaptive-icon mark on #121a16)
- `feature-1024x500.png` — 1024×500 feature graphic
- `screenshot-1..5.png` — 1080×1920 phone screenshots (raw 1080×2400
  emulator captures are in `raw/`; they are 9:20, outside Play's 16:9–9:16
  limit, hence the framing): Home active, blocked site in Chrome,
  Filter categories, VPN disclosure onboarding, Sitr Family.
- `video/sitr-promo-1080p.mp4` — 1920×1080, 63 s, silent promo for the
  "Video" field of the store listing: intro card → the review recording
  framed beside the pitch → end card. Upload to YouTube (public or
  unlisted, ads off, embeddable) and paste the watch URL; Play does not
  accept file uploads. Sources: `video/*.html` + the ffmpeg command in
  the session that produced it (intro 3 s, xfade 0.6 s, outro 4 s).
