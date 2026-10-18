# Sitr for Android 0.2.0 — Google Play submission audit

Audited 2026-10-18 against the current Play policies (quoted from
support.google.com on the same day). This update adds the child lock
(Guard mode) and the "images and video off on X" switch.

## Verdict

The **app itself is ready**: it builds, passes lint and every test, targets
API 36, and its policy problems have been fixed in code. **It is not ready
to submit yet.** Five steps are left for you, all outside the code:

1. Commit and tag the code, then build the bundle from that commit.
2. Deploy the website (privacy policy and Family page).
3. Record the Accessibility API video and fill in the declaration.
4. Update the store listing text and the review notes in Play Console.
5. Upload the bundle with the release notes below.

The phone re-test and the reboot test are done (section 6).

Details are under "What's left".

## Build facts

| Item | Value |
|---|---|
| Package | `com.sitrshield.sitr` |
| Version | **versionCode 3, versionName 0.2.0** (was 2 / 0.1.1) |
| Target / compile SDK | 36 / 36. Play has required API 36 for updates since 31 Aug 2026 |
| Min SDK | 26 |
| `./gradlew build` | Pass: lint (no errors; 16 minor warnings, none in new code that matter), unit tests in all modules |
| Release bundle | `apps/android/app/build/outputs/bundle/release/app-release.aab`, signed with the upload key (`CN=Sitr, O=Dooplin, C=ES`). Built from **uncommitted** code, so use it for checks only and rebuild after committing |
| Permissions in the release build | INTERNET, ACCESS_NETWORK_STATE, FOREGROUND_SERVICE, FOREGROUND_SERVICE_SYSTEM_EXEMPTED, POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED, plus WAKE_LOCK and the self-scoped DYNAMIC_RECEIVER permission from libraries. No new permissions in this update |
| New components | One AccessibilityService (`GuardService`, `isAccessibilityTool="false"`, bound by `BIND_ACCESSIBILITY_SERVICE`). No Device Admin |

## Policy findings and what was done

| # | Policy | Finding | Status |
|---|---|---|---|
| 1 | Malware policy (answer/9888380): "Don't use device admin features to block uninstallation". No parental exception, and it can be enforced against the whole account | The child lock made Sitr a device admin to block uninstall | **Fixed — Device Admin removed.** Uninstalling is now stopped only by the accessibility guard closing the uninstall prompt and App info. The parental exception covers this (below). Checked on the emulator |
| 2 | Accessibility API (answer/16558241): may not "prevent the ability for users to disable or uninstall any app or service unless authorized by a parent or guardian through a parental control app" | Sitr is a parental control and the lock is turned on by a guardian behind a PIN | OK |
| 3 | Accessibility API: may not "work around Android built-in platform security controls, privacy controls and notifications" | The guard closed **other apps' VPN permission prompts**, which can read as suppressing a system prompt | **Fixed — rule removed.** Always-on VPN already refuses another VPN app, and Android closes that prompt itself (checked on the emulator with no guard running). Only Sitr's own "Disconnect" dialog is still closed |
| 4 | Same clause, residual risk | The guard still closes the safe-mode prompt and the factory-reset screen | **Open, medium risk.** Both are routes to disabling or removing Sitr, so they fall under the parental exception in #2. The declaration text below says so. If a reviewer objects, removing those two phrases from `GuardRules.kt` is a two-line change |
| 5 | Prominent disclosure (answer/10964491): inside the app, separate from other disclosures, describes the data and its use, affirmative consent, shown before the permission request | The disclosure was body text at the top of the setup card, three steps above the "I agree" button, with no way to decline | **Fixed.** "Turn on accessibility guard" now opens a dialog showing only the accessibility disclosure, with "No thanks" and "I agree". Only "I agree" opens accessibility settings; "No thanks", Back and tapping outside do nothing, and the button shows it again. The text scrolls, so it stays readable at 1.3× font (it was cut off before). Checked on the emulator |
| 6 | `isAccessibilityTool` only for apps that help people with disabilities | Set to `false` | OK. The test run showed `true` would let the guard see more, but it must stay `false` |
| 7 | "The use of the Accessibility API must be documented in the Google Play listing" | The listing mentioned it only in passing | **Fixed** in `listing.md`: the child-lock bullet now names the Accessibility service and says what it reads |
| 8 | Data safety (answer/10787469): "Collect" means transmitting off the device | The guard reads window text in memory and discards it | OK, no change to the form. The declaration answer "No" matches |
| 9 | Privacy policy must "comprehensively disclose" access to user data; a link or text in the app | The live policy at sitrshield.com/privacy had no child-lock section; the in-app privacy text didn't mention it | **Fixed locally:** `docs/privacy-policy.md`, `sitr-site/src/pages/privacy.astro` (dated "updated 2026-10-18"), and the in-app About & privacy text, which now also links to the full policy. **The site still has to be deployed** |
| 10 | Stalkerware / monitoring apps | Sitr transmits nothing, so it isn't a monitoring app under Play's definition | OK. Don't set `isMonitoringTool` (it would add a Play Protect warning). The listing already says nothing is recorded or sent |
| 11 | Misleading metadata | The website's Family page said "the PIN is friction, not a lock… preventing an uninstall is the platform's job" | **Fixed locally** in `sitr-site/src/pages/family.astro`; deploy with #9 |
| 12 | Misleading metadata | My notes said the store promo video claims "No accessibility service" | Checked frame by frame: it doesn't. The separate 16:9 demo did; its source was fixed (not on Play) |
| 13 | Target API | 36 | OK |
| 14 | "No APK outside Google Play" for monitoring apps | The planned QR-code APK hosting was for Locked mode, which was removed | Moot |

