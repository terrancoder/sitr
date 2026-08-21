// :core — pure Kotlin/JVM. No Android APIs, no network, no coroutines.
// Faithful port of extension/src/lib (the reference TypeScript
// implementation) plus the DNS codecs the :engine module drives. Every
// ported behavior is pinned by apps/shared/fixtures.
plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    // Android provides org.json in the platform — compileOnly keeps it out
    // of the APK; tests run on the JVM and supply it themselves.
    compileOnly(libs.orgjson)
    testImplementation(libs.orgjson)
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    // Fixture tests locate apps/shared/fixtures by walking up from here.
    systemProperty("sitr.repo.marker", rootDir.parentFile.parentFile.absolutePath)
}
