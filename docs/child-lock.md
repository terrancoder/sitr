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
private space's settings (a new user, a guest or a private space has no
Sitr, and a VPN filters only the user that started it). Deleting a
private space stays possible. The
phrase rules apply to the Settings app only; in an installer or the Play
Store only Sitr's own name counts, and Android delivers the guard no
window events from any other app. Wi-Fi stays usable. The "Network &
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
   (or "No thanks" to stop there), and switch on "Sitr child lock" in
   Accessibility settings. On a phone where Sitr was not installed from
   the Play Store the switch may be greyed out: open Sitr's App info, tap
   ⋮ → "Allow restricted settings" first.
3. Tap "Lock this phone".

To turn it off: Sitr → Child lock → Turn off child lock, then the
guardian PIN. While the lock is on, the phone cannot leave its household
("Turn off the child lock before you leave the household."); once it is
off, a child's phone leaves only with the guardian PIN.

What the guard reads: the text and type of the window in front when it belongs to
Settings, an installer, the Play Store or a system dialog, checked on the
phone against a short list of screens (`GuardRules.kt`) and discarded at
once. Nothing is stored or sent anywhere.

There is no Device Admin step. Play's Malware policy forbids using Device
Admin to block uninstalling, so uninstalling is stopped only by the guard
closing the uninstall prompt and Sitr's App info. adb (USB debugging) can
still uninstall or clear Sitr; the Child lock screen warns in red while
USB debugging is on.
