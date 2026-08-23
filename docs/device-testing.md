# Testing Sitr on a real device

Unit tests and the conformance fixtures prove the logic; an emulator or
simulator proves the app runs. Neither proves how the filter behaves on
a real network — carrier IPv6, captive portals, Doze, another VPN taking
the slot. This is the runbook for that last mile.

## Android

### Install

Enable **Developer options** (tap Build number seven times in Settings →
About phone), then **USB debugging**, and connect the phone.

```sh
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
adb devices                      # confirm the device shows as "device"
cd apps/android
./gradlew :app:installDebug      # debug signing needs no account
```

The debug build is signed with the local debug keystore, so sideloading
needs no Play account and no developer program.

### First run

Tap **Turn on protection**. Android shows its own VPN consent dialog —
that dialog is the system's, not ours, and it must be accepted by hand
on a real device (the emulator run pre-authorised it with `appops`,
which is a test shortcut, not something the app can do for itself).

### Verify filtering

Fastest check without a computer: open Chrome and load a site from
[`blocklist/sources/gambling/domains.txt`](../blocklist/sources/gambling/domains.txt)
— `bet365.com` is the usual benign test — and confirm it fails to
resolve while an ordinary site still loads.

With adb, the same checks precisely:

```sh
adb shell ping -c1 bet365.com      # blocked  -> 0.0.0.0 (ping prints 127.0.0.1)
adb shell ping -c1 example.com     # allowed  -> a real address
adb shell ping -c1 www.google.com  # rewritten -> forcesafesearch.google.com
```

Note that the system resolver caches: after changing a category or a
list, a name queried in the last few minutes may keep its old answer.
Test settings changes with a domain you have not queried yet.

### What only a real device shows

| Scenario | How to trigger | Expected |
|---|---|---|
| Another VPN takes the slot | Connect any other VPN app | Sitr's notification turns red ("turned off or replaced"), status matches |
| Strict Private DNS | Settings → Network → Private DNS → enter a hostname | Red, with the guidance to set it back to Automatic — filtering really is bypassed, so the honest report is the whole point |
| Always-on VPN | Settings → Network → VPN → Sitr → Always-on. Leave **Block connections without VPN OFF** | Survives reboot; lockdown would break all non-DNS traffic because our tunnel carries only DNS |
| Reboot without always-on | Restart the phone | Either the service returns, or the notification says it did not — never silence |
| Doze | Leave the phone idle overnight | Filtering intact; sync may defer |
| Network handover | Walk from Wi-Fi to cellular | Upstream resolvers re-read, filtering continues |
| Captive portal | Join a hotel/airport Wi-Fi | The portal must still be reachable |
| IPv6-only carrier | A carrier on 464XLAT | Filtering works over the IPv6 resolver |
| Force-stop | Settings → Apps → Sitr → Force stop | Status worker posts the red notification within ~15 min |

## iOS

### One-time setup (before the first device build)

1. In the Apple Developer portal, register the App IDs and the group:
   `com.sitrshield.sitr`, `com.sitrshield.sitr.blocker`, and App Group
   `group.com.sitrshield.sitr`.
2. **Enable Family Controls (Development)** on `com.sitrshield.sitr`.
   The app requests `com.apple.developer.family-controls`, so signing
   for a device fails without it. This one is self-service; only the
   *distribution* variant needs Apple's approval
   (`Udocs/family-controls-entitlement-guide.md`). To test before then,
   the alternative is temporarily removing that key from
   `apps/ios/Sitr/Sitr.entitlements` — Screen Time is runtime-gated, so
   everything else still works.
3. Set your team, either in Xcode's Signing pane or in
   `apps/ios/Configs/Shared.xcconfig`:

   ```
   DEVELOPMENT_TEAM = ABCDE12345
   ```

### Install

```sh
xcrun devicectl list devices            # get the device UDID
open apps/ios/Sitr.xcodeproj            # select the device, press Run
```

or headless:

```sh
xcodebuild -project apps/ios/Sitr.xcodeproj -scheme Sitr \
  -destination 'platform=iOS,id=<UDID>' build
```

### First run

The blocker is off until the user enables it: **Settings → Apps →
Safari → Extensions → Sitr Blocker**. Until then the app says
PROTECTION INACTIVE, which is correct — that is the state being
reported, not a bug.

### Verify filtering

Load a blocked domain in Safari; it should fail to load while ordinary
sites work. Then check the honest-status behaviour, which matters as
much as the blocking:

| Scenario | How to trigger | Expected |
|---|---|---|
| Blocker disabled | Turn Sitr Blocker off in Settings | App shows red with the enable steps |
| Rules stale | Change a category, then background/foreground the app | Green again once Safari reloads; red "needs reload" if it did not |
| Non-Safari browser | Open the same site in Chrome for iOS | Still blocked **only** if Screen Time is enabled; otherwise not — this is the documented limit, not a defect |
| Screen Time revoked | Turn Sitr off in Settings → Screen Time | App shows red for that row |
| Child mode | Enable Screen Time in child mode on a Family Sharing child device | Revoking requires the parent |
| SafeSearch | Search on Google | **Not enforced** on iOS. The app says so; confirm it does not claim otherwise |

### Reading the results honestly

Two observations that look like failures and are not:

- **Searching for a blocked site still returns results.** Sitr blocks the
  domain, not the search listing — follow the link and it fails. See
  [threat-model.md](threat-model.md) T11.
- **Gambling terms are unaffected by SafeSearch.** SafeSearch covers
  explicit sexual content; it was never a gambling filter. Gambling is
  handled by blocking those domains.

And one that is a real limit: on search engines with no vendor-published
safe-mode endpoint — **Brave Search** among them — SafeSearch cannot be
enforced at all, so explicit results and image thumbnails are unfiltered
there even while the destination domains stay blocked.

## Recording results

Note the OS version, device, and carrier for anything that fails —
DNS behaviour varies by carrier and OEM more than by Android version.
Anything that turns out to be a platform limit rather than a bug
belongs in [threat-model.md](threat-model.md) as a disclosed limit,
not in a bug tracker.
