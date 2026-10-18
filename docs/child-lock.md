# Child lock on Android

Sitr Family can lock a child's Android phone so protection cannot be
switched off without the guardian PIN. It works on any phone, with no
reset. The phone must be in a Sitr Family household with a guardian PIN
set, because the PIN is the only way to open the lock again.

Sitr's accessibility guard closes the screens that would switch Sitr
off: its app info, its VPN
settings, the accessibility page, Developer options, factory reset, the
uninstall prompt, the Private DNS dialog, the VPN disconnect dialog and
the Users page (a new user or guest has no Sitr, and a VPN
filters only the user that started it). Wi-Fi and the "Network & internet" page stay usable.
Other VPN apps can't take Sitr's place because Sitr is the always-on VPN:
Android itself refuses them, so their permission prompts are left alone.

What it does not cover, as the app says next to the toggle:

- safe mode, on phones where it is entered with the volume keys;
- settings shown in a language other than English, except screens that
  name Sitr;
- phone "cleaner" apps that force-stop Sitr. Android then switches the
  guard off until a guardian turns it back on (Home shows it red), and
  filtering stops until Sitr is opened again: always-on VPN does not
  restart a force-stopped app.

## Setting it up

Sitr → Child lock, then follow the two steps. The order matters: the
guard closes the VPN screens the first step uses.

1. Set Sitr as the always-on VPN (leave "Block connections without VPN"
   off — Sitr's tunnel carries only DNS).
2. Tap "Turn on accessibility guard", read the disclosure, tap "I agree"
   (or "No thanks" to stop there), and switch on "Sitr child lock" in
   Accessibility settings. On a phone where Sitr was not installed from
   the Play Store the switch may be greyed out: open Sitr's App info, tap
   ⋮ → "Allow restricted settings" first.
3. Tap "Lock this phone".

To turn it off: Sitr → Child lock → Turn off child lock, then the
guardian PIN.

What the guard reads: the text of the window in front when it belongs to
Settings, an installer, the Play Store or a system dialog, checked on the
phone against a short list of screens (`GuardRules.kt`) and discarded at
once. Nothing is stored or sent anywhere.

There is no Device Admin step. Play's Malware policy forbids using Device
Admin to block uninstalling, so uninstalling is stopped only by the guard
closing the uninstall prompt and Sitr's App info. adb (USB debugging) can
still uninstall or clear Sitr; the Child lock screen warns in red while
USB debugging is on.
