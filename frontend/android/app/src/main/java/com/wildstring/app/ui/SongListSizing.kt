package com.wildstring.app.ui

import androidx.compose.runtime.staticCompositionLocalOf
import com.wildstring.app.data.SongListSize

/** Collect preferences once at the application root, rather than once per visible song. */
internal val LocalSongListSize = staticCompositionLocalOf { SongListSize.MEDIUM }
