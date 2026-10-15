package dev.wildstring.app.data

import com.google.gson.annotations.SerializedName

data class Page<T>(val items: List<T>, val total: Int, val limit: Int, val offset: Int)
data class AuthStatus(val configured: Boolean, val authenticated: Boolean)
data class LoginRequest(val username: String, val password: String)
data class Track(
    val id: String, val title: String, val artists: List<String>, val album: String?,
    @SerializedName("duration_ms") val durationMs: Long,
    @SerializedName("has_cover") val hasCover: Boolean = false,
    val loved: Boolean = false, val format: String = "", val status: String = "available",
) { val artist: String get() = artists.joinToString(" / ").ifBlank { "未知艺人" } }
data class Album(val id: String, val title: String, val artists: List<String>,
    @SerializedName("track_count") val trackCount: Int,
    @SerializedName("cover_track_id") val coverTrackId: String?)
data class Artist(val id: String, val name: String, @SerializedName("track_count") val trackCount: Int,
    @SerializedName("cover_track_id") val coverTrackId: String?)
data class Playlist(val id: String, val name: String, val kind: String, val version: Int,
    @SerializedName("track_count") val trackCount: Int,
    @SerializedName("cover_track_id") val coverTrackId: String?)
data class LyricLine(@SerializedName("time_ms") val timeMs: Long?, val text: String)
data class Lyrics(val kind: String = "none", val lines: List<LyricLine> = emptyList())
data class FavoriteRequest(val loved: Boolean)
data class PlaylistRequest(val name: String, val kind: String = "manual")
data class RenamePlaylist(val name: String, val version: Int)
data class AddTracks(val version: Int, @SerializedName("track_ids") val trackIds: List<String>)
data class ListeningRequest(@SerializedName("session_id") val sessionId: String,
    @SerializedName("track_id") val trackId: String, @SerializedName("listened_ms") val listenedMs: Long)
fun formatTime(ms: Long): String {
    val seconds = ms.coerceAtLeast(0) / 1000
    return "%d:%02d".format(seconds / 60, seconds % 60)
}
