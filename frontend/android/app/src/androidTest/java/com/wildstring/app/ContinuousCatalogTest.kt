package com.wildstring.app

import android.graphics.Bitmap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.semantics.getOrNull
import com.google.gson.Gson
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ContinuousCatalogTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val gson = Gson()
    private val names = (0 until 257).map { index -> when {
        index < 10 -> "${index} 旋律"
        index < 110 -> "A 旋律 $index"
        index < 160 -> "M 旋律 $index"
        index < 250 -> "Z 旋律 $index"
        else -> "♪ 旋律 $index"
    } }
    private val songs = names.mapIndexed { index, name -> Track("song-$index", if (index == 60) "$name · 一首用来核对长标题省略与封面对齐的歌曲" else name, listOf("演唱者"), "V", 12000,
        albumId = "album-v", trackNumber = index + 1) }
    private val albumSongs = (1..12).map { Track("album-song-$it", "专辑曲目 $it", listOf("演唱者"), "V", 12000,
        albumId = "album-v", trackNumber = it) }
    private val requests = CopyOnWriteArrayList<String>()
    private val failRange = AtomicBoolean(false)
    private val failAlbum = AtomicBoolean(false)

    private fun fixture(server: MockWebServer) {
        val login = AtomicBoolean(false)
        val audio = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.mp3").use { it.readBytes() }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl!!; val path = url.encodedPath
                requests += path + "?" + url.encodedQuery.orEmpty()
                fun json(value: Any) = MockResponse().setHeader("Content-Type", "application/json").setBody(gson.toJson(value))
                fun page(items: List<Any>): MockResponse {
                    val offset = url.queryParameter("offset")?.toIntOrNull() ?: 0
                    val limit = url.queryParameter("limit")?.toIntOrNull() ?: 50
                    return json(mapOf("items" to items.drop(offset).take(limit), "total" to items.size, "limit" to limit, "offset" to offset))
                }
                return when {
                    path == "/api/v1/auth/status" -> json(mapOf("configured" to true, "authenticated" to login.get(), "user" to if (login.get()) Account("browse-user", "listener", "admin") else null))
                    path == "/api/v1/auth/login" -> { login.set(true); json(emptyMap<String, String>()).setHeader("Set-Cookie", "wildstring_session=browse-test; Path=/; HttpOnly") }
                    path == "/api/v1/browse-index" -> {
                        val keys = listOf("0–9") + ('A'..'Z').map { it.toString() } + "#"
                        val starts = mapOf("0–9" to 0, "A" to 10, "M" to 110, "Z" to 160, "#" to 250)
                        val counts = mapOf("0–9" to 10, "A" to 100, "M" to 50, "Z" to 90, "#" to 7)
                        json(BrowseIndex(url.queryParameter("kind")!!, 257, keys.map { BrowseGroup(it, starts[it], counts[it] ?: 0) }))
                    }
                    path == "/api/v1/albums/album-v/tracks" -> if (failAlbum.get()) MockResponse().setResponseCode(503) else page(albumSongs)
                    path == "/api/v1/tracks" || path.matches(Regex("/api/v1/artists/[^/]+/tracks")) -> {
                        if (failRange.get() && url.queryParameter("offset") == "150") MockResponse().setResponseCode(503) else page(songs)
                    }
                    path == "/api/v1/albums" || path.endsWith("/albums") -> page(names.mapIndexed { index, name -> Album("album-$index", name, listOf("演唱者"), 12, null) })
                    path == "/api/v1/artists" -> page(names.mapIndexed { index, name -> Artist("artist-$index", name, 257, null) })
                    path.endsWith("/stream") -> audioStreamFixture(request, audio, "audio/mpeg", "\"continuous-v1\"")
                    path.endsWith("/lyrics") -> json(Lyrics())
                    path.matches(Regex("/api/v1/tracks/[^/]+")) -> json((songs + albumSongs).first { path.endsWith("/" + it.id) })
                    else -> page(emptyList())
                }
            }
        }
        server.start()
    }

    private fun connect(server: MockWebServer): MusicViewModel {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val address = server.url("/").toString()
        compose.runOnIdle { vm.settings.quality(0); vm.settings.appearance("light"); vm.settings.songListSize(SongListSize.MEDIUM); vm.connect(address, "listener", "test-password-original", true) }
        compose.waitUntil(15_000) { vm.state.value.account?.id == "browse-user" && !vm.state.value.loading }
        return vm
    }
    private fun ready(vm: MusicViewModel) = compose.waitUntil(15_000) { !vm.state.value.loading && vm.state.value.total == 257 && vm.state.value.browseIndex != null }
    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
        android.os.SystemClock.sleep(400)
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        directory.mkdirs(); File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }

    @Test fun jumpLoadsUnseenPageCanScrollBackAndPreservesAnchorAfterAlbum() {
        MockWebServer().use { server ->
            fixture(server); val vm = connect(server)
            try {
                compose.runOnIdle { vm.navigate("library"); vm.kind("tracks") }; ready(vm)
                compose.onNodeWithContentDescription("下一页").assertDoesNotExist()
                compose.onNodeWithTag("alphabet-B").assertIsNotEnabled()
                compose.onNodeWithTag("alphabet-Z").performClick()
                compose.waitUntil(10_000) { vm.state.value.window.trackAt(160) != null }
                compose.onNodeWithTag("catalog-item-160").assertIsDisplayed()
                compose.onNodeWithTag("alphabet-Z").assertIsSelected()
                assertTrue(requests.any { it.startsWith("/api/v1/tracks?") && it.contains("offset=150") })
                compose.onNodeWithTag("catalog-list").performScrollToIndex(150)
                compose.waitUntil(10_000) { vm.state.value.window.trackAt(149) != null }
                compose.onNodeWithTag("catalog-item-149").assertIsDisplayed()
                compose.onNodeWithTag("alphabet-M").assertIsSelected()
                compose.onNodeWithTag("alphabet-Z").performClick()
                compose.onNodeWithContentDescription("Z 旋律 160的操作").performClick()
                compose.onNodeWithText("查看所属专辑").performClick()
                compose.waitUntil(10_000) { vm.state.value.collectionId == "album-v" && !vm.state.value.loading }
                compose.onNodeWithTag("alphabet-rail").assertDoesNotExist()
                compose.onNodeWithContentDescription("返回上一页").performClick()
                ready(vm)
                compose.onNodeWithTag("catalog-item-160").assertIsDisplayed()
                capture("continuous-catalog-light.png")
                compose.runOnIdle { vm.settings.appearance("dark") }; capture("continuous-catalog-dark.png")
            } finally { compose.runOnIdle { vm.controller?.stop(); vm.repository.session.invalidate() } }
        }
    }

    @Test fun failedSliceDoesNotLoopRetriesOnTapAndStatisticsHideRail() {
        MockWebServer().use { server ->
            fixture(server); val vm = connect(server)
            try {
                compose.runOnIdle { vm.navigate("library"); vm.kind("tracks") }; ready(vm)
                failRange.set(true)
                compose.onNodeWithTag("alphabet-Z").performClick()
                compose.waitUntil(10_000) { vm.state.value.rangeErrors.containsKey(150) }
                val attempts = requests.count { it.startsWith("/api/v1/tracks?") && it.contains("offset=150") }
                compose.waitForIdle()
                assertEquals(attempts, requests.count { it.startsWith("/api/v1/tracks?") && it.contains("offset=150") })
                failRange.set(false)
                compose.onNodeWithTag("catalog-placeholder-160").performClick()
                compose.waitUntil(10_000) { vm.state.value.window.trackAt(160) != null }
                compose.onNodeWithTag("catalog-item-160").assertIsDisplayed()
                compose.onNodeWithTag("catalog-list").performScrollToIndex(0)
                compose.onNodeWithTag("catalog-sort").performClick()
                compose.onNodeWithText("播放次数").performClick()
                compose.waitUntil(10_000) { !vm.state.value.loading && vm.state.value.sort == "play_count" }
                compose.onNodeWithTag("alphabet-rail").assertDoesNotExist()
                compose.runOnIdle { vm.recent() }
                compose.waitUntil(10_000) { vm.state.value.kind == "recent" && !vm.state.value.loading }
                assertEquals("last_played_at", vm.state.value.sort)
                assertTrue(requests.last { it.startsWith("/api/v1/tracks?") && it.contains("played_only=true") }.contains("sort=last_played_at"))
                compose.onNodeWithTag("catalog-sort").performClick()
                compose.onNodeWithText("名称").performClick()
                compose.waitUntil(10_000) { !vm.state.value.loading && vm.state.value.sort == "title" }
                val recentRequest = requests.last { it.startsWith("/api/v1/tracks?") && it.contains("played_only=true") }
                assertTrue(recentRequest.contains("sort=title"))
                assertFalse(recentRequest.contains("sort=last_played_at"))
            } finally { compose.runOnIdle { vm.repository.session.invalidate() } }
        }
    }

    @Test fun draggingJumpsBeforeReleaseAndAlbumArtistListsUseGlobalPositions() {
        MockWebServer().use { server ->
            fixture(server); val vm = connect(server)
            try {
                compose.runOnIdle { vm.navigate("library") }; ready(vm)
                compose.onNodeWithTag("alphabet-rail").performTouchInput {
                    down(Offset(center.x, height * .15f)); moveTo(Offset(center.x, height * 26.5f / 28f), delayMillis = 200)
                }
                compose.onNodeWithTag("alphabet-preview").assertIsDisplayed()
                compose.waitUntil(10_000) { vm.state.value.window.albumAt(160) != null }
                compose.onNodeWithTag("catalog-item-160").assertIsDisplayed()
                compose.onNodeWithTag("alphabet-rail").performTouchInput { up() }
                compose.waitUntil(10_000) { vm.state.value.window.albumAt(160) != null }
                compose.onNodeWithTag("catalog-item-160").assertIsDisplayed()
                compose.onNodeWithTag("alphabet-preview").assertDoesNotExist()
                compose.runOnIdle { vm.kind("artists") }; ready(vm)
                compose.onNodeWithTag("alphabet-Z").performClick()
                compose.waitUntil(10_000) { vm.state.value.window.artistAt(160) != null }
                compose.onNodeWithTag("catalog-item-160").assertIsDisplayed()
                compose.onNodeWithTag("catalog-list").performScrollToIndex(150)
                compose.waitUntil(10_000) { vm.state.value.window.artistAt(149) != null }
                compose.onNodeWithTag("catalog-item-149").assertIsDisplayed()
            } finally { compose.runOnIdle { vm.repository.session.invalidate() } }
        }
    }

    @Test fun searchEditorKeepsFocusAcrossDiscoverAndResultPages() {
        MockWebServer().use { server ->
            fixture(server); val vm = connect(server)
            try {
                compose.onNodeWithTag("catalog-search").performClick().performTextInput("许")
                compose.waitUntil(10_000) { vm.state.value.query == "许" && !vm.state.value.loading }
                compose.onNodeWithTag("catalog-search").assertIsFocused().performTextInput("嵩")
                compose.waitUntil(10_000) { vm.state.value.query == "许嵩" && !vm.state.value.loading }
                compose.onNodeWithTag("catalog-search").assertTextEquals("许嵩").assertIsFocused()
                capture("chinese-search-editor.png")
                compose.onNodeWithContentDescription("清空搜索").performClick()
                compose.waitUntil(10_000) { vm.state.value.kind == "discover" && !vm.state.value.loading }
                compose.onNodeWithTag("catalog-search").assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.EditableText, androidx.compose.ui.text.AnnotatedString(""))).assertIsFocused()
            } finally { compose.runOnIdle { vm.repository.session.invalidate() } }
        }
    }

    @Test fun compactAlbumAndNestedNavigationReturnToPlayerWithLyrics() {
        MockWebServer().use { server ->
            fixture(server); val vm = connect(server)
            try {
                compose.runOnIdle { vm.openAlbum(Album("album-v", "V", listOf("演唱者"), 12, null)) }
                compose.waitUntil(10_000) { vm.state.value.collectionId == "album-v" && !vm.state.value.loading && vm.controller != null }
                compose.runOnIdle { vm.play(albumSongs, 0); vm.controller!!.pause() }
                compose.waitUntil(10_000) { vm.state.value.current?.id == albumSongs.first().id }
                compose.onNodeWithText("0 次 · 0 分钟").assertDoesNotExist()
                val mini = compose.onNodeWithTag("mini-player").fetchSemanticsNode().boundsInRoot
                val listTop = compose.onNodeWithTag("catalog-list").fetchSemanticsNode().boundsInRoot.top
                val rowHeight = 64 * compose.activity.resources.displayMetrics.density
                val fullyVisible = compose.onAllNodes(hasTestTagPrefix("catalog-item-")).fetchSemanticsNodes().count {
                    it.boundsInRoot.top >= listTop && it.boundsInRoot.bottom <= mini.top && it.boundsInRoot.height >= rowHeight - 1
                }
                assertTrue("Compact album should expose at least six full rows; actual=$fullyVisible", fullyVisible >= 6)
                capture("compact-album-light.png")
                compose.onNodeWithContentDescription("更多选项").performClick()
                compose.onNodeWithText("更新专辑元数据").assertIsDisplayed()
                compose.onNodeWithText("刷新曲库").performClick()
                compose.waitUntil(10_000) { !vm.state.value.loading }
                compose.onNodeWithTag("mini-player-open").performClick()
                compose.onNodeWithTag("player-visual-stage").performClick()
                compose.onNodeWithTag("player-album").assertIsDisplayed()
                val queue = vm.state.value.queue.map { it.entryId }
                compose.onNodeWithTag("player-album").performClick()
                compose.waitUntil(10_000) { vm.state.value.navigationDepth == 2 && !vm.state.value.loading }
                compose.onNodeWithTag("player-phone").assertDoesNotExist()
                compose.runOnIdle { vm.openArtist(Artist("artist-0", "艺人", 257, null)) }
                compose.waitUntil(10_000) { vm.state.value.collection == "artists" && !vm.state.value.loading }
                compose.onNodeWithContentDescription("返回上一页").performClick()
                compose.onNodeWithTag("player-phone").assertDoesNotExist()
                compose.onNodeWithContentDescription("返回上一页").performClick()
                compose.onNodeWithTag("player-phone").assertIsDisplayed()
                compose.onNodeWithContentDescription("返回封面").assertIsDisplayed()
                assertEquals(queue, vm.state.value.queue.map { it.entryId })
                failAlbum.set(true)
                compose.onNodeWithTag("player-album").performClick()
                compose.waitUntil(10_000) { vm.state.value.error != null }
                compose.onNodeWithTag("player-phone").assertIsDisplayed()
                assertEquals(queue, vm.state.value.queue.map { it.entryId })
                capture("player-album-origin.png")
            } finally { compose.runOnIdle { vm.controller?.stop(); vm.repository.session.invalidate() } }
        }
    }

    @Test fun songListSizeSettingsPersistAndKeepTheSameScrolledQueue() {
        MockWebServer().use { server ->
            fixture(server); val vm = connect(server)
            try {
                compose.runOnIdle { vm.navigate("library"); vm.kind("tracks") }; ready(vm)
                compose.waitUntil(10_000) { vm.controller != null }
                compose.runOnIdle { vm.play(songs.take(3), 0); vm.controller!!.pause() }
                compose.waitUntil(10_000) { vm.state.value.current?.id == songs.first().id && vm.state.value.queue.size == 3 && compose.runOnIdle { vm.controller!!.playbackState == androidx.media3.common.Player.STATE_READY } }
                compose.runOnIdle { vm.controller!!.seekTo(1500) }
                compose.waitUntil(10_000) { compose.runOnIdle { vm.controller!!.currentPosition >= 1500 } }
                val baseline = compose.runOnIdle { vm.controller!!.currentPosition }
                val queue = vm.state.value.queue.map { it.entryId }
                val route = vm.state.value.contentKey
                assertSongRowSize(0, SongListSize.MEDIUM)
                capture("song-list-medium-top.png")
                compose.onNodeWithTag("catalog-list").performScrollToIndex(61)
                compose.waitUntil(10_000) { vm.state.value.window.trackAt(60) != null }
                assertSongRowSize(60, SongListSize.MEDIUM)
                capture("song-list-medium-scrolled.png")
                listOf(SongListSize.SMALL, SongListSize.LARGE, SongListSize.MEDIUM).forEach { size ->
                    compose.onNodeWithContentDescription("设置").performClick()
                    compose.onNodeWithTag("setting-歌曲列表大小").performScrollTo().performClick()
                    if (size == SongListSize.SMALL) capture("song-list-size-settings.png")
                    compose.onNodeWithText(size.label).performClick()
                    compose.onNodeWithTag("mini-player").assertIsDisplayed()
                    assertEquals(size, AppSettings(InstrumentationRegistry.getInstrumentation().targetContext).state.value.songListSize)
                    compose.onNodeWithTag("settings-back").performClick()
                    compose.onNodeWithTag("catalog-item-60").assertIsDisplayed()
                    assertSongRowSize(60, size)
                    assertEquals(compose.onNodeWithTag("catalog-list").fetchSemanticsNode().boundsInRoot.top,
                        compose.onNodeWithTag("catalog-item-60").fetchSemanticsNode().boundsInRoot.top, 1f)
                    assertEquals(route, vm.state.value.contentKey)
                    assertEquals(queue, vm.state.value.queue.map { it.entryId })
                    compose.runOnIdle {
                        assertFalse(vm.controller!!.isPlaying)
                        assertEquals(baseline, vm.controller!!.currentPosition)
                    }
                    compose.onNodeWithContentDescription("下一页").assertDoesNotExist()
                    compose.onNodeWithText("0 次 · 0 分钟").assertDoesNotExist()
                    capture("song-list-${size.key}.png")
                }
            } finally { compose.runOnIdle { vm.settings.songListSize(SongListSize.MEDIUM); vm.controller?.stop(); vm.repository.session.invalidate() } }
        }
    }

    private fun assertSongRowSize(index: Int, size: SongListSize) {
        compose.waitForIdle()
        val density = compose.activity.resources.displayMetrics.density
        val row = compose.onNodeWithTag("catalog-item-$index").fetchSemanticsNode().boundsInRoot
        val cover = compose.onNodeWithTag("track-cover-$index", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val action = compose.onNodeWithTag("track-action-$index", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val title = compose.onNodeWithTag("track-title-$index", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertEquals(size.rowDp * density, row.height, 1f)
        assertEquals(size.coverDp * density, cover.width, 1f)
        assertEquals(size.coverDp * density, cover.height, 1f)
        assertEquals(row.center.y, cover.center.y, 1f)
        assertEquals(row.center.y, action.center.y, 1f)
        assertEquals(cover.right + 14 * density, title.left, 1f)
        assertTrue(action.width >= 48 * density - 1)
        assertTrue(action.height >= 48 * density - 1)
        val layouts = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        compose.onNodeWithTag("track-title-$index", useUnmergedTree = true)
            .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertEquals(size.titleSp.toFloat(), layouts.single().layoutInput.style.fontSize.value, .01f)
        assertEquals(1, layouts.single().layoutInput.maxLines)
        assertEquals(androidx.compose.ui.text.style.TextOverflow.Ellipsis, layouts.single().layoutInput.overflow)
        compose.onNodeWithTag("track-subtitle-$index", useUnmergedTree = true).assertTextEquals("演唱者")
        val viewport = compose.onNodeWithTag("catalog-list").fetchSemanticsNode().boundsInRoot
        val fullRows = compose.onAllNodes(hasTestTagPrefix("catalog-item-")).fetchSemanticsNodes().count {
            it.boundsInRoot.top >= viewport.top && it.boundsInRoot.bottom <= viewport.bottom && it.boundsInRoot.height >= size.rowDp * density - 1
        }
        android.util.Log.i("SongListSizingTest", "size=${size.key} anchor=$index fullyVisible=$fullRows rowDp=${row.height / density}")
    }

    private fun hasTestTagPrefix(prefix: String) = SemanticsMatcher("tag starts with $prefix") {
        it.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.TestTag)?.startsWith(prefix) == true
    }
}
