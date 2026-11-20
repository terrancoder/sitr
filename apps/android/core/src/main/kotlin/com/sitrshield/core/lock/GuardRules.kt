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
 *  - the Users page, private space setup (by window class, see
 *    PRIVATE_SPACE_WINDOWS) and an existing private space's settings: a
 *    new user, a guest or a private space has no Sitr, and a VPN only
 *    filters the user that started it.
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
 * The phrases are Android's own wording (AOSP Settings, SettingsLib and
 * VpnDialogs strings, Android 15 and 16) in English, Bengali, Arabic,
 * Turkish and Malay. All five are checked whatever the phone's language;
 * the resource name is next to each phrase so a reviewer can compare.
 *
 * ponytail: five languages as AOSP words them, and the common OEM package
 * names. Another language, an OEM that rewords Settings (Xiaomi, Samsung)
 * or an unlisted OEM settings app gets only the label and vpndialogs
 * checks. Upgrade path: add a locale block from that build's strings.
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

    /**
     * Arabic marks AOSP uses inconsistently (الخاصة / الخاصّة in the same
     * release, المطورين / المطوّرين between 15 and 16), tatweel, and the
     * bidi marks that lead some Arabic strings. Stripped from both sides.
     */
    private val MARKS = Regex("[\u064B-\u065F\u0670\u0640\u200E\u200F]")

    private fun normalise(text: String) = text.replace(MARKS, "")

    /**
     * Row titles only the network hub page carries (whole-text match, any
     * case). Every regional English Android ships is listed: with only the
     * en-US wording, a phone set to English (United Kingdom) lost its way
     * to Wi-Fi (QA 2026-11-20). Languages not listed here fall back to the
     * Sitr-name rule, which closes the hub because it shows Sitr's VPN row.
     */
    private val NETWORK_HUB = listOf(
        // network_dashboard_title, airplane_mode, tether_settings_title_all
        "Network & internet", "Airplane mode", "Hotspot & tethering", // en (US)
        "Network and Internet", "Aeroplane mode", "Hotspot and tethering", // en-GB, en-AU, en-IN, en-CA
        "নেটওয়ার্ক ও ইন্টারনেট", "বিমান মোড", "হটস্পট এবং টিথারিং", // bn
        "الشبكة والإنترنت", "وضع الطيران", "نقطة الاتصال والتوصيل", // ar
        "Ağ ve internet", "Uçak modu", "Hotspot ve tethering", // tr
        "Rangkaian dan Internet", "Mod pesawat", "Tempat liputan & penambatan", // ms
    ).map(::normalise)

    /** VpnDialogs `disconnect`: the button on the connected VPN's manage dialog. */
    private val DISCONNECT = listOf(
        "disconnect", // en
        "সংযোগ বিচ্ছিন্ন", // bn
        "قطع الاتصال", // ar
        "bağlantıyı kes", // tr
        "putuskan sambungan", // ms
    ).map(::normalise)

    /**
     * Reset options lists "Delete private space": removing that unfiltered
     * profile is fine, and the list must stay open. Cut before matching.
     * reset_private_space_delete_title, private_space_delete_title/_header.
     */
    private val DELETE_PRIVATE_SPACE = listOf(
        "delete private space", // en
        "প্রাইভেট স্পেস মুছ", // bn: মুছুন, মুছবেন?
        "حذف المساحة الخاصة", // ar
        "özel alanı sil", "özel alan silinsin", // tr
        "padamkan ruang persendirian", "padamkan ruang privasi", // ms (16, 15)
    ).map(::normalise)

    /**
     * The delete confirmation's own heading (private_space_delete_header,
     * whole text). Its body says "If you have a private space on your
     * device…", which the private-space phrases would otherwise close,
     * stopping a guardian from removing the unfiltered profile.
     */
    private val DELETE_PRIVATE_SPACE_HEADER = listOf(
        "Delete private space?", // en, en-GB, en-AU, en-IN, en-CA
        "প্রাইভেট স্পেস মুছবেন?", // bn
        "هل تريد حذف المساحة الخاصّة؟", // ar
        "Özel alan silinsin mi?", // tr
        "Padamkan ruang privasi?", "Padamkan ruang persendirian?", // ms (15, 16)
    ).map(::normalise)

    /** The private-space entries of PROTECTED_PHRASES, waived on the delete confirmation. */
    private val PRIVATE_SPACE_PHRASES = listOf(
        "private space", "প্রাইভেট স্পেস", "مساحة الخاص", "مساحتك الخاص", "مساحة خاصة",
        "özel alan", "ruang privasi", "ruang persendirian", "ruang peribadi",
    ).map(::normalise).toSet()

    private val PROTECTED_PHRASES = listOf(
        // en
        "usb debugging", // SettingsLib enable_adb, adb_warning_title
        "use developer options", // developer_options_main_switch_title
        "add user", // SettingsLib user_add_user, user_add_user_or_profile_menu
        "add guest", // SettingsLib guest_new_guest
        // ponytail: Android 15+ private space is a profile the VPN doesn't
        // cover; untested on a device (the test phone has none).
        "private space", // private_space_title, private_space_setup_title
        "private dns provider hostname", // SettingsLib private_dns_mode_provider
        "hostname of dns provider", // SettingsLib private_dns_mode_provider_hostname_hint
        // Mobile network reset (Android 15: page and confirmation) and the
        // older single network reset; not the Reset options list.
        "reset all mobile network settings", // reset_mobile_network_settings_desc
        "reset all network settings", // reset_network_final_desc(_esim)

        // bn
        "usb ডিবাগিং", // enable_adb, adb_warning_title
        "ডেভেলপার বিকল্প ব্যবহার করুন", // developer_options_main_switch_title
        "ব্যবহারকারীর অ্যাকাউন্ট যোগ করুন", // user_add_user
        "ব্যবহারকারী অথবা প্রোফাইল যোগ করুন", // user_add_user_or_profile_menu
        "অতিথি যোগ করুন", // guest_new_guest
        "প্রাইভেট স্পেস", // private_space_title
        "ডিএনএস প্রদানকারীর হোস্টনেম", // private_dns_mode_provider(_hostname_hint)
        "সব মোবাইল নেটওয়ার্ক সেটিংস রিসেট", // reset_mobile_network_settings_desc
        "সব নেটওয়ার্ক সেটিং", // reset_network_final_desc(_esim)

        // ar
        "تصحيح أخطاء usb", // enable_adb, adb_warning_title
        "استخدام ميزة \"خيارات المطورين", // developer_options_main_switch_title (15)
        "استخدام خيارات المطورين", // developer_options_main_switch_title (16)
        "إضافة مستخدم", // user_add_user, user_add_user_or_profile_menu
        "إضافة ضيف", // guest_new_guest
        "مساحة الخاص", // private_space_title (المساحة / للمساحة الخاصة)
        "مساحتك الخاص", // "your private space", e.g. private_space_unlock_description
        "مساحة خاصة", // "a private space", e.g. private_space_error_screen_title
        "اسم مضيف مزود", // private_dns_mode_provider
        "اسم مضيف dns", // private_dns_mode_provider_hostname_hint
        "إعادة ضبط كل إعدادات شبكة الجوال", // reset_mobile_network_settings_desc
        "إعادة ضبط جميع إعدادات الشبكة", // reset_network_final_desc
        "إعادة ضبط كل إعدادات الشبكة", // reset_network_final_desc_esim

        // tr
        "usb hata ayıklama", // enable_adb, adb_warning_title
        "geliştirici seçeneklerini kullan", // developer_options_main_switch_title
        "kullanıcı ekle", // user_add_user
        "kullanıcı veya profil ekle", // user_add_user_or_profile_menu
        "misafir ekle", // guest_new_guest
        "özel alan", // private_space_title
        "dns sağlayıcının ana makine adı", // private_dns_mode_provider(_hostname_hint)
        "tüm mobil ağ ayarlarını sıfırla", // reset_mobile_network_settings_desc
        "tüm ağ ayarları sıfırlansın", // reset_network_final_desc(_esim)

        // ms
        "penyahpepijatan usb", // enable_adb, adb_warning_title
        "gunakan pilihan pembangun", // developer_options_main_switch_title
        "tambah pengguna", // user_add_user, user_add_user_or_profile_menu
        "tambah tetamu", // guest_new_guest
        "ruang privasi", // private_space_title
        "ruang persendirian", // private_space_delete_* and others (16)
        "ruang peribadi", // private_space_error_screen_title and others
        "nama hos penyedia dns", // private_dns_mode_provider(_hostname_hint)
        "semula semua tetapan rangkaian", // reset_mobile_network_settings_desc, reset_network_final_desc(_esim)
    ).map(::normalise)

    /**
     * Private space setup, matched by the window's activity class because
     * its text never reaches this service: on Android 15 the setup window
     * gives a non-tool accessibility service an empty node tree (checked
     * with every service flag; uiautomator still sees the text). The class
     * name arrives with the window event, before SET UP can be pressed —
     * the profile is created only after that tap. The authentication step
     * leads only to setup or to an existing private space's settings, both
     * of which close anyway. Not exported to other apps.
     */
    private val PRIVATE_SPACE_WINDOWS = setOf(
        "com.android.settings.privatespace.PrivateSpaceSetupActivity",
        "com.android.settings.privatespace.PrivateSpaceAuthenticationActivity",
    )

    /** Every app whose windows the guard may read — the service asks Android for these alone. */
    val packages: Set<String> get() = WATCHED + VPN_DIALOGS

    /** Whether any window of [packageName] can be closed; nothing else is read. */
    fun watches(packageName: String): Boolean =
        packageName == VPN_DIALOGS || packageName in WATCHED

    fun shouldClose(
        packageName: String,
        texts: List<String>,
        appLabel: String,
        /** The activity class from the window event, when Android gives one. */
        windowClass: String? = null,
    ): Boolean {
        if (packageName == SETTINGS && windowClass in PRIVATE_SPACE_WINDOWS) return true
        val norm = texts.map(::normalise)
        if (packageName == VPN_DIALOGS) {
            // Only the connected VPN's manage dialog has "Disconnect", and
            // with always-on that VPN is Sitr. Consent requests pass.
            return norm.any { t -> DISCONNECT.any { t.contains(it, ignoreCase = true) } }
        }
        if (packageName !in WATCHED) return false
        // The network hub names the connected VPN in its VPN row, but it is
        // also the way to Wi-Fi. Leave it open: the VPN screen and the
        // Private DNS dialog behind it are separate windows and still close.
        // Whole-text match, so a search result's "Network & internet > VPN"
        // breadcrumb doesn't count.
        if (norm.any { t -> NETWORK_HUB.any { t.equals(it, ignoreCase = true) } }) return false
        val phrases = packageName == SETTINGS
        val deleting = norm.any { t -> DELETE_PRIVATE_SPACE_HEADER.any { t.trim().equals(it, ignoreCase = true) } }
        val active = if (deleting) PROTECTED_PHRASES.filter { it !in PRIVATE_SPACE_PHRASES } else PROTECTED_PHRASES
        return norm.any { n ->
            val text = DELETE_PRIVATE_SPACE.fold(n) { t, cut -> t.replace(cut, "", ignoreCase = true) }
            text.contains(appLabel) ||
                (phrases && active.any { text.contains(it, ignoreCase = true) })
        }
    }
}
