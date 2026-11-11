package com.wildstring.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalConfiguration

internal enum class AndroidLayoutMode { Phone, Pad }

/** Window space, not the device model: a folded or narrow split window uses Phone. */
internal fun androidLayoutMode(widthDp: Int, heightDp: Int): AndroidLayoutMode =
    if (minOf(widthDp, heightDp) >= 600) AndroidLayoutMode.Pad else AndroidLayoutMode.Phone

@Composable
internal fun currentAndroidLayoutMode(): AndroidLayoutMode {
    val configuration = LocalConfiguration.current
    return androidLayoutMode(configuration.screenWidthDp, configuration.screenHeightDp)
}

internal val LocalAndroidLayoutMode = staticCompositionLocalOf { AndroidLayoutMode.Phone }
