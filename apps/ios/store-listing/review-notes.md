# App Review notes — Sitr for iPhone and iPad

*Paste the text under "Notes for the reviewer" into App Store Connect →
the version → App Review Information → Notes. Tags work as in
listing.md: every tag starts its line, one tag per line. Delete lines
starting `[DNS]` if the build has no DNS filter; delete lines starting
`[NO-DNS]` if it has one; delete lines starting `[ST]` if the Family
Controls distribution entitlement is not granted (the owner decided on
2026-11-19 that Screen Time ships, so keep them unless the distribution
build fails to sign with Family Controls). Then remove the tag
text. The `[FILL]` placeholders are for the owner on submission day.
Without `[ST]`, section 3 disappears and the numbering skips it; renumber
or leave the gap.*

*If the `[ST]` lines go, the build must not carry the Family Controls
entitlement either (apps/ios/Sitr/Sitr.entitlements line 13 sets it
unconditionally today), and the Home screen still shows a "Screen Time
filter" row ("off — optional"); check what tapping it does in the
submitted build, or the reviewer will tap it and find it broken.*

*Test household: the owner supplies the pairing code and PIN separately,
from a private file that is never committed
(`Udocs/app-review-test-household-2026-11-19.md`, gitignored). Never paste a pairing code
into this repo: a code IS a household's root secret
(docs/threat-model.md T7). Generate a fresh throwaway household for each
submission, with a guardian PIN set, and put the code and PIN only in
App Store Connect's private Notes field. Creating a household on the
official server needs a Sitr Family token; joining one does not. The
pairing code does not expire and is not single-use, and a guardian device
can show it again with the PIN.*

*Sign-in information: the app has no account and no login, so untick
"Sign-in required".*

*`[DNS]` section 5.4 claims to confirm before submitting: the Apple
Developer membership is an **Organization** account (guideline 5.4 lets
only organization accounts use the VPN API; if it is an Individual
account, ship with `SITR_DNS_FILTER = NO` and delete the `[DNS]` lines);
and China mainland is unticked in Pricing and Availability (app-privacy.md
§6).*

## Notes for the reviewer

WHAT SITR IS

Sitr is an on-device content filter for families. It blocks adult, gambling and dating websites with a public blocklist that ships inside the app and is the same for every user. It is a filter, not a monitoring tool: it records nothing, reports nothing, and has no account, no login, no analytics, no ads and no third-party SDKs. All filtering works with no network connection.

The app's only network request of its own is the optional household sync (Sitr Family) to https://sync.sitrshield.com, which stores one end-to-end-encrypted settings blob the server cannot read. Without a household, the app makes no network requests of its own.
[DNS] The optional DNS filter (section 8) forwards the device's own DNS lookups to the network's resolver; it sends nothing to us.

1. SAFARI CONTENT BLOCKER (the core feature; no entitlement needed)

a. Open Sitr once and tap Continue. The first launch writes the full list (about 100,000 rules) for Safari; before that, Safari has only a small built-in fallback list (about 500 rules).
b. Enable the blocker: Settings → Apps → Safari → Extensions → Sitr → turn on Allow Extension. (On iOS versions before 18: Settings → Safari → Extensions → Sitr.)
c. Return to Sitr. Home rechecks when the app comes to the front and turns green: "Protection active", and the Safari filtering row reads "enforced". Until the blocker is on, Home shows a red "PROTECTION INACTIVE" with the fix. This is by design: the app never claims protection it cannot confirm.
d. In Safari, open https://1xbet.com (a gambling site). It does not load; Safari shows an error page instead.
e. Home → Filter categories: adult blocking has no off switch; Gambling and Dating can be switched off. Turn Gambling off. The change is saved at once, and Sitr shows "Updating Safari rules…" while Safari loads the new rules in the background; with about 100,000 rules this can take around 30 to 40 seconds on a phone, and it is normal. When the banner has gone, reload https://1xbet.com: it loads. Turn Gambling back on.
[DNS] With the DNS filter on (section 8), the filter already applies such a change within a few seconds, before Safari has finished.

2. OPT-IN VIOLENCE LIST

