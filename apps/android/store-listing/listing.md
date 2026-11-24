# Google Play listing copy — Sitr for Android

*Must stay consistent with docs/privacy-policy.md, the Chrome listing, the
Chrome data-safety form, the Apple App Privacy label, and in-app text (the
six-way consistency rule). No absolutist claims — only specific,
substantiated ones. Every sentence below describes what the shipped build
does; see docs/mobile.md and docs/threat-model.md T9.*

## App name (30 chars max)

Sitr — Family Content Filter

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
  (always on; no allow entry opens them)
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
• Shows a red "protection inactive" warning if filtering ever stops,
  instead of pretending
• Optional Reels blocking in the Facebook app: closes the Reels tab and
  full-screen reels. Feed previews stay; not in browsers
• Optional child lock (Sitr Family): on a child's phone, protection can't be
  switched off without the guardian PIN
• Both use Android's Accessibility service, only while on. It reads the
  Facebook app or the screens that would turn Sitr off, on the phone;
  nothing is recorded or sent
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
lists checked by name, so some entries will be wrong: use "Report a
site" (a public form or your mail app; Sitr sends nothing). Fixes come
with app updates.

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

**The use changed in 0.3.0 (2026-11-22), so this form must be submitted
again.** The service now has two uses: the child lock, as before, and
Reels blocking in the Facebook app, which any user can turn on. The
service's name in Android's settings is now "Sitr guard" (it was "Sitr
child lock").

| Question | Answer |
|---|---|
| Why does your app need the Accessibility Services API? | **App functionality** only |
| Do you collect and/or share personal or sensitive data using the accessibility capabilities? | **No**. Window text, and for Reels blocking the Facebook app's screen items, is processed in memory on the device and discarded; nothing is stored and nothing leaves the phone. Must match Data safety and the privacy policy |
| Video link | **Recorded 2026-11-24 for 0.3.0 (versionCode 11, the redesigned screens)**: `assets/video/sitr-accessibility-review.mp4` (gitignored; 2:46, 720 × 1770, no sound, captions burned in; what it shows is listed under "Video for 0.3.0" below; script, step times and captions in `build/review-video/a11y-0.3.0-vc11/`). Upload it unlisted and paste the link. The versionCode 10 and 8 videos are kept as `sitr-accessibility-review-0.3.0-vc10.mp4` and `-vc8.mp4`; they show the screens before the redesign, so do not use them. Older record: `assets/video/sitr-accessibility-review.mp4` (gitignored; re-recorded 2026-11-11 on the `sitr-video` emulator with the 0.2.2 release build, whose disclosure names the Private DNS dialog, private space setup and the other settings pages that show Sitr's name; 1:47, captions burned in. Script, step times and captions are in `build/review-video/a11y-0.2.2/`. Older videos are kept as `sitr-accessibility-review-0.2.1.mp4` and `-0.2.0.mp4`). |

Description wording if asked: "Sitr is a content filter and parental
control. Its accessibility service has two separate uses, each off until
the user turns it on in Sitr after a disclosure dialog. (1) Child lock:
when a guardian turns on the optional child lock (protected by the
guardian PIN), a fixed, rule-based list of checks closes the screens that
would switch Sitr off on the child's phone: Sitr's App info and other
settings pages that show Sitr's name, its uninstall prompt, its VPN and
accessibility settings, the VPN disconnect dialog, Developer options,
adding users, setting up or opening a private space, the Private DNS
dialog and the mobile network reset (which would clear always-on VPN). It
leaves Android's own recovery tools, safe mode and factory reset, alone.
For this it reads text, and which window is open, only in Settings, app
installers, the Play Store and system dialogs. (2) Reels blocking in the
Facebook app: when the user turns it on, each time the Facebook app's
screen changes the service looks up the screen items whose text or label
contains "Reel" and, if the Reels tab or a full-screen reel is in front,
switches Facebook to its Home tab or presses Back. Reels shares its network addresses with the
rest of Facebook, so DNS filtering cannot do this, and no narrower Android
API can see which tab is open inside another app. While Reels blocking is
off, the service receives nothing from Facebook. Both uses work only on
the device; the service stores nothing, logs nothing and sends nothing,
and reads no app other than Facebook and the system screens above."

The app's disclosure dialog, word for word, is `GUARD_DISCLOSURE` in
`apps/android/app/src/main/kotlin/com/sitrshield/app/ui/ChildLockScreen.kt`
(also quoted in docs/reels-blocking-privacy.md).

Play's disclosure rule, re-read on 2026-11-24 (answer/10964491): the
disclosure "Cannot be included with other disclosures pertaining to
personal or sensitive data collection", and "should be a separate
disclosure indicating why the app requires the AccessibilityService API
and any potential use cases". The page does not say that each use needs
its own dialog. Sitr shows one dialog, about the accessibility service
only, covering its two uses; this is read as allowed. If a reviewer
objects, the fallback is a separate Reels-only dialog (a code change).

**Video for 0.3.0 (recorded 2026-11-24, versionCode 11)**: the five
parts Play's page asks for, with captions, 2 minutes 46 seconds. It
replaces the versionCode 10 video made the same morning, because the
redesign that added the tab bar changed every screen in it (kept as
`sitr-accessibility-review-0.3.0-vc10.mp4`). Recorded on the `sitr-video`
emulator with the versionCode 11 release build, in a test household set
up off camera. The Reels part was recorded on a phone that has the
Facebook app, with a test install of the same versionCode 11 code under
another app id, because the emulator has no Facebook. The phone is in
dark appearance and the emulator in light, so that part looks darker.
1. 0:00 Open Sitr from the home screen. The Child lock tab shows step 2,
   "Accessibility guard", Off: the service is not on.
2. 0:09 Filters tab → open "Social media" → the switch "Block Reels in
   the Facebook app" → the disclosure dialog, shown whole and scrolled
   slowly to its last sentence (35 seconds).
3. 0:58 Decline: "No thanks". The switch stays off and nothing opens.
4. 1:02 The switch again: the same disclosure appears again → "I agree" →
   Android's Accessibility settings ("Sitr guard", Off) → the "Sitr
   guard" page with its description → switched on → Android's own dialog
   → Allow. Back in Sitr the switch is on and "Social media" reads "Reels
   blocking is on."
5. 1:35 Reels blocking in use, on the phone. First the test install's
   Filters tab (the phone's status bar is blacked out): "Social media" is
   opened and scrolled to "Block Reels in the Facebook app", which is on;
   the section reads "Reels blocking is on." Then, from 1:47, the
   Facebook app: the Reels tab is tapped twice and each time Facebook
   returns to Home with "Reels are off in Sitr"; Marketplace, Friends and
   Home stay open. The owner's feed is blacked out: only Facebook's first
   four tabs and Sitr's message are visible, and a card on screen says so.
6. 2:12 Child lock in use, on the emulator: Child lock tab, both steps On
   → "Lock this phone" → Sitr's Home tab lists "Child lock: Guard mode is
   on" → Sitr's App info opens and is closed with "Locked by Sitr — ask
   your guardian."; the uninstall prompt is closed the same way → "Turn
   off child lock (guardian PIN)" → the PIN is typed (the app masks the
   digits) → the lock is off.

Known small things in the cut: App info and the uninstall prompt are on
screen for under a second each, because the guard closes them that fast;
the Child lock tab on the emulator shows the app's own red "USB debugging
is on" warning; the first frame of the phone clip is held for 2 seconds;
in the phone's test install the five "Images and video off" switches and
both optional lists happen to be on.

Not in the video: a reel opened from the feed (it would show a real
person's reel from the owner's account). The child lock and Reels
blocking on together, with Facebook in front, were checked on a phone on
2026-11-24. If the use changes later, Play requires submitting this form
again; it has changed in 0.3.0 (above).

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
  (never leaves the device). The same holds for the accessibility
  service: the child lock reads foreground window text in memory to
  recognise screens that would disable Sitr, and Reels blocking reads the
  Facebook app's "Reel" items in memory; both discard it at once and send
  nothing. 0.3.0 (Reels blocking) changes no answer, because that
  processing never leaves the device. *Re-read Play's definition of
  "collection" on the policy page on screen before submitting.*
- Independent security review: No.
- Re-checked 2026-11-18 against the opt-in lists (violence, encrypted-DNS
  hosts), the larger blocklist, "Wait before loosening" and the "Report a
  site" links: no answer changes. The lists ship in the app, and their
  switches and the wait are stored only on the phone; the report links open the browser or mail app and the app
  sends nothing.

## Review notes (App content → App access / notes)

> Sitr is a DNS-based content filter, not a monitoring app. It does not use
> QUERY_ALL_PACKAGES or Device Admin. The Accessibility API has two optional
> uses, each turned on after a prominent disclosure dialog: the child lock,
> which a guardian turns on and which closes the screens that would disable
> the parental control, and Reels blocking in the Facebook app, which leaves
> Facebook's Reels tab or a full-screen reel. Nothing the service reads
> leaves the device. To test: open
> the app, complete the three onboarding screens (the second explains the
> local DNS-only VPN before any system dialog), tap Turn on, accept the VPN
> prompt, then open Chrome and load https://1xbet.com — it fails to load
> (blocked by DNS; same as in the review video). Load
> https://google.com/search?q=test — the results page shows SafeSearch locked
> on. Sitr Family: joining a household needs a pairing code; creating one
> needs a Sitr Family token purchased on sitrshield.com. Test token: [PASTE
> ON SUBMISSION DAY]. Test pairing code: [PASTE ON SUBMISSION DAY].
> Child lock: Family tab → Create household with the test token → set a
> guardian PIN → Child lock tab → step 1 (set Sitr as always-on VPN) →
> step 2 (disclosure → I agree → switch on "Sitr guard") → Lock this
> phone. Long-press the Sitr icon → App info or Uninstall: the screen is
> closed. Child lock tab → Turn off child lock → the PIN unlocks it.
> Reels blocking: Filters tab → open "Social media" → "Block Reels in the
> Facebook app" → disclosure → I agree → switch on "Sitr guard" if it is off. In the
> Facebook app (installed and signed in), tap the Reels tab: Facebook goes
> back to Home with the toast "Reels are off in Sitr". This needs a
> Facebook account, so the accessibility review video shows it too.

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
  **All five were retaken on 2026-11-24** from the 0.3.0 (versionCode 11)
  release build, after the redesign that added the tab bar (Home, Filters,
  Lists, Family, Child lock). Filter categories shows the open "Social
  media" section with the "Block Reels in the Facebook app" switch; the
  Family picture shows the guardian's screen with the pairing code hidden
  behind its "Show pairing code" button. `feature-1024x500.png` was
  re-rendered the same day with the line "Family content filter."
- `video/sitr-promo-1080p.mp4` — 1920×1080, 70 s, silent promo for the
  "Video" field of the store listing: intro card → the review recording
  framed beside the pitch → end card. **Remade on 2026-11-24** with the
  versionCode 11 release build, the shield emblem and the line "Family
  content filter."; the September one (old screens, old mark, "Halal &
  family content filter.") is kept as `sitr-promo-1080p-2026-09.mp4` and
  is the one on YouTube until the new file is uploaded. Upload to YouTube
  (public or unlisted, ads off, embeddable) and paste the watch URL; Play
  does not accept file uploads. The recording inside it is the new
  `build/review-video/sitr-vpn-review.mp4` (63 s: three onboarding
  screens, the second being the VPN disclosure "About the VPN icon" →
  notification permission → "Turn on protection" → Android's "Connection
  request" dialog → "Protection active" → 1xbet.com fails to load in
  Chrome → back to Sitr, Filters tab, Home tab). The whole recipe is
  saved this time: `build/review-video/promo-0.3.0-vc11/record.sh` then
  `assemble.sh`. The pitch panel's texts are unchanged and still hold
  (it never mentions accessibility).
- The separate 16:9 demo (`video/demo/`, `sitr-demo-1080p.mp4`) and the
  vertical `sitr-promo-9x16.mp4` were NOT remade: they show the old
  screens and the old mark. Do not use them anywhere until they are.
