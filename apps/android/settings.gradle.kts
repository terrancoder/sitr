// Sitr for Android.
//
// :core is pure Kotlin/JVM (no Android dependency) so the shared logic —
// sync crypto, protocol client, household model, gate/PIN, DNS codecs,
// decision ladder — builds and tests with only a JDK, everywhere the
// conformance fixtures live. The Android modules (:engine, :app) require
// the Android SDK and are included only when one is available, so a
// JDK-only environment can still run the :core suite.
pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "sitr-android"

include(":core")

val hasAndroidSdk =
    System.getenv("ANDROID_HOME") != null ||
        System.getenv("ANDROID_SDK_ROOT") != null ||
        file("local.properties").let { it.exists() && it.readText().contains("sdk.dir") }

if (hasAndroidSdk) {
    // :engine (VpnService DNS filter) and :app (Compose UI) land here.
    listOf(":engine", ":app").forEach { name ->
        if (file(name.removePrefix(":")).exists()) include(name)
    }
}
