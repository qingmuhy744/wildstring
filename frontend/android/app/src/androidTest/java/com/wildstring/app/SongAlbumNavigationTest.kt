package com.wildstring.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.media3.common.Player
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.Gson
import com.wildstring.app.data.Album
import com.wildstring.app.data.Artist
import com.wildstring.app.data.Track
import com.wildstring.app.ui.MusicViewModel
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class SongAlbumNavigationTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
        android.os.SystemClock.sleep(300)
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let { java.io.File(it) }
            ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        directory.mkdirs()
        java.io.File(directory, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Test fun songMenuAndPlayerOpenExactWholeAlbumWithoutReplacingQueue() {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val loggedIn = AtomicBoolean(false)
        val requests = CopyOnWriteArrayList<String>()
        val track = Track("song-one", "第一首", listOf("客席"), "同名专辑", 12000, format = "mp3", albumId = "exact-album")
        val second = track.copy(id = "song-two", title = "第二首", artists = listOf("另一位艺人"))
        val gson = Gson()
        val audio = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.mp3").use { it.readBytes() }
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    requests += path
                    fun json(value: Any) = MockResponse().setHeader("Content-Type", "application/json").setBody(gson.toJson(value))
                    fun page(items: List<Any>) = json(mapOf("items" to items, "total" to items.size, "limit" to 50, "offset" to 0))
                    return when (path) {
                        "/api/v1/auth/status" -> json(mapOf("configured" to true, "authenticated" to loggedIn.get(), "user" to if (loggedIn.get()) mapOf("id" to "album-user", "username" to "listener", "profile" to "listener") else null))
                        "/api/v1/auth/login" -> { loggedIn.set(true); json(emptyMap<String, String>()).setHeader("Set-Cookie", "wildstring_session=album-test; Path=/; HttpOnly") }
                        "/api/v1/tracks/song-one" -> json(track)
                        "/api/v1/tracks/song-two" -> json(second)
                        "/api/v1/tracks/song-one/stream", "/api/v1/tracks/song-two/stream" -> audioStreamFixture(request, audio, "audio/mpeg", "\"song-album-v1\"")
                        "/api/v1/tracks/song-one/lyrics", "/api/v1/tracks/song-two/lyrics" -> json(mapOf("kind" to "none", "lines" to emptyList<String>()))
                        "/api/v1/tracks", "/api/v1/artists/guest/tracks" -> page(listOf(track))
                        "/api/v1/albums/exact-album/tracks" -> page(listOf(track, second)).setBodyDelay(250, TimeUnit.MILLISECONDS)
                        "/api/v1/albums" -> page(listOf(Album("wrong-album", "同名专辑", listOf("其他艺人"), 1, null)))
                        else -> page(emptyList())
                    }
                }
            }
            server.start()
            val address = server.url("/").toString()
            try {
                compose.runOnIdle { vm.settings.quality(0); vm.settings.appearance("light"); vm.connect(address, "listener", "test-password-original", true) }
                compose.waitUntil(15_000) { vm.state.value.account?.id == "album-user" && !vm.state.value.loading }
                compose.runOnIdle { vm.openArtist(Artist("guest", "客席", 1, null)) }
                compose.waitUntil(10_000) { vm.state.value.tracks.size == 1 && !vm.state.value.loading }
                compose.onNodeWithContentDescription("第一首的操作").performClick()
                compose.onNodeWithTag("song-action-离线保存").assertIsDisplayed()
                val sheet = compose.onNodeWithTag("song-actions-sheet")
                val sheetTop = sheet.fetchSemanticsNode().boundsInRoot.top
                repeat(3) {
                    compose.onNodeWithTag("song-actions-scroll").performTouchInput { swipeUp(durationMillis = 90) }
                    compose.waitForIdle()
                    assertEquals("The action sheet should not follow a list fling", sheetTop, sheet.fetchSemanticsNode().boundsInRoot.top, 1f)
                    compose.onNodeWithTag("song-actions-scroll").performTouchInput { swipeDown(durationMillis = 90) }
                    compose.waitForIdle()
                    assertEquals(sheetTop, sheet.fetchSemanticsNode().boundsInRoot.top, 1f)
                }
                compose.onNodeWithTag("song-action-查看所属专辑").performScrollTo()
                val labelPositions = listOf("查看所属专辑", "下一首播放", "加入播放队列").map {
                    compose.onNodeWithText(it, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.left
                }
                assertTrue("Song action labels should align", labelPositions.max() - labelPositions.min() <= 1f)
                capture("song-actions-light.png")
                compose.runOnIdle { vm.settings.appearance("dark") }
                capture("song-actions-dark.png")
                compose.onNodeWithText("查看所属专辑").performClick()
                compose.waitUntil(10_000) { vm.state.value.collectionId == "exact-album" && !vm.state.value.loading }
                assertEquals("albums", vm.state.value.collection)
                assertNull(vm.state.value.albumFilter)
                assertEquals(listOf("第一首", "第二首"), vm.state.value.tracks.map { it.title })
                compose.onNodeWithContentDescription("返回上一页").performClick()
                compose.waitUntil(10_000) { vm.state.value.collection == "artists" && !vm.state.value.loading }
                assertEquals("guest", vm.state.value.collectionId)
                // Older saved queue entries lack album_id. Resolve the track by ID, never by title.
                compose.runOnIdle { vm.openTrackAlbum(track.copy(albumId = null)) }
                compose.waitUntil(10_000) { vm.state.value.collectionId == "exact-album" && !vm.state.value.loading }
                assertTrue(requests.contains("/api/v1/tracks/song-one"))
                compose.waitUntil(10_000) { vm.controller != null }
                compose.runOnIdle { vm.play(listOf(track, second), 0) }
                compose.waitUntil(10_000) { compose.runOnIdle { vm.controller!!.playbackState == Player.STATE_READY && vm.controller!!.currentPosition > 250 } }
                compose.waitUntil(10_000) { vm.state.value.current?.id == track.id && vm.state.value.queue.size == 2 }
                compose.onNodeWithTag("mini-player-open").performClick()
                compose.onNodeWithTag("player-album").assertIsDisplayed()
                capture("song-player-album.png")
                val entries = vm.state.value.queue.map { it.entryId }
                val repeatMode = vm.state.value.repeatMode
                val position = compose.runOnIdle { vm.controller!!.currentPosition }
                compose.onNodeWithTag("player-album").performClick()
                // Navigation waits for the album response before closing the player.
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("player-phone").fetchSemanticsNodes().isEmpty() }
                compose.onNodeWithTag("player-phone").assertDoesNotExist()
                assertEquals("exact-album", vm.state.value.collectionId)
                assertEquals(entries, vm.state.value.queue.map { it.entryId })
                assertEquals(track.id, vm.state.value.current?.id)
                compose.runOnIdle {
                    assertTrue(vm.controller!!.isPlaying)
                    assertTrue(vm.controller!!.currentPosition >= position)
                }
                assertEquals(repeatMode, vm.state.value.repeatMode)
                assertFalse(requests.any { it.contains("/albums/wrong-album/") })
                // Same-album navigation still has an explicit player origin, even when the
                // underlying catalog was already this album before expanding playback.
                compose.onNodeWithContentDescription("返回上一页").performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("player-phone").fetchSemanticsNodes().size == 1 }
                compose.onNodeWithTag("player-phone").assertIsDisplayed()
                assertEquals("exact-album", vm.state.value.collectionId)
                compose.onNodeWithContentDescription("收起播放器").performClick()
                compose.onNodeWithContentDescription("返回上一页").performClick()
                compose.waitUntil(10_000) { vm.state.value.collection == "artists" && !vm.state.value.loading }
                assertEquals("guest", vm.state.value.collectionId)
            } finally { compose.runOnIdle { vm.controller?.stop(); vm.repository.session.invalidate() } }
        }
    }
}
