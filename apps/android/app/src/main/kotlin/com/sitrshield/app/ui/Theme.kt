package com.sitrshield.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Sitr green — the extension's protection-active color family. */
val ProtectionGreen = Color(0xff1a7f37)
val ProtectionRed = Color(0xffc62828)

private val Light = lightColorScheme(
    primary = ProtectionGreen,
    secondary = Color(0xff4a6552),
    surface = Color(0xfffbfdf9),
    background = Color(0xfff6f8f5),
)

private val Dark = darkColorScheme(
    primary = Color(0xff46c06a),
    secondary = Color(0xff9db8a5),
    surface = Color(0xff1b211c),
    background = Color(0xff141815),
)

@Composable
fun SitrTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) Dark else Light,
        content = content,
    )
}
