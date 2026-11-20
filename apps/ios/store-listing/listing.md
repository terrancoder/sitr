# App Store listing copy — Sitr for iPhone and iPad

*Must stay consistent with docs/privacy-policy.md, the App Privacy label
(app-privacy.md beside this file), the Mac App Store listing, the in-app
text and every public statement (the six-way consistency rule,
Udocs/store-review-risk-register.md). No absolutist claims, only specific
ones a reader can check. App Store Connect renders these fields as PLAIN
TEXT: paste the lines under each heading as they are, without the tags.
iOS is JOIN-ONLY: no text here, or anywhere in the app, may say where Sitr
Family access is bought or where households are created (guideline 3.1.1).
Apple rejects mentions of other platforms in the listing, so none appear.*

*Three line tags, each removable in one pass. Every tag starts its line
(column 0) and a line carries at most one tag; the tag applies to the
whole line.*

- *`[DNS]` — true only if the build ships the opt-in on-device DNS filter
  (SitrTunnel). Without it: delete every `[DNS]` line.*
- *`[NO-DNS]` — true only WITHOUT the DNS filter. With it: delete every
  `[NO-DNS]` line. (Keeping both sets would contradict itself.)*
- *`[ST]` — needs the Family Controls distribution entitlement. The owner
  enabled "Family Controls (Distribution)" on the app identifier on
  2026-11-18; it is not yet proven by a distribution-signed upload
  (Udocs/family-controls-entitlement-guide.md). The owner decided on
  2026-11-19 that Screen Time ships: keep the `[ST]` lines. Only if the
  distribution build fails to sign with Family Controls: delete every
  `[ST]` line.*

*Then remove the tag text itself (`[DNS] `, `[NO-DNS] `, `[ST] `) and
paste. Single-line fields (name, subtitle, promotional text, keywords)
carry no tags: they are true in every variant. Check each field's
character count, in every variant, against the limit in its heading.*

## App name (30 chars max)

Sitr — Halal & Family Filter

## Subtitle (30 chars max)

Blocks adult & gambling sites

## Promotional text (170 chars max)

Blocks about 100,000 adult, gambling and dating sites in Safari, on your device. No account, no analytics, no ads. The blocklist is public and the same for everyone.

## Description (4,000 chars max)

Sitr (سِتْر — "covering, protection") blocks adult, gambling and dating sites in Safari on iPhone and iPad. It is built for Muslim families and useful for anyone who wants a cleaner internet without being watched.
[DNS] With the optional DNS filter, it filters other apps too.

PRIVATE BY DESIGN

[NO-DNS] • Filtering happens on your device. Safari applies Sitr's rules itself, so Sitr never sees the pages you visit.
[DNS] • Filtering happens on your device. Safari applies Sitr's rules itself, so Sitr never sees the pages you visit in Safari.
[DNS] • The optional DNS filter reads the site names apps look up, decides on the device, and logs, stores and sends none of them.
• The blocklist ships inside the app and is identical for every user, so it says nothing about you. It is public, and every entry can be contested.
• No account, no analytics, no crash reports, no ads, no third-party SDKs.
• The source code is public (MPL-2.0). The lists bundled in the app can be checked against published checksums.

WHAT IT DOES

• Blocks about 100,000 sites in Safari: 43,884 adult, 45,811 gambling and 10,360 dating. Adult blocking is always on; gambling and dating can be switched off.
• An opt-in list of 258 gore and hate sites, off unless you turn it on. It is old and incomplete, and the app says so.
• Optional switches that turn off all images and video on X, Reddit, Tumblr, Pinterest and Imgur. Sitr cannot tell which pictures are explicit, so it is all of a site's media or none. Posts and text still load.
• Your own allow and block lists, kept on this device.
[ST] • Optional Screen Time filter: Apple's adult web filter in other browsers too, plus the first 40 sites on your block lists. On a child's device set up with Family Sharing, turning it off needs a parent's approval.
• Optional "Wait before loosening": a change that loosens protection waits 5 minutes to 24 hours before it can be made.
• Sitr Family (optional): join a household with a pairing code, typed or scanned, to share allow and block lists, category choices and a guardian PIN. On a child's device loosening is refused (leaving needs the guardian PIN); on a guardian's device it asks for the PIN if one is set. Settings sync as one end-to-end-encrypted blob our server cannot read.
• If Safari filtering is off or its rules did not load, Sitr shows a red "Protection inactive" status with the reason and the fix, instead of pretending.
• "Report a site" links open a public GitHub form or your mail app. Sitr itself sends nothing.
[DNS] 
[DNS] OPTIONAL DNS FILTER (OFF BY DEFAULT)
[DNS] 
[DNS] Turn it on to filter apps outside Safari with the same lists and settings. It is a local VPN that sees only DNS lookups. Blocked names are answered on the device; SafeSearch is enforced on Google, Bing and DuckDuckGo, and Restricted Mode on YouTube; every other lookup goes, unencrypted, to your network's own DNS server. No Sitr server is involved. iOS asks permission, lists the filter under VPN in Settings and shows a VPN badge in Control Center. If it stops, Home turns red and says why.

