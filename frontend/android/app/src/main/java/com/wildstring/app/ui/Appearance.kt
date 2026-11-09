package com.wildstring.app.ui

import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

internal val LocalDarkAppearance = staticCompositionLocalOf { true }

// Warm paper daylight palette aligned with DESIGN.md §3.1.
internal val classicLightColors = lightColorScheme(
    primary = Color(0xFFBC5438), onPrimary = Color(0xFFFFFAF3), primaryContainer = Color(0xFFF5DDD4), onPrimaryContainer = Color(0xFF3A160B),
    secondary = Color(0xFF57492F), onSecondary = Color(0xFFFFFAF3), secondaryContainer = Color(0xFFDDE2D0), onSecondaryContainer = Color(0xFF2A2B25),
    background = Color(0xFFF6F3ED), surface = Color(0xFFF6F3ED), surfaceVariant = Color(0xFFE4E7DB),
    onSurface = Color(0xFF2A2B25), onSurfaceVariant = Color(0xFF626457),
    surfaceContainerLowest = Color(0xFFFFFDF8), surfaceContainerLow = Color(0xFFFAF9F4), surfaceContainer = Color(0xFFEEECE5),
    surfaceContainerHigh = Color(0xFFE6E5DC), surfaceContainerHighest = Color(0xFFE4E7DB),
    outline = Color(0xFF6A6E5B), outlineVariant = Color(0xFFDEDED2),
)
