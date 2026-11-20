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
  a Sitr server or any third-party resolver. They travel unencrypted, so
  Android's automatic encrypted DNS is not used while Sitr is on.
• The blocklist is identical for every user and published openly, so we have
  no way to see which sites you visit — and you can see and contest every rule.
• No account, no analytics, no crash reporting, no ads, no third-party SDKs.
  Analytics aren't "off by default" — they don't exist in the code.
• Open source with a reproducible build: anyone can rebuild the unsigned app and
  compare it against the published checksum.

**Why Android shows a VPN key icon**

Android's only system-wide filtering mechanism is a local VPN. Sitr's VPN is
DNS-only: the tunnel routes nothing but DNS lookups, and the app cannot see,
proxy, or inspect any other traffic. There is no TLS interception and no
Sitr server in the path. The design and its limits are documented in the
public threat model.

**What it does**

• Blocks adult content, gambling, and dating sites: about 100,000 domains
  (gambling and dating can be switched off)
• Optional lists, off by default: gore and hate sites (old and
  incomplete); well-known encrypted-DNS services
• Forces SafeSearch on Google, Bing, and DuckDuckGo, and YouTube Restricted Mode
• Optional switches to turn off all images and video on X, Reddit, Tumblr,
  Pinterest and Imgur, in their apps and websites (Sitr can't tell which
  pictures are explicit, so it's all of a site's media or none)
• Per-site allow and block lists, stored only on your phone
• Optional guardian PIN so settings can't be loosened casually, and an
  optional wait (5 minutes to 24 hours) before loosening changes
• Optional Sitr Family household: shares lists across devices, end-to-end
  encrypted, unreadable to us
• Shows a red "protection inactive" warning if filtering ever stops —
  another VPN takes over, Private DNS conflicts — instead of pretending
• Optional child lock (Sitr Family): on a child's phone, protection can't be
  switched off without the guardian PIN. It uses Android's Accessibility
  service to close the screens that would turn Sitr off (its app info,
  uninstalling, VPN and accessibility settings and the like). It reads those
  screens on the phone only; nothing is recorded or sent
• Supports managed configuration for organisations and Family Link

**What it doesn't do**

No monitoring. Sitr never records, reports, or shows anyone what you or your
children browse. No screenshots, no location, no app lists. The optional
Family plan stores exactly one thing on our server: an
end-to-end-encrypted household-settings blob we cannot decrypt — household
preferences, never browsing.

Honest limits: a fixed Private DNS hostname conflicts with Sitr; Sitr
shows red and tells you to set it to Automatic or Off. A browser's own
"Secure DNS" with a chosen provider bypasses filtering; the encrypted-DNS
switch blocks well-known providers, so pages fail until Secure DNS is back
on automatic (tested with Chrome on Android 15). Providers set by IP
address or not listed still bypass. Most of the list comes from public
lists checked by name, so some entries will be wrong: allow the site (not
an adult-listed one) and use "Report a site" (a public form or your
mail app; Sitr sends nothing).

Source, blocklist, appeals: https://github.com/terrancoder/sitr

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

## Accessibility API declaration (App content → Sensitive permissions and APIs → Accessibility API)

Appears after a build with the AccessibilityService is uploaded. Policy:
https://support.google.com/googleplay/android-developer/answer/10964491 —
the service is **not** an accessibility tool (`isAccessibilityTool="false"`;
Play reserves that for apps built for people with disabilities). Parental
control use is allowed: the Accessibility API may not be used to "prevent
the ability for users to disable or uninstall any app or service unless
authorized by a parent or guardian through a parental control app"
(answer/16558241).

| Question | Answer |
|---|---|
| Why does your app need the Accessibility Services API? | **App functionality** only |
| Do you collect and/or share personal or sensitive data using the accessibility capabilities? | **No** — window text is read in memory on the device and discarded; nothing leaves the phone. Must match Data safety and the privacy policy |
| Video link | Unlisted YouTube link to `assets/video/sitr-accessibility-review.mp4` (gitignored; re-recorded 2026-11-20 on the `sitr-video` emulator with the 0.3.0 release build (versionCode 8), whose disclosure says Sitr reads "the text and type of the window" and names "setting up or opening a private space"; 1:54, 720 × 1770, captions burned in. Script, step times and captions are in `build/review-video/a11y-0.3.0/`. Older videos are kept as `sitr-accessibility-review-0.2.2.mp4`, `-0.2.1.mp4` and `-0.2.0.mp4`) |

