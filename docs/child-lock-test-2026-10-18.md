# Child lock (Guard mode) — device test, 2026-10-18

Running log, updated as each test finishes.

## Setup

- Phone: Xiaomi 23129RN51X, Android 16 / HyperOS, English (US).
- Build under test: `-PsideBySide` debug (`com.sitrshield.sitr.debug`,
  "Sitr (debug)", not debuggable), Locked mode removed. The Play build
  (`com.sitrshield.sitr`) stays installed and is used as "another VPN app",
  along with Proton VPN.
- Driven over USB adb (`input`, `uiautomator`, `am`). USB debugging was on
  for the whole run. adb is itself a way round the guard that a child with a
  computer could use; Guard mode closes Developer options, not adb.
- Household: created on the phone with no token (local only; its syncs get
  402 from the production server). Guardian PIN set on the phone.
- Fix made before testing: the accessibility service label was hard-coded
  "Sitr child lock"; it is now `${appLabel} child lock`, so the debug build
  matches its own accessibility row the same way the Play build does.

## Results

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | Install over the existing debug build, protection on | Pass | Blocked host resolves to 127.0.0.1 |
| 2 | Child lock screen with no household | Pass | Points to Sitr Family; no Locked mode, reset or QR text left |
| 3 | Create household, set PIN | Pass | Sync shows "failed (402)", filtering unaffected |
| 4 | "Lock this phone" with nothing set up | Pass | Disabled |
| 5 | Device admin activation (step 2) | Pass | Row turns "on" on return |
| 6 | Accessibility guard (step 3), adb-installed app | Pass | Not greyed out as a restricted setting on this phone; the "Allow full control" prompt appears |
| 7 | Always-on VPN (step 1): switch on in Settings, come back | **Fail → fixed** | Row stayed "off" and Lock stayed disabled. Android doesn't restart a VPN that is already connected when always-on is switched on, so the service never re-read it. Fix: Child lock screen sends a start to the running service on each resume, which re-reads always-on. Re-tested: row turns "on" |
| 8 | Switch always-on off while connected | Platform behaviour | Android revokes Sitr's VPN; Home correctly shows "VPN was turned off or replaced" |
| 9 | Child lock screen after the VPN stopped | **Fail → fixed** | Row kept showing the old "on", and Lock was enabled with no filter running. Fix: always-on counts as unknown unless the tunnel is up, and unknown no longer enables Lock on Android 10+ (it used to: `alwaysOn != false`) |
| 10 | Force-stop Sitr before locking | Platform behaviour | Removes the guard from Android's enabled accessibility services (must be re-enabled by hand) |
| 11 | An app that already has VPN permission (Play Sitr, Proton) | Platform behaviour | Takes the VPN slot with no prompt at all when always-on is not set. So always-on is what stops a takeover, not the guard's dialog check |

### With the lock on

