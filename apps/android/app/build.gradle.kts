// :app — the Sitr Android app (Compose UI + service wiring).
// Blocklist artifacts are consumed straight from the committed
// apps/shared/blocklists/android directory as assets — apps never copy
// artifacts, so CI's determinism diff covers exactly what ships.
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.sitrshield.app"
    // Play requires new apps and updates to target API 36 (Android 16)
    // from 31 Aug 2026; keep target and compile in lockstep.
    compileSdk = 36

    defaultConfig {
        applicationId = "com.sitrshield.sitr"
        minSdk = 26
        targetSdk = 36
        // Static version identity — never derived at build time
        // (reproducibility, docs/mobile.md §Verifiability).
        // Play accepts an upload only with a code above the published one
        // (1); bump it for every upload. versionName is the label users see.
        versionCode = 2
        versionName = "0.1.1"
    }

    sourceSets["main"].assets.srcDirs("../../shared/blocklists/android")

    buildFeatures {
        compose = true
    }

    // Play upload signing. The upload key lives OUTSIDE the repo; this
    // block only activates when apps/android/keystore.properties exists
    // (gitignored), so CI and any clean checkout still produce the
    // unsigned, byte-reproducible artifact that docs/mobile.md promises.
    // Play App Signing holds the real app-signing key; the upload key
    // can be reset through the console if ever lost.
    val keystoreProps = rootProject.file("keystore.properties")
    if (keystoreProps.exists()) {
        val props = Properties().also { p -> keystoreProps.inputStream().use { p.load(it) } }
        signingConfigs {
            create("upload") {
                storeFile = rootProject.file(props.getProperty("storeFile"))
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
            }
        }
    }

    // The launcher label is a placeholder so the side-by-side build below
    // can call itself something else.
    defaultConfig.manifestPlaceholders["appLabel"] = "Sitr"

    buildTypes {
        debug {
            // On-device QA next to the Play build: `-PsideBySide` gives the
            // debug build its own application id. A locally signed build
            // can never replace the Play-signed one (different key), and
            // uninstalling that would wipe its data.
            if (project.hasProperty("sideBySide")) {
                applicationIdSuffix = ".debug"
                manifestPlaceholders["appLabel"] = "Sitr (debug)"
                // Not debuggable: Android runs debuggable apps unoptimised
                // (the PIN hash was 5–10x slower), so timings taken on a
                // debuggable build say nothing about what users get.
                isDebuggable = false
            }
        }
        release {
            // No minification in v1: the APK stays byte-auditable against
            // the source, and there is no dead third-party code to strip.
            isMinifyEnabled = false
            if (keystoreProps.exists()) {
                signingConfig = signingConfigs.getByName("upload")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":engine"))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.core.ktx)
    implementation(libs.coroutines.android)
    implementation(libs.work.runtime)
}