Description wording if asked: "Sitr is a parental control. When a guardian
turns on the optional child lock (protected by the guardian PIN), a fixed,
rule-based list of checks closes the screens that would switch Sitr off on
the child's phone: Sitr's App info and other settings pages that show
Sitr's name, its uninstall prompt, its VPN and accessibility settings, the
VPN disconnect dialog, Developer options, adding users, setting up or
opening a private space, the Private DNS dialog and the mobile network reset (which
would clear always-on VPN). It leaves Android's own recovery tools, safe
mode and factory reset, alone. It reads text, and which window is open,
only in Settings, app
installers, the Play Store and system dialogs, only on the device, stores nothing and sends nothing. It
does not act autonomously, does not read other apps, and does nothing until
the lock is on."

The in-app disclosure, word for word (`GUARD_DISCLOSURE` in
`app/src/main/kotlin/com/sitrshield/app/ui/ChildLockScreen.kt`, 0.3.0):
"Sitr's child lock uses Android's Accessibility service. While a guardian
has the lock on, Sitr reads the text and type of the window in front of you
when it is Settings, an app installer, the Play Store or a system dialog, to
recognise the screens that would switch Sitr off — its app info and other
settings pages that show Sitr's name, uninstalling, its VPN and
accessibility settings, the VPN disconnect dialog, Developer options, adding
users, setting up or opening a private space, the Private DNS dialog and the
mobile network reset — and closes them. The text is checked on this phone
and discarded at once: nothing is stored, and nothing is sent anywhere. Sitr
doesn't read other apps, and the lock opens only with the guardian PIN. Sitr
filters only this phone's main user: a private space, work profile or other
user that already exists is not filtered, so remove it before you lock the
phone."

**Video (required parts, per answer/10964491)** — record on a phone with the
release build, under 2 minutes, captions on (the 2026-11-20 recording
follows this list):
1. Sitr's Child lock screen (household with a guardian PIN already set,
   step 1 always-on VPN already on).
2. Step 2 "Turn on accessibility guard" → the disclosure dialog, shown
   whole for about 15 s.
3. Consent: tap "I agree" → Accessibility settings → "Sitr child lock"
   (its description) → switch on → Allow.
4. Back in Sitr tap "Lock this phone".
5. Core feature, each closed with "Locked by Sitr — ask your guardian.":
   Sitr's App info, the uninstall prompt for Sitr, Sitr's VPN settings,
   the Private DNS dialog (Settings → Network & internet), "Reset Mobile
   Network Settings" (System → Reset options), and the private space setup
   (Security & privacy → Private space, after the screen-lock PIN; never
   press SET UP).
6. Screens that stay open: Network & internet, Wi-Fi (Internet) and the
   Reset options list. Show Wi-Fi before private space: on the emulator,
   after the private space setup is closed, Settings kept closing for the
   rest of that recording.
7. End on the Child lock screen with "Guard mode is on".
   (Open App info by its link or the launcher, not Settings → Apps: that
   whole page closes because Sitr is listed under Recent apps, which looks
   like a crash on video. The decline step and the PIN unlock were left
   out to stay under 2 minutes.)

If the use changes later, Play requires submitting this form again.

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
- Data types collected: check exactly **Device or other IDs** — the
  household ID, which the sync server keeps readable as the key of the
  household's record. (The random per-device IDs travel only inside the
  end-to-end-encrypted blob, which Play's form puts out of scope: "does
  not need to be disclosed as collected". Corrected in the repo on 19
  November 2026; this line used to name the per-device ID.) *Owner note:
  the Play Console answers need no change: the data type stays Device or
  other IDs and every other answer in this section stays as it is. Only
  this file's explanation changed; as far as this file records, the form
  has no free-text field for the reason (check on screen).* Note:
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
  (never leaves the device). The same holds for the optional child lock's
  accessibility service, which reads foreground window text in memory to
  recognise screens that would disable Sitr, and discards it.
