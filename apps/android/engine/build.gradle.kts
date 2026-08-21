// :engine — the VpnService DNS filter. All protocol/decision logic lives
// in :core (pure, JVM-tested); this module is the Android wiring: tun
// device, protected sockets, network callbacks, foreground notification.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.sitrshield.engine"
    compileSdk = 35
    defaultConfig {
        minSdk = 26
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
    api(project(":core"))
    implementation(libs.coroutines.android)
    implementation(libs.core.ktx)
}
