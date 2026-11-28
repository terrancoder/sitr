package com.sitrshield.core

import com.sitrshield.core.lock.GuardRules
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** POCO X3 NFC, MIUI 14.0.5, Android 12, English (2026-11-28): screens and classes as recorded. */
class GuardRulesMiuiTest {
    private val SETTINGS = "com.android.settings"
    private val CORE = "com.miui.securitycore"
    private val SUB = "com.android.settings.SubSettings"

    private fun decide(pkg: String, windowClass: String?, vararg texts: String) =
        GuardRules.shouldClose(pkg, texts.toList(), appLabel = "Sitr (debug)", windowClass = windowClass)

    // Settings → Additional settings, top and bottom, as a child sees it.
    private val additionalTop = arrayOf(
        "Additional settings", "SYSTEM SETTINGS", "Date & time", "Languages & input", "Region", "Bangladesh",
        "ACCESSIBILITY", "Accessibility", "Gesture shortcuts", "Quick ball", "One-handed mode", "Clear speaker",
    )
    private val additionalBottom = arrayOf(
        "Additional settings", "Clear speaker", "SPECIAL FEATURES", "Floating windows", "Memory extension",
        "LED light", "Second space", "Enterprise mode", "Developer options", "Need other settings?",
        "Back up and restore", "Sound effects", "Full screen display", "Factory reset",
    )
    private val apps = arrayOf(
        "Apps", "System app settings", "Manage apps", "Manage Home screen shortcuts", "Uninstalled system apps",
        "Dual apps", "Permissions", "App lock",
    )

    @Test
    fun developerOptionsClosesByHandAndByIntent() {
        // By hand MIUI hosts it in SubSettings; the top switch is "Developer options".
        val top = arrayOf(
            "Developer options", "Developer options", "Apps from unverified developers", "Bug report handler",
            "Home screen backup password", "Full Home screen backups aren't currently protected", "Keep screen on",
            "Screen won't go to sleep while charging", "Skip screen lock", "Bluetooth HCI snoop log", "Disabled",
            "OEM unlocking", "Allow the bootloader to be unlocked",
        )
        assertTrue(decide(SETTINGS, SUB, *top))
        // Any one of the rows under the switch is enough (larger font, smaller screen).
        assertTrue(decide(SETTINGS, SUB, "Developer options", "Developer options", "Apps from unverified developers"))
        assertTrue(decide(SETTINGS, SUB, "Developer options", "Developer options", "Bug report handler"))
        // By intent it is its own activity, closed before any text is read.
        assertTrue(decide(SETTINGS, "com.android.settings.Settings\$DevelopmentSettingsDashboardActivity"))
    }

    @Test
    fun multipleUsersClosesByClass() {
        // MIUI's menus don't link it; its first page has no "Add user".
        assertTrue(decide(SETTINGS, "com.android.settings.Settings\$UserSettingsActivity", "Multiple users", "Use multiple users", "Off"))
        assertTrue(decide(SETTINGS, "com.android.settings.Settings\$UserSettingsActivity"))
    }

    @Test
    fun secondSpaceAndDualAppsCloseByClass() {
        assertTrue(decide(CORE, "com.miui.securityspace.ui.activity.PrivateSpaceMainActivity", "Second space", "Turn on Second space"))
        assertTrue(decide(CORE, "com.miui.xspace.ui.activity.XSpaceSettingActivity", "Dual apps", "Create"))
        assertTrue(GuardRules.watches(CORE) && CORE in GuardRules.packages)
    }

    @Test
    fun theLinkingPagesStayOpen() {
        assertFalse(decide(SETTINGS, "com.android.settings.MiuiSettings", "Settings", "Search settings", "About phone", "Wi-Fi", "Apps", "Additional settings"))
        assertFalse(decide(SETTINGS, SUB, *additionalTop))
        assertFalse(decide(SETTINGS, SUB, *additionalBottom))
        assertFalse(decide(SETTINGS, SUB, *apps))
    }

    @Test
    fun otherSecurityCoreWindowsStayOpen() {
        // The dual app chooser and Second space removal, even naming Sitr.
        assertFalse(decide(CORE, "com.miui.xspace.ui.activity.XSpaceResolveActivity", "Sitr (debug)"))
        assertFalse(decide(CORE, "com.miui.securityspace.ui.activity.RemoveUserActivity", "Second space"))
        // MIUI's launch splash window and an event with no class.
        assertFalse(decide(CORE, "android.widget.FrameLayout", "Application icon"))
        assertFalse(decide(CORE, null, "Second space", "Turn on Second space"))
        // The same class names in any other app mean nothing.
        assertFalse(decide("com.twitter.android", "com.miui.xspace.ui.activity.XSpaceSettingActivity"))
        assertFalse(decide(SETTINGS, "com.miui.xspace.ui.activity.XSpaceSettingActivity"))
    }
}
