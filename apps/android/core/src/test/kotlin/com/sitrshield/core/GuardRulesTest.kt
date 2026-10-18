package com.sitrshield.core

import com.sitrshield.core.lock.GuardRules
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class GuardRulesTest {
    private fun decide(pkg: String, vararg texts: String) =
        GuardRules.shouldClose(pkg, texts.toList(), appLabel = "Sitr")

    @Test
    fun closesEveryRouteToSwitchingSitrOff() {
        // The disconnect dialog for Sitr's VPN.
        assertTrue(decide("com.android.vpndialogs", "Sitr", "Disconnect"))
        // App info / VPN list / uninstall prompt all name Sitr.
        assertTrue(decide("com.android.settings", "App info", "Sitr", "Force stop"))
        assertTrue(decide("com.miui.securitycenter", "Sitr (debug)"))
        assertTrue(decide("com.google.android.packageinstaller", "Sitr", "Do you want to uninstall this app?"))
        // Routes that don't name Sitr.
        assertTrue(decide("com.android.settings", "Developer options", "USB debugging"))
        // The top of Developer options, before the USB debugging row scrolls in.
        assertTrue(decide("com.android.settings", "Developer options", "Use developer options", "Memory"))
        // A new user or guest isn't filtered.
        assertTrue(decide("com.android.settings", "Users", "You (Owner)", "Add user", "Add guest"))
        assertTrue(decide("com.android.settings", "Private space", "Set up"))
        assertTrue(decide("com.android.settings", "Erase all data (factory reset)"))
        assertTrue(decide("com.android.settings", "Private DNS provider hostname"))
        assertTrue(decide("android", "Reboot to safe mode"))
    }

    @Test
    fun readsOnlyThePackagesItCanClose() {
        assertTrue(GuardRules.watches("com.android.settings"))
        assertTrue(GuardRules.watches("com.android.vpndialogs"))
        assertTrue(GuardRules.watches("android"))
        assertFalse(GuardRules.watches("com.brave.browser"))
        assertFalse(GuardRules.watches("com.twitter.android"))
    }

    @Test
    fun leavesEverythingElseAlone() {
        // Sitr's own consent dialog, so a guardian can re-enable it.
        assertFalse(decide("com.android.vpndialogs", "Connection request", "Sitr wants to set up a VPN connection"))
        // Other apps' consent prompts are the system's; always-on refuses them.
        assertFalse(decide("com.android.vpndialogs", "Connection request", "Proton VPN wants to set up a VPN connection"))
        // Ordinary Settings pages, e.g. joining Wi-Fi.
        assertFalse(decide("com.android.settings", "Network & internet", "Internet", "VPN"))
        assertFalse(decide("com.android.settings", "Network & internet", "Internet", "VPN", "Sitr", "Private DNS"))
        // ...but a search result pointing at the VPN screen is not the hub.
        assertTrue(decide("com.android.settings", "Network & internet > VPN", "Sitr"))
        // The home screen shows Sitr's icon label — never a launcher.
        assertFalse(decide("com.google.android.apps.nexuslauncher", "Sitr"))
        // The power menu without safe mode, and any other app.
        assertFalse(decide("com.android.systemui", "Power off", "Restart"))
        assertFalse(decide("com.twitter.android", "Sitr", "factory reset"))
    }
}