[NO-DNS] Home → Filter categories → Opt-in lists → "Gore and hate sites". It is off by default and holds 258 sites; the note under the switch says the list is old and incomplete and works in Safari only. To test: with the switch off, https://14words.com (a hate site on the list) loads in Safari; turn the switch on, wait until "Updating Safari rules…" has gone, and reload: it is blocked.
[DNS] Home → Filter categories → Opt-in lists → "Gore and hate sites". It is off by default and holds 258 sites; the note under the switch says the list is old and incomplete, and applies in Safari, and in other apps while the DNS filter is on. To test: with the switch off, https://14words.com (a hate site on the list) loads in Safari; turn the switch on, wait until "Updating Safari rules…" has gone, and reload: it is blocked.

[ST] 3. SCREEN TIME (FAMILY CONTROLS)
[ST] 
[ST] Home → "Screen Time filter" → choose a mode:
[ST] • "Protect this device (mine)" requests FamilyControls authorization for .individual. Accept the system prompt. The row then reads "enforced (individual)". This applies Apple's web content filter (ManagedSettings webContent.blockedByFilter, .auto) plus up to 40 sites from the user's own block lists, in Safari and other WebKit browsers.
[ST] • "Protect a child's device (Family Sharing)" requests .child authorization. It needs a device signed in to a child's Apple Account in a Family Sharing group, and a parent's approval to enable and to revoke.
[ST] To undo individual mode: the same screen → "Turn Screen Time filtering off", or remove Sitr's access in Settings → Screen Time.
[ST] Sitr does not use DeviceActivity and has no Screen Time app extensions.

4. HOUSEHOLD PAIRING (SITR FAMILY, optional)

This app joins existing households only; it has no purchase, subscription or account screens.
a. Home → Sitr Family → Join a household.
b. Enter this test pairing code: [FILL: test pairing code]. Or tap "Scan QR code" to scan the code as a QR image. The camera is used only for this scan, only after that tap.
c. For "This device is for", choose "A guardian", then tap Join. The app syncs straight away; the household's PIN and lists appear after that first sync ("Sync now" repeats it).

5. GUARDIAN PIN (as a guardian device in the test household)

The PIN belongs to the household; the test household has one: [FILL: test guardian PIN].
a. Filter categories → switch Gambling off. A PIN sheet appears; enter the PIN and the change is made. A wrong PIN is refused, and repeated wrong PINs lock the sheet for a growing time. Switch Gambling back on (no PIN: tightening never asks).
b. Sitr Family → Show pairing code also asks for the PIN.
c. Sitr Family → Guardian PIN → Set changes it, after asking for the current PIN.

6. WAIT BEFORE LOOSENING (takes at least 5 minutes)

a. Home → Wait before loosening → choose 5 minutes.
b. Filter categories → switch Dating off. An alert says the change is held; tap "Start the wait".
c. On the Wait before loosening screen the status counts down ("Ready in 4:59" ...). After 5 minutes it reads "Changes open for 10:00". Switch Dating off again: it goes through, after the PIN.
d. While changes are still open, set the wait back to Off (turning it off is itself a loosening change, so it needs the open window and the PIN). Leave it Off before section 9, or the steps there will be held.
The wait slows changes made inside Sitr only; the screen says so.

7. REPORT A SITE

Home → Allow & block lists → Report a site. "Ask to block a site" and "Report a wrongly blocked site" open public GitHub issue forms in Safari; "Email instead" opens Mail to support@sitrshield.com. Sitr sends nothing itself; these are ordinary links and carry no data from the app.

