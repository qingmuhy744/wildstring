package com.wildstring.app

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Real Media3 playback and API contracts, only on an explicitly supplied disposable library. */
class PlaybackIndicatorRealBackendTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun marker(tag: String) = compose.onNode(hasTestTag("playback-indicator") and hasAnyAncestor(hasTestTag(tag)), useUnmergedTree = true)
    private fun status(tag: String, value: String) {
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasTestTag("playback-indicator") and hasAnyAncestor(hasTestTag(tag)) and
                SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, value), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        marker(tag).assertIsDisplayed()
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val folder = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let { java.io.File(it) }
            ?: instrumentation.targetContext.getExternalFilesDir(null)!!
        folder.mkdirs()
        val image = instrumentation.uiAutomation.takeScreenshot()!!
        java.io.File(folder, name).outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }
    @Test fun currentSongFollowsPlaybackAcrossPlaylistFavoritesDailyAndDuplicateQueueEntries() {
        val endpoint = InstrumentationRegistry.getArguments().getString("realBackend")
        assumeTrue("Disposable synthetic realBackend is required", endpoint != null)
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val login = compose.runOnIdle { vm.repository.session.invalidate(); vm.sharing.mode("off"); vm.connect(endpoint!!, "admin", "disposable-browser-test-password", true) }
        compose.waitUntil(20_000) { login.isCompleted && vm.state.value.connected && !vm.state.value.connecting && !vm.state.value.loading }
        compose.waitUntil(10_000) { compose.runOnIdle { compose.activity.hasWindowFocus() } }
        compose.onNodeWithTag("nav-library").performClick()
        compose.waitUntil(10_000) { vm.state.value.tab == "library" && !vm.state.value.loading }
        var playlistId: String? = null
        var tracks = emptyList<Track>()
        var loved = emptySet<String>()
        var primary: Throwable? = null
        try {
            println("Playback indicator: connected, creating fixture playlist")
            val playlist = runBlocking {
                tracks = listOf(vm.repository.tracks("晴天测试曲").items.single { it.title == "晴天测试曲" },
                    vm.repository.tracks("夜晚测试曲").items.single { it.title == "夜晚测试曲" })
                loved = vm.repository.feature("favorites/ids").getAsJsonArray("ids").map { it.asString }.toSet()
                val created = vm.repository.feature("playlists", "POST", jsonBody("name" to "Android 播放标识回归", "kind" to "manual"))
                playlistId = created.text("id")
                vm.repository.feature("playlists/$playlistId/tracks", "POST", jsonBody("version" to created.number("version"), "track_ids" to jsonStrings(tracks.map { it.id })))
                vm.repository.api().playlist(vm.repository.url("api", "v1", "playlists", playlistId))
            }
            println("Playback indicator: opening manual playlist")
            compose.runOnIdle { vm.openPlaylist(playlist) }
            compose.waitUntil(10_000) { vm.state.value.activePlaylist?.id == playlist.id && !vm.state.value.loading }
            compose.onNodeWithTag("catalog-item-0").performClick()
            compose.waitUntil(10_000) { vm.state.value.current?.id == tracks[0].id && vm.state.value.playing && !vm.state.value.buffering }
            InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            compose.waitUntil(10_000) { compose.onAllNodesWithTag("catalog-item-0").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("catalog-item-0").assertIsSelected()
            status("catalog-item-0", "正在播放")
            compose.runOnIdle { vm.controller!!.pause() }
            status("catalog-item-0", "已暂停")
            capture("now-playing-playlist-android.png")
            compose.runOnIdle { vm.playQueue(1) }
            compose.waitUntil(10_000) { vm.state.value.current?.id == tracks[1].id && vm.state.value.playing && !vm.state.value.buffering }
            compose.onNodeWithTag("catalog-item-0").assertIsNotSelected()
            compose.onNodeWithTag("catalog-item-1").assertIsSelected()
            marker("catalog-item-0").assertDoesNotExist()
            status("catalog-item-1", "正在播放")
            compose.runOnIdle { vm.controller!!.pause() }
            val favorites = runBlocking {
                tracks.forEach { vm.repository.api().favorite(vm.repository.url("api", "v1", "tracks", it.id, "favorite"), FavoriteRequest(true)).close() }
                val item = vm.repository.feature("playlists").objects().first { it.text("kind") == "favorites" }
                vm.repository.api().playlist(vm.repository.url("api", "v1", "playlists", item.text("id")))
            }
            compose.runOnIdle { vm.openPlaylist(favorites) }
            compose.waitUntil(10_000) { vm.state.value.activePlaylist?.id == favorites.id && !vm.state.value.loading }
            val index = (0 until vm.state.value.total).first { vm.state.value.window.trackAt(it)?.id == tracks[1].id }
            compose.onNodeWithTag("catalog-item-$index").assertIsSelected()
            status("catalog-item-$index", "已暂停")
            capture("now-playing-favorites-android.png")
            val daily = runBlocking { vm.repository.agentApi().daily().items.first().track }
            compose.runOnIdle { vm.navigate("search") }
            compose.waitUntil(10_000) { vm.state.value.tab == "search" && vm.state.value.kind == "discover" && !vm.state.value.loading }
            val entry = hasText("每日推荐", substring = false) and hasClickAction()
            compose.waitUntil(10_000) { compose.onAllNodes(entry).fetchSemanticsNodes().isNotEmpty() }
            compose.onNode(entry).performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("播放推荐") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            val dailyTag = "daily-track-${daily.id}"
            compose.onNodeWithTag("daily-recommendations").performScrollToNode(hasTestTag(dailyTag))
            compose.onNodeWithTag(dailyTag).performClick()
            compose.waitUntil(10_000) { vm.state.value.current?.id == daily.id && vm.state.value.playing && !vm.state.value.buffering }
            compose.onNodeWithTag(dailyTag).assertIsSelected()
            status(dailyTag, "正在播放")
            compose.runOnIdle { vm.controller!!.pause() }
            status(dailyTag, "已暂停")
            capture("now-playing-daily-android.png")
            InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            compose.waitUntil(10_000) { compose.onAllNodesWithTag("daily-recommendations").fetchSemanticsNodes().isEmpty() && compose.runOnIdle { compose.activity.hasWindowFocus() } }
            val count = vm.state.value.queue.size
            compose.runOnIdle { vm.addToQueue(daily); vm.addToQueue(daily) }
            compose.waitUntil(10_000) { vm.state.value.queue.size == count + 2 }
            val duplicate = vm.state.value.queue.last()
            compose.runOnIdle { vm.playQueue(duplicate.index) }
            compose.waitUntil(10_000) { vm.state.value.entryId == duplicate.entryId && vm.state.value.playing && !vm.state.value.buffering }
            compose.onNodeWithTag("mini-player-queue").performClick()
            val queueTag = "queue-row-${duplicate.entryId}"
            compose.onNodeWithTag("playback-queue").performScrollToNode(hasTestTag(queueTag))
            compose.onNodeWithTag(queueTag).assertIsSelected()
            status(queueTag, "正在播放")
            compose.onAllNodes(hasTestTag("playback-indicator") and hasAnyAncestor(hasTestTag("playback-queue")), useUnmergedTree = true).assertCountEquals(1)
            capture("now-playing-queue-android.png")
        } catch (error: Throwable) {
            primary = error
            runCatching { capture("now-playing-failure-android.png") }
            throw error
        } finally {
            compose.runOnIdle { vm.controller?.stop(); vm.controller?.clearMediaItems() }
            val cleanup = runCatching { runBlocking {
                tracks.forEach { vm.repository.api().favorite(vm.repository.url("api", "v1", "tracks", it.id, "favorite"), FavoriteRequest(it.id in loved)).close() }
                playlistId?.let { id -> val latest = vm.repository.api().playlist(vm.repository.url("api", "v1", "playlists", id)); vm.repository.api().deletePlaylist(vm.repository.url("api", "v1", "playlists", id), latest.version) }
            } }
            compose.runOnIdle { vm.repository.session.invalidate() }
            cleanup.exceptionOrNull()?.let { error -> if (primary != null) primary.addSuppressed(error) else throw error }
        }
    }
}
