# Child lock on Android

Sitr Family can lock a child's Android phone so protection cannot be
switched off without the guardian PIN. It works on any phone, with no
reset. The phone must be in a Sitr Family household with a guardian PIN
set, because the PIN is the only way to open the lock again.

Sitr's accessibility guard closes the screens that would switch Sitr
off: its app info and other settings pages that show Sitr's name, its VPN
settings, the accessibility page, Developer options, the mobile network
reset (it clears always-on VPN), the uninstall prompt, the Private DNS
dialog, the VPN disconnect dialog,
the Users page, private space setup (recognised by its window type,
because Android gives the guard no text for that page) and an existing
private space's settings, and on Xiaomi phones Second space and Dual apps
(their entry pages, recognised by window type alone; a new user, a guest, a
private space, a second space or a dual app has no Sitr filtering, and a
VPN filters only the user that started it). Deleting a
private space stays possible. The
phrase rules apply to the Settings app only; in an installer or the Play
Store only Sitr's own name counts. Besides Settings, the installers, the
Play Store, the system dialogs and, on Xiaomi phones, the Second space and
Dual apps screens, the child lock gets no
window events from any other app; the one other app Android delivers to the same
service is the Facebook app, only while Reels blocking is on, and the
child lock never acts on it
([reels-blocking-privacy.md](reels-blocking-privacy.md)). Wi-Fi stays usable. The "Network &
internet" page stays open in the five languages, including the regional
English wordings (for example UK English); in another language it closes
when it shows Sitr's VPN row, and Wi-Fi is then reached from Quick
Settings.
Other VPN apps can't take Sitr's place because Sitr is the always-on VPN:
Android itself refuses them, so their permission prompts are left alone.

What it does not cover, as the app says next to the toggle:

- a private space, work profile or other user that already exists. An
  Android VPN filters only the user that started it, and Sitr in the
  main user can neither filter nor detect them; a private space can
  still be opened from the apps list. Remove them before you lock the
  phone;
- safe mode and factory reset. Both are Android's own recovery tools,
  and Google Play doesn't allow an accessibility service to block them;
  both can also be reached with the hardware keys;
- settings in a language other than English, Bengali, Arabic, Turkish or
  Malay, and settings a phone maker words differently from Android
  itself, except screens that name Sitr. The five languages are matched
  as Android 15 and 16 word them (checked on an Android 15 emulator; the
  Android 16 wording only in unit tests), English in its US, UK,
  Australian, Indian and Canadian wording;
- a browser's own "Secure DNS" and apps that use their own DNS server:
  those lookups never reach Sitr. The encrypted-DNS switch in Filter
  categories covers well-known providers only
  ([doh-hosts-policy.md](../blocklist/policy/doh-hosts-policy.md));
- phone "cleaner" apps that force-stop Sitr. Android then switches the
  guard off until a guardian turns it back on (Home shows it red), and
  filtering stops until Sitr is opened again: always-on VPN does not
  restart a force-stopped app.

## Setting it up

Sitr → Child lock, then follow the steps. The order matters: the
guard closes the VPN screens the first step uses. Before you start,
remove any private space (Settings → Security & privacy → Private
space), work profile and other users (Settings → System → Users).

1. Set Sitr as the always-on VPN (leave "Block connections without VPN"
   off — Sitr's tunnel carries only DNS).
2. Tap "Turn on accessibility guard", read the disclosure, tap "I agree"
   (or "No thanks" to stop there), and switch on "Sitr guard" in
   Accessibility settings. On a phone where Sitr was not installed from
   the Play Store the switch may be greyed out: open Sitr's App info, tap
   ⋮ → "Allow restricted settings" first.
3. Tap "Lock this phone".

To turn it off: Sitr → Child lock → Turn off child lock, then the
guardian PIN. While the lock is on, the phone cannot leave its household
("Turn off the child lock before you leave the household."); once it is
off, a child's phone leaves only with the guardian PIN.

What the guard reads: the text and type of the window in front when it belongs to
Settings, an installer, the Play Store, a system dialog or, on Xiaomi
phones, the Second space and Dual apps screens, checked on the
phone against a short list of screens (`GuardRules.kt`) and discarded at
once. Nothing is stored or sent anywhere. The same service also does
Reels blocking in the Facebook app when the user turns that on; it is
separate from the lock, and the lock does not need it.

There is no Device Admin step. Play's Malware policy forbids using Device
Admin to block uninstalling, so uninstalling is stopped only by the guard
closing the uninstall prompt and Sitr's App info. adb (USB debugging) can
still uninstall or clear Sitr; the Child lock screen warns in red while
USB debugging is on.

## Locking from the guardian's phone

A guardian can also ask for the lock, or for it to be opened, from their
own phone: Sitr Family → Child phones → Lock child phones. The request
goes to every child phone of the household through the encrypted
household state ([sync-protocol.md](sync-protocol.md), `policy.child`).
Asking for the lock needs no PIN; asking for it to be opened takes the
guardian PIN. A lock request needs a guardian PIN set in the household.

What it can do:

- Lock a child's phone where steps 1 and 2 above are already done, at
  that phone's next sync: within about 30 minutes, or at once with "Sync
  now" on that phone.
- Open the lock on every child phone the same way.

What it cannot do:

- Do steps 1 and 2. Both are Android settings that only someone holding
  the child's phone can switch on. Until they are done, the child's phone
  says "Your guardian asked to lock this phone. Finish steps 1 and 2; it
  then locks by itself." Once they are done, it locks at its next sync or
  when Sitr is next opened on it.
- Say whether a phone is locked now. The guardian's phone shows only what
  was asked and how many phones confirmed it: "Lock requested at HH:MM,
  confirmed by N phone(s)". A lock opened by hand on the child's phone
  with the PIN is not reported back.
- Override what is done on the phone afterwards. Each request is applied
  once; a lock armed or opened on the phone stays that way until the
  guardian sends a new request. Leaving the household resets this: a
  child's phone that leaves and joins again applies the household's last
  request again, so if that request was a lock, the phone locks at its
  first sync once steps 1 and 2 are done.

Armed from a sync, the lock cannot restart the Settings screens the way
"Lock this phone" does, so the guard checks the window already in front
the moment the lock turns on, and again whenever the guard service
(re)connects.
