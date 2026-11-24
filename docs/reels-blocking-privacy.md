# Reels blocking in the Facebook app: what Sitr reads

*Android app, from 0.3.0. Written 2026-11-22. Source of truth for the
code: `apps/android/core/src/main/kotlin/com/sitrshield/core/lock/ReelsRules.kt`
and `apps/android/app/src/main/kotlin/com/sitrshield/app/lock/GuardService.kt`.*

## What it does

"Block Reels in the Facebook app" is a switch on Sitr's Filter categories
screen. It is off until you turn it on, and it is free. When the Reels
tab is open in the Facebook app, Sitr switches Facebook to its first tab
(Home). When a reel is open full screen, Sitr presses Back. Each time, it
shows the message "Reels are off in Sitr".

Sitr cannot do this with its DNS filter, because Reels comes from the
same addresses as the rest of Facebook. Android has no narrower way for
one app to see which tab is open in another, so Sitr uses its
accessibility service, the same one the child lock uses. In Android's
settings it is called "Sitr guard".

## What Sitr reads, and when

- Only while the switch is on. While it is off, Android sends Sitr's
  accessibility service nothing from Facebook.
- Only from the Facebook app (`com.facebook.katana`).
- Each time the Facebook screen changes, at most once every quarter of a
  second, Sitr asks Facebook for the items on screen whose text or label
  contains "reel" (and, in the full-screen reel window, the Bengali
  "রিল"). It does not go through the rest of the screen.
- For each item it looks at three things: what kind of item it is (for
  example a tab), its label, and whether it is selected.
- These items can include post text or names that happen to contain the
  word "reel". The consent dialog therefore says, more broadly, that Sitr
  reads the text and labels on the screen and that this can include
  posts, names and comments.

## What Sitr does with it

It decides one thing: is the Reels tab selected, or is a reel open full
screen? If yes, it switches to Home or presses Back. Then the items are
thrown away.

## What is kept, and for how long

Nothing is kept. The text exists in the phone's memory only while that
one screen change is checked: a median of 6.4 ms measured while scrolling
the feed, and up to a few hundred milliseconds in the full-screen reel
player. There is no retention period, because nothing is stored. The only
setting saved is whether the switch is on, on this phone only; it is not
part of a Sitr Family household and is never synced.

## What Sitr never does

- No log, no counter, no history of what you watched or what was closed.
- No screenshots.
- Nothing is sent anywhere: not to us, not to a guardian, not to anyone.
- No other apps. Apart from Facebook, the accessibility service gets
  events only from the system screens the child lock uses (Settings, app
  installers, the Play Store and system dialogs). It reads their text
  only while a guardian has the child lock on, and otherwise ignores
  them.
- Nothing from Facebook while the switch is off.

## How to turn it off

Switch off "Block Reels in the Facebook app" on the Filter categories
screen. In a Sitr Family household with a guardian PIN, this needs the
PIN; on a child's phone it is refused; if you set "Wait before
loosening", the wait applies. You can also switch off "Sitr guard" in
Android's Accessibility settings, unless the child lock is on.

## Limits

- Reel previews in the feed stay visible. Videos that play in the feed
  are not touched. Stories are not closed.
- Facebook in a browser is not covered. Covering it would mean reading
  the browser's address bar, which Sitr does not do.
- Facebook Lite, Instagram, TikTok and YouTube Shorts are not covered.
- Sitr knows Facebook's labels in English and Bengali only (checked on
  Facebook 588). If a Facebook update renames them, blocking stops
  without any sign, and Sitr has no way to notice.
- If the phone lies sideways, a reel can go full screen with no label.
  Sitr acts when the Reels tab is selected, before that.
- Without the child lock, anyone with the phone can switch the
  accessibility service off in Android's settings.

## The consent dialog, as shown in the app

Turning the switch on shows this dialog. Only "I agree" turns Reels
blocking on; "No thanks", Back or a tap outside changes nothing. The
text is `GUARD_DISCLOSURE` in
`apps/android/app/src/main/kotlin/com/sitrshield/app/ui/ChildLockScreen.kt`.

> **Before you turn on Sitr's accessibility service**
>
> Sitr's accessibility service does two separate things. Each works only while it is switched on in Sitr.
>
> Reels blocking in Facebook (your choice). While it is on, each time the Facebook app's screen changes, Sitr reads the text and labels on that screen (this can include posts, names and comments) only to check whether it is Reels. If it is, Sitr switches Facebook to its Home tab or presses Back for you. Reel previews in your feed stay visible, and Facebook in a browser is not covered.
>
> Child lock (set by a guardian). While a guardian has the lock on, Sitr reads the text and type of the window in front of you when it is Settings, an app installer, the Play Store or a system dialog, to recognise the screens that would switch Sitr off: its app info and other settings pages that show Sitr's name, uninstalling, its VPN and accessibility settings, the VPN disconnect dialog, Developer options, adding users, setting up or opening a private space, the Private DNS dialog and the mobile network reset. It closes them. The lock opens only with the guardian PIN. Sitr filters only this phone's main user: a private space, work profile or other user that already exists is not filtered, so remove it before you lock the phone.
>
> What is kept: nothing. The text stays in this phone's memory only while that one screen change is checked, then it is thrown away. Nothing is stored, logged or sent anywhere. While Reels blocking is off, Sitr receives nothing from Facebook. Sitr reads no other apps.
