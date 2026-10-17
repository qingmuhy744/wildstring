package com.wildstring.app.data

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class Preferences(val redCloth: Boolean = false, val redIcon: Boolean = false,
    val metadataMb: Int = 32, val artworkMb: Int = 64, val audioMb: Int = 256, val haptics: Boolean = true, val appearance: String = "system", val aacBitrate: Int = 0,
    val playbackStyle: String = "cover", val songListSize: SongListSize = SongListSize.MEDIUM)

@Singleton
class AppSettings @Inject constructor(@param:ApplicationContext private val context: Context) {
    private val prefs = context.getSharedPreferences("appearance_cache", Context.MODE_PRIVATE)
    private val mutable = MutableStateFlow(Preferences(prefs.getBoolean("red_cloth", false), prefs.getBoolean("red_icon", false),
        prefs.getInt("metadata_mb", 32), prefs.getInt("artwork_mb", 64), prefs.getInt("audio_mb", 256), prefs.getBoolean("haptics", true), prefs.getString("appearance", "system") ?: "system", prefs.getInt("aac_bitrate", 0).takeIf { it in listOf(0, 128, 192, 256, 320) } ?: 0,
        prefs.getString("playback_style", "cover").takeIf { it in listOf("cover", "vinyl", "cassette") } ?: "cover",
        SongListSize.fromStored(runCatching { prefs.getString("song_list_size", null) }.getOrNull())))
    val state = mutable.asStateFlow()
    private val gainMutable = MutableStateFlow(0L)
    val gainRevision = gainMutable.asStateFlow()
    fun gainChanged() { gainMutable.value += 1 }
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
    fun haptics(enabled: Boolean) { prefs.edit().putBoolean("haptics", enabled).apply(); mutable.value = mutable.value.copy(haptics = enabled) }
    fun theme(red: Boolean) { prefs.edit().putBoolean("red_cloth", red).apply(); mutable.value = mutable.value.copy(redCloth = red) }
    fun limits(metadata: Int, artwork: Int, audio: Int) {
        require(metadata in listOf(0, 8, 32, 64) && artwork in listOf(0, 32, 64, 128) && audio in listOf(0, 128, 256, 512, 1024))
        prefs.edit().putInt("metadata_mb", metadata).putInt("artwork_mb", artwork).putInt("audio_mb", audio).apply()
        mutable.value = mutable.value.copy(metadataMb = metadata, artworkMb = artwork, audioMb = audio)
    }
    fun icon(red: Boolean) {
        val manager = context.packageManager
        fun component(redIcon: Boolean) = ComponentName(context, "com.wildstring.app." + if (redIcon) "RedClothIcon" else "ClassicIcon")
        // Enable the destination first so an interrupted switch always leaves a launcher entry.
        manager.setComponentEnabledSetting(component(red), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
        manager.setComponentEnabledSetting(component(!red), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
        prefs.edit().putBoolean("red_icon", red).apply(); mutable.value = mutable.value.copy(redIcon = red)
    }
}
