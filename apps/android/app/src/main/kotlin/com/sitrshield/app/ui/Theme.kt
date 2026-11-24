package com.sitrshield.app.ui

import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.LocalActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

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
    // App-only, derived from the tokens above: the raised card ground (a
    // lighter paper) and its hairline (a softer rule).
    val card = Color(0xfffbf8f0)
    val hairline = Color(0xffe2dac6)
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
    // App-only: the raised card ground; its hairline is the rule itself.
    val card = Color(0xff18221d)
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
    surfaceContainerLow = LightTokens.card,
    surfaceContainer = LightTokens.paper2,
    surfaceContainerHigh = LightTokens.paper2,
    surfaceContainerHighest = LightTokens.paper2,
    outline = LightTokens.rule,
    outlineVariant = LightTokens.hairline,
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
    surfaceContainerLow = DarkTokens.card,
    surfaceContainer = DarkTokens.paper2,
    surfaceContainerHigh = DarkTokens.paper2,
    surfaceContainerHighest = DarkTokens.paper2,
    outline = DarkTokens.rule,
    outlineVariant = DarkTokens.rule,
    error = Color(0xffe05d5d),
    onError = DarkTokens.paper,
)

/**
 * The status hero on Home and Child lock: one block of colour that IS the
 * status. Green only for proven-active, red for not protected. The same
 * in light and dark, so the meaning never depends on the appearance.
 */
object Hero {
    val Green = Color(0xff0f5c46)
    val OnGreen = Color(0xfff4efe4)
    val OnGreenSoft = Color(0xffdfe6d8)
    val GreenInk = Color(0xff0a3f30)
    val Red = Color(0xffc62828)
    val OnRed = Color(0xffffffff)
    val OnRedSoft = Color(0xfffde8e4)
    val RedInk = Color(0xff8e1b1b)
    val Gold = Color(0xffc9a558)
}

/** True while the app is drawn dark (the resolved appearance, not the phone's). */
val LocalSitrDark = staticCompositionLocalOf { false }

/**
 * Type: system families only, like the site (no webfont, nothing bundled).
 * Serif for display and headlines, the default sans for everything else;
 * small labels use FontFamily.Monospace where they are drawn.
 */
private val Base = Typography()
private val SitrTypography = Typography(
    displaySmall = Base.displaySmall.copy(fontFamily = FontFamily.Serif, fontWeight = FontWeight.Medium),
    headlineLarge = Base.headlineLarge.copy(fontFamily = FontFamily.Serif, fontWeight = FontWeight.Medium),
    headlineMedium = Base.headlineMedium.copy(fontFamily = FontFamily.Serif, fontWeight = FontWeight.Medium),
    headlineSmall = Base.headlineSmall.copy(fontFamily = FontFamily.Serif, fontWeight = FontWeight.Medium),
    titleLarge = Base.titleLarge.copy(fontWeight = FontWeight.SemiBold),
    titleMedium = Base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
    bodySmall = Base.bodySmall.copy(fontSize = 13.sp, lineHeight = 19.sp),
    labelLarge = Base.labelLarge.copy(fontWeight = FontWeight.SemiBold),
)

private val SitrShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
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
    // System bars follow the APP's appearance, not the phone's: without
    // this a Light app on a dark phone had white status icons on cream,
    // and the navigation bar kept a grey scrim.
    val activity = LocalActivity.current as? ComponentActivity
    LaunchedEffect(darkTheme) {
        val style = if (darkTheme) SystemBarStyle.dark(Color.Transparent.toArgb())
        else SystemBarStyle.light(Color.Transparent.toArgb(), Color.Transparent.toArgb())
        activity?.enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
    }
    CompositionLocalProvider(LocalSitrDark provides darkTheme) {
        MaterialTheme(
            colorScheme = if (darkTheme) Dark else Light,
            typography = SitrTypography,
            shapes = SitrShapes,
            content = content,
        )
    }
}
