package com.sitrshield.core

import com.sitrshield.core.lock.GuardRules
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** QA 2026-11-20: private space under the child lock, and regional English. */
class GuardRulesPrivateSpaceAndEnglishTest {
    private val SETTINGS = "com.android.settings"
    private val SETUP = "com.android.settings.privatespace.PrivateSpaceSetupActivity"
    private val AUTH = "com.android.settings.privatespace.PrivateSpaceAuthenticationActivity"

    private fun decide(pkg: String, windowClass: String?, vararg texts: String) =
        GuardRules.shouldClose(pkg, texts.toList(), appLabel = "Sitr", windowClass = windowClass)

    @Test
    fun privateSpaceSetupClosesByWindowClassEvenWithNoText() {
        // On Android 15 the setup window reaches the service with no text at all.
        assertTrue(decide(SETTINGS, SETUP))
        assertTrue(decide(SETTINGS, SETUP, "Settings"))
        assertTrue(decide(SETTINGS, AUTH))
        // Same class name from any other app is not Settings' setup.
        assertFalse(decide("com.twitter.android", SETUP))
        assertFalse(decide("com.google.android.apps.nexuslauncher", SETUP))
        // An ordinary Settings window with no text stays open.
        assertFalse(decide(SETTINGS, "com.android.settings.SubSettings"))
        assertFalse(decide(SETTINGS, null))
        assertFalse(decide(SETTINGS, "com.android.settings.password.ConfirmDeviceCredentialActivity"))
    }

    @Test
    fun anExistingPrivateSpacesSettingsPageCloses() {
        // Settings → Security & privacy → Private space, after the lock check (Android 15).
        assertTrue(
            decide(
                SETTINGS, "com.android.settings.SubSettings",
                "Private space", "Keep private apps in a separate space that you can hide or lock",
                "Lock", "Private space lock", "Hide", "Hide private space", "Delete private space",
            ),
        )
    }

    @Test
    fun deletingAPrivateSpaceStaysOpen() {
        // Reset options → Delete private space → its confirmation (Android 15).
        assertFalse(
            decide(
                SETTINGS, "com.android.settings.SubSettings",
                "Delete private space?",
                "If you have a private space on your device, it will be permanently deleted " +
                    "and the Google Account added to your space will be removed.",
                "Cancel", "Delete",
            ),
        )
    }

    @Test
    fun theNetworkPageStaysOpenInEveryRegionalEnglish() {
        // network_dashboard_title, airplane_mode, tether_settings_title_all from AOSP
        // Settings res/values-en-r{GB,AU,IN,CA} (android15-release and android16-release).
        val pages = listOf(
            listOf("Network and Internet", "Internet", "VPN", "Sitr", "Private DNS"), // en-GB, en-CA
            listOf("Network and internet", "Internet", "VPN", "Sitr", "Private DNS"), // en-AU, en-IN
            listOf("Aeroplane mode", "VPN", "Sitr", "Private DNS"), // en-GB, en-AU, en-IN
            listOf("Hotspot and tethering", "VPN", "Sitr", "Private DNS"), // en-GB, en-AU, en-IN, en-CA
            listOf("Airplane mode", "VPN", "Sitr", "Private DNS"), // en-CA
        )
        for (page in pages) assertFalse(decide(SETTINGS, "com.android.settings.SubSettings", *page.toTypedArray()), "$page")
        // A search result breadcrumb is still not the hub.
        assertTrue(decide(SETTINGS, null, "Network and Internet > VPN", "Sitr"))
    }

    @Test
    fun regionalEnglishWordingStillClosesWhatMustClose() {
        // developer_options_main_switch_title (en-GB, en-AU, en-IN on Android 15)
        assertTrue(decide(SETTINGS, null, "Developer options", "Use Developer options"))
        // reset_network_final_desc (en-AU, en-CA use a straight apostrophe)
        assertTrue(decide(SETTINGS, null, "Reset Mobile Network Settings?", "Reset all network settings? You can't undo this action."))
    }

    @Test
    fun aLanguageWithoutAHubEntryFallsBackToClosingTheHubThatNamesSitr() {
        // French is not a claimed language: the hub shows Sitr's VPN row, so the
        // Sitr-name rule closes it (fail closed); without Sitr's name it stays open.
        assertTrue(decide(SETTINGS, null, "Réseau et Internet", "Internet", "VPN", "Sitr"))
        assertFalse(decide(SETTINGS, null, "Réseau et Internet", "Internet", "VPN"))
    }

    @Test
    fun theDeleteConfirmationStaysOpenInEveryClaimedLanguage() {
        // private_space_delete_header + the start of reset_private_space_delete_dialog
        // (AOSP Settings, android15-release; Malay also android16-release).
        val dialogs = listOf(
            listOf("প্রাইভেট স্পেস মুছবেন?", "আপনার ডিভাইসে কোনও প্রাইভেট স্পেস থাকলে, তা স্থায়ীভাবে মুছে ফেলা হবে"),
            listOf("هل تريد حذف المساحة الخاصّة؟", "\u200Fإذا كانت لديك مساحة خاصّة على جهازك، سيتم حذفها نهائيًا"),
            listOf("Özel alan silinsin mi?", "Cihazınızda özel alan varsa kalıcı olacak silinir"),
            listOf("Padamkan ruang privasi?", "Jika anda mempunyai ruang privasi pada peranti anda"),
            listOf("Padamkan ruang persendirian?", "Jika anda mempunyai ruang persendirian pada peranti anda"),
        )
        for (d in dialogs) assertFalse(decide(SETTINGS, "com.android.settings.SubSettings", *d.toTypedArray()), "$d")
        // The same body without the delete heading is the private space itself: closes.
        assertTrue(decide(SETTINGS, null, "Jika anda mempunyai ruang privasi pada peranti anda"))
    }
}
