package com.wildstring.app.data

import android.content.Context
import android.content.SharedPreferences
import java.security.MessageDigest
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class Preferences(
    val metadataMb: Int = 32, val artworkMb: Int = 64, val audioMb: Int = 256, val haptics: Boolean = true, val appearance: String = "system", val aacBitrate: Int = 0,
    val playbackStyle: String = "vinyl", val songListSize: SongListSize = SongListSize.MEDIUM,
    val lyricFollowSeconds: Int = 2, val lyricSize: LyricSize = LyricSize.MEDIUM,
    val orientation: String = "auto")

@Singleton
class AppSettings @Inject constructor(@param:ApplicationContext private val context: Context) {
    private val devicePrefs = context.getSharedPreferences("appearance_cache", Context.MODE_PRIVATE)
    private var prefs = devicePrefs
    private var boundAccount: String? = null
    private var initializedBinding = false
    private fun preferences(): Preferences {
        if (prefs.contains("red_cloth")) prefs.edit().remove("red_cloth").apply()
        if (devicePrefs.contains("red_icon")) devicePrefs.edit().remove("red_icon").apply()
        return Preferences(
        prefs.getInt("metadata_mb", 32), prefs.getInt("artwork_mb", 64), prefs.getInt("audio_mb", 256), prefs.getBoolean("haptics", true), prefs.getString("appearance", "system") ?: "system", prefs.getInt("aac_bitrate", 0).takeIf { it in listOf(0, 128, 192, 256, 320) } ?: 0,
        prefs.getString("playback_style", "vinyl").takeIf { it in listOf("cover", "vinyl", "cassette") } ?: "vinyl",
        SongListSize.fromStored(runCatching { prefs.getString("song_list_size", null) }.getOrNull()),
        prefs.getInt("lyric_follow_seconds", 2).takeIf { it in listOf(1, 2, 3, 5, 10) } ?: 2,
        LyricSize.fromStored(runCatching { prefs.getString("lyric_size", null) }.getOrNull()),
        prefs.getString("screen_orientation", "auto").takeIf { it in listOf("auto", "portrait", "sensor") } ?: "auto")
    }
    private val mutable = MutableStateFlow(preferences())

    /** Stable server and account IDs survive token refreshes and reconnects. */
    @Synchronized fun bindAccount(serverId: String?, userId: String?) {
        val identity = if (serverId != null && userId != null) "$serverId:$userId" else null
        if (initializedBinding && identity == boundAccount) return
        val name = identity?.let { value ->
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
        } ?: "signed-out"
        val target = context.getSharedPreferences("account_preferences_$name", Context.MODE_PRIVATE)
        // Claim the old device-wide values only once, for the first existing account.
        if (identity != null && !devicePrefs.contains("preferences_legacy_owner")) {
            val edit = target.edit()
            devicePrefs.all.forEach { (key, value) ->
                if (key != "red_icon" && !target.contains(key)) copyPreference(edit, key, value)
            }
            edit.apply()
            devicePrefs.edit().putString("preferences_legacy_owner", identity).apply()
        }
        prefs = target
        boundAccount = identity
        initializedBinding = true
        mutable.value = preferences()
    }

