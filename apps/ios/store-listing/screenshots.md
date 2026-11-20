# App Store screenshot plan — Sitr for iPhone and iPad

*Captured 2026-11-18/19: see "Captured set" at the end. Rules
(Udocs/store-review-risk-register.md, "Screenshots show real UI states
only"): every shot is a real screen of the submitted build in a state it
can actually reach. No mockups, no composited UI, and no Screen Time UI
unless the Family Controls entitlement is granted and the feature is live
in that build. Captions may sit above the screenshot on a plain
background, but each must be true of the build. Same tags as listing.md:
`[DNS]` shots only if the DNS filter ships, `[ST]` shots only with the
Screen Time entitlement.*

## Sizes

| Display | Simulator | Portrait pixels | Required |
|---|---|---|---|
| iPhone 6.9-inch | iPhone 16 Pro Max (or newer Pro Max) | 1320 × 2868 (1290 × 2796 also accepted) | yes, up to 10 shots |
| iPad 13-inch | iPad Pro 13-inch (M4) | 2064 × 2752 (2048 × 2732 also accepted) | yes, because the app runs on iPad (`TARGETED_DEVICE_FAMILY = 1,2`, apps/ios/Configs/Shared.xcconfig:7). No shot 2b on iPad: there is no iPad device, and the simulator cannot run the DNS filter |

Pixel sizes and counts are from Apple's screenshot specifications as
remembered: **confirm on the App Store Connect upload page** before
capturing. Smaller sizes are scaled down from these by App Store Connect. Use the
same shots, in the same order, on both devices. Portrait on both.

## Setup before capturing

- A fresh install, opened once (so the full list is written, not the
  500-rule fallback), Safari blocker enabled, so Home is green. After
  any settings change, wait until "Updating Safari rules…" has gone
  before capturing (unless that banner is what the shot shows).
- Appearance: Light for every shot (About & privacy → Appearance), so the
  set looks like one product. Optionally repeat the set in Dark later.
- Status bar: 9:41, full battery, full signal (`xcrun simctl status_bar
  <device> override --time 9:41 --batteryLevel 100 --cellularBars 4`).
- For the household shots: a throwaway test household with a guardian
  PIN, joined as "A guardian". Never capture a revealed pairing code: it
  is the household's root secret.
- The Sitr Family **join** screen may be captured: its footnote now only
  says to ask the household's guardian for the pairing code, and names no
  other platform (apps/ios/Sitr/Views/HouseholdView.swift:87). Never with
  a real code typed in.
- Never capture the "Debug builds only" → "Diagnostics" section of the
  DNS filter screen; it is not in a Release build. Capture from a Release
  build so it does not appear.

## Shot list

| # | Screen | State | Caption |
|---|---|---|---|
| 1 | Home (`HomeStatusView`) | Green "Protection active" card; Protections: Safari filtering "enforced", Screen Time filter "off — optional", SafeSearch "not available on iOS" (`[DNS]` builds also show DNS filter "off — optional", and SafeSearch reads "not available on iOS without the DNS filter") | Filters in Safari, on your device |
| 2 | Safari | https://1xbet.com open, showing Safari's error page because the content blocker stopped it | Adult and gambling sites stop loading in Safari |
| 3 | Filter categories (`CategoriesView`) | Adult content blocking "always on"; Gambling and Dating on; the opt-in "Gore and hate sites" switch off, with its note visible | About 100,000 sites blocked. Adult blocking is always on. |
| 4 | Allow & block lists (`ListsView`) | One or two example domains in "Always block these sites", the "Report a site" section visible below | Your own allow and block lists. Report a wrong block. |
| 5 | Wait before loosening (`DelaySettingsView`) | Wait set to 30 minutes, a request running: status "Ready in 24:13" (any value; it counts down live) | Make loosening wait 5 minutes to 24 hours |
| 6 | Sitr Family, member view (`HouseholdView`) | "This device: guardian", Devices "2/20 (fair use)", last sync OK, "Show pairing code" button NOT tapped, Guardian PIN section saying "A PIN is set…" | Share lists across your family's devices, end-to-end encrypted |
| 7 | About & privacy (`SettingsAboutView`) | Scrolled so "Privacy" and "Honest limits on iOS" are both visible | No account. No analytics. No ads. |


**Shot 1 and the Screen Time row.** Home always shows a "Screen Time
filter" row (apps/ios/Sitr/Views/HomeStatusView.swift:24, `:116-154`); it
reads "off — optional" in every build. The risk register forbids Screen
Time UI in screenshots without the entitlement. If the entitlement is not
granted, either crop shot 1 so the Protections section is not shown, or
leave shot 1 out and lead with shot 2, until the app hides that row in
such builds. The owner decided on 2026-11-19 that Screen Time ships, so
this applies only if the distribution build fails to sign with Family
Controls. Decided the same day: shots as planned; phone shots allowed for
the Sitr app screens in this file.

[ST] Shot 8: Screen Time (`ScreenTimeSetupView`), the explanation and the two mode buttons, before authorization. Caption: "Optional: Apple's adult filter in other browsers too".

[DNS] Add when the DNS filter ships, after shot 2:
[DNS] Shot 2b: Home with the DNS filter on: Protections → DNS filter "on", SafeSearch "enforced by the DNS filter". No VPN icon in the status bar: the phone used does not show a VPN indicator there while the filter is connected; Control Center does show a VPN badge in its status row (owner's observation, 20 November 2026). Source: real phone (iPhone 13 Pro Max), 19 November 2026, scaled from 1284 × 2778 to 1320 × 2868; its status bar is the phone's own (6:53, not 9:41). iPhone only: there is no iPad version (no iPad device; the simulator cannot run the tunnel). Caption: "Optional DNS filter for other apps, on your device".
[DNS] Shot 2c: a browser other than Safari, https://1xbet.com failing to load with the DNS filter on. **Not taken**: needs another browser app on the phone and the owner's yes. Caption: "Blocks the same sites in other apps".
[DNS] Shot 2d (optional): the DNS filter disclosure ("What it does", "What it sees", "Where lookups go", "Why iOS says VPN", "Limits") before "Turn on". Caption: "What it sees and where lookups go, before you turn it on".
[DNS] Check every caption against what the screen actually says in the submitted build.

Order: 1 to 7 tells the story without Screen Time or the DNS filter.
If both extras ship, keep the set at 10 or fewer (App Store Connect's
limit): drop 7 first.

## Check before upload

- Every caption is a claim: it must match listing.md and the screen.
- No shot shows another platform's name, a price, a purchase link, a
  pairing code, or a real person's data.
- iPad shots are taken on the iPad simulator, not stretched from iPhone.

## Captured set

Files in `screenshots/iphone-6.9/` (1320 × 2868) and `screenshots/ipad-13/`
(2064 × 2752), PNG, no alpha channel. All from a Release build on the
simulator except iPhone 2b (real phone, above). Both 2d frames on both
devices and iPad 7 were retaken on 2026-11-20 and show the current text:
"Why iOS says VPN" now says iOS lists the filter under VPN in Settings
and shows a VPN badge in Control Center (2d frames retaken again for
this), and the "up to a few seconds" network-change limit. Every file
matches the current app.

- iPhone: 11 files. Upload set (10, App Store Connect's limit): 1, 2, 2b,
  2d (two frames: `02d-dns-filter-disclosure.png`,
  `02d-dns-filter-disclosure-limits.png`), 3, 4, 5, 6, 7.
  `02e-dns-filter-off.png` (DNS filter screen, off) is captured but not in
  the upload set.
- iPad: 10 files: 1, 2, 2d (two frames), 2e, 3, 4, 5, 6, 7. No 2b (no iPad
  device) and no 2c.
- Not taken: 2c (above); [ST] shot 8 (Family Controls does not run on the
  simulator; adding it means dropping one, 7 first).
- Differences from the table: 6 is the **join** screen (no household was
  joined on the live server); 3 shows the Social media rows with
  third-party names (X, Reddit, Tumblr, Pinterest; the iPad also Imgur,
  Facebook, Instagram, TikTok), which cannot be scrolled out of view;
  on iPhone, 7 shows all of "Privacy" but only the start of "Honest limits
  on iOS".
