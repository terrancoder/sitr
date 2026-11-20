# App Store Connect fill-in sheet — App Privacy, age rating, compliance

*For the app's owner: answers to paste into App Store Connect for Sitr on
iPhone and iPad, each with the file and line that backs it. Line numbers
are as of 2026-11-18 on branch `ios-release`. Must agree with
docs/privacy-policy.md (the source of truth), the Mac App Store label
(extension/store-listing/mac-app-store.md), the Play Data safety form and
the in-app text (six-way consistency rule,
Udocs/store-review-risk-register.md). Lines starting `[DNS]` apply only
if the build ships the on-device DNS filter; delete them otherwise. Apple
field names and options below were written from the 2025-26 App Store
Connect forms as remembered, not copied from them: **confirm each label in
App Store Connect** as you fill it in.*

## 1. App Privacy ("nutrition label")

### What actually leaves the device

Checked in the code, not only in the docs:

| What | When | Who can read it | Evidence |
|---|---|---|---|
| Nothing at all | No household joined (the default) | — | `apps/ios/Sitr/Controllers/SyncScheduler.swift:94` (`guard let secret = Storage.loadRootSecret() else { return settings }`), `:47` (background task does nothing without a household); `docs/data-flow.md:32`; `docs/privacy-policy.md:20-23` |
| One end-to-end-encrypted household blob, by GET/PUT to `https://sync.sitrshield.com/v1/blob/{householdId}` | Only while the device is in a household: on app open, after each household change, best-effort every ~30 min in the background, and once more when it leaves the household (to remove its own entry from the device list) | Sitr's server stores it but cannot decrypt it; keys are derived on the device from the pairing code, which is never sent | `apps/ios/SitrCore/Sources/SitrCore/SyncClient.swift:78` (the URL), `:116-118` (path), `:120-128` (GET), `:149-176` (PUT); `apps/ios/Sitr/Controllers/SyncScheduler.swift:5-31` (the app's only URLSession), `:66` (30 min); `apps/ios/SitrCore/Sources/SitrCore/Unenroll.swift` (the leave request); `docs/data-flow.md:21-23` |
| Inside the blob (encrypted): household allow and block lists, disabled categories, the guardian PIN as a salted PBKDF2 hash, a revision number and time, and the random per-device IDs of the household's devices | same | same (ciphertext only) | `apps/ios/SitrCore/Sources/SitrCore/Household.swift:23-32` (fields), `:273-287` (`sealState` encrypts the whole state); `apps/ios/Sitr/Model/AppSettings.swift:39` (device ID is `UUID().uuidString`, generated on the device) |
| Outside the blob, in the request: the household ID (derived from the pairing code) and a derived bearer credential | same | the server, to find and authorise the blob | `SyncClient.swift:126`, `:160`; `apps/ios/SitrCore/Sources/SitrCore/SyncCrypto.swift:7` (three independent HKDF outputs: household ID, credential, key); `docs/data-flow.md:23` |
| The device's IP address, as with any HTTPS request | same | the server's in-memory rate limiter, cleared hourly; no request logs | `docs/data-flow.md:28-30`; `docs/privacy-policy.md:32-33` |
| "Report a site" links | Only when tapped | They open GitHub in Safari or a draft in Mail; the app sends nothing | `apps/ios/Sitr/Views/ListsView.swift:57-66`, `:112-117`; `docs/data-flow.md:164-168` |

[DNS] Also leaving the device, only while the DNS filter is on: the device's own DNS lookups, forwarded unchanged and unencrypted to the network's own resolver (never to Sitr or a third party), plus the filter's own A/AAAA lookups of the SafeSearch hosts at that resolver. Evidence: `apps/ios/SitrTunnel/PacketTunnelProvider.swift:169-174` (only the two synthetic addresses routed), `:254` (forward), `apps/ios/SitrCore/Sources/SitrCore/Dns/DnsEngine.swift` (`UpstreamResolver`: the network's resolvers only), `Dns/TunnelNet.swift` (`SafeSearchTargets`); `docs/data-flow.md` §iOS DNS filter.

Not sent, ever: browsing history, URLs, looked-up names, location,
contacts, photos (the camera frame is read by the system QR scanner and
discarded), analytics, crash reports, advertising IDs. Evidence:
`docs/privacy-policy.md:17-18`, `:41-43`; the app's only network call site
is `SyncScheduler.swift:5-12`; no third-party packages
(`docs/mobile.md:33-34`, zero third-party runtime dependencies).

