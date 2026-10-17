package com.wildstring.app

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import com.wildstring.app.ui.obj
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import retrofit2.HttpException
import java.io.IOException

/** CI and explicit local integration: only the supplied disposable synthetic backend is touched. */
class RealBackendCompletionTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun syntheticBackendValidatesActualStrictContractsAndMobilePlayback() {
        val endpoint = InstrumentationRegistry.getArguments().getString("realBackend")
        assumeTrue("Pass realBackend for an isolated synthetic server", endpoint != null)
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.quality(0); vm.sharing.mode("off"); vm.connect(endpoint!!, "admin", "disposable-browser-test-password", true) }
        compose.waitUntil(20_000) { vm.state.value.connected && !vm.state.value.loading }
        var step = "login"
        try {
            val api = vm.repository.api(); val repo = vm.repository
            val tracks = runBlocking { repo.tracks(query = "测试曲").items }
            assertTrue(tracks.size >= 2)
            val track = tracks.first()
            step = "playlist"
            val playlist = runBlocking { api.createPlaylist(PlaylistRequest("Android 真实接口测试")) }
            step = "added"
            val added = runBlocking { api.addTracks(repo.url("api", "v1", "playlists", playlist.id, "tracks"), AddTracks(playlist.version, tracks.take(2).map { it.id })) }
            step = "reordered"
            val reordered = runBlocking { api.reorderPlaylist(repo.url("api", "v1", "playlists", playlist.id, "order"), AddTracks(added.version, tracks.take(2).reversed().map { it.id })) }
            runBlocking { api.removeTrack(repo.url("api", "v1", "playlists", playlist.id, "tracks", track.id), reordered.version).close() }
            step = "current"
            val current = runBlocking { api.playlist(repo.url("api", "v1", "playlists", playlist.id)) }
            assertEquals(204, runBlocking { api.deletePlaylist(repo.url("api", "v1", "playlists", playlist.id), current.version).code() })
            val definition = JsonParser.parseString("""{"all":[{"is":{"loved":true}}],"sort":"title","order":"asc","limit":100}""").asJsonObject
            step = "smart"
            val smart = runBlocking { api.createPlaylist(PlaylistRequest("Android 规则测试", "smart", definition)) }
            step = "updated"
            val updated = runBlocking { api.updatePlaylist(repo.url("api", "v1", "playlists", smart.id), PlaylistUpdate("Android 规则编辑", smart.version, definition, "smart")) }
            assertEquals("smart", updated.kind)
            assertEquals(204, runBlocking { api.deletePlaylist(repo.url("api", "v1", "playlists", smart.id), updated.version).code() })

            val metadataUrl = repo.url("api", "v1", "manage", "tracks", track.id, "metadata")
            step = "original"
            val original = runBlocking { api.objectGet(metadataUrl) }
            val changed = original.getAsJsonObject("overrides").deepCopy().apply { addProperty("title", "Android 临时修正") }
            step = "saved"
            val saved = runBlocking { api.objectPut(metadataUrl, obj("version" to original["version"], "overrides" to changed)) }
            assertEquals("Android 临时修正", saved.getAsJsonObject("effective")["title"].asString)
            runBlocking { api.objectPut(metadataUrl, obj("version" to saved["version"], "overrides" to original["overrides"])) }
            val lyricsUrl = repo.url("api", "v1", "manage", "tracks", track.id, "lyrics")
            step = "beforeLyrics"
            val beforeLyrics = runBlocking { api.objectGet(lyricsUrl) }
            assertTrue(beforeLyrics["file_version"].asString.matches(Regex("[0-9a-f]{64}")))
            val body = obj("version" to beforeLyrics["version"], "file_version" to beforeLyrics["file_version"], "text" to "第一句\n第二句")
            runBlocking { api.objectPost("$lyricsUrl/preview", obj("text" to "第一句\n第二句")) }
            step = "lyricSaved"
            val lyricSaved = runBlocking { api.objectPut(lyricsUrl, body) }
            assertEquals(2, runBlocking { repo.lyrics(track.id) }.lines.size)
            try { runBlocking { api.objectPut(lyricsUrl, body) }; fail("Old lyric versions must fail") } catch (error: HttpException) { assertEquals(409, error.code()) }
            step = "restoreLyrics"
            runBlocking { api.objectPut(lyricsUrl, obj("version" to lyricSaved["version"], "file_version" to lyricSaved["file_version"], "text" to beforeLyrics["override"])) }

            step = "prefs"
            val prefs = runBlocking { api.recommendationPreferences() }
            val options = runBlocking { api.saveRecommendationPreferences(prefs.copy(count = 5)) }
            step = "daily"
            val daily = runBlocking { api.refreshDaily() }
            assertTrue(daily.items.size <= 5); assertEquals(daily.id, runBlocking { api.daily() }.id)
            runBlocking { api.saveRecommendationPreferences(options.copy(count = prefs.count)); api.refreshDaily() }
            step = "draft"
            val draft = runBlocking { api.discover(DiscoveryRequest("测试曲")) }
            assertEquals("local", draft.mode); assertTrue(draft.items.all { it.track.id.isNotBlank() })
            assertNotNull(runBlocking { api.listeningSummary() })
            assertNotNull(runBlocking { api.artists("", role = "composer") })

            compose.runOnIdle { vm.play(tracks.take(2)); vm.controller!!.pause(); vm.controller!!.seekTo(1000) }
            step = "shared"
            val shared = runBlocking { withContext(Dispatchers.Main) { vm.sharePlayback() } }
            assertEquals(vm.deviceId(), shared.deviceId)
            step = "other"
            val other = runBlocking { api.saveSharedPlayback(shared.copy(deviceId = "other-test-device", updatedAt = null).writeBody()) }
            val previous = compose.runOnIdle { vm.controller!!.currentMediaItem!!.mediaId }
            try { runBlocking { withContext(Dispatchers.Main) { vm.resumeShared(shared) } }; fail("Stale handoff must fail") } catch (error: IOException) { assertTrue(error.message.orEmpty().contains("进度已更新")) }
            assertEquals(previous, compose.runOnIdle { vm.controller!!.currentMediaItem!!.mediaId })
            runBlocking { withContext(Dispatchers.Main) { vm.resumeShared(other) } }
            compose.waitUntil(10_000) { compose.runOnIdle { vm.controller!!.currentPosition == other.positionMs } }
            compose.runOnIdle { assertFalse(vm.controller!!.playWhenReady); vm.toggle() }
            compose.waitUntil(15_000) { compose.runOnIdle { vm.controller!!.isPlaying } }
            compose.runOnIdle { vm.controller!!.pause() }
            step = "downloads"
            val downloads = repo.downloads
            downloads.wifiOnly = false; downloads.enqueue(listOf(track)); runBlocking { downloads.run {} }
            assertNotNull(downloads.file(track.id)); assertTrue(downloads.file(track.id)!!.length() > 0)
            compose.runOnIdle { vm.play(listOf(track)) }
            compose.waitUntil(15_000) { compose.runOnIdle { vm.controller!!.isPlaying } }
            assertTrue(vm.state.value.playbackQuality.startsWith("原音"))
        } catch (error: HttpException) { throw AssertionError("Step $step: HTTP ${error.code()} ${error.response()?.errorBody()?.string()?.take(1200)}", error) }
        finally { compose.runOnIdle { vm.sleep.cancel(); vm.repository.session.invalidate(); vm.controller?.stop(); vm.controller?.clearMediaItems() } }
    }
}
