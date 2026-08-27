package com.sitrshield.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color

/**
 * sitrshield.com design tokens, verbatim (site CSS custom properties).
 * Dynamic color stays OFF: the app is the site's brand, not the wallpaper's.
 */
private object LightTokens {
    val paper = Color(0xfff4efe4)
    val paper2 = Color(0xffece5d4)
    val ink = Color(0xff1d2a24)
    val inkSoft = Color(0xff51604f)
    val green = Color(0xff0f5c46)
    val greenDeep = Color(0xff0a3f30)
    val gold = Color(0xffa37e2c)
    val goldSoft = Color(0xffc4a45c)
    val rule = Color(0xffc9bfa6)
}

private object DarkTokens {
    val paper = Color(0xff121a16)
    val paper2 = Color(0xff0d1411)
    val ink = Color(0xffe4ddc9)
    val inkSoft = Color(0xff94a093)
    val green = Color(0xff3aa886)
    val greenDeep = Color(0xff2c8168)
    val gold = Color(0xffc9a558)
    val goldSoft = Color(0xffa3873f)
    val rule = Color(0xff2c3a32)
}

/**
 * Fail-visible red for inactive/unknown protection. Deliberately NOT a
 * brand token: status stays honest — red for not-proven, green (primary)
 * only for proven-active. Mapped to the scheme's error slot so it tracks
 * the resolved light/dark theme, not the system setting.
 */
val ProtectionRed: Color
    @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.error

private val Light = lightColorScheme(
    primary = LightTokens.green,
    onPrimary = LightTokens.paper,
    primaryContainer = LightTokens.greenDeep,
    onPrimaryContainer = LightTokens.paper,
    secondary = LightTokens.gold,
    onSecondary = LightTokens.paper,
    secondaryContainer = LightTokens.paper2,
    onSecondaryContainer = LightTokens.gold,
    tertiary = LightTokens.goldSoft,
    onTertiary = LightTokens.ink,
    background = LightTokens.paper,
    onBackground = LightTokens.ink,
    surface = LightTokens.paper,
    onSurface = LightTokens.ink,
    surfaceVariant = LightTokens.paper2,
    onSurfaceVariant = LightTokens.inkSoft,
    surfaceDim = LightTokens.paper2,
    surfaceBright = LightTokens.paper,
    surfaceContainerLowest = LightTokens.paper,
    surfaceContainerLow = LightTokens.paper2,
    surfaceContainer = LightTokens.paper2,
    surfaceContainerHigh = LightTokens.paper2,
    surfaceContainerHighest = LightTokens.paper2,
    outline = LightTokens.rule,
    outlineVariant = LightTokens.rule,
    error = Color(0xffc62828),
    onError = LightTokens.paper,
)

private val Dark = darkColorScheme(
    primary = DarkTokens.green,
    onPrimary = DarkTokens.paper,
    primaryContainer = DarkTokens.greenDeep,
    onPrimaryContainer = DarkTokens.paper,
    secondary = DarkTokens.gold,
    onSecondary = DarkTokens.paper,
    secondaryContainer = DarkTokens.paper2,
    onSecondaryContainer = DarkTokens.gold,
    tertiary = DarkTokens.goldSoft,
    onTertiary = DarkTokens.ink,
    background = DarkTokens.paper,
    onBackground = DarkTokens.ink,
    surface = DarkTokens.paper,
    onSurface = DarkTokens.ink,
    surfaceVariant = DarkTokens.paper2,
    onSurfaceVariant = DarkTokens.inkSoft,
    surfaceDim = DarkTokens.paper2,
    surfaceBright = DarkTokens.paper,
    surfaceContainerLowest = DarkTokens.paper2,
    surfaceContainerLow = DarkTokens.paper2,
    surfaceContainer = DarkTokens.paper2,
    surfaceContainerHigh = DarkTokens.paper2,
    surfaceContainerHighest = DarkTokens.paper2,
    outline = DarkTokens.rule,
    outlineVariant = DarkTokens.rule,
    error = Color(0xffe05d5d),
    onError = DarkTokens.paper,
)

/** Values the appearance setting may hold; anything else means SYSTEM. */
object Appearance {
    const val SYSTEM = "system"
    const val LIGHT = "light"
    const val DARK = "dark"
}

@Composable
fun SitrTheme(appearance: String = Appearance.SYSTEM, content: @Composable () -> Unit) {
    val darkTheme = when (appearance) {
        Appearance.LIGHT -> false
        Appearance.DARK -> true
        else -> isSystemInDarkTheme()
    }
    MaterialTheme(
        colorScheme = if (darkTheme) Dark else Light,
        content = content,
    )
}