## What's left (yours)

### 1. Commit, tag and build

The tree has a lot uncommitted: the child lock, the X media switch, iOS
changes, blocklist checksums and docs. Commit what belongs in 0.2.0, tag it
(e.g. `android-v0.2.0`), then run `./gradlew clean :app:bundleRelease` from
that commit. The 0.1.1 handoff explains why the uploaded bundle must match
CI's unsigned build. Also confirm that Play's **automatic protection** (App
integrity) is off, as that handoff asked.

### 2. Deploy the website

`sitr-site` has two edited pages: `privacy.astro` and `family.astro`. Both
build. The policy at https://sitrshield.com/privacy must include the child
lock before you submit. Deploy with `wrangler pages deploy` (not by pushing
to main).

### 3. Accessibility API declaration and video

Play Console → App content → Sensitive permissions and APIs → Accessibility
API (it appears after the bundle is uploaded to any track). Answers, the
wording to give if asked, and the five-part video script are in
`apps/android/store-listing/listing.md` under "Accessibility API
declaration". In short:

- Why: **App functionality**.
- Collect or share data through it: **No**.
- Video: open the app → Child lock → disclosure dialog → "No thanks" →
  show the disclosure again → "I agree" → switch the service on → lock →
  long-press the icon → App info / Uninstall gets closed. Captions on,
  unlisted YouTube. Don't use Settings → Apps in the video: that page
  closes at once while locked (Sitr is under Recent apps).

### 4. Store listing and review notes

- Paste the updated full description from `listing.md` (3048 of 4000
  characters). The short description is unchanged.
- App access / review notes: use the updated text in `listing.md`. It now
  says Device Admin isn't used and walks the reviewer through the child
  lock. Paste a **live test token and pairing code**: the child lock needs a
  household with a PIN, and without a token a new household syncs with
  "failed (402)", which a reviewer could take for a bug.
- Data safety: no change. Re-save only if Console asks.
- VPN declaration: no change.

### 5. Release notes (en-US, 307 of 500 characters)

```
• New: optional child lock for Sitr Family. On a child's phone, protection can't be switched off without the guardian PIN. It uses Android's Accessibility service on the phone only; nothing is recorded or sent.
• New: switch off images and video on X.
• About & privacy now links to the full privacy policy.
```

If 0.1.1 was never sent, also carry over its notes: 0.2.0 includes those
fixes.

### 6. Done since: phone re-test and reboot

The final build was re-tested on the phone with three reboots: setup,
disclosure, no Device Admin, the narrower VPN rule, uninstall routes, PIN.
All passed after one more fix (see the test log's last section).

## Known limits to keep in mind (disclosed in the app and docs)

- adb (USB debugging on, plus a computer) can uninstall or clear Sitr. The
  Child lock screen warns in red while USB debugging is on.
- A force-stop (e.g. a "cleaner" app) switches the guard off, and filtering
  stays off until Sitr is opened again.
- Phones set to another language: only the screens that name Sitr close.
- Safe mode entered with the volume keys, browser secure DNS, and work
  profiles from Play are not covered.
- Right after a reboot, Android could drop the guard's close action, so
  App info stayed open (it happened on 2 of 2 boots). Fixed by re-checking
  after each close; passed 9/9 on the next boot.

## Sources

- Accessibility API and permissions: https://support.google.com/googleplay/android-developer/answer/16558241
- Accessibility disclosure, declaration and video: https://support.google.com/googleplay/android-developer/answer/10964491
- User Data (disclosure and privacy policy): https://support.google.com/googleplay/android-developer/answer/10144311
- Malware (device admin, stalkerware): https://support.google.com/googleplay/android-developer/answer/9888380
- Data safety: https://support.google.com/googleplay/android-developer/answer/10787469
- Target API: https://support.google.com/googleplay/android-developer/answer/11926878
- Device test log: `docs/child-lock-test-2026-10-18.md`

## Progress (2026-10-18, evening)

- **Step 1, done:** branch `android-0.2.0` with two commits (`baebe9d`
  Blocklists: optional X images-and-video list; `e166abc` Android 0.2.0),
  annotated tag `android-v0.2.0` on `e166abc`. Fast-forwarded into main
  and pushed with the tag the same evening. iOS changes, the code-review file, the launch announcement,
  `tools/curation/` and the 0.1.1 handoff were left uncommitted on purpose.
  `npm test` (145) and `./gradlew clean build :app:bundleRelease` pass
  from the tagged tree. Bundle: `apps/android/app/build/outputs/bundle/
  release/app-release.aab`, SHA-256 `dcc0a04613690fa7dbd23bba85fc0e9ced2394653f2c57a5d1d536661f0af5d4`.
- **Step 2, done:** sitr-site branch `child-lock-copy` (one commit, since
  merged into main and pushed), deployed to production with
  `wrangler pages deploy … --branch=main`.
  Verified live on https://sitrshield.com/privacy and /family.
- **Step 3, video done; declaration not yet:** the video is
  `apps/android/store-listing/assets/video/sitr-accessibility-review.mp4`.
  The Accessibility API declaration only appears in Play Console after the
  bundle is uploaded (step 5), and the video needs to go on YouTube
  (unlisted) from your account first.
