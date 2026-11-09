package com.wildstring.app.data

import androidx.annotation.StringRes
import com.wildstring.app.AppLanguage
import com.wildstring.app.R

/** Local song-row sizing; never changes the player's typography or system font scale. */
enum class SongListSize(
    val key: String, @StringRes val labelRes: Int, val rowDp: Int, val coverDp: Int,
    val titleSp: Int, val artistSp: Int, val titleLineSp: Int, val artistLineSp: Int,
) {
    SMALL("small", R.string.song_size_small, 56, 36, 14, 12, 20, 16),
    MEDIUM("medium", R.string.song_size_medium, 64, 44, 16, 12, 24, 16),
    LARGE("large", R.string.song_size_large, 80, 56, 18, 14, 28, 20);

    val label: String get() = AppLanguage.string(labelRes)

    companion object {
        fun fromStored(value: String?): SongListSize = entries.firstOrNull { it.key == value } ?: MEDIUM
    }
}
