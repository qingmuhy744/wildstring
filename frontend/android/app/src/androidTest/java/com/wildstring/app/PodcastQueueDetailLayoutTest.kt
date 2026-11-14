package com.wildstring.app

import android.graphics.Bitmap
import android.graphics.Color
import android.os.ParcelFileDescriptor
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.google.gson.Gson
import com.google.gson.JsonParser
import com.wildstring.app.data.PodcastEpisode
import com.wildstring.app.data.PodcastSummary
import com.wildstring.app.data.Track
import com.wildstring.app.ui.MusicViewModel
import java.io.ByteArrayOutputStream
import java.io.File
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.AfterClass
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test

/**
 * The phone show-detail header after an episode joins the pending queue.
 * The queue entry point, the follow rule and the overflow action share one row;
 * adding an episode must not push any of them outside the visible width.
 */
class PodcastQueueDetailLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    companion object {
        private fun shell(command: String) {
            ParcelFileDescriptor.AutoCloseInputStream(
                InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
            ).use { it.readBytes() }
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
        instrumentation.uiAutomation.waitForIdle(1_000, 10_000)
        android.os.SystemClock.sleep(1_000)
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
        private val gson = Gson()
        @Volatile private var queue = """{"version":1,"device_id":"qa","items":[]}"""
        private val show = PodcastSummary(
            "show-0", "合成电台", author = "合成主播", feedUrl = "https://example.invalid/feed",
            coverUrl = "", description = "用于待播布局验证的节目简介。", followed = true,
            totalEpisodes = 3, unplayedEpisodes = 3,
        )
        private val episodes = (0..2).map {
            PodcastEpisode(
                "episode-$it", "show-0", "$it", "合成单集 ${it + 1}：一个足够长的标题用来检查换行与挤压",
                audioUrl = "https://example.invalid/$it.mp3", durationSeconds = 1800,
                pubDate = "2026-11-1${it + 1}T00:00:00Z",
            )
        }
        private val cover = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888).let { bitmap ->
            android.graphics.Canvas(bitmap).drawColor(Color.rgb(143, 91, 57))
            ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); bitmap.recycle() }.toByteArray()
        }

        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    requests += "${request.method} $path"
                    fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                    return when {
                        path.endsWith("/auth/status") -> json(
                            """{"configured":true,"authenticated":${request.getHeader("Cookie") != null},"user":{"id":"qa-user","username":"qa","profile":"listener"}}"""
                        )
                        path.endsWith("/auth/login") -> json("{}").setHeader("Set-Cookie", "wildstring_session=qa; Path=/; Max-Age=3600")
                        path == "/api/v1/podcasts" -> json(gson.toJson(listOf(show)))
                        path == "/api/v1/podcasts/show-0" -> json("""{"podcast":${gson.toJson(show)},"episodes":${gson.toJson(episodes)}}""")
                        path.startsWith("/api/v1/podcasts/episodes/") -> {
                            val episode = episodes.firstOrNull { it.id == path.substringAfterLast('/') }
                            if (episode == null) MockResponse().setResponseCode(404) else json(gson.toJson(episode))
                        }
                        path == "/api/v1/podcasts/show-0/cover" -> MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(cover))
                        path.endsWith("/podcasts/queue/preferences") -> json(
                            """{"version":1,"default_action":"queue_last","auto_limit":3,"auto_continue":true,"shows":{}}"""
                        )
                        path.endsWith("/podcasts/queue") -> if (request.method == "PUT") {
                            val body = JsonParser.parseString(request.body.readUtf8()).asJsonObject
                            val items = body.getAsJsonArray("items")
                            queue = """{"version":${body.get("version").asInt + 1},"device_id":"qa","items":$items}"""
                            json(queue)
                        } else json(queue)
                        path.endsWith("/catalog-settings") -> json("""{"can_add":false,"version":1}""")
                        path.endsWith("/favorites/ids") -> json("""{"ids":[]}""")
                        path.endsWith("/tracks") -> json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                        path.endsWith("/artists") -> json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                        path.endsWith("/albums") -> json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                        path.endsWith("/playlists") -> json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                        path.startsWith("/api/v1/agent/") -> json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
        }

        override fun close() = server.close()
    }

    @Test fun phoneShowDetailKeepsQueueControlsInsideTheHeader() {
        val vm = compose.runOnIdle { ViewModelProvider(activity())[MusicViewModel::class.java] }
        Fixture().use { fixture -> try {
            compose.runOnIdle { vm.settings.appearance("light"); vm.settings.orientation("auto") }
            window(390, 844)
            val address = fixture.server.url("/").toString()
            val login = compose.runOnIdle { vm.connect(address, "qa", "synthetic-password", true) }
            try {
                compose.waitUntil(60_000) { login.isCompleted && vm.state.value.connected && !vm.state.value.loading }
            } catch (error: Throwable) {
                throw AssertionError(
                    "login timeout: state=${vm.state.value} completed=${login.isCompleted} requests=${fixture.requests}",
                    error,
                )
            }
            compose.onNodeWithTag("nav-podcast").performClick()
            compose.waitUntil(30_000) { compose.onAllNodesWithTag("podcast-show-show-0").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("podcast-show-show-0").performClick()
            compose.waitUntil(30_000) { compose.onAllNodesWithTag("podcast-episodes").fetchSemanticsNodes().isNotEmpty() }
            compose.waitUntil(30_000) { vm.podcastBrowser.state.value.details["show-0"]?.episodes?.size == 3 }
            capture("phone-detail-before-queue")

            compose.onAllNodesWithText(uiString(R.string.podcast_queue_add)).onFirst().performClick()
            compose.waitUntil(30_000) { vm.podcastCloud.value.queue.size == 1 }
            compose.waitUntil(30_000) {
                compose.onAllNodesWithText(uiString(R.string.podcast_queue_added)).fetchSemanticsNodes().isNotEmpty()
            }
            compose.waitForIdle()
            capture("phone-detail-after-queue")
            appearance(vm, "dark")
            capture("phone-detail-after-queue-dark")

            val queueAction = compose.onNodeWithTag("podcast-detail-play-queue").fetchSemanticsNode().boundsInRoot
            val followMenu = compose.onNodeWithTag("podcast-follow-menu").fetchSemanticsNode().boundsInRoot
            val queuedChip = compose.onAllNodesWithText(uiString(R.string.podcast_queue_added)).onFirst().fetchSemanticsNode().boundsInRoot
            val screen = compose.onRoot().fetchSemanticsNode().boundsInRoot
            assertTrue("queue action must stay inside the phone width", queueAction.right <= screen.right + 0.5f)
            assertTrue("queue action must not be squeezed to nothing", queueAction.width > 60f)
            assertTrue("queue action must not overlap the follow rule", queueAction.right <= followMenu.left + 0.5f)
            assertTrue("queued chip must stay inside the phone width", queuedChip.right <= screen.right + 0.5f)
            assertTrue("queued chip keeps a standard action height", queuedChip.height <= 48.5f)

            compose.onAllNodesWithText(uiString(R.string.podcast_queue_added)).onFirst().performClick()
            compose.waitUntil(30_000) { vm.podcastCloud.value.queue.isEmpty() }
            compose.waitUntil(30_000) {
                compose.onAllNodesWithTag("podcast-detail-play-queue").fetchSemanticsNodes().isEmpty()
            }
            compose.onAllNodesWithText(uiString(R.string.podcast_queue_add)).onFirst().assertIsDisplayed()
        } finally {
            compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.appearance("system"); vm.settings.orientation("auto") }
        } }
    }
}
