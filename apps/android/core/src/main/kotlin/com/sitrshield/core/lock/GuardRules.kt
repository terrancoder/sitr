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
 *  - Developer options (adb), the Private DNS hostname dialog, and the
 *    mobile network reset, which clears always-on VPN and disconnects
 *    Sitr (checked on Android 15). Matched by the reset screen's own
 *    sentences, so the Reset options list itself stays open;
 *  - the Users page and private space setup: a new user, a guest or a
 *    private space has no Sitr, and a VPN only filters the user that
 *    started it.
 *
 * The phrase rules apply to the Settings app alone. In an installer or the
 * Play Store only Sitr's own name counts: an unrelated store page that
 * happens to mention "USB debugging" is not a way to switch Sitr off.
 *
 * Factory reset and the safe-mode prompt are left alone on purpose: they
 * are Android's own recovery tools, Play's Accessibility policy forbids
 * working around platform security controls, and both can be reached
 * with the hardware keys anyway.
 *
 * ponytail: matches English UI text and the common OEM package names; a
 * phone in another language or an unlisted OEM settings app gets only the
 * label and vpndialogs checks. Upgrade path: per-locale phrase tables.
 */
object GuardRules {
    private const val VPN_DIALOGS = "com.android.vpndialogs"
    private const val SETTINGS = "com.android.settings"

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
        "private dns provider hostname",
        "hostname of dns provider",
        // Mobile network reset (Android 15: page and confirmation) and the
        // older single network reset; not the Reset options list.
        "reset all mobile network settings",
        "reset all network settings",
    )

    /** Every app whose windows the guard may read — the service asks Android for these alone. */
    val packages: Set<String> get() = WATCHED + VPN_DIALOGS

    /** Whether any window of [packageName] can be closed; nothing else is read. */
    fun watches(packageName: String): Boolean =
        packageName == VPN_DIALOGS || packageName in WATCHED

    fun shouldClose(packageName: String, texts: List<String>, appLabel: String): Boolean {
        if (packageName == VPN_DIALOGS) {
            // Only the connected VPN's manage dialog has "Disconnect", and
            // with always-on that VPN is Sitr. Consent requests pass.
            return texts.any { it.contains("disconnect", ignoreCase = true) }
        }
        if (packageName !in WATCHED) return false
        // The network hub names the connected VPN in its VPN row, but it is
        // also the way to Wi-Fi. Leave it open: the VPN screen and the
        // Private DNS dialog behind it are separate windows and still close.
        // Whole-text match, so a search result's "Network & internet > VPN"
        // breadcrumb doesn't count.
        if (texts.any { t -> NETWORK_HUB.any { t.equals(it, ignoreCase = true) } }) return false
        val phrases = packageName == SETTINGS
        return texts.any { raw ->
            // Reset options lists "Delete private space": removing that
            // unfiltered profile is fine, and the list must stay open.
            val text = raw.replace("delete private space", "", ignoreCase = true)
            text.contains(appLabel) ||
                (phrases && PROTECTED_PHRASES.any { text.contains(it, ignoreCase = true) })
        }
    }
}