- Independent security review: No.
- Re-checked 2026-11-18 against the opt-in lists (violence, encrypted-DNS
  hosts), the larger blocklist, "Wait before loosening" and the "Report a
  site" links: no answer changes. The lists ship in the app, and their
  switches and the wait are stored only on the phone; the report links open the browser or mail app and the app
  sends nothing.

## Review notes (App content → App access / notes)

> Sitr is a DNS-based content filter, not a monitoring app. It does not use
> QUERY_ALL_PACKAGES or Device Admin. The Accessibility API is used only by
> the optional child lock, which a guardian turns on after a prominent
> disclosure dialog; the accessibility service closes the screens that would
> disable the parental control, and nothing it reads leaves the device. To test: open
> the app, complete the three onboarding screens (the second explains the
> local DNS-only VPN before any system dialog), tap Turn on, accept the VPN
> prompt, then open Chrome and load https://1xbet.com — it fails to load
> (blocked by DNS; same as in the review video). Load
> https://google.com/search?q=test — the results page shows SafeSearch locked
> on. Sitr Family: joining a household needs a pairing code; creating one
> needs a Sitr Family token purchased on sitrshield.com. Test token: [PASTE
> ON SUBMISSION DAY]. Test pairing code: [PASTE ON SUBMISSION DAY].
> Child lock: Sitr Family → Create household with the test token → set a
> guardian PIN → Back → Child lock → step 1 (set Sitr as always-on VPN) →
> step 2 (disclosure → I agree → switch on "Sitr child lock") → Lock this
> phone. Long-press the Sitr icon → App info or Uninstall: the screen is
> closed. Child lock → Turn off child lock → the PIN unlocks it.

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
- The promo video's claims still hold (checked frame by frame 2026-10-18;
  it never mentions accessibility). The separate 16:9 demo
  (`video/demo/`) said "No accessibility service"; that line was removed
  from its source on 2026-10-18 — re-render before using that demo
  anywhere.
- `video/sitr-promo-1080p.mp4` — 1920×1080, 63 s, silent promo for the
  "Video" field of the store listing: intro card → the review recording
  framed beside the pitch → end card. Upload to YouTube (public or
  unlisted, ads off, embeddable) and paste the watch URL; Play does not
  accept file uploads. Sources: `video/*.html` + the ffmpeg command in
  the session that produced it (intro 3 s, xfade 0.6 s, outro 4 s).

## Version with subscription code (not yet published)

> **NOT YET PUBLISHED.** For the first store version that takes a Sitr
> Family subscription code (built on the development branch, not part of
> 0.3.0). Nothing below applies to the listing, forms or review notes
> above, which stay as they are until that version ships.

- **Sentence the description will need:** "Sitr Family is an optional
  paid plan sold on sitrshield.com by the publisher." No link and no call
  to action: the app sells nothing in-app. The description is at 3,996
  of 4,000 characters, so other text must make room for it.
- **Pricing row:** still no in-app purchase; Sitr Family is redeemed by
  entering a subscription code (or, until the cut-over, a token) instead
  of a token only.
- **Data safety:** the subscription code is sent to the publisher's claim
  service (claim.sitrshield.com) together with a random claim secret made
  on the phone. The code is an identifier, so it is most likely **User
  IDs** (Personal info); the claim secret is likely covered by the
  existing Device or other IDs answer. Whether **Purchases** (Financial
  info) also applies, as the privacy draft suggests, is a second question.
  Both to be confirmed by the owner before submission. Also answer from the privacy-policy text that ships with it
  (draft: docs/entitlement-v2-privacy-text-draft.md).
- **App access and review notes:** a subscription code binds to one
  device, so reviewers do not get one. They get a pairing code to a demo
  household and its guardian PIN, join it as a guardian, and test Sitr
  Family and the child lock from there. The child-lock steps then start
  with joining instead of creating a household.
- **Permissions:** none added. The claim goes through the existing
  network access, and the VpnService and Accessibility declarations do not
  change.