| # | Scenario | Result | Notes |
|---|---|---|---|
| 12 | Sitr's VPN settings page (intent) | Pass | Closed |
| 13 | Accessibility settings (intent) | Pass | Closed |
| 14 | Sitr's App info (intent, 5 tries) | Pass ×4, open ×1 | The one miss came right after arming, with an older Settings back stack behind it |
| 15 | Uninstall prompt (intent and launcher long-press → Uninstall) | Pass | Closed |
| 16 | Developer options | **Partial** | Opens; closes only once the "USB debugging" row is scrolled into view. The top of the page (master switch, Stay awake, etc.) stays usable |
| 17 | Device admin list (Settings search → Device admin) | **Fail** | Stays open with Sitr listed. The rows are filled in after Settings' last accessibility event, so the guard only ever sees the header. Tapping Sitr's row (the deactivate screen) is closed, so admin can't be removed this way |
| 18 | Settings → Apps | **False positive** | Closed straight away because "Recent apps" lists Sitr. The whole Apps page is unusable while locked |
| 19 | Network & internet, Wi-Fi | Pass | Stay open |
| 20 | Private DNS dialog | Pass | Closed (matched "Private DNS provider hostname") |
| 21 | Play Sitr "Re-enable" (already has VPN permission) | Pass | Refused by always-on, no dialog; filter stays with the debug build |
| 22 | Play Sitr "Re-enable" with its permission withdrawn | Pass | `com.android.vpndialogs` ConfirmDialog closed at once |
| 23 | Proton VPN "Connect" | Pass | Proton shows "Disable always-on for other VPN apps"; can't connect |
| 24 | Quick settings → VPN footer → "Open VPN settings" | Pass | VPN settings closed |
| 25 | `adb uninstall` | Pass | DELETE_FAILED_DEVICE_POLICY_MANAGER |
| 26 | `adb shell pm clear` | **Bypass (adb)** | Succeeds: household, PIN and lock all gone. Needs USB debugging on and a computer |
| 27 | `am force-stop` (what cleaner apps do) | **Fail** | Guard removed from enabled services **and filtering stops**. Always-on did not restart the VPN within 100 s. The app's warning says only the guard goes off |
| 28 | Phone's own cleaner (`com.miui.cleaner.go`) "Clean up" | Pass | Only clears caches; VPN and guard survive |
| 29 | Recents: swipe Sitr away, and "Clear all" | Pass | VPN and guard survive |
| 30 | Quick settings "N apps are active" (foreground app manager) | Pass | Sitr is listed but has no Stop button (VPN is exempt) |
| 31 | Long-press Sitr's notification → "Turn off" | Inconclusive | The sheet vanished after the tap and Sitr's channels stayed on; what the tap did wasn't seen |
| 32 | Reset options (Settings → System) | Pass | Closed ("Erase all data") — this also hides the network reset |
| 33 | Users page ("Add user", "Add guest") | **Fail → fixed** | Was open. A new user or guest has no Sitr, and a VPN filters only the user that started it, so this was an unfiltered phone. Now closed ("add user", "add guest") |
| 34 | Developer options top half | **Fixed** | Now closed on "Use developer options" |
| 35 | Device admin list | **Fixed (by title)** | Root cause: Android hides this list's rows from accessibility services that aren't declared accessibility tools (confirmed: with `isAccessibilityTool=true` the rows appear). Play allows that flag only for disability apps, so the guard now matches the title "Device admin". Side effect: Settings → Security & privacy → More security & privacy also closes (it has a "Device admin" row) |
| 36 | Private space | Not on this phone | Only a leftover "Delete private space" item. On phones that have it, apps there would not be filtered |
| 37 | PIN: 5 wrong | Pass | "Wrong PIN" ×5, then "Too many attempts — try again in 30s" |
| 38 | PIN lockout after killing the app | Pass | Still locked out after relaunch |
| 39 | Status after the guard is killed | Pass | Child lock shows "Guard mode is NOT fully on", accessibility guard "off" |
| 40 | Safe-mode prompt (power menu → long-press Power off) | Pass (inferred) | Gone within 2 s and the "Locked by Sitr" toast fired; the prompt itself wasn't caught on screen. On this phone holding power opens Gemini by default; set to power menu for the test, then restored |
| 41 | Closing a page that sits on another Settings page | Note | Back closes it, but Home is dropped: the child lands on the Settings page underneath instead of the home screen. Not a bypass |
| 42 | Sitr's notification settings | Pass | Closed |
| 43 | Benign pages: Wi-Fi, Bluetooth, Display, Sound, Date, Languages, Network & internet | Pass | Stay open |
| 44 | Correct PIN → Turn off child lock | Pass | Lock off, filtering stays on, VPN settings open again. Device admin and the guard stay enabled but do nothing (the guardian removes them in Settings if wanted) |
| 45 | Airplane mode on, then off | Pass | VPN reconnects, blocked host still 127.0.0.1, normal sites resolve |
| 46 | Guard cost while scrolling Brave (12 scrolls, ~11 s) | Pass | ~60 ms of CPU for Sitr. Since then the guard reads only the packages it can close (Settings, installers, Play, VPN dialogs, system dialogs) |
| 47 | App info, 10 tries after the last build | Pass | 10/10 closed, 4/4 right after a guard restart. Both misses in the run came within seconds of reinstalling Sitr or just after arming, not reproducible since |
| 48 | Process restart after a force-stop (e.g. guard re-enabled) | Note | Always-on reconnects as soon as Sitr's process starts again; nothing starts it on its own |

## Not tested here

- **Reboot.** The phone has a screen-lock PIN, and Sitr can't start until
  someone unlocks after a restart. Needs a person at the phone.
- **Another language.** Known gap (English phrase list); screens that name
  Sitr still close.
- **Volume-key safe mode.** Known gap; can't be blocked by Guard mode.
- **Browser secure DNS** (Brave/Chrome "Use secure DNS" with a custom
  provider) and in-app VPNs/proxies such as Opera's. They bypass any DNS
  filter. Already in threat-model T9; the child lock doesn't close those
  settings.
- **Work profile apps from Play** (e.g. Island, Shelter): they create a
  profile the VPN doesn't cover. Installing from Play isn't blocked.
