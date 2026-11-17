package com.wildstring.app

import android.animation.ValueAnimator
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.provider.Settings
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.Gson
import com.wildstring.app.data.*
import com.wildstring.app.ui.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import okio.Buffer
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName

/** Real presentation components, controlled states and an isolated synthetic feed. */
class PodcastPresentationTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @get:Rule val caseName = TestName()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val directory get() = (InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
        ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))).also { it.mkdirs() }
    private fun label(id: Int) = AppLanguage.string(id)
    private fun bounds(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot
    private fun capture(name: String) {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
    private fun shell(command: String) = ParcelFileDescriptor.AutoCloseInputStream(
        instrumentation.uiAutomation.executeShellCommand(command),
    ).use { it.readBytes().toString(Charsets.UTF_8).trim() }
    private var originalScale = "1.0"
    private fun systemAnimations(scale: String) {
        shell("settings put global animator_duration_scale $scale")
        val target = scale.toFloat()
        compose.waitUntil(5_000) {
            abs(Settings.Global.getFloat(compose.activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, -1f) - target) < .01f &&
                ValueAnimator.areAnimatorsEnabled() == (target > 0)
        }
    }
    @Before fun enableSystemAnimations() {
        originalScale = Settings.Global.getString(compose.activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE) ?: "1.0"
        systemAnimations("1.0")
    }
    @After fun restoreSystemAnimations() = systemAnimations(originalScale)

    private inner class Fixture : AutoCloseable {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val show = PodcastSummary("presentation-show", "合成声音档案", author = "合成主播", feedUrl = "https://example.invalid/feed", followed = true)
        val episode = PodcastEpisode("presentation-episode", show.id, "presentation-guid",
            "517 关陇集团是如何炼成的：「八柱国」与西魏北周政权的崛起，以及长标题的布局验证",
            description = "<p>合成文章。</p>", audioUrl = "https://example.invalid/audio.mp3", durationSeconds = 5219,
            pubDate = "2026-10-10T00:00:00Z", positionSeconds = 1, resourcePlaybackCached = true)
        val state = mutableStateOf(MusicState(current = episode.toTrack(show), duration = 5_219_000))
        val dark = mutableStateOf(false)
        val fontScale = mutableFloatStateOf(1f)
        val rows = mutableStateOf(false)
        val action = mutableIntStateOf(0)
        val completed = mutableStateOf(false)
        @Volatile var articleStatus = 200
        @Volatile var articleDelay = 0L
        @Volatile var description = episode.description
        val server = MockWebServer()
        init {
            val cover = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888).let {
                val canvas = android.graphics.Canvas(it)
                canvas.drawColor(android.graphics.Color.rgb(98, 110, 80))
                val paint = android.graphics.Paint().apply { color = android.graphics.Color.rgb(235, 222, 194) }
                canvas.drawCircle(64f, 64f, 36f, paint)
                ByteArrayOutputStream().also { out -> it.compress(Bitmap.CompressFormat.PNG, 100, out); it.recycle() }.toByteArray()
            }
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when {
                    request.path?.contains("/cover") == true -> MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(cover))
                    request.path?.contains("/episodes/") == true -> MockResponse().setResponseCode(articleStatus)
                        .setHeader("Content-Type", "application/json").setHeadersDelay(articleDelay, TimeUnit.MILLISECONDS)
                        .setBody(if (articleStatus == 200) Gson().toJson(episode.copy(id = request.requestUrl!!.pathSegments.last(), description = description)) else """{"detail":"synthetic article failure"}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            val serverUrl = server.url("/").toString()
            compose.runOnIdle {
                vm.repository.session.configure(serverUrl, true)
                vm.repository.session.write("wildstring_session=presentation; Path=/; Max-Age=3600")
                vm.repository.session.bindAccount(Account("presentation-user", "presentation-user"))
                vm.settings.bindAccount(vm.repository.session.activeServerId, "presentation-user")
                vm.settings.interfaceAnimations(true)
                vm.repository.rememberPlaybackTrack(state.value.current!!)
                compose.activity.setContent {
                    val density = LocalDensity.current
                    CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale.floatValue), LocalDarkAppearance provides dark.value) {
                        MaterialTheme(colorScheme = if (dark.value) classicDarkColors else classicLightColors) {
                            Surface(Modifier.fillMaxSize()) {
                                if (rows.value) Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                                    Column(Modifier.align(Alignment.TopCenter).widthIn(max = 760.dp).fillMaxWidth()) {
                                        EpisodeRowItem(episode.copy(completed = completed.value), isQueued = action.intValue == 1,
                                            isActive = action.intValue == 2, isFavorite = true,
                                            onPlay = { action.intValue = 2 }, onRestart = {}, onPlayNext = {},
                                            onAddToQueue = { action.intValue = 1 }, onRemoveFromQueue = { action.intValue = 0 }, onSave = {})
                                        EpisodeRowItem(episode.copy(id = "following-episode", title = "下一集：状态切换不应推动这张卡片"),
                                            onPlay = {}, onRestart = {}, onPlayNext = {}, onAddToQueue = {}, onSave = {})
                                    }
                                } else BoxWithConstraints(Modifier.fillMaxSize()) {
                                    PodcastPlayerScreen(vm, state.value, wide = maxWidth >= 840.dp, dragEnabled = true,
                                        onBack = { rows.value = true }, onDismiss = { rows.value = true }, onDragOffset = { _, _ -> }, onQueue = {}, onSleep = {})
                                }
                            }
                        }
                    }
                }
            }
        }
        override fun close() {
            compose.mainClock.autoAdvance = true
            compose.runOnIdle { vm.settings.interfaceAnimations(true); vm.repository.session.invalidate() }
            server.close()
        }
    }

    @Test fun artworkUsesAvailableHeightAndBalancesTheTitleGroup(): Unit = Fixture().use { f ->
        compose.waitUntil(10_000) { runBlocking { f.vm.repository.cachedPodcastEpisode(f.episode.id) } != null }
        for (dark in listOf(false, true)) for (scale in listOf(1f, 1.3f)) {
            compose.runOnIdle { f.dark.value = dark; f.fontScale.floatValue = scale }
            compose.waitForIdle()
            val density = compose.activity.resources.displayMetrics.density
            val cover = compose.onNodeWithContentDescription(f.show.title, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            val title = bounds("podcast-player-title")
            val show = bounds("podcast-player-show")
            val slot = bounds("podcast-cover-slot")
            val availableHeight = slot.height - (show.bottom - title.top) - (18 + 16) * density
            val expected = minOf(slot.width, 400 * density, availableHeight)
            assertEquals("artwork must use the room left by the measured text", expected, cover.width, 4 * density)
            assertEquals("artwork remains square", cover.width, cover.height, 1f)
            assertTrue("title remains below artwork", title.top >= cover.bottom)
            assertTrue("group is vertically balanced", abs((cover.top + show.bottom) / 2 - slot.center.y) < 5 * density)
            val duration = compose.onNodeWithText("1:26:59").fetchSemanticsNode().boundsInRoot
            assertTrue("duration must not overlap the more button", duration.left >= bounds("podcast-controls-more").right)
            capture("presentation-cover-${if (dark) "dark" else "light"}-font-$scale")
        }
        compose.runOnIdle { f.state.value = f.state.value.copy(playbackError = "音源暂时无法加载，请检查网络后重试。") }
        compose.onNodeWithText(label(R.string.pod_player_retry)).assertIsDisplayed()
        compose.onNodeWithTag("podcast-play-pause").assertIsDisplayed()
        capture("presentation-cover-playback-error")
    }

    @Test fun queueStatesKeepCardAndFollowingCardInPlace(): Unit = Fixture().use { f ->
        compose.runOnIdle { f.rows.value = true }
        for (dark in listOf(false, true)) for (scale in listOf(1f, 1.3f)) {
            compose.runOnIdle { f.dark.value = dark; f.fontScale.floatValue = scale; f.action.intValue = 0 }
            compose.waitForIdle()
            val rowEdges = mutableListOf<Rect>()
            val followingEdges = mutableListOf<Rect>()
            for (action in 0..2) {
                if (action == 1) compose.onAllNodesWithText(label(R.string.podcast_queue_add)).onFirst().performClick()
                if (action == 2) compose.onAllNodesWithContentDescription(label(R.string.pod_scr_play_episode_desc)).onFirst().performClick()
                compose.waitForIdle()
                rowEdges += bounds("podcast-episode-${f.episode.id}")
                followingEdges += bounds("podcast-episode-following-episode")
                if (scale == 1f) capture("presentation-row-${if (dark) "dark" else "light"}-$action")
            }
            val problems = MotionAssertions.staysPut("episode bottom", rowEdges.map { it.bottom }) +
                MotionAssertions.staysPut("following episode top", followingEdges.map { it.top })
            assertTrue(problems.joinToString("\n") + "\n$rowEdges", problems.isEmpty())
            compose.onNodeWithText(label(R.string.podcast_playing)).assertIsNotEnabled()
            compose.runOnIdle { f.action.intValue = 1 }
            compose.onNodeWithText(label(R.string.podcast_queue_added)).performClick()
            assertEquals(0, f.action.intValue)
        }
        compose.runOnIdle { f.completed.value = true }
        compose.onNodeWithTag("podcast-episode-progress-${f.episode.id}").assertDoesNotExist()
        capture("presentation-row-completed")
    }

    private data class IconFrame(val time: Int, val bounds: Rect, val hash: Int, val changed: Int)
    private fun transition(f: Fixture, from: MusicState, to: MusicState): List<IconFrame> {
        compose.runOnIdle { f.state.value = from }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        var previous: IntArray? = null
        compose.runOnIdle { f.state.value = to }
        val frames = (1..28).map { index ->
            compose.mainClock.advanceTimeByFrame()
            val node = compose.onNodeWithTag("podcast-play-pause")
            val bitmap = node.captureToImage().asAndroidBitmap()
            // Only the opaque centre of the button: backdrop artwork loading is unrelated to icon motion.
            val side = minOf(bitmap.width, bitmap.height) / 2
            val pixels = IntArray(side * side).also { bitmap.getPixels(it, 0, side, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side) }
            val changed = previous?.let { old -> pixels.indices.count { pixels[it] != old[it] } } ?: -1
            previous = pixels
            IconFrame(index * 16, node.fetchSemanticsNode().boundsInRoot, pixels.contentHashCode(), changed)
        }
        compose.mainClock.autoAdvance = true
        File(directory, "${caseName.methodName}-frames-${from.playing}-${from.buffering}-${to.playing}.json").writeText(Gson().toJson(frames))
        return frames
    }
    private fun assertAnimated(frames: List<IconFrame>) {
        assertTrue("icon must pass through intermediate frames: $frames", frames.map { it.hash }.distinct().size >= 5)
        val problems = MotionAssertions.staysPut("button left", frames.map { it.bounds.left }) +
            MotionAssertions.staysPut("button bottom", frames.map { it.bounds.bottom }) +
            MotionAssertions.landsAndStays("transport icon", frames.map { it.time }, frames.map { it.bounds.top }, frames.map { it.changed })
        assertTrue(problems.joinToString("\n"), problems.isEmpty())
    }
    @Test fun bufferingToPlaybackHasAContinuousTransition(): Unit = Fixture().use { f ->
        assertAnimated(transition(f, f.state.value.copy(buffering = true), f.state.value.copy(playing = true)))
    }
    @Test fun playAndPauseHaveAContinuousTransition(): Unit = Fixture().use { f ->
        val paused = f.state.value
        val playing = paused.copy(playing = true)
        assertAnimated(transition(f, paused, playing))
        compose.onNodeWithTag("podcast-play-pause").assertContentDescriptionEquals(label(R.string.pod_player_pause))
        assertAnimated(transition(f, playing, paused))
        compose.onNodeWithTag("podcast-play-pause").assertContentDescriptionEquals(label(R.string.pod_player_play))
    }
    @Test fun appReducedMotionLandsImmediately(): Unit = Fixture().use { f ->
        compose.runOnIdle { f.vm.settings.interfaceAnimations(false) }
        val buffering = f.state.value.copy(buffering = true)
        val stillLoading = transition(f, buffering, buffering)
        assertEquals("loading indicator must also respect app reduced motion", 1, stillLoading.map { it.hash }.distinct().size)
        val frames = transition(f, f.state.value.copy(buffering = true), f.state.value.copy(playing = true, buffering = false))
        assertEquals("reduced motion must land in the first frame", 1, frames.map { it.hash }.distinct().size)
    }
    @Test fun systemReducedMotionLandsImmediately() {
        val old = Settings.Global.getString(compose.activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE) ?: "1.0"
        try {
            systemAnimations("0")
            Fixture().use { f ->
                val frames = transition(f, f.state.value.copy(buffering = true), f.state.value.copy(playing = true))
                assertEquals("system reduced motion must land in the first frame", 1, frames.map { it.hash }.distinct().size)
            }
        } finally { systemAnimations(old) }
    }

    // The same fixture is also used for article boundaries; each ID bypasses the previous cached article.
    @Test fun articleEmptyLoadingErrorAndPermissionStatesRemainUsable(): Unit = Fixture().use { f ->
        for (dark in listOf(false, true)) {
            compose.runOnIdle { f.dark.value = dark }
            for (status in listOf(200, 500, 403)) {
                f.articleStatus = status; f.description = ""; f.articleDelay = if (status == 200) 2000 else 0
                val id = "article-$dark-$status"
                compose.runOnIdle { f.state.value = f.state.value.copy(current = f.episode.copy(id = id).toTrack(f.show)) }
                val tabs = compose.onAllNodesWithTag("podcast-article-tab").fetchSemanticsNodes()
                if (tabs.isNotEmpty()) compose.onNodeWithTag("podcast-article-tab").performClick()
                if (status == 200) {
                    compose.onNodeWithText(label(R.string.pod_player_loading_article)).assertIsDisplayed()
                    capture("presentation-article-loading-$dark")
                    compose.waitUntil(10_000) { compose.onAllNodesWithText(label(R.string.pod_player_no_article)).fetchSemanticsNodes().isNotEmpty() }
                } else compose.waitUntil(10_000) { compose.onAllNodesWithText(label(R.string.pod_player_reload)).fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("podcast-play-pause").assertIsDisplayed()
                capture("presentation-article-$status-$dark")
                if (tabs.isNotEmpty()) compose.onNodeWithTag("podcast-cover-tab").performClick()
            }
        }
        compose.onNodeWithTag("podcast-back").performClick()
        compose.onNodeWithTag("podcast-episode-${f.episode.id}").assertIsDisplayed()
    }
}