    private fun copyPreference(edit: SharedPreferences.Editor, key: String, value: Any?) {
        when (value) {
            is String -> edit.putString(key, value)
            is Boolean -> edit.putBoolean(key, value)
            is Int -> edit.putInt(key, value)
            is Long -> edit.putLong(key, value)
            is Float -> edit.putFloat(key, value)
        }
    }
    val state = mutable.asStateFlow()
    private val gainMutable = MutableStateFlow(0L)
    val gainRevision = gainMutable.asStateFlow()
    private val avatarMutable = MutableStateFlow(0L)
    val avatarRevision = avatarMutable.asStateFlow()
    private fun sortKey(owner: String?, context: String) = if (boundAccount != null) "catalog-sort:$context" else "catalog-sort:$owner:$context"
    private fun sortValue(owner: String?, context: String, suffix: String, fallback: String): String {
        val legacy = "catalog-sort:$owner:$context$suffix"
        return prefs.getString(sortKey(owner, context) + suffix, null)
            ?: prefs.getString(legacy, null) ?: devicePrefs.getString(legacy, fallback) ?: fallback
    }
    fun catalogSort(owner: String?, context: String): CatalogSort {
        val fallback = defaultCatalogSort(context)
        val sort = sortValue(owner, context, "", fallback.sort).takeIf { candidate -> catalogSortChoices(context).any { it.first == candidate } } ?: fallback.sort
        val order = sortValue(owner, context, ":order", fallback.order).takeIf { it in listOf("asc", "desc") } ?: fallback.order
        return CatalogSort(sort, order)
    }
    fun catalogSort(owner: String?, context: String, selection: CatalogSort) {
        require(catalogSortChoices(context).any { it.first == selection.sort } && selection.order in listOf("asc", "desc"))
        val key = sortKey(owner, context)
        prefs.edit().putString(key, selection.sort).putString("$key:order", selection.order).apply()
    }
    fun avatarChanged() { avatarMutable.value += 1 }
    fun gainChanged() { gainMutable.value += 1 }
    fun lyricFollowSeconds(seconds: Int) {
        require(seconds in listOf(1, 2, 3, 5, 10))
        prefs.edit().putInt("lyric_follow_seconds", seconds).apply()
        mutable.value = mutable.value.copy(lyricFollowSeconds = seconds)
    }
    fun lyricSize(size: LyricSize) {
        prefs.edit().putString("lyric_size", size.key).apply()
        mutable.value = mutable.value.copy(lyricSize = size)
    }
    fun songListSize(size: SongListSize) {
        prefs.edit().putString("song_list_size", size.key).apply(); mutable.value = mutable.value.copy(songListSize = size)
    }
    fun playbackStyle(style: String) {
        require(style in listOf("cover", "vinyl", "cassette"))
        prefs.edit().putString("playback_style", style).apply(); mutable.value = mutable.value.copy(playbackStyle = style)
    }
    fun quality(bitrate: Int) {
        require(bitrate in listOf(0, 128, 192, 256, 320))
        prefs.edit().putInt("aac_bitrate", bitrate).apply(); mutable.value = mutable.value.copy(aacBitrate = bitrate)
    }
    fun appearance(mode: String) {
        require(mode in listOf("system", "light", "dark"))
        prefs.edit().putString("appearance", mode).apply(); mutable.value = mutable.value.copy(appearance = mode)
    }
    fun orientation(mode: String) {
        require(mode in listOf("auto", "portrait", "sensor"))
        prefs.edit().putString("screen_orientation", mode).apply(); mutable.value = mutable.value.copy(orientation = mode)
    }
    /** Cache of the account default auto-continue. The server copy is preferences.auto_continue. */
    fun podcastContinuePreference(): PodcastContinuePreference = PodcastContinuePreference(
        order = PodcastContinueOrder.fromStored(prefs.getString("podcast_continue_order", null)),
        skipCompleted = prefs.getBoolean("podcast_continue_skip_completed", true),
        autoContinue = prefs.getBoolean("podcast_continue_enabled", true),
    )
    fun podcastContinuePreference(value: PodcastContinuePreference) {
        prefs.edit()
            .putString("podcast_continue_order", value.order.stored)
            .putBoolean("podcast_continue_skip_completed", value.skipCompleted)
            .putBoolean("podcast_continue_enabled", value.autoContinue)
            .apply()
    }
    fun haptics(enabled: Boolean) { prefs.edit().putBoolean("haptics", enabled).apply(); mutable.value = mutable.value.copy(haptics = enabled) }
    fun limits(metadata: Int, artwork: Int, audio: Int) {
        require(metadata in CacheLimits.metadataMb && artwork in CacheLimits.artworkMb && audio in CacheLimits.audioMb)
        prefs.edit().putInt("metadata_mb", metadata).putInt("artwork_mb", artwork).putInt("audio_mb", audio).apply()
        mutable.value = mutable.value.copy(metadataMb = metadata, artworkMb = artwork, audioMb = audio)
    }
}
