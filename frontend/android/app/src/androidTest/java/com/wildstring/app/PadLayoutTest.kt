package com.wildstring.app

import android.animation.ValueAnimator
import android.graphics.Bitmap
import android.graphics.Color
import android.os.ParcelFileDescriptor
import android.provider.Settings
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.wildstring.app.ui.MusicViewModel
import com.wildstring.app.data.*
import com.google.gson.Gson
import java.io.File
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.Assert.*
import org.junit.AfterClass
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test

/** Synthetic catalog: resizing changes presentation without replacing the selected page. */
class PadLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    companion object {
        private fun shell(command: String) {
            ParcelFileDescriptor.AutoCloseInputStream(InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)).use { it.readBytes() }
        }
        @BeforeClass @JvmStatic fun prepareWindow() {
            shell("wm density 160")
            shell("wm size 390x844")
            val deadline = android.os.SystemClock.elapsedRealtime() + 30_000
            while (true) {
                val configuration = InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration
                if (configuration.densityDpi == 160 && configuration.screenWidthDp == 390) break
                check(android.os.SystemClock.elapsedRealtime() < deadline) { "Phone configuration did not settle" }
                android.os.SystemClock.sleep(50)
            }
        }
        @AfterClass @JvmStatic fun restoreWindow() {
            shell("wm size 1080x1920")
            shell("wm density 420")
        }
    }
    private fun activity() = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
        .filterIsInstance<MainActivity>().single()
    private fun window(width: Int, height: Int) {
        shell("wm size ${width}x$height")
        compose.waitUntil(30_000) { compose.runOnIdle {
            val decor = activity().window.decorView
            decor.width == width && decor.height == height
        } }
        compose.waitForIdle()
        InstrumentationRegistry.getInstrumentation().uiAutomation.waitForIdle(300, 5_000)
    }
    private fun appearance(vm: MusicViewModel, mode: String) {
        compose.runOnIdle { vm.settings.appearance(mode) }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("appearance-$mode").fetchSemanticsNodes().isNotEmpty() }
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
        android.os.SystemClock.sleep(300)
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        directory.mkdirs()
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
    private class Fixture : AutoCloseable {
        val server = MockWebServer()
        val requests = java.util.concurrent.ConcurrentLinkedQueue<String>()
        val searchGate = CountDownLatch(1)
        @Volatile var catalogGate = CountDownLatch(0)
        private fun awaitCatalogGate() {
            val latch = catalogGate
            if (latch.count > 0) latch.await(8, TimeUnit.SECONDS)
        }
        private val gson = Gson()
        private val tracks = (0..39).joinToString(",") { gson.toJson(Track(
            "track-$it", "合成歌曲 ${it.toString().padStart(2, '0')}",
            when (it) { 0 -> listOf("艺人甲", "艺人乙"); 2 -> emptyList(); else -> listOf("艺人甲与一个很长的名字") },
            if (it == 2) null else "合成专辑与较长的副标题", 195000, format = "mp3", albumId = if (it == 2) null else "album",
        )) }
        private val artists = (0..11).joinToString(",") { gson.toJson(Artist("artist-$it", "合成艺人 $it", 40, null)) }
        private val playlists = (0..7).joinToString(",") { gson.toJson(Playlist("playlist-$it", "合成歌单 $it", "manual", 1, 40, null)) }
        private val cover = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888).let { bitmap ->
            val canvas = android.graphics.Canvas(bitmap)
            canvas.drawColor(Color.rgb(143, 91, 57))
            val paint = android.graphics.Paint().apply { color = Color.rgb(232, 209, 169) }
            canvas.drawCircle(48f, 48f, 26f, paint)
            ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); bitmap.recycle() }.toByteArray()
        }
        private val shows get() = (0..7).map { gson.toJson(PodcastSummary(
            "show-$it", "合成节目 $it", author = "合成主播", feedUrl = "https://example.invalid/$it",
            coverUrl = server.url("/source/show-$it.png").toString(),
            description = "用于布局验证的节目简介。", followed = true, totalEpisodes = 40, unplayedEpisodes = 40,
        )) }
        private val conversation = """{"id":"history-one","title":"合成历史会话","messages":[${(0..39).joinToString(",") { """{"id":"message-$it","role":"assistant","content":"历史消息 $it：这是合成会话，用于检查阅读宽度与滚动位置。"}""" }}],"runs":[]}"""
        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    requests += "${request.method} ${request.requestUrl}"
                    fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                    fun page(items: String, total: Int): MockResponse {
                        val limit = request.requestUrl!!.queryParameter("limit")?.toInt() ?: 50
                        val offset = request.requestUrl!!.queryParameter("offset")?.toInt() ?: 0
                        val slice = com.google.gson.JsonParser.parseString("[$items]").asJsonArray.drop(offset).take(limit).joinToString(",")
                        return json("""{"items":[$slice],"total":$total,"limit":$limit,"offset":$offset}""")
                    }
                    return when {
                        path.startsWith("/source/") -> MockResponse().setResponseCode(503)
                        path == "/api/v1/podcasts/show-0/cover" -> MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(cover))
                        path.endsWith("/cover") -> MockResponse().setResponseCode(502)
                        path.endsWith("/auth/status") -> json("""{"configured":true,"authenticated":${request.getHeader("Cookie") != null},"user":{"id":"pad-user","username":"pad","profile":"listener"}}""")
                        path.endsWith("/auth/login") -> json("{}").setHeader("Set-Cookie", "wildstring_session=pad; Path=/; Max-Age=3600")
                        path.endsWith("/tracks") -> when (request.requestUrl!!.queryParameter("q")) {
                            "missing" -> page("", 0)
                            "denied" -> json("""{"detail":"forbidden"}""").setResponseCode(403)
                            "loading" -> { searchGate.await(15, TimeUnit.SECONDS); page(tracks, 40) }
                            else -> { awaitCatalogGate(); page(tracks, 40) }
                        }
                        path.endsWith("/artists") -> when (val name = request.requestUrl!!.queryParameter("q")) {
                            "艺人甲", "艺人乙", "艺人甲与一个很长的名字" -> page(gson.toJson(Artist("matched-artist", name, 40, null)), 1)
                            else -> { awaitCatalogGate(); page(artists, 12) }
                        }
                        path.endsWith("/albums") -> { awaitCatalogGate(); page("", 0) }
                        path.endsWith("/playlists") -> { awaitCatalogGate(); page(playlists, 8) }
                        path == "/api/v1/podcasts" -> json(shows.joinToString(prefix = "[", postfix = "]"))
                        path.startsWith("/api/v1/podcasts/show-") -> {
                            val id = path.substringAfterLast('-').toInt()
                            val episodes = (0..39).map { PodcastEpisode(
                                "episode-$it", "show-$id", "$it", "合成单集 ${it.toString().padStart(2, '0')}",
                                audioUrl = "https://example.invalid/$it.mp3", durationSeconds = 1800, pubDate = "2026-11-11T00:00:00Z",
                            ) }
                            json("""{"podcast":${shows[id]},"episodes":${gson.toJson(episodes)}}""")
                        }
                        path.endsWith("/catalog-settings") -> json("""{"can_add":false,"version":1}""")
                        path.endsWith("/podcasts/queue/preferences") -> json("""{"version":1,"global":{"action":"off","limit":0},"shows":{}}""")
                        path.endsWith("/podcasts/queue") -> json("""{"version":1,"items":[]}""")
                        path.endsWith("/favorites/ids") -> json("""{"ids":[]}""")
                        path == "/api/v1/agent/conversations" -> page(conversation, 1)
                        path == "/api/v1/agent/conversations/history-one" -> json(conversation)
                        path.startsWith("/api/v1/agent/") -> page("", 0)
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
        }
        override fun close() { catalogGate.countDown(); searchGate.countDown(); server.close() }
    }
    @Test fun tabletSongColumnsNavigateToArtistAndAlbum() {
        val vm = compose.runOnIdle { ViewModelProvider(activity())[MusicViewModel::class.java] }
        Fixture().use { fixture -> try {
            compose.runOnIdle { vm.settings.orientation("auto") }
            window(390, 844)
            val serverUrl = fixture.server.url("/").toString()
            val login = compose.runOnIdle { vm.connect(serverUrl, "pad", "synthetic-password", true) }
            compose.waitUntil(20_000) { login.isCompleted && vm.state.value.connected && !vm.state.value.loading }
            compose.onNodeWithTag("nav-library").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("catalog-tracks").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("catalog-tracks").performClick()
            compose.waitUntil(15_000) { vm.state.value.tracks.size == 40 }
            compose.onNodeWithTag("track-artist-0", useUnmergedTree = true).assertDoesNotExist()
            window(1200, 800)
            compose.onNodeWithTag("track-artist-0", useUnmergedTree = true).assertHasClickAction().performClick()
            compose.onNodeWithTag("track-artist-choice-0-1").performClick()
            compose.waitUntil(15_000) { vm.state.value.collectionId == "matched-artist" && !vm.state.value.loading }
            assertEquals("艺人乙", vm.state.value.title)
            compose.runOnIdle { vm.back() }
            compose.waitUntil(15_000) { vm.state.value.collection == null && !vm.state.value.loading }
            compose.onNodeWithTag("track-album-0", useUnmergedTree = true).assertHasClickAction().performClick()
            compose.waitUntil(15_000) { vm.state.value.collectionId == "album" && !vm.state.value.loading }
            compose.runOnIdle { vm.back() }
            compose.waitUntil(15_000) { vm.state.value.collection == null && !vm.state.value.loading }
            compose.onNodeWithTag("track-artist-1", useUnmergedTree = true).performClick()
            compose.waitUntil(15_000) { vm.state.value.collectionId == "matched-artist" && !vm.state.value.loading }
            assertEquals("艺人甲与一个很长的名字", vm.state.value.title)
            compose.runOnIdle { vm.back() }
            compose.waitUntil(15_000) { vm.state.value.collection == null && !vm.state.value.loading }
            compose.onNodeWithTag("track-artist-2", useUnmergedTree = true).assertIsNotEnabled()
            compose.onNodeWithTag("track-album-2", useUnmergedTree = true).assertIsNotEnabled()
        } finally {
            compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.orientation("auto") }
            window(390, 844)
        } }
    }
    @Test fun phonePadAndNarrowWindowsKeepCatalogPodcastAndChatState() {
        val vm = compose.runOnIdle { ViewModelProvider(activity())[MusicViewModel::class.java] }
        Fixture().use { fixture -> try {
            compose.runOnIdle { vm.settings.appearance("light"); vm.settings.orientation("auto") }
            window(390, 844)
            val address = "http://127.0.0.1:${fixture.server.port}/"
            val login = compose.runOnIdle { vm.connect(address, "pad", "synthetic-password", true) }
            compose.waitUntil(20_000) { login.isCompleted && !vm.state.value.connecting }
            assertTrue("Connection failed: ${vm.state.value.error}; requests=${fixture.requests}", vm.state.value.connected)
            compose.waitUntil(15_000) { !vm.state.value.loading }
            compose.onNodeWithTag("bottom-navigation").assertIsDisplayed()
            compose.onNodeWithTag("nav-library").performClick()
            compose.onNodeWithTag("nav-library").assertIsSelected()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("catalog-tracks").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("catalog-tracks").performClick()
            compose.waitUntil(15_000) { vm.state.value.tracks.size == 40 }
            capture("pad-phone-tracks-light")
            appearance(vm, "dark")
            capture("pad-phone-tracks-dark")
            compose.onNodeWithTag("catalog-list").performScrollToIndex(20)
            compose.onNodeWithTag("catalog-item-19").assertIsDisplayed()
            window(1200, 800)
            compose.onNodeWithTag("navigation-rail").assertIsDisplayed()
            compose.onNodeWithTag("catalog-item-19").assertIsDisplayed()
            compose.onNodeWithTag("track-duration-19", useUnmergedTree = true).assertExists()
            capture("pad-landscape-tracks-dark")
            appearance(vm, "light")
            capture("pad-landscape-tracks-light")
            window(800, 1200)
            compose.onNodeWithTag("catalog-item-19").assertIsDisplayed()
            capture("pad-portrait-tracks-light")
            compose.onNodeWithTag("catalog-artists").performClick()
            compose.waitUntil(15_000) { vm.state.value.artists.size == 12 }
            val first = compose.onNodeWithTag("catalog-item-0").fetchSemanticsNode().boundsInRoot
            val second = compose.onNodeWithTag("catalog-item-1").fetchSemanticsNode().boundsInRoot
            assertEquals(first.top, second.top, 1f)
            assertTrue(first.right <= second.left)
            capture("pad-portrait-artists-light")
            appearance(vm, "dark")
            capture("pad-portrait-artists-dark")
            appearance(vm, "light")
            compose.onNodeWithTag("nav-mine").performClick()
            compose.waitUntil(15_000) { vm.state.value.playlists.size == 8 }
            compose.onNodeWithTag("catalog-list").performScrollToIndex(1)
            capture("pad-portrait-playlists-light")
            compose.onNodeWithTag("nav-search").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("catalog-search").fetchSemanticsNodes().isNotEmpty() }
            compose.runOnIdle { vm.search("合成歌曲") }
            compose.waitUntil(15_000) { !vm.state.value.loading && vm.state.value.total == 40 }
            window(1200, 800)
            capture("pad-search-light")
            appearance(vm, "dark")
            capture("pad-search-dark")
            compose.runOnIdle { vm.search("missing") }
            compose.waitUntil(15_000) { !vm.state.value.loading && vm.state.value.total == 0 }
            compose.onNodeWithText(uiString(R.string.catalog_no_matches)).assertIsDisplayed()
            capture("pad-search-empty-dark")
            compose.runOnIdle { vm.search("loading") }
            compose.waitUntil(10_000) { fixture.requests.any { it.contains("q=loading") } && vm.state.value.loading }
            capture("pad-search-loading-dark")
            fixture.searchGate.countDown()
            compose.waitUntil(15_000) { !vm.state.value.loading }
            compose.runOnIdle { vm.search("denied") }
            compose.waitUntil(15_000) { !vm.state.value.loading && vm.state.value.error != null }
            capture("pad-search-permission-dark")
            compose.runOnIdle { vm.search("合成歌曲") }
            compose.waitUntil(15_000) { !vm.state.value.loading && vm.state.value.error == null }
            appearance(vm, "light")
            compose.onNodeWithTag("nav-podcast").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("podcast-show-show-0").fetchSemanticsNodes().isNotEmpty() }
            window(1200, 800)
            compose.onNodeWithTag("podcast-two-pane").assertIsDisplayed()
            capture("pad-podcast-empty-selection")
            compose.onNodeWithTag("podcast-show-show-0").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("podcast-episodes").fetchSemanticsNodes().isNotEmpty() }
            compose.waitUntil(15_000) { vm.podcastBrowser.state.value.details["show-0"]?.episodes?.size == 40 }
            compose.waitUntil(15_000) { fixture.requests.any { it.contains("/api/v1/podcasts/show-0/cover") } }
            compose.onNodeWithTag("podcast-show-show-0").assertIsSelected()
            compose.onNodeWithTag("podcast-episodes").performScrollToIndex(16)
            val episode = compose.onNodeWithTag("podcast-episodes").onChildren().filter(hasText("合成单集", substring = true)).onFirst().fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.Text].first().text
            capture("pad-landscape-podcast-light")
            appearance(vm, "dark")
            capture("pad-landscape-podcast-dark")
            // 840dp window = 760dp content beside the 80dp rail: the first width that splits.
            window(840, 1200)
            compose.onNodeWithTag("podcast-two-pane").assertIsDisplayed()
            capture("pad-portrait-podcast-dark")
            appearance(vm, "light")
            capture("pad-portrait-podcast-light")
            appearance(vm, "dark")
            window(800, 1200)
            compose.onNodeWithTag("podcast-single-pane").assertIsDisplayed()
            capture("pad-medium-podcast-dark")
            window(700, 1000)
            compose.onNodeWithTag("navigation-rail").assertIsDisplayed()
            compose.onNodeWithTag("podcast-single-pane").assertIsDisplayed()
            assertEquals("show-0", vm.state.value.podcastId)
            compose.onNodeWithText(episode, substring = true).assertIsDisplayed()
            capture("pad-narrow-podcast-dark")
            window(390, 844)
            compose.onNodeWithTag("bottom-navigation").assertIsDisplayed()
            compose.onNodeWithText(episode, substring = true).assertIsDisplayed()
            capture("pad-phone-podcast-dark")
            appearance(vm, "light")
            capture("pad-phone-podcast-light")
            appearance(vm, "dark")
            compose.onNodeWithTag("nav-assistant").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("agent-chat-input").fetchSemanticsNodes().isNotEmpty() }
            // The workspace's initial load keeps History disabled; a click before it finishes is ignored.
            compose.waitUntil(15_000) { compose.onAllNodes(hasText(uiString(R.string.agent_ws_history)) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(uiString(R.string.agent_ws_history), substring = false).performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("history-open-history-one").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("history-open-history-one").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("历史消息 0", substring = true).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("agent-messages").performScrollToIndex(20)
            compose.onNodeWithTag("agent-chat-input").performTextInput("旋转后保留的草稿")
            compose.runOnIdle { val activity = activity(); WindowCompat.getInsetsController(activity.window, activity.window.decorView).hide(WindowInsetsCompat.Type.ime()) }
            compose.waitUntil(10_000) { compose.runOnIdle {
                val activity = activity()
                androidx.core.view.ViewCompat.getRootWindowInsets(activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == false
            } }
            capture("pad-phone-chat-dark")
            window(1200, 800)
            compose.onNodeWithTag("agent-two-pane").assertIsDisplayed()
            compose.onNodeWithTag("history-open-history-one").assertIsSelected()
            compose.onNodeWithTag("agent-chat-input").assertTextContains("旋转后保留的草稿")
            compose.onNodeWithText("历史消息 20", substring = true).assertIsDisplayed()
            capture("pad-landscape-chat-dark")
            appearance(vm, "light")
            capture("pad-landscape-chat-light")
            window(840, 1200)
            compose.onNodeWithTag("agent-two-pane").assertIsDisplayed()
            compose.onNodeWithTag("agent-chat-input").assertTextContains("旋转后保留的草稿")
            capture("pad-portrait-chat-light")
            window(390, 844)
            compose.onNodeWithTag("agent-single-pane").assertIsDisplayed()
            compose.onNodeWithTag("agent-chat-input").assertTextContains("旋转后保留的草稿")
            compose.onNodeWithText("历史消息 20", substring = true).assertIsDisplayed()
            capture("pad-phone-chat-light")
            compose.onNodeWithTag("nav-library").performClick()
            compose.onNodeWithTag("nav-assistant").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("agent-messages").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("agent-chat-input").assertTextContains("旋转后保留的草稿")
            compose.onNodeWithText("历史消息 20", substring = true).assertIsDisplayed()
        } catch (error: Throwable) {
            println("Pad failure: tab=${vm.state.value.tab}, kind=${vm.state.value.kind}, connected=${vm.state.value.connected}, error=${vm.state.value.error}, requests=${fixture.requests}")
            runCatching { capture("pad-failure") }
            throw error
        } finally {
            compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.appearance("system"); vm.settings.orientation("auto") }
        } }
    }

    @Test fun defaultTabletSettingsReturnToCategoriesOnPhone() {
        val vm = compose.runOnIdle { ViewModelProvider(activity())[MusicViewModel::class.java] }
        Fixture().use { fixture -> try {
            compose.runOnIdle { vm.settings.appearance("light"); vm.settings.orientation("auto") }
            window(390, 844)
            val address = fixture.server.url("/").toString()
            val login = compose.runOnIdle { vm.connect(address, "pad", "synthetic-password", true) }
            compose.waitUntil(20_000) { login.isCompleted && vm.state.value.connected && !vm.state.value.loading }
            window(1200, 800)
            compose.onNodeWithContentDescription(uiString(R.string.settings_title)).performClick()
            compose.onNodeWithTag("setting-category-account").assertIsSelected()
            capture("settings-default-tablet-light")
            window(390, 844)
            compose.onNodeWithTag("setting-category-storage").performScrollTo().assertIsDisplayed()
            capture("settings-default-phone-light")
            appearance(vm, "dark")
            capture("settings-default-phone-dark")
            window(1200, 800)
            compose.onNodeWithTag("setting-category-account").assertIsSelected()
            capture("settings-default-tablet-dark")
            // An explicit choice must still survive resizing.
            compose.onNodeWithTag("setting-category-storage").performClick()
            compose.onNodeWithTag("setting-audio-cache").performScrollTo().assertIsDisplayed()
            window(390, 844)
            compose.onNodeWithTag("setting-audio-cache").assertIsDisplayed()
            compose.onNodeWithTag("settings-back").performClick()
            compose.onNodeWithTag("setting-category-storage").performScrollTo().assertIsDisplayed()
            compose.onNodeWithTag("setting-category-podcast").performScrollTo().performClick()
            compose.onNodeWithTag("setting-podcast-resource-source").assertDoesNotExist()
            capture("podcast-settings-phone-dark")
            appearance(vm, "light")
            capture("podcast-settings-phone-light")
            window(1200, 800)
            capture("podcast-settings-tablet-light")
            appearance(vm, "dark")
            capture("podcast-settings-tablet-dark")
        } finally {
            compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.appearance("system"); vm.settings.orientation("auto") }
            window(390, 844)
        } }
    }

    private fun assertBoundsUnchanged(label: String, before: DpRect, after: DpRect) {
        assertEquals("$label left shifted", before.left.value, after.left.value, 0.5f)
        assertEquals("$label top shifted", before.top.value, after.top.value, 0.5f)
        assertEquals("$label right shifted", before.right.value, after.right.value, 0.5f)
        assertEquals("$label bottom shifted", before.bottom.value, after.bottom.value, 0.5f)
    }

    /** Mini player in the Pad shell, then the full player with the queue always floating over wide screens (>=840x600dp). */
    @Test fun padMiniPlayerAndQueueFloatingOverlayKeepStageStill() {
        val vm = compose.runOnIdle { ViewModelProvider(activity())[MusicViewModel::class.java] }
        Fixture().use { fixture -> try {
            compose.runOnIdle { vm.settings.appearance("light"); vm.settings.orientation("auto") }
            window(390, 844)
            val serverUrl = fixture.server.url("/").toString()
            val login = compose.runOnIdle { vm.connect(serverUrl, "pad", "synthetic-password", true) }
            compose.waitUntil(20_000) { login.isCompleted && vm.state.value.connected && !vm.state.value.loading }
            compose.onNodeWithTag("nav-library").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("catalog-tracks").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("catalog-tracks").performClick()
            compose.waitUntil(15_000) { vm.state.value.tracks.size == 40 }
            compose.runOnIdle { vm.play(vm.state.value.tracks.take(3), 0) }
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("mini-player-open").fetchSemanticsNodes().isNotEmpty() }
            for ((width, height, name) in listOf(Triple(1200, 800, "landscape"), Triple(800, 1200, "portrait"))) {
                window(width, height)
                compose.onNodeWithTag("navigation-rail").assertIsDisplayed()
                compose.onNodeWithTag("mini-player").assertIsDisplayed()
                capture("pad-$name-miniplayer-light")
                appearance(vm, "dark")
                capture("pad-$name-miniplayer-dark")
                appearance(vm, "light")
            }
            for ((width, height, label) in listOf(Triple(1200, 800, "landscape"), Triple(900, 1200, "portrait"))) {
                window(width, height)
                compose.onNodeWithTag("mini-player-open").performClick()
                compose.waitUntil(15_000) { compose.onAllNodesWithTag("player-tablet").fetchSemanticsNodes().isNotEmpty() }
                compose.waitForIdle()
                val stageBefore = compose.onNodeWithTag("player-visual-stage-tablet").assertIsDisplayed().getBoundsInRoot()
                val albumBefore = compose.onNodeWithTag("player-album").assertIsDisplayed().getBoundsInRoot()
                val qualityBefore = compose.onNodeWithTag("playback-quality", useUnmergedTree = true).assertIsDisplayed().getBoundsInRoot()
                assertTrue("Album subtitle ($albumBefore) overflowed into quality badge ($qualityBefore) at ${width}x$height", albumBefore.right < qualityBefore.left)
                compose.onNodeWithContentDescription(uiString(R.string.play_queue)).performClick()
                compose.waitUntil(15_000) { compose.onAllNodesWithTag("playback-queue").fetchSemanticsNodes().isNotEmpty() }
                compose.waitForIdle()
                compose.onNodeWithTag("player-queue-popup").assertIsDisplayed()
                compose.onNodeWithTag("player-queue-docked").assertDoesNotExist()
                assertBoundsUnchanged("stage at ${width}x$height", stageBefore, compose.onNodeWithTag("player-visual-stage-tablet").getBoundsInRoot())
                assertBoundsUnchanged("album at ${width}x$height", albumBefore, compose.onNodeWithTag("player-album").getBoundsInRoot())
                assertBoundsUnchanged("quality at ${width}x$height", qualityBefore, compose.onNodeWithTag("playback-quality", useUnmergedTree = true).getBoundsInRoot())
                capture("pad-player-queue-floating-$label-light")
                appearance(vm, "dark")
                capture("pad-player-queue-floating-$label-dark")
                appearance(vm, "light")
                androidx.test.espresso.Espresso.pressBack()
                compose.waitUntil(15_000) { compose.onAllNodesWithTag("playback-queue").fetchSemanticsNodes().isEmpty() }
                compose.waitUntil(15_000) { compose.onAllNodesWithTag("player-queue-popup").fetchSemanticsNodes().isEmpty() }
                assertBoundsUnchanged("stage after dismiss at ${width}x$height", stageBefore, compose.onNodeWithTag("player-visual-stage-tablet").getBoundsInRoot())
                androidx.test.espresso.Espresso.pressBack()
                compose.waitUntil(15_000) { compose.onAllNodesWithTag("player-tablet").fetchSemanticsNodes().isEmpty() }
            }
            window(390, 844)
            compose.onNodeWithTag("mini-player-open").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("player-phone").fetchSemanticsNodes().isNotEmpty() }
            compose.waitForIdle()
            val phoneAlbumBounds = compose.onNodeWithTag("player-album").assertIsDisplayed().getBoundsInRoot()
            val phoneQualityBounds = compose.onNodeWithTag("playback-quality", useUnmergedTree = true).assertIsDisplayed().getBoundsInRoot()
            assertTrue("Phone album subtitle ($phoneAlbumBounds) overflowed into quality badge ($phoneQualityBounds)", phoneAlbumBounds.right < phoneQualityBounds.left)
            capture("pad-phone-player-light")
            appearance(vm, "dark")
            capture("pad-phone-player-dark")
            appearance(vm, "light")
        } finally {
            compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.appearance("system"); vm.settings.orientation("auto") }
            window(390, 844)
        } }
    }

    /** Frame-by-frame queue popup motion: the stage stays still while the floating queue enters, lands, exits smoothly, or snaps under reduced motion. */
    @Test fun padFullscreenQueuePopupMotionIsContinuousAndStageStaysPut() {
        val resolver = InstrumentationRegistry.getInstrumentation().targetContext.contentResolver
        val originalScale = runCatching {
            Settings.Global.getString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE)
        }.getOrNull()?.takeIf { it.isNotBlank() && it != "null" } ?: "1.0"
        val vm = compose.runOnIdle { ViewModelProvider(activity())[MusicViewModel::class.java] }
        fun popupImage(): Bitmap? = runCatching {
            compose.onNodeWithTag("player-queue-popup")
                .captureToImage().asAndroidBitmap().copy(Bitmap.Config.ARGB_8888, false)
        }.getOrNull()
        fun diffPixels(before: Bitmap?, after: Bitmap?): Int {
            if (before == null || after == null || before.width != after.width || before.height != after.height) return -1
            val a = IntArray(after.width * after.height).also { after.getPixels(it, 0, after.width, 0, 0, after.width, after.height) }
            val b = IntArray(a.size).also { before.getPixels(it, 0, before.width, 0, 0, before.width, before.height) }
            return a.indices.count { a[it] != b[it] }
        }
        Fixture().use { fixture -> try {
            shell("settings put global animator_duration_scale 1.0")
            compose.waitUntil(5_000) { ValueAnimator.areAnimatorsEnabled() }
            compose.runOnIdle { vm.settings.appearance("light"); vm.settings.orientation("auto"); vm.settings.interfaceAnimations(true) }
            window(390, 844)
            val serverUrl = fixture.server.url("/").toString()
            val login = compose.runOnIdle { vm.connect(serverUrl, "pad", "synthetic-password", true) }
            compose.waitUntil(20_000) { login.isCompleted && vm.state.value.connected && !vm.state.value.loading }
            compose.onNodeWithTag("nav-library").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("catalog-tracks").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("catalog-tracks").performClick()
            compose.waitUntil(15_000) { vm.state.value.tracks.size == 40 }
            compose.runOnIdle { vm.play(vm.state.value.tracks.take(3), 0) }
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("mini-player-open").fetchSemanticsNodes().isNotEmpty() }
            window(1200, 800)
            compose.onNodeWithTag("mini-player-open").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("player-tablet").fetchSemanticsNodes().isNotEmpty() }
            compose.waitForIdle()

            // Animated open & close
            data class Sample(
                val tMs: Int, val stageLeft: Float, val stageRight: Float, val albumLeft: Float,
                val popupTop: Float?, val popupBottom: Float?, val changedPx: Int,
            )
            fun stepFrames(count: Int): List<Sample> = buildList {
                var prev: Bitmap? = null
                repeat(count) { idx ->
                    compose.mainClock.advanceTimeByFrame()
                    val stage = compose.onAllNodesWithTag("player-visual-stage-tablet").fetchSemanticsNodes().first().boundsInRoot
                    val album = compose.onAllNodesWithTag("player-album").fetchSemanticsNodes().first().boundsInRoot
                    val popup = compose.onAllNodesWithTag("player-queue-popup").fetchSemanticsNodes().firstOrNull()?.boundsInRoot
                    val img = if (popup != null) popupImage() else null
                    add(Sample((idx + 1) * 16, stage.left, stage.right, album.left, popup?.top, popup?.bottom, if (popup != null) diffPixels(prev, img) else 0))
                    prev?.recycle()
                    prev = img
                }
                prev?.recycle()
            }

            compose.mainClock.autoAdvance = false
            compose.onNodeWithContentDescription(uiString(R.string.play_queue)).performClick()
            val openFrames = stepFrames(30)
            compose.mainClock.autoAdvance = true
            compose.waitForIdle()

            val openProblems = buildList {
                addAll(MotionAssertions.staysPut("stage left on open", openFrames.map { it.stageLeft }))
                addAll(MotionAssertions.staysPut("stage right on open", openFrames.map { it.stageRight }))
                addAll(MotionAssertions.staysPut("album left on open", openFrames.map { it.albumLeft }))
                val popupSamples = openFrames.filter { it.popupTop != null }
                check(popupSamples.size >= 10) { "Popup did not stay mounted across animation frames: ${popupSamples.size}" }
                val tops = popupSamples.map { it.popupTop!! }
                assertTrue("Popup must animate vertically >= ${MotionAssertions.MIN_TRAVEL_PX}px, traveled ${abs(tops.last() - tops.first())}", abs(tops.last() - tops.first()) >= MotionAssertions.MIN_TRAVEL_PX)
                addAll(MotionAssertions.continuousCurve("popup open top", tops))
                addAll(MotionAssertions.landsAndStays("popup open", popupSamples.map { it.tMs }, tops, popupSamples.map { it.changedPx }, settleMs = 300))
            }
            assertTrue(openProblems.joinToString("\n"), openProblems.isEmpty())

            compose.mainClock.autoAdvance = false
            compose.onNodeWithContentDescription(uiString(R.string.play_queue)).performClick()
            compose.mainClock.advanceTimeByFrame()
            assertTrue("playback-queue semantics must vanish immediately on close", compose.onAllNodesWithTag("playback-queue").fetchSemanticsNodes().isEmpty())
            val closeFrames = stepFrames(29)
            compose.mainClock.autoAdvance = true
            compose.waitForIdle()

            val closeProblems = buildList {
                addAll(MotionAssertions.staysPut("stage left on close", closeFrames.map { it.stageLeft }))
                addAll(MotionAssertions.staysPut("stage right on close", closeFrames.map { it.stageRight }))
                addAll(MotionAssertions.staysPut("album left on close", closeFrames.map { it.albumLeft }))
                val closingTops = closeFrames.filter { it.popupTop != null && it.tMs < 270 }.map { it.popupTop!! }
                if (closingTops.size >= 4) {
                    addAll(MotionAssertions.continuousCurve("popup close top", closingTops))
                }
                assertTrue("Popup must be gone after settle", closeFrames.filter { it.tMs >= 320 }.all { it.popupTop == null })
            }
            assertTrue(closeProblems.joinToString("\n"), closeProblems.isEmpty())

            // Reduced motion (app preference off): lands in the first frame.
            compose.runOnIdle { vm.settings.interfaceAnimations(false) }
            compose.waitForIdle()
            compose.mainClock.autoAdvance = false
            compose.onNodeWithContentDescription(uiString(R.string.play_queue)).performClick()
            val reducedOpen = stepFrames(16)
            compose.mainClock.autoAdvance = true
            compose.waitForIdle()
            val firstTop = reducedOpen.first().popupTop!!
            val lastTop = reducedOpen.last().popupTop!!
            assertEquals("Reduced motion popup must land in frame 1", firstTop, lastTop, 0.5f)
            assertTrue("Reduced motion must not drift", MotionAssertions.staysPut("reduced motion top", reducedOpen.mapNotNull { it.popupTop }).isEmpty())
        } finally {
            compose.mainClock.autoAdvance = true
            compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.appearance("system"); vm.settings.orientation("auto"); vm.settings.interfaceAnimations(true) }
            shell("settings put global animator_duration_scale $originalScale")
            window(390, 844)
        } }
    }

    /** Pad and Phone skeletons match their final layouts (compact 116dp album strip + multi-column tracks/card grids on Pad). */
    @Test fun padAndPhoneLoadingSkeletonsMatchTargetLayouts() {
        val vm = compose.runOnIdle { ViewModelProvider(activity())[MusicViewModel::class.java] }
        Fixture().use { fixture -> try {
            compose.runOnIdle { vm.settings.appearance("light"); vm.settings.orientation("auto") }
            // Gate initial discovery load so discovery-skeleton stays visible cleanly for assertions & screenshots.
            fixture.catalogGate = CountDownLatch(1)
            window(1200, 800)
            val serverUrl = fixture.server.url("/").toString()
            val login = compose.runOnIdle { vm.connect(serverUrl, "pad", "synthetic-password", true) }
            compose.waitUntil(15_000) { login.isCompleted && vm.state.value.connected }
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("discovery-skeleton-album-4").fetchSemanticsNodes().isNotEmpty() }

            val padAlbum0 = compose.onNodeWithTag("discovery-skeleton-album-0").getBoundsInRoot()
            val padAlbum4 = compose.onNodeWithTag("discovery-skeleton-album-4").getBoundsInRoot()
            val padShortcut0 = compose.onNodeWithTag("discovery-skeleton-shortcut-0").getBoundsInRoot()
            val padTrack0 = compose.onNodeWithTag("discovery-skeleton-track-0").getBoundsInRoot()
            assertEquals("Pad discovery skeleton album card width must stay compact (116dp)", 116f, (padAlbum0.right - padAlbum0.left).value, 2f)
            assertEquals("Pad discovery skeleton albums must sit on one horizontal strip", padAlbum0.top.value, padAlbum4.top.value, 1f)
            assertTrue("Pad discovery shortcuts must not stretch to 350dp phone-grid squares", (padShortcut0.right - padShortcut0.left).value < 260f)
            assertTrue("Pad discovery track row must be single-line tabular", (padTrack0.bottom - padTrack0.top).value < 64f)

            capture("skeleton-pad-discovery-light")
            appearance(vm, "dark")
            capture("skeleton-pad-discovery-dark")
            appearance(vm, "light")

            window(390, 844)
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("discovery-skeleton-album-0").fetchSemanticsNodes().isNotEmpty() }
            capture("skeleton-phone-discovery-light")

            // Unblock discovery, then inspect Pad tracks, artists, and playlists ("mine") skeletons individually.
            fixture.catalogGate.countDown()
            compose.waitUntil(15_000) { !vm.state.value.loading }

            window(1200, 800)
            compose.onNodeWithTag("nav-library").performClick()
            compose.waitUntil(15_000) { !vm.state.value.loading && compose.onAllNodesWithTag("catalog-tracks").fetchSemanticsNodes().isNotEmpty() }

            fixture.catalogGate = CountDownLatch(1)
            compose.onNodeWithTag("catalog-tracks").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("catalog-skeleton-row-0").fetchSemanticsNodes().isNotEmpty() }
            val trackRow0 = compose.onNodeWithTag("catalog-skeleton-row-0").getBoundsInRoot()
            assertTrue("Pad track skeleton row must be wide multi-column", (trackRow0.right - trackRow0.left).value > 760f)
            capture("skeleton-pad-tracks-light")
            appearance(vm, "dark")
            capture("skeleton-pad-tracks-dark")
            appearance(vm, "light")
            fixture.catalogGate.countDown()
            compose.waitUntil(15_000) { !vm.state.value.loading }

            fixture.catalogGate = CountDownLatch(1)
            compose.onNodeWithTag("catalog-artists").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("catalog-skeleton-card-1").fetchSemanticsNodes().isNotEmpty() }
            val artistCard0 = compose.onNodeWithTag("catalog-skeleton-card-0").getBoundsInRoot()
            val artistCard1 = compose.onNodeWithTag("catalog-skeleton-card-1").getBoundsInRoot()
            assertEquals("Pad artist skeleton cards must form a multi-column grid", artistCard0.top.value, artistCard1.top.value, 1f)
            assertTrue("Pad artist skeleton cards must sit side by side", artistCard0.right.value <= artistCard1.left.value)
            capture("skeleton-pad-artists-light")
            fixture.catalogGate.countDown()
            compose.waitUntil(15_000) { !vm.state.value.loading }

            fixture.catalogGate = CountDownLatch(1)
            compose.onNodeWithTag("nav-mine").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("catalog-skeleton-card-1").fetchSemanticsNodes().isNotEmpty() }
            val mineCard0 = compose.onNodeWithTag("catalog-skeleton-card-0").getBoundsInRoot()
            val mineCard1 = compose.onNodeWithTag("catalog-skeleton-card-1").getBoundsInRoot()
            assertEquals("Pad playlists skeleton cards must form a multi-column grid", mineCard0.top.value, mineCard1.top.value, 1f)
            capture("skeleton-pad-mine-light")
            fixture.catalogGate.countDown()
            compose.waitUntil(15_000) { !vm.state.value.loading }
        } finally {
            fixture.catalogGate.countDown()
            compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.appearance("system"); vm.settings.orientation("auto") }
            window(390, 844)
        } }
    }
}