### The decision

**Decided by the owner on 19 November 2026: declare what the app does,
consistent with Android.** (Position B, "Data Not Collected", was chosen
and withdrawn the same day.)

The facts above, held against each store's own rule:

- **Apple** (App Privacy details, https://developer.apple.com/app-store/app-privacy-details/):
  "Collect" means "transmitting data off the device and storing it in a
  readable form for longer than the time it takes you and/or your
  third-party partners to service the request". Apple's page says nothing
  explicit about end-to-end encrypted data; the "readable form" wording
  is the only text that covers it (not confirmed beyond that wording).
- **Google Play** (Data safety, https://support.google.com/googleplay/android-developer/answer/10787469),
  under "Not in scope for data collection": user data "that is unreadable
  by you or anyone other than the sender and recipient" as a result of
  end-to-end encryption "does not need to be disclosed as collected".
  Data processed ephemerally (in memory, no longer than needed for the
  request) is also out of scope.

| Fact (only while the device is in a household) | Kept by our server? | Apple App Privacy (iOS) | Mac App Store label | Google Play Data safety |
|---|---|---|---|---|
| Encrypted blob: household lists, categories, PIN hash, revision and time, the household's random per-device IDs | Yes, as ciphertext we cannot read | Not collected: not stored in a readable form | Today: **User Content** (differs; should follow Apple's rule, as iOS) | Not collected: end-to-end encrypted |
| Household ID (16 random-looking bytes derived on the device from the pairing code; the server's key for the household's record) | Yes, readable, until the record is deleted (18 months without a write, or on request) | **Identifiers → User ID** ("other user- or account-level ID that can be used to identify a particular user or account"): App Functionality, not linked to the user's identity, not used for tracking | Today: not declared (differs) | **Device or other IDs** ("identifiers that relate to an individual device, browser or app"): Play's closest category; the form's current reason names the per-device ID instead (see owner actions) |
| Bearer credential | Only as a SHA-256 hash, to check later requests to the same record | Part of the same household record; no separate Apple data type (judgement, not confirmed) | — | Part of the same record; no separate Play category (judgement) |
| Write counter and last-write day | Yes (day only) | Record metadata; no data type (judgement) | — | Same |
| IP address | No: an in-memory rate limiter cleared hourly | Not collected: not retained | — | Not collected: ephemeral |
| Sitr Family token (`X-Sitr-Entitlement`) | No: checked on household creation, not stored; carries no identity | iOS never sends it (join-only) | — | Android sends it with every PUT while a token is saved (the server checks it only when a request creates a household); not collected (not retained) |
| DNS lookups (DNS filter, Android VPN) | No: they go to the network's own resolver, never to us | Not collected | — | Not collected |
| Device with no household | Nothing is sent to our server | — | — | — |

iOS and Android send the same things to the sync server (same protocol,
same fields: `SyncClient.swift` and Android `SyncClient.kt`, GET and PUT
with the household ID in the path and the bearer credential in the
`Authorization` header). The one difference: Android can create a
household, and sends the Sitr Family token with every PUT while one is
saved; iOS only joins and never sends it. The token is not stored, so no store answer changes.

**The iOS answer to enter.** "Yes, we collect data from this app" (check
on screen), then one data type:

| Data type | Purposes | Linked to the user's identity? | Used for tracking? |
|---|---|---|---|
| **Identifiers → User ID** | App Functionality | **No** | **No** |

Nothing else. "Linked" is No: no account, name or email exists, the ID is
random-looking and derived from a secret we never receive, and we do not
tie it to other data (`docs/privacy-policy.md:146-148`,
`docs/data-flow.md:25-27`). Tracking is No (`PrivacyInfo.xcprivacy:8-11`).

### Manifest to match

For the code worker to copy into `apps/ios/Sitr/PrivacyInfo.xcprivacy`,
replacing the empty `<array/>` after `NSPrivacyCollectedDataTypes`, and to
correct the file's comment, which says nothing is collected. Constants
checked against Apple's `NSPrivacyCollectedDataType` and
`NSPrivacyCollectedDataTypePurposes` reference pages (19 November 2026).

```xml
<key>NSPrivacyCollectedDataTypes</key>
<array>
	<dict>
		<key>NSPrivacyCollectedDataType</key>
		<string>NSPrivacyCollectedDataTypeUserID</string>
		<key>NSPrivacyCollectedDataTypeLinked</key>
		<false/>
		<key>NSPrivacyCollectedDataTypeTracking</key>
		<false/>
		<key>NSPrivacyCollectedDataTypePurposes</key>
		<array>
			<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
		</array>
	</dict>
</array>
```

The tunnel (`apps/ios/SitrTunnel/PrivacyInfo.xcprivacy`) needs no
collected-data entry: it sends nothing to our server, only DNS lookups
to the network's own resolver. The blocker has no manifest and no
network code. Only the app sends the sync requests
(`SyncScheduler.swift`, the app's only URLSession).

### What must change elsewhere so all stores agree

1. **Mac App Store label.** Done in the repo text on 19 November 2026:
   `extension/store-listing/mac-app-store.md` ("App Privacy label") now
   gives the same answer as iOS (User ID, App Functionality, not linked,
   not tracking; no User Content). The Mac app sends the same things (the
   same join-only sync client). The Mac app is not published (the owner
   confirmed this on 19 November 2026), so no live label needs changing. The Mac targets
   have no privacy manifest.
2. **Play Data safety.** Done in the repo text on 19 November 2026:
   `apps/android/store-listing/listing.md` now gives the household ID as
   the reason for Device or other IDs. **Owner:** nothing to change in
   the Play Console; the answers stay as they are.
3. **Privacy policy.** `docs/privacy-policy.md` says the store answers
   "mirror this policy exactly". With these answers it is true in
   substance (the policy describes the one encrypted blob; the household
   ID it is kept under is in `docs/sync-protocol.md`). The policy does
   not name the household ID as an identifier in one sentence. Not
   changed; the owner has not asked for it.

### Not collected

- **Browsing History, Search History.** Safari applies the content-blocker
  rules itself; the app never receives a URL
  (`docs/threat-model.md:211-219`, `docs/privacy-policy.md:66-71`).
[DNS] The DNS filter reads looked-up names in memory on the device and discards them; on-device processing that never leaves the device is not collection (`PacketTunnelProvider.swift:10-16`: never log, store or print a looked-up name; Release builds write nothing to disk and log nothing).
- **User Content, Device ID.** Only inside the encrypted blob (see the
  table above).
- **Diagnostics (crash data, performance data).** No crash reporter or
  SDK (`docs/privacy-policy.md:17-18`, `:123-125`).
- **IP address.** Seen by the server only as needed to answer the
  request: an in-memory rate limiter cleared hourly, no request logs
  (`docs/data-flow.md:28-30`).
- **Location, Contacts, Photos or Videos, Financial, Health, Purchases,
  Sensitive Info, Usage Data, Other Data.**

**Privacy Policy URL:** https://sitrshield.com/privacy
(`apps/android/store-listing/listing.md:102`).
**User Privacy Choices URL:** leave empty (no data choices to manage).

## 2. Age rating questionnaire

Answer for what the app itself contains. Sitr has no web browser, no
user-to-user content and no media; it blocks gambling sites and contains
none. The group names below follow Apple's questionnaire as revised in
2025 (written from memory: **confirm the exact wording in App Store
Connect**, especially whether "Parental Controls" is asked and how).

| Question group | Answer | Evidence |
|---|---|---|
| In-app controls → **Parental Controls** | **Yes** — a household guardian PIN, a child role that refuses loosening (leaving needs the guardian PIN), and Screen Time child mode | `apps/ios/SitrCore/Sources/SitrCore/Gate.swift:81-86`; `apps/ios/Sitr/Views/HouseholdView.swift:71-74`, `:158-177`; `apps/ios/Sitr/Views/HomeStatusView.swift:188-193` |
| In-app controls → Age Assurance | **No** — the app never asks for or checks age | no age prompt anywhere in `apps/ios/Sitr/Views/` |
| Capabilities → Unrestricted Web Access | **No** — no in-app browser or web view; the few links open Safari or Mail | `apps/ios/Sitr/Views/ListsView.swift:59-66`; `SettingsAboutView.swift:88` |
| Capabilities → User-Generated Content | **No** — household lists are shared only among the household's own devices, encrypted, and are never shown to other users | `docs/privacy-policy.md:27-33` |
| Capabilities → Messaging and Chat | **No** | — |
| Capabilities → Advertising | **No** | `docs/privacy-policy.md:41-43` |
| Mature themes (profanity or crude humour, horror or fear, alcohol/tobacco/drugs) | **None** | — |
| Medical or wellness | **None** | — |
| Sexuality or nudity | **None** — the app blocks such sites and shows no such content; list entries are never displayed | `CategoriesView.swift:20-24` (labels only) |
| Violence (cartoon, realistic, graphic) | **None** — the opt-in list is labelled "Gore and hate sites"; no such content is shown | `CategoriesView.swift:141-145` |
| Chance-based activities (gambling, simulated gambling, contests, loot boxes) | **None** — the app blocks gambling sites | `CategoriesView.swift:28-57` |

These answers compute the lowest rating. **Decided by the owner on 19
November 2026:** accept the calculated rating; no higher rating is chosen
(the same approach as on Android). Two internal notes still name a
higher audience (`Udocs/store-review-risk-register.md:21` "18+",
`Udocs/family-controls-entitlement-guide.md:66` "audience 17+"); the
decision replaces them for the age rating.
Either way Sitr is for the adults who install it, not for children, and
the description addresses parents throughout.

## 3. Made for Kids / Kids category

**No.** Do not select the Kids category and do not mark the app "Made for
Kids". Sitr is a parental-control tool installed and configured by
parents and adults, not an app directed at children
(`Udocs/store-review-risk-register.md:21`;
`Udocs/family-controls-entitlement-guide.md:65-67`; the privacy policy's
Children section, `docs/privacy-policy.md:133-142`). The Kids category
would also forbid the external links the app does have ("Report a site",
`ListsView.swift:59-66`).

## 4. Export compliance

**Does your app use encryption?** The build answers this itself:
`INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO`
(`apps/ios/Configs/App.xcconfig:18`), so App Store Connect does not ask.
The basis (`App.xcconfig:15-17`): all cryptography is Apple's own —
HTTPS through URLSession, CryptoKit AES-GCM and HKDF for the household
blob, CommonCrypto PBKDF2 for the PIN hash (`Pin.swift:25`,
`SyncCrypto.swift`); nothing proprietary, no third-party crypto.

If App Store Connect asks anyway: "Yes, uses encryption" → "only
standard algorithms, through Apple's operating system" → exempt; no
documents to upload. **Decided by the owner on 19 November 2026:** no
non-exempt encryption; keep `ITSAppUsesNonExemptEncryption` = NO. The
household blob is end-to-end encrypted user data, which goes beyond
"HTTPS only", with standard algorithms through Apple's frameworks. This
sheet is not legal advice.
[DNS] The DNS filter adds no cryptography (it forwards plain DNS), so the
[DNS] answer does not change.

## 5. Content rights

**Does your app contain, show, or access third-party content?** **Yes.**
The bundled blocklists include domain lists from eight public third-party
sources, filtered and merged by Sitr (`blocklist/imports/ATTRIBUTION.md:6-18`):
four under MIT (`:25`, `:35`, `:55`, `:90`), one under CC BY 4.0 (`:45`) and
three under CC BY-SA 4.0 (`:70`, `:80`, `:100`). Two of them (`:85-100`)
feed only the opt-in violence list, which also ships in the iOS app
(`apps/shared/blocklists/safari/violence.safari.json`).

**Do you have all necessary rights to that content?** **Yes.** Each source
is used under its licence; the combined data is CC BY-SA 4.0, and the
required attribution ships inside the app (a bundled `NOTICE.txt` shown
under About & privacy → Licence and credits, plus a link to the full
credits): `apps/ios/Sitr/Views/SettingsAboutView.swift:83-88`, `:103-108`.

## 6. Other App Store Connect fields

| Field | Answer | Evidence |
|---|---|---|
| Sign-in required | **No** — no account exists; give the test pairing code in the review notes | `docs/privacy-policy.md:41-43`; review-notes.md |
| Contains ads | **No** | `docs/privacy-policy.md:41-43`, `:123-125` |
| Price | **Free** (decided by the owner on 19 November 2026) | — |
| Availability (territories) | **All territories except China mainland** (owner's decision): untick China mainland in Pricing and Availability. Reason: the DNS filter uses the VPN API, and guideline 5.4 requires a licence for VPN apps in territories that demand one; the review notes state the app is not offered there | review-notes.md §GUIDELINE 5.4 |
| In-app purchases | **None.** No purchase, subscription or token screen exists on iOS (join-only) | `docs/mobile.md:44-47`; `apps/ios/Sitr/Views/OnboardingView.swift:3-5` |
| Devices | iPhone and iPad, iOS 16 or later | `apps/ios/Configs/Shared.xcconfig:5`, `:7` |
