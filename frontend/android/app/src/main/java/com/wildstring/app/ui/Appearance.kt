package com.wildstring.app.ui

import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

internal val LocalDarkAppearance = staticCompositionLocalOf { true }

// Warm paper daylight palette aligned with DESIGN.md §3.1.
internal val classicLightColors = lightColorScheme(
    primary = Color(0xFFBC5438), onPrimary = Color(0xFFFFFAF3), primaryContainer = Color(0xFFF5DDD4), onPrimaryContainer = Color(0xFF3A160B),
    secondary = Color(0xFF57492F), onSecondary = Color(0xFFFFFAF3), secondaryContainer = Color(0xFFDDE2D0), onSecondaryContainer = Color(0xFF2A2B25),
    background = Color(0xFFF6F3ED), surface = Color(0xFFF6F3ED), surfaceVariant = Color(0xFFDDE2D0),
    onSurface = Color(0xFF2A2B25), onSurfaceVariant = Color(0xFF626457),
    surfaceContainerLowest = Color(0xFFFFFDF8), surfaceContainerLow = Color(0xFFEEEEE5), surfaceContainer = Color(0xFFFAF9F4),
    surfaceContainerHigh = Color(0xFFFFFDF8), surfaceContainerHighest = Color(0xFFE4E7DB),
    outline = Color(0xFF6A6E5B), outlineVariant = Color(0xFFDEDED2),
    inverseSurface = Color(0xFF2A2B25), inverseOnSurface = Color(0xFFF6F3ED),
    inversePrimary = Color(0xFFE98A6D),
    tertiary = Color(0xFF9F422B), onTertiary = Color(0xFFFFFAF3), tertiaryContainer = Color(0xFFF5DDD4), onTertiaryContainer = Color(0xFF3A160B),
    error = Color(0xFFA64027), onError = Color(0xFFFFFAF3), errorContainer = Color(0xFFF5D8CE), onErrorContainer = Color(0xFF7A2815),
)

// DESIGN.md §3.1/§3.2 status colours (no Compose roles).
internal val SuccessColor: Color @Composable get() = if (LocalDarkAppearance.current) Color(0xFFB2C69A) else Color(0xFF496332)
internal val WarnColor: Color @Composable get() = if (LocalDarkAppearance.current) Color(0xFFE5BD7C) else Color(0xFF80591E)
