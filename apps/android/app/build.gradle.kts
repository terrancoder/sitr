// :app — the Sitr Android app (Compose UI + service wiring).
// Blocklist artifacts are consumed straight from the committed
// apps/shared/blocklists/android directory as assets — apps never copy
// artifacts, so CI's determinism diff covers exactly what ships.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.sitrshield.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sitrshield.sitr"
        minSdk = 26
        targetSdk = 35
        // Static version identity — never derived at build time
        // (reproducibility, docs/mobile.md §Verifiability).
        versionCode = 1
        versionName = "0.1.0"
    }

    sourceSets["main"].assets.srcDirs("../../shared/blocklists/android")

    buildFeatures {
        compose = true
    }

    buildTypes {
        release {
            // No minification in v1: the APK stays byte-auditable against
            // the source, and there is no dead third-party code to strip.
            isMinifyEnabled = false
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