- Play build only: Sitr's own Play Store page would be closed (WATCHED +
  label), so a child can't open it. The debug build can't show this.

## Fixes made during the run

1. Accessibility service label follows the app label (debug build parity).
2. Child lock screen re-reads always-on on resume (it stayed "off").
3. Always-on counts as unknown while the tunnel is down, and unknown no
   longer enables "Lock this phone" on Android 10+.
4. Guard closes the Users page ("add user", "add guest") and the top of
   Developer options ("use developer options"); also watches
   `com.miui.global.packageinstaller`.
5. Guard matches the "Device admin" page title, because Android hides that
   list's rows from non-tool accessibility services.
6. Guard reads text only in the packages it can close.
8. Child lock screen warns in red when USB debugging is on (adb can wipe
   Sitr's data, lock and PIN included). Doesn't block locking.
9. "private space" added to the guard's phrases — unit-tested only; this
   phone has no private space.
7. Disclosures (Child lock screen, accessibility description, child-lock.md,
   threat-model T7) now say adding users is closed and that a force-stop
   also stops filtering until Sitr is opened again.

## Changes after this run (Play audit, same day)

Made after the phone tests above, for Play policy; re-checked on the
`sitr-test` emulator (Android 15), not on the phone:

- **Device Admin removed.** Play's Malware policy says "Don't use device
  admin features to block uninstallation" with no parental exception. Rows
  5, 17, 25 and 35 above no longer apply. Uninstall is now stopped only by
  the guard: on the emulator the uninstall prompt and App info closed 3/3
  each. adb can now uninstall Sitr as well as clear it.
- **Other apps' VPN permission prompts are no longer closed.** With Sitr as
  always-on and no guard running, Android opened and immediately finished
  the other app's `ConfirmDialog` and refused the takeover (emulator). Only
  the VPN "Disconnect" dialog is still closed. Row 22 no longer applies.
- **Disclosure is a dialog** ("No thanks" / "I agree") shown right before
  accessibility settings open. Checked: "No thanks" and Back open nothing;
  the button shows the dialog again; "I agree" opens accessibility settings.
- Early misses: on the emulator VPN settings stayed open 3 times in the
  first loop straight after setup, then closed 13/13, including straight
  after re-locking. With the phone's two misses (rows 14 and 47), all
  three cases were within about a minute of setup or a reinstall.
  Intermittent, cause not found.

## Phone re-test of the final 0.2.0 build (same day, evening)

Redmi A3 again, side-by-side build at versionCode 3 / 0.2.0, offline
(mobile data off) so the test household never reached the server.

| Scenario | Result |
|---|---|
| Setup: two steps, no Device Admin step; red USB-debugging warning shown | Pass |
| Step 1 row turns "on" after setting always-on in Settings | Pass |
| Disclosure dialog: full text readable; "No thanks", Back and tap-outside open nothing; "I agree" opens Accessibility settings | Pass |
| Lock with no Device Admin; filtering on (blocked host → 127.0.0.1) | Pass |
| Matrix ×3 then ×4 (uninstall prompt, App info, VPN, accessibility, Developer options, Users, Sitr's notification settings) | 1 miss in 27 on the first loop, then 24/24 right after a reinstall |
| Launcher long-press → Uninstall, and → App info | Pass (closed; app still installed) |
| Play Sitr "Re-enable", pre-consented and with consent withdrawn (guard no longer closes other apps' prompts) | Pass: the ConfirmDialog started and finished by itself; Sitr kept the VPN |
| Private DNS dialog ×2 | Pass |
| **Reboot** (×3, user unlocked each time) | Pass: within 10 s of unlocking, the VPN, guard and filtering were back by themselves and Child lock showed green |
| Wrong PIN, then right PIN | Pass: "Wrong PIN", then unlocked; VPN settings open again |

**The early misses: root cause found and fixed.** App info stayed open on
the first try after both of the first two reboots. Temporary logging showed
the guard *did* see App info naming Sitr and decided to close it, but on a
freshly booted phone Android dropped the Back/Home actions while the window
was still opening. Without Device Admin this mattered: from an open App info
a child could tap Force stop, whose confirmation dialog doesn't name Sitr.
Fix in `GuardService`: after closing, look again at 0.8 s and 2 s and close
again if the screen is still there. After the third reboot: 9/9 closed,
including the first App info. That's one boot's worth of evidence; the
earlier misses (rows 14 and 47, and the emulator's) fit the same pattern.
