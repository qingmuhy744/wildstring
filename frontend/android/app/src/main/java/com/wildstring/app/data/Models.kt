package com.wildstring.app.data

import com.google.gson.annotations.SerializedName

data class Page<T>(val items: List<T>, val total: Int, val limit: Int, val offset: Int)
data class Account(val id: String, val username: String, val role: String, val enabled: Boolean = true, val version: Int = 1)
data class AuthStatus(val configured: Boolean, val authenticated: Boolean, val user: Account? = null)
data class PasswordChange(@SerializedName("current_password") val currentPassword: String, @SerializedName("new_password") val newPassword: String)
data class LoginRequest(val username: String, val password: String)
data class Track(
    val id: String, val title: String, val artists: List<String>, val album: String?,
    @SerializedName("duration_ms") val durationMs: Long,
    @SerializedName("has_cover") val hasCover: Boolean = false,
    @SerializedName("play_count") val playCount: Int = 0, @SerializedName("listened_ms") val listenedMs: Long = 0,
    @SerializedName("last_played_at") val lastPlayedAt: String? = null,
    val loved: Boolean = false, val format: String = "", val status: String = "available",
    @SerializedName("album_id") val albumId: String? = null,
) { val artist: String get() = artists.joinToString(" / ").ifBlank { "未知艺人" } }
data class Album(val id: String, val title: String, val artists: List<String>,
    @SerializedName("track_count") val trackCount: Int,
    @SerializedName("cover_track_id") val coverTrackId: String?)
data class Artist(val id: String, val name: String, @SerializedName("track_count") val trackCount: Int,
    @SerializedName("cover_track_id") val coverTrackId: String?)
data class Playlist(val id: String, val name: String, val kind: String, val version: Int,
    @SerializedName("track_count") val trackCount: Int,
    @SerializedName("cover_track_id") val coverTrackId: String?, @SerializedName("definition") private val definitionValue: com.google.gson.JsonElement? = null) {
    val definition: com.google.gson.JsonObject? get() = definitionValue?.takeIf { it.isJsonObject }?.asJsonObject
}
data class LyricLine(@SerializedName("time_ms") val timeMs: Long?, val text: String)
data class Lyrics(val kind: String = "none", val lines: List<LyricLine> = emptyList(), val source: String? = null)
data class FavoriteRequest(val loved: Boolean)
data class PlaylistRequest(val name: String, val kind: String = "manual", val definition: com.google.gson.JsonObject? = null)
data class RenamePlaylist(val name: String, val version: Int)
data class AddTracks(val version: Int, @SerializedName("track_ids") val trackIds: List<String>)
data class ListeningRequest(@SerializedName("session_id") val sessionId: String,
    @SerializedName("track_id") val trackId: String, @SerializedName("listened_ms") val listenedMs: Long,
    @SerializedName("started_at") val startedAt: Double? = null, val state: String = "paused")
fun formatTime(ms: Long): String {
    val seconds = ms.coerceAtLeast(0) / 1000
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

internal data class AudioOutput(val codec: String, @SerializedName("bitrate_kbps") val bitrateKbps: Int? = null)
internal data class PlaybackPlan(val mode: String, val reason: String?, val output: AudioOutput,
    @SerializedName("duration_ms") val durationMs: Long, @SerializedName("start_ms") val startMs: Long,
    @SerializedName("stream_url") val streamUrl: String)


data class LastfmStatus(val configured: Boolean, val connected: Boolean, val username: String?,
    val scrobble: Boolean, @SerializedName("now_playing") val nowPlaying: Boolean,
    @SerializedName("needs_auth") val needsAuth: Boolean = false, val version: Int)
data class LastfmPreferences(val version: Int, val scrobble: Boolean, @SerializedName("now_playing") val nowPlaying: Boolean)
data class AuthorizationUrl(val url: String)


data class PlaylistUpdate(val name: String, val version: Int, val definition: com.google.gson.JsonObject? = null, val kind: String = "manual")
data class ListeningSummary(@SerializedName("play_count") val playCount: Long = 0,
    @SerializedName("listened_ms") val listenedMs: Long = 0,
    @SerializedName("tracks_played") val playedTracks: Int = 0, @SerializedName("favorites") val lovedTracks: Int = 0)
data class SharedPlayback(val version: Int = 0, @SerializedName("device_id") val deviceId: String = "",
    @SerializedName("track_ids") val trackIds: List<String> = emptyList(), val index: Int = 0,
    @SerializedName("position_ms") val positionMs: Long = 0, val mode: String = "sequential",
    @SerializedName("updated_at") val updatedAt: String? = null)
data class RecommendationItem(val track: Track, val reason: String = "")
data class DailyRecommendations(val id: String = "", val date: String = "", val items: List<RecommendationItem> = emptyList(), val engine: String = "local")
data class RecommendationPreferences(val version: Int = 1, @SerializedName("use_ai") val useAi: Boolean = false,
    @SerializedName("use_lastfm") val useLastfm: Boolean = false, val count: Int = 20)
data class RecommendationFeedback(@SerializedName("event_id") val eventId: String = java.util.UUID.randomUUID().toString(),
    @SerializedName("track_id") val trackId: String, val action: String)
data class DiscoveryRequest(val prompt: String, val limit: Int = 20)
data class DiscoveryResult(val title: String, val items: List<RecommendationItem>, val mode: String = "local", val warning: String? = null)


data class SharedPlaybackWrite(val version: Int, @SerializedName("device_id") val deviceId: String,
    @SerializedName("track_ids") val trackIds: List<String>, val index: Int,
    @SerializedName("position_ms") val positionMs: Long, val mode: String)
fun SharedPlayback.writeBody() = SharedPlaybackWrite(version, deviceId, trackIds, index, positionMs, mode)
fun networkGson(): com.google.gson.Gson = com.google.gson.GsonBuilder().serializeNulls().create()
