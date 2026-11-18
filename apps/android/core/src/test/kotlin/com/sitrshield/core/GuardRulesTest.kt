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
        assertTrue(decide("com.android.settings", "Private DNS provider hostname"))
        // Mobile network reset clears always-on VPN (Android 15 page, its
        // confirmation, and the older combined reset).
        assertTrue(decide("com.android.settings", "Reset Mobile Network Settings", "This will reset all mobile network settings", "Reset settings"))
        assertTrue(decide("com.android.settings", "Reset Mobile Network Settings?", "Reset all network settings? You can’t undo this action."))
        assertTrue(decide("com.android.settings", "This will reset all network settings, including:", "Wi‑Fi", "Mobile data"))
    }

    @Test
    fun readsOnlyThePackagesItCanClose() {
        assertTrue(GuardRules.watches("com.android.settings"))
        assertTrue(GuardRules.watches("com.android.vpndialogs"))
        assertFalse(GuardRules.watches("android"))
        assertFalse(GuardRules.watches("com.android.systemui"))
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
        // Android's own recovery tools stay usable (Play's Accessibility policy).
        assertFalse(
            decide(
                "com.android.settings", "Reset options", "Delete private space",
                "Erase all data (factory reset)", "Reset Bluetooth & Wi‑Fi",
                "Reset Mobile Network Settings", "Reset app preferences",
            ),
        )
        assertFalse(decide("com.android.settings", "Reset options Delete private space Erase all data (factory reset)"))
        assertFalse(decide("com.android.settings", "Erase all data", "Erase all data"))
        assertFalse(decide("android", "Reboot to safe mode"))
        // Phrases count in Settings only: a store page about a debugging tool stays open.
        assertFalse(decide("com.android.vending", "ADB helper", "Turn on USB debugging to use this app"))
        assertTrue(decide("com.android.vending", "Sitr", "Uninstall"))
        assertTrue("com.android.vpndialogs" in GuardRules.packages && "com.android.systemui" !in GuardRules.packages)
        // Any other app.
        assertFalse(decide("com.twitter.android", "Sitr", "factory reset"))
    }

    /** A screen's texts, as the service reads them; [closes]/[stays] by package. */
    private class Locale(val closes: List<Pair<String, List<String>>>, val stays: List<Pair<String, List<String>>>)

    // Full strings from AOSP (Android 15 and 16 Settings, SettingsLib and
    // VpnDialogs), generated from the resources, not retyped: the phrase
    // table must match Android's exact code points, including Bengali's
    // decomposed nukta letters and Arabic's optional shadda and bidi marks.
    private val SETTINGS = "com.android.settings"
    private val VPN = "com.android.vpndialogs"
    private val locales = mapOf(
        "bn" to Locale(
            closes = listOf(
                SETTINGS to listOf("ডেভেলপার বিকল্প", "ডেভেলপার বিকল্প ব্যবহার করুন"),
                SETTINGS to listOf("ডেভেলপার বিকল্প", "USB ডিবাগিং"),
                SETTINGS to listOf("USB ডিবাগিং মঞ্জুর করবেন?", "USB ডিবাগিং কেবলমাত্র বিকাশ করার উদ্দেশ্যে। আপনার কম্পিউটার এবং আপনার ডিভাইসের মধ্যে ডেটা অনুলিপি করতে এটি ব্যবহার করুন, বিজ্ঞপ্তি ছাড়া আপনার ডিভাইসে অ্যাপ্লিকেশানগুলি ইনস্টল করুন এবং ডেটা লগ পড়ুন।"),
                SETTINGS to listOf("ব্যবহারকারী", "ব্যবহারকারীর অ্যাকাউন্ট যোগ করুন", "অতিথি যোগ করুন"),
                SETTINGS to listOf("ব্যবহারকারী অথবা প্রোফাইল যোগ করুন"),
                SETTINGS to listOf("প্রাইভেট স্পেস"),
                SETTINGS to listOf("প্রাইভেট ডিএনএস", "ব্যক্তিগত ডিএনএস প্রদানকারীর হোস্টনেম"),
                SETTINGS to listOf("ডিএনএস প্রদানকারীর হোস্টনেম লিখুন"),
                SETTINGS to listOf("মোবাইল নেটওয়ার্ক সেটিংস রিসেট করুন", "এর ফলে সব মোবাইল নেটওয়ার্ক সেটিংস রিসেট হয়ে যাবে"),
                SETTINGS to listOf("মোবাইল নেটওয়ার্ক সেটিংস রিসেট করবেন?", "সব নেটওয়ার্ক সেটিংস রিসেট করবেন? আগের সেটিংসে আর ফিরে যেতে পারবেন না।"),
                SETTINGS to listOf("সব নেটওয়ার্ক সেটিং রিসেট করে ই-সিম মুছবেন? এটি আগের অবস্থায় আর ফিরিয়ে আনতে পারবেন না।"),
                VPN to listOf("কনফিগার করুন", "সংযোগ বিচ্ছিন্ন করুন"),
            ),
            stays = listOf(
                SETTINGS to listOf("নেটওয়ার্ক ও ইন্টারনেট", "VPN", "Sitr", "প্রাইভেট ডিএনএস"),
                SETTINGS to listOf("বিমান মোড", "VPN", "Sitr", "প্রাইভেট ডিএনএস"),
                SETTINGS to listOf("হটস্পট এবং টিথারিং", "VPN", "Sitr", "প্রাইভেট ডিএনএস"),
                SETTINGS to listOf("সিস্টেম", "ডেভেলপার বিকল্প", "ব্যবহারকারী", "রিসেট করার বিকল্প"),
                SETTINGS to listOf("রিসেট করার বিকল্প", "প্রাইভেট স্পেস মুছুন", "সমস্ত ডেটা মুছুন (ফ্যাক্টরি রিসেট)", "ব্লুটুথ ও ওয়াই-ফাই রিসেট করুন", "মোবাইল নেটওয়ার্ক সেটিংস রিসেট করুন", "অ্যাপ পছন্দ রিসেট করবেন?"),
                SETTINGS to listOf("প্রাইভেট স্পেস মুছবেন?"),
                SETTINGS to listOf("ডিসপ্লে", "সাউন্ড ও ভাইব্রেশন", "ওয়াই-ফাই"),
                VPN to listOf("সংযোগের অনুরোধ", "Sitr এমন একটি VPN সংযোগ সেট আপ করতে চাইছে যেটি দিয়ে এটি নেটওয়ার্ক ট্রাফিক নিরীক্ষণ করতে পারবে। আপনি সোর্সটি বিশ্বাস করলে একমাত্র তখনই অ্যাক্সেপ্ট করুন। PN অ্যাক্টিভ থাকলে <br /> <br /> <img src=vpn_icon /> আপনার স্ক্রিনে দেখা যায়।"),
                VPN to listOf("সবসময়-চালু VPN এর সাথে সংযোগ করা যাচ্ছে না", "VPN সেটিংস পরিবর্তন করুন", "খারিজ করুন"),
            ),
        ),
        "ar" to Locale(
            closes = listOf(
                SETTINGS to listOf("خيارات المطورين", "استخدام ميزة \"خيارات المطورين\""),
                SETTINGS to listOf("خيارات المطورين", "‏تصحيح أخطاء USB"),
                SETTINGS to listOf("‏هل تريد السماح بتصحيح أخطاء USB؟", "‏تم تصميم تصحيح أخطاء USB لأغراض التطوير فقط. يمكن استخدامه لنسخ البيانات بين الكمبيوتر والجهاز، وتثبيت التطبيقات على جهازك بدون تنبيه، وقراءة بيانات السجل."),
                SETTINGS to listOf("المستخدمون", "إضافة مستخدم", "إضافة ضيف"),
                SETTINGS to listOf("إضافة مستخدم أو ملف شخصي"),
                SETTINGS to listOf("المساحة الخاصة"),
                SETTINGS to listOf("نظام أسماء النطاقات الخاص", "اسم مضيف مزوّد \"نظام أسماء النطاقات الخاص\""),
                SETTINGS to listOf("‏يُرجى إدخال اسم مضيف DNS"),
                SETTINGS to listOf("إعادة ضبط إعدادات شبكة الجوال", "سيؤدي هذا الإجراء إلى إعادة ضبط كل إعدادات شبكة الجوال"),
                SETTINGS to listOf("أتريد إعادة ضبط إعدادات شبكة الجوال؟", "هل تريد إعادة ضبط جميع إعدادات الشبكة؟ لا يمكنك التراجع عن هذا الإجراء."),
                SETTINGS to listOf("‏هل تريد إعادة ضبط كل إعدادات الشبكة ومحو بيانات شرائح eSIM؟ لا يمكنك التراجع عن هذا الإجراء."),
                VPN to listOf("تهيئة", "قطع الاتصال"),
                SETTINGS to listOf("خيارات المطورين", "استخدام خيارات المطوّرين"),
            ),
            stays = listOf(
                SETTINGS to listOf("الشبكة والإنترنت", "‏شبكة VPN", "Sitr", "نظام أسماء النطاقات الخاص"),
                SETTINGS to listOf("وضع الطيران", "‏شبكة VPN", "Sitr", "نظام أسماء النطاقات الخاص"),
                SETTINGS to listOf("نقطة الاتصال والتوصيل", "‏شبكة VPN", "Sitr", "نظام أسماء النطاقات الخاص"),
                SETTINGS to listOf("النظام", "خيارات المطورين", "المستخدمون", "خيارات إعادة الضبط"),
                SETTINGS to listOf("خيارات إعادة الضبط", "حذف المساحة الخاصة", "محو جميع البيانات (إعادة الضبط على الإعدادات الأصلية)", "‏إعادة ضبط البلوتوث وWi‑Fi", "إعادة ضبط إعدادات شبكة الجوال", "هل تريد إعادة ضبط الإعدادات المفضّلة للتطبيقات؟"),
                SETTINGS to listOf("هل تريد حذف المساحة الخاصّة؟"),
                SETTINGS to listOf("الشاشة", "الصوت والاهتزاز", "Wi‑Fi"),
                VPN to listOf("طلب الاتصال", "‏يريد تطبيق Sitr إعداد اتصال شبكة افتراضية خاصة (VPN) يتيح له مراقبة حركة بيانات الشبكة. لا تقبل السماح بذلك إلا إذا كنت تثق في المصدر. <br /> <br /> <img src=vpn_icon /> يظهر على شاشتك عندما تكون الشبكة الافتراضية الخاصة نشطة."),
                VPN to listOf("‏يتعذّر الاتصال بشبكة VPN التي يتم تشغيلها دائمًا", "‏تغيير إعدادات الشبكة الافتراضية الخاصة (VPN)", "تجاهل"),
                VPN to listOf("طلب الاتصال", "‏يريد تطبيق Sitr إعداد اتصال شبكة VPN يتيح له مراقبة حركة بيانات الشبكة. لا تقبل السماح بذلك إلا إذا كنت تثق في المصدر. <br /> <br /> <img src=vpn_icon /> يظهر على شاشتك عندما تكون شبكة VPN نشطة."),
                VPN to listOf("‏يتعذّر الاتصال بشبكة VPN التي يتم تشغيلها دائمًا", "‏تغيير إعدادات شبكة VPN", "تجاهل"),
            ),
        ),
        "tr" to Locale(
            closes = listOf(
                SETTINGS to listOf("Geliştirici seçenekleri", "Geliştirici seçeneklerini kullan"),
                SETTINGS to listOf("Geliştirici seçenekleri", "USB hata ayıklaması"),
                SETTINGS to listOf("USB hata ayıklamasına izin verilsin mi?", "USB hata ayıklaması yalnızca geliştirme amaçlıdır. Verileri bilgisayarınızla cihazınız arasında kopyalamak, bildirim göndermeksizin uygulamaları cihazınıza yüklemek ve günlük verilerini okumak için kullanın."),
                SETTINGS to listOf("Kullanıcılar", "Kullanıcı ekle", "Misafir ekle"),
                SETTINGS to listOf("Kullanıcı veya profil ekle"),
                SETTINGS to listOf("Özel alan"),
                SETTINGS to listOf("Gizli DNS", "Gizli DNS sağlayıcının ana makine adı"),
                SETTINGS to listOf("DNS sağlayıcının ana makine adını girin"),
                SETTINGS to listOf("Mobil Ağ Ayarlarını sıfırla", "Bu işlem tüm mobil ağ ayarlarını sıfırlar"),
                SETTINGS to listOf("Mobil Ağ Ayarları sıfırlansın mı?", "Tüm ağ ayarları sıfırlansın mı? Bu işlemi geri alamazsınız."),
                SETTINGS to listOf("Tüm ağ ayarları sıfırlansın ve eSIM'ler silinsin mi? Bu işlem geri alınamaz."),
                VPN to listOf("Yapılandır", "Bağlantıyı kes"),
            ),
            stays = listOf(
                SETTINGS to listOf("Ağ ve internet", "VPN", "Sitr", "Gizli DNS"),
                SETTINGS to listOf("Uçak modu", "VPN", "Sitr", "Gizli DNS"),
                SETTINGS to listOf("Hotspot ve tethering", "VPN", "Sitr", "Gizli DNS"),
                SETTINGS to listOf("Sistem", "Geliştirici seçenekleri", "Kullanıcılar", "Sıfırlama seçenekleri"),
                SETTINGS to listOf("Sıfırlama seçenekleri", "Özel alanı sil", "Tüm verileri sil (fabrika ayarlarına sıfırla)", "Bluetooth ve kablosuzu sıfırla", "Mobil Ağ Ayarlarını sıfırla", "Uygulama tercihleri sıfırlansın mı?"),
                SETTINGS to listOf("Özel alan silinsin mi?"),
                SETTINGS to listOf("Ekran", "Ses ve titreşim", "Kablosuz"),
                VPN to listOf("Bağlantı isteği", "Sitr, ağ trafiğini izlemesine izin veren bir VPN bağlantısı oluşturmak istiyor. Yalnızca kaynağa güveniyorsanız kabul edin. VPN etkin olduğunda ekranınızda <br /> <br /> <img src=vpn_icon /> görünür."),
                VPN to listOf("Her zaman açık VPN'ye bağlanılamıyor", "VPN ayarlarını değiştir", "Kapat"),
            ),
        ),
        "ms" to Locale(
            closes = listOf(
                SETTINGS to listOf("Pilihan pembangun", "Gunakan pilihan pembangun"),
                SETTINGS to listOf("Pilihan pembangun", "Penyahpepijatan USB"),
                SETTINGS to listOf("Benarkan penyahpepijatan USB?", "Penyahpepijatan USB adalah dimaksudkan untuk tujuan pembangunan sahaja. Gunakannya untuk menyalin data antara komputer dan peranti anda, memasang aplikasi pada peranti anda tanpa pemberitahuan, dan membaca data log."),
                SETTINGS to listOf("Pengguna", "Tambah pengguna", "Tambah tetamu"),
                SETTINGS to listOf("Tambah pengguna atau profil"),
                SETTINGS to listOf("Ruang privasi"),
                SETTINGS to listOf("DNS Peribadi", "Nama hos penyedia DNS peribadi"),
                SETTINGS to listOf("Masukkan nama hos penyedia DNS"),
                SETTINGS to listOf("Tetapkan Semula Tetapan Rangkaian Mudah Alih", "Tindakan ini akan menetapkan semula semua tetapan rangkaian mudah alih"),
                SETTINGS to listOf("Tetapkan Semula Tetapan Rangkaian Mudah Alih?", "Tetapkan semula semua tetapan rangkaian? Tindakan ini tidak boleh dibuat asal."),
                SETTINGS to listOf("Tetapkan semula semua tetapan rangkaian dan padamkan eSIM? Tindakan ini tidak boleh dibuat asal."),
                VPN to listOf("Konfigurasikan", "Putuskan sambungan"),
            ),
            stays = listOf(
                SETTINGS to listOf("Rangkaian dan Internet", "VPN", "Sitr", "DNS Peribadi"),
                SETTINGS to listOf("Mod pesawat", "VPN", "Sitr", "DNS Peribadi"),
                SETTINGS to listOf("Tempat liputan & penambatan", "VPN", "Sitr", "DNS Peribadi"),
                SETTINGS to listOf("Sistem", "Pilihan pembangun", "Pengguna", "Pilihan tetapan semula"),
                SETTINGS to listOf("Pilihan tetapan semula", "Padamkan ruang persendirian", "Padamkan semua data (tetapan semula kilang)", "Tetapkan semula Bluetooth & Wi-Fi", "Tetapkan Semula Tetapan Rangkaian Mudah Alih", "Tetapkan semula pilihan apl?"),
                SETTINGS to listOf("Padamkan ruang privasi?"),
                SETTINGS to listOf("Paparan", "Bunyi dan getaran", "Wi‑Fi"),
                VPN to listOf("Permintaan sambungan", "Sitr ingin menyediakan sambungan VPN yang membenarkan apl tersebut memantau trafik rangkaian. Hanya terima jika anda mempercayai sumber tersebut. <br /> <br /> <img src=vpn_icon /> muncul pada skrin anda apabila VPN aktif."),
                VPN to listOf("Tidak dapat menyambung ke VPN sentiasa hidup", "Tukar tetapan VPN", "Ketepikan"),
                SETTINGS to listOf("Padamkan ruang persendirian?"),
            ),
        ),
    )

    @Test
    fun recognisesTheSameScreensInBengaliArabicTurkishAndMalay() {
        for ((tag, locale) in locales) {
            for ((pkg, texts) in locale.closes) {
                assertTrue(decide(pkg, *texts.toTypedArray()), "$tag should close: $texts")
            }
            for ((pkg, texts) in locale.stays) {
                assertFalse(decide(pkg, *texts.toTypedArray()), "$tag should stay open: $texts")
            }
        }
    }

    @Test
    fun turkishDottedAndDotlessIMatchInAnyCase() {
        assertTrue(decide(SETTINGS, "KULLANICI EKLE"))
        assertTrue(decide(SETTINGS, "GELİŞTİRİCİ SEÇENEKLERİNİ KULLAN"))
        assertTrue(decide(VPN, "BAĞLANTIYI KES"))
        assertFalse(decide(SETTINGS, "AĞ VE İNTERNET", "VPN", "Sitr"))
    }
}
