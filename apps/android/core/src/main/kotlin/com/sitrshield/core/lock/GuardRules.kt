package com.sitrshield.core.lock

/**
 * Guard mode's whole decision: given the app a window belongs to and the
 * text on it, close it (true) or leave it. Pure so it is testable off-device;
 * the accessibility service only gathers the inputs and acts.
 *
 * What gets closed while a child lock is on — every route a child has to
 * switch Sitr off without the guardian PIN:
 *  - the disconnect dialog for Sitr's VPN (vpndialogs). Other apps' VPN
 *    consent dialogs are left alone: with Sitr as always-on VPN, Android
 *    closes them itself and refuses the takeover (checked on Android 15
 *    and 16), and Play doesn't allow suppressing the system's own prompts;
 *  - any Settings / installer / Play / app-manager screen that names Sitr:
 *    its app info (force stop, clear data, uninstall), the VPN list, the
 *    accessibility list, the uninstall prompt;
 *  - Developer options (adb), factory reset, the Private DNS hostname
 *    dialog, and the "reboot to safe mode" prompt;
 *  - the Users page: a new user or guest has no Sitr, and a VPN only
 *    filters the user that started it.
 *
 * ponytail: matches English UI text and the common OEM package names; a
 * phone in another language or an unlisted OEM settings app gets only the
 * label and vpndialogs checks. Upgrade path: per-locale phrase tables.
 */
object GuardRules {
    private const val VPN_DIALOGS = "com.android.vpndialogs"

    /** Where a screen naming Sitr is a way to switch it off. Never a launcher. */
    private val WATCHED = setOf(
        "com.android.settings",
        "com.android.packageinstaller",
        "com.google.android.packageinstaller",
        "com.miui.packageinstaller",
        "com.miui.global.packageinstaller",
        "com.miui.securitycenter",
        "com.android.permissioncontroller",
        "com.google.android.permissioncontroller",
        "com.android.vending",
        "com.samsung.android.lool",
        "com.coloros.safecenter",
    )

    /** The power menu's safe-mode confirmation is drawn by these. */
    private val SYSTEM_DIALOGS = setOf("android", "com.android.systemui")

    /** Row titles only the network hub page carries. */
    private val NETWORK_HUB = listOf("Network & internet", "Airplane mode", "Hotspot & tethering")

    private val PROTECTED_PHRASES = listOf(
        "usb debugging",
        "use developer options",
        "add user",
        "add guest",
        // ponytail: Android 15+ private space is a profile the VPN doesn't
        // cover; untested on a device (the test phone has none).
        "private space",
        "factory reset",
        "erase all data",
        "private dns provider hostname",
        "hostname of dns provider",
    )

    /** Whether any window of [packageName] can be closed; nothing else is read. */
    fun watches(packageName: String): Boolean =
        packageName == VPN_DIALOGS || packageName in SYSTEM_DIALOGS || packageName in WATCHED

    fun shouldClose(packageName: String, texts: List<String>, appLabel: String): Boolean {
        if (packageName == VPN_DIALOGS) {
            // Only the connected VPN's manage dialog has "Disconnect", and
            // with always-on that VPN is Sitr. Consent requests pass.
            return texts.any { it.contains("disconnect", ignoreCase = true) }
        }
        if (packageName in SYSTEM_DIALOGS) {
            return texts.any { it.contains("safe mode", ignoreCase = true) }
        }
        if (packageName !in WATCHED) return false
        // The network hub names the connected VPN in its VPN row, but it is
        // also the way to Wi-Fi. Leave it open: the VPN screen and the
        // Private DNS dialog behind it are separate windows and still close.
        // Whole-text match, so a search result's "Network & internet > VPN"
        // breadcrumb doesn't count.
        if (texts.any { t -> NETWORK_HUB.any { t.equals(it, ignoreCase = true) } }) return false
        return texts.any { text ->
            text.contains(appLabel) ||
                PROTECTED_PHRASES.any { text.contains(it, ignoreCase = true) }
        }
    }
}