[DNS] 8. ON-DEVICE DNS FILTER (optional, off by default)
[DNS] 
[DNS] a. Home → Protections → "DNS filter" (it reads "off — optional") → "Turn on the DNS filter…". Sitr's own disclosure appears first (What it does, What it sees, Where lookups go, Why iOS says VPN, Limits). Tap "Turn on". Only then does iOS ask permission to add a VPN configuration named "Sitr DNS filter"; allow it. The row reads "on", and Control Center shows a VPN badge in its status row. In Settings → VPN the configuration shows server "On this device".
[DNS] b. To test: with the filter on, open https://1xbet.com in a browser other than Safari: it fails to load. Search https://www.google.com/search?q=test: the results page shows SafeSearch locked on, and Home → SafeSearch reads "enforced by the DNS filter".
[DNS] c. The same screen has an optional switch, "Block encrypted-DNS bypass", off by default.
[DNS] d. To turn it off: the DNS filter screen → "Turn off the DNS filter". Like switching a category off, it asks for the guardian PIN in the test household (on a child's device it is refused). The configuration stays, so turning it on again asks nothing. If its VPN status switch is flipped off in Settings → VPN instead, Home turns red with the reason; iOS's Connect On Demand may then restart it by itself within a minute. Sitr itself never re-enables a configuration that was disabled or removed.
[DNS] What it is: a Network Extension packet tunnel that runs entirely on the device. Its routes cover only two synthetic DNS resolver addresses (10.111.222.1 and fd66:f83a:c650::1), so only DNS packets enter it; it cannot see any other traffic. It applies the same lists and settings as the Safari blocker. Blocked names are answered on the device; for Google, Bing, DuckDuckGo and YouTube it answers with a CNAME to the vendors' own SafeSearch / Restricted Mode hosts; every other lookup is forwarded, unencrypted (plain DNS), to the DNS resolvers of the network the device is on. There is no remote server, no VPN service, no TLS interception, and no logging of names.
[DNS] Limits, shown in the app: apps with their own encrypted DNS are not covered; for about half a second at each network change, and up to a few seconds if the new network is slow to announce its DNS server, lookups are not filtered, and the same for up to about two seconds each time the filter reads the network's DNS server again on the same network; iOS allows one VPN at a time, so another VPN app switches the filter off.

9. CHILD ROLE (do this last)

A device joined as a child cannot loosen anything, by design; it can leave the household only with the household's guardian PIN (before its first sync, without one).
a. Sitr Family → Leave household (asks for the PIN).
b. Join again with the same pairing code, this time choosing "A child".
c. Filter categories → switch Gambling off. It is refused: "This is managed by your guardian."
[DNS] With the DNS filter on, "Turn off the DNS filter" is refused the same way.
d. To return the device to normal: Sitr Family → Leave household, then the guardian PIN. The device leaves the household and is removed from its device list.

[DNS] GUIDELINE 5.4 (VPN API)
[DNS] 
[DNS] • The DNS filter is optional and off by default; the user turns it on.
[DNS] • Its purpose is parental control and content blocking: an on-device DNS filter. It is not a VPN service: no remote server, no change of location, no traffic tunnelled anywhere.
[DNS] • It routes only two local resolver addresses; no other traffic enters it.
[DNS] • No remote server: blocked names are answered on the device, and allowed lookups go to the network's own DNS server.
[DNS] • The DNS filter collects no data: names are decided in memory and never logged, stored or sent. The privacy policy (https://sitrshield.com/privacy) says what the filter handles and commits that we do not sell, use or disclose to third parties any data from it, for any purpose.
[DNS] • Sitr's disclosure is shown before the iOS permission prompt, and stays available on the DNS filter screen under "About the DNS filter".
[DNS] • Submitted from an organization developer account.
[DNS] • Not offered in territories that require a VPN licence: the app is not available in China mainland.

WHY EACH ENTITLEMENT AND EXTENSION EXISTS

• Safari Content Blocker extension (com.sitrshield.sitr.blocker): hands Safari the blocking rules. Safari applies them; the extension cannot see browsing.
• App Groups (group.com.sitrshield.sitr): the app writes the generated rules and settings into the shared container, and the content blocker reads the rules from there.
[ST] • Family Controls (com.apple.developer.family-controls), main app only: FamilyControls authorization (.individual and .child) and ManagedSettings web content filtering, as in section 3.
• Camera (NSCameraUsageDescription): "Sitr uses the camera only to scan a household pairing code." Used only after tapping "Scan QR code"; the system's DataScannerViewController reads the QR code, and nothing is stored or sent.
• Background fetch (BGAppRefreshTask com.sitrshield.sitr.sync): refreshes the household settings, best-effort, no sooner than every 30 minutes, only while the device is in a household. With no household it does nothing.
[DNS] • Network Extension, packet tunnel provider (main app and com.sitrshield.sitr.tunnel): the optional on-device DNS filter in section 8. Not a VPN service: it routes only DNS, to itself, and sends nothing to us or any third party. The app group also carries Sitr's settings to the filter.

NO ACCOUNT

There is no sign-up, login or account of any kind. A household is joined with a pairing code; nothing identifies a person.

Source code: https://github.com/terrancoder/sitr
Privacy policy: https://sitrshield.com/privacy
