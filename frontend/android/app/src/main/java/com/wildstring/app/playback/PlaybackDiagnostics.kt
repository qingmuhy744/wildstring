package com.wildstring.app.playback

import com.google.gson.GsonBuilder

/** Deliberate allowlist: no MediaItem, metadata title/extras, URL, identifier, user, or exception. */
@androidx.annotation.Keep
data class PlaybackDiagnosticSnapshot(
    val app_version: String,
    val manufacturer: String,
    val model: String,
    val sdk: Int,
    val captured_elapsed_ms: Long,
    val requested_aac_kbps: Int,
    val actual_mode: String,
    val actual_codec: String,
    val platform_duration_ms: Long?,
    val platform_position_ms: Long?,
    val platform_speed: Float?,
    val platform_state: Int?,
    val platform_actions: Long?,
    val platform_seek_supported: Boolean,
    val platform_update_elapsed_ms: Long?,
    val player_duration_ms: Long?,
    val player_position_ms: Long,
    val player_live: Boolean,
    val player_seekable: Boolean,
    val engine_duration_ms: Long?,
    val engine_live: Boolean,
    val engine_seekable: Boolean,
) {
    fun render(): String = GsonBuilder().serializeNulls().setPrettyPrinting().create().toJson(this)
}
