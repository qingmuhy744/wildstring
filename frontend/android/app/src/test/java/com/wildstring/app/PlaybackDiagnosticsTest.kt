package com.wildstring.app

import com.google.gson.JsonParser
import com.wildstring.app.playback.PlaybackDiagnosticSnapshot
import org.junit.Assert.*
import org.junit.Test

class PlaybackDiagnosticsTest {
    @Test fun reportHasOnlyAllowlistedDeviceAndPlaybackFields() {
        val value = PlaybackDiagnosticSnapshot("0.4.0", "OPPO", "synthetic-model", 36, 20000,
            192, "transcode", "aac", 12000, 6500, 1f, 3, 256, true, 19000, 12000, 6500,
            false, true, null, false, false)
        val report = value.render(); val json = JsonParser.parseString(report).asJsonObject
        assertEquals(12000L, json["platform_duration_ms"].asLong)
        assertTrue(json["engine_duration_ms"].isJsonNull)
        assertTrue(json["platform_seek_supported"].asBoolean)
        assertEquals(setOf("app_version", "manufacturer", "model", "sdk", "captured_elapsed_ms", "requested_aac_kbps", "actual_mode", "actual_codec",
            "platform_duration_ms", "platform_position_ms", "platform_speed", "platform_state", "platform_actions", "platform_seek_supported", "platform_update_elapsed_ms",
            "player_duration_ms", "player_position_ms", "player_live", "player_seekable", "engine_duration_ms", "engine_live", "engine_seekable"), json.keySet())
        listOf("title", "artist", "media_id", "track_id", "url", "cookie", "token", "account", "extras", "path").forEach { assertFalse("No $it in diagnostics", json.has(it)) }
    }
}