WHAT IT DOESN'T DO

No monitoring. Sitr never records, reports or shows anyone what you or your children browse. No screenshots, no location, no app lists.

HONEST LIMITS

[NO-DNS] • Sitr's lists apply in Safari and in web pages that apps open through Safari. They do not reach pages shown inside other apps' own web views.
[DNS] • Without the DNS filter, Sitr's lists apply only in Safari and in web pages that apps open through Safari.
[NO-DNS] • Other browsers and apps are not filtered by Sitr's lists.
[ST] • The optional Screen Time filter applies Apple's adult filter, not Sitr's category lists, in other browsers.
[DNS] • The DNS filter, and with it SafeSearch, works only while it is on, and does not cover apps that use their own encrypted DNS. For about half a second per network change (up to a few seconds if a network is slow to give its DNS server), lookups are not filtered.
[DNS] • iOS allows one VPN at a time: another VPN app switches the DNS filter off.
[NO-DNS] • SafeSearch is not enforced on iOS: no supported iOS API can force it for every app.
• Anyone with the device passcode can switch Sitr off in Settings or delete the app. A parent's Screen Time restrictions can stop apps being deleted; Sitr does not block deletion itself.
• The wait and the guardian PIN slow changes made inside Sitr only.
• Most of the list comes from public lists checked by name, so some entries will be wrong: allow the site (not an adult-listed one) and use "Report a site".

Source code, blocklist and appeals: https://github.com/terrancoder/sitr

## Keywords (100 chars max; comma-separated, no spaces after commas)

content blocker,parental controls,muslim,islamic,adult blocker,porn blocker,gambling,dating,privacy

*No word from the name (Sitr, Halal, Family, Filter). No Apple trademarks
(Safari, Screen Time) and no other apps' names (guideline 2.3.7). With
the DNS filter shipped, the owner may paste this alternate instead, with
"safesearch" in place of "porn blocker" (optional; the line above stays
true either way):*

[DNS] content blocker,parental controls,muslim,islamic,adult blocker,gambling,dating,safesearch,privacy

## What's New in This Version (4,000 chars max)

First release for iPhone and iPad.

*As far as I know App Store Connect does not offer this field on an
app's first version (confirm in App Store Connect); keep the line for the
record and use it from the second version on.*

## URLs

| Field | Value |
|---|---|
| Support URL | https://github.com/terrancoder/sitr/issues |
| Marketing URL | https://sitrshield.com |
| Privacy Policy URL | https://sitrshield.com/privacy |

*All three are the URLs already used in the Mac App Store listing and the
other store listings; none is new.*

The support page must show a way to contact the developer. The GitHub
issues page does; support@sitrshield.com (docs/privacy-policy.md) is the
email for anyone without a GitHub account.

## Category

- Primary: **Utilities** (matches `LSApplicationCategoryType =
  public.app-category.utilities`, apps/ios/Configs/App.xcconfig).
- Secondary: Lifestyle (optional; owner's choice).
- **Never** the Kids category, and never "Made for Kids": Sitr is a tool
  for parents and adults (app-privacy.md).

## Copyright

2026 Dooplin Apps

*App Store Connect asks for the year and the rights holder's name, and
shows the © itself (as remembered; confirm in the field's help text); the licence line (code MPL-2.0, blocklist data CC BY-SA 4.0)
belongs in the description or the app, where it already is (About &
privacy).*
