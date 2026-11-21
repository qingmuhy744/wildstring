package com.wildstring.app.ui

import com.google.gson.JsonObject
import com.wildstring.app.AppLanguage
import com.wildstring.app.R

private val lyricLevels = listOf(
    R.string.lyric_scan_level_none,
    R.string.lyric_scan_level_static,
    R.string.lyric_scan_level_synced,
    R.string.lyric_scan_level_bilingual_synced,
    R.string.lyric_scan_level_word,
    R.string.lyric_scan_level_bilingual_word,
)
internal fun lyricLevelLabel(quality: JsonObject?): String? {
    if (quality == null) return null
    val level = quality.get("level")?.takeIf { !it.isJsonNull }?.asInt
    if (level != null && level in lyricLevels.indices) return AppLanguage.string(lyricLevels[level])
    return quality.text("label").takeIf { it.isNotBlank() }
}
