package com.wildstring.app.data

/** Local song-row sizing; never changes the player's typography or system font scale. */
enum class SongListSize(
    val key: String, val label: String, val rowDp: Int, val coverDp: Int,
    val titleSp: Int, val artistSp: Int, val titleLineSp: Int, val artistLineSp: Int,
) {
    SMALL("small", "小", 56, 36, 14, 12, 20, 16),
    MEDIUM("medium", "中（推荐）", 64, 44, 16, 12, 24, 16),
    LARGE("large", "大", 80, 56, 18, 14, 28, 20);

    companion object {
        fun fromStored(value: String?): SongListSize = entries.firstOrNull { it.key == value } ?: MEDIUM
    }
}
