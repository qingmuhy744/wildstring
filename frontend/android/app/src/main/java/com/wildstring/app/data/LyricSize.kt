package com.wildstring.app.data

import androidx.annotation.StringRes
import com.wildstring.app.AppLanguage
import com.wildstring.app.R

/** Local typography presets for the fullscreen lyric view. */
enum class LyricSize(val key: String, @StringRes val labelRes: Int, val scale: Float) {
    SMALL("small", R.string.lyric_size_small, .86f),
    MEDIUM("medium", R.string.lyric_size_medium, 1f),
    LARGE("large", R.string.lyric_size_large, 1.2f),
    ;

    val label: String get() = AppLanguage.string(labelRes)

    companion object {
        fun fromStored(value: String?): LyricSize = entries.firstOrNull { it.key == value } ?: MEDIUM
    }
}
