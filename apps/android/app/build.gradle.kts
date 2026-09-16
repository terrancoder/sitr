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
        versionCode = 1
        versionName = "0.1.0"
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

    buildTypes {
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
