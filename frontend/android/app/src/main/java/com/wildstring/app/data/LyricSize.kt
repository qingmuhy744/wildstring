package com.wildstring.app.data

/** Local typography presets for the fullscreen lyric view. */
enum class LyricSize(val key: String, val label: String, val scale: Float) {
    SMALL("small", "小", .86f),
    MEDIUM("medium", "中（默认）", 1f),
    LARGE("large", "大", 1.2f),
    ;

    companion object {
        fun fromStored(value: String?): LyricSize = entries.firstOrNull { it.key == value } ?: MEDIUM
    }
}
