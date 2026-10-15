package com.wildstring.app.ui

import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

internal val LocalDarkAppearance = staticCompositionLocalOf { true }
internal val LocalRedCloth = staticCompositionLocalOf { false }

// The original warm orange / deep green palette remains the classic dark appearance.
internal val classicLightColors = lightColorScheme(
    primary = Color(0xFFA34527), onPrimary = Color.White, primaryContainer = Color(0xFFFFDBCC), onPrimaryContainer = Color(0xFF3A160B),
    secondary = Color(0xFF58644F), onSecondary = Color.White, secondaryContainer = Color(0xFFDFE7D5), onSecondaryContainer = Color(0xFF20271B),
    background = Color(0xFFF8F7F2), surface = Color(0xFFF8F7F2), surfaceVariant = Color(0xFFE8EADF),
    onSurface = Color(0xFF282B23), onSurfaceVariant = Color(0xFF62685A),
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFF1F1E9), surfaceContainer = Color(0xFFEDEEE4),
    surfaceContainerHigh = Color(0xFFE7E9DE), surfaceContainerHighest = Color(0xFFE0E3D7),
    outline = Color(0xFF797F70), outlineVariant = Color(0xFFCBCFC0),
)
