package com.wildstring.app

import android.graphics.Bitmap
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import com.google.gson.Gson
import com.wildstring.app.data.*
import com.wildstring.app.ui.*
import java.io.ByteArrayOutputStream
import kotlin.math.abs
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import okio.Buffer
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/**
 * Switching between Cover and Article must move the reading area and the controls along one
 * continuous curve, and the screen must be still once it has landed.
 *
 * The tests step the Compose clock one frame at a time and measure the real layout and pixels, so
 * a second step shows up as numbers instead of depending on how the animation looks: a control row
 * dropping out when its exit animation ends, a container that trails the controls and drags the
 * content with it, or a row that re-spaces its buttons when a finished item is removed.
 */
class PodcastTabTransitionTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    /** The buttons of the bottom row that are on screen in both modes. */
    private val steadyButtons = listOf("podcast-rewind", "podcast-play-pause", "podcast-forward")

    /**
     * Edges of the reading area (the content slot), the control bar and the header, the left edge of
     * each [steadyButtons] entry, and how many pixels of the control bar changed since the last frame
     * (-1 while its size is changing).
     */
    private data class Frame(
        val time: Int, val top: Float, val bottom: Float, val controlsTop: Float, val headerBottom: Float,
        val buttonsLeft: List<Float>, val changedPixels: Int,
    )

    private fun bounds(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().firstOrNull()?.boundsInRoot

    private fun controlsImage(): Bitmap? = runCatching {
        val full = compose.onAllNodesWithTag("podcast-controls-full").fetchSemanticsNodes().isNotEmpty()
        compose.onNodeWithTag(if (full) "podcast-controls-full" else "podcast-controls-compact")
            .captureToImage().asAndroidBitmap().copy(Bitmap.Config.ARGB_8888, false)
    }.getOrNull()

    private fun changedPixels(before: Bitmap?, after: Bitmap?): Int {
        if (before == null || after == null || before.width != after.width || before.height != after.height) return -1
        val a = IntArray(after.width * after.height).also { after.getPixels(it, 0, after.width, 0, 0, after.width, after.height) }
        val b = IntArray(a.size).also { before.getPixels(it, 0, before.width, 0, 0, before.width, before.height) }
        return a.indices.count { a[it] != b[it] }
    }

    private fun record(frames: Int): List<Frame> = buildList {
        var previous: Bitmap? = null
        repeat(frames) { index ->
            compose.mainClock.advanceTimeByFrame()
            val slot = bounds("podcast-view-slot")
            val controls = bounds("podcast-controls-full") ?: bounds("podcast-controls-compact")
            val header = bounds("podcast-player-header")
            val buttons = steadyButtons.map { bounds(it)?.left }
            val image = controlsImage()
            if (slot != null && controls != null && header != null && buttons.all { it != null }) {
                add(Frame((index + 1) * 16, slot.top, slot.bottom, controls.top, header.bottom, buttons.map { it!! }, changedPixels(previous, image)))
            }
            previous = image
        }
    }

    private fun table(frames: List<Frame>) = frames.joinToString("\n") {
        "t=%3dms top=%7.1f bottom=%7.1f controlsTop=%7.1f headerBottom=%6.1f buttons=%s changedPx=%d".format(
            it.time, it.top, it.bottom, it.controlsTop, it.headerBottom, it.buttonsLeft.joinToString("/") { x -> "%.0f".format(x) }, it.changedPixels,
        )
    }

    /** One edge or button must move along one curve: no frame takes a big share, and the fastest frame is not the last. */
    private fun shapeProblems(name: String, edge: List<Float>, maxShare: Float): List<String> = buildList {
        val travel = abs(edge.last() - edge.first())
        if (travel < 10f) return@buildList
        val steps = edge.zipWithNext { a, b -> b - a }
        val biggest = steps.maxOf { abs(it) }
        if (biggest > travel * maxShare) add("The $name moved %.1f of %.1f px in one frame".format(biggest, travel))
        val moving = steps.indices.filter { abs(steps[it]) > 0.5f }
        if (moving.size >= 4) {
            val first = moving.first(); val last = moving.last()
            val peak = steps.indices.maxBy { abs(steps[it]) }
            if (peak > first + 0.65f * (last - first)) add("The $name moves fastest near the end of the switch (frame $peak of $first..$last)")
        }
    }

    /** Problems a viewer would notice in a switch that is meant to be one continuous movement. */
    private fun continuityProblems(frames: List<Frame>): List<String> = buildList {
        val travel = abs(frames.last().bottom - frames.first().bottom)
        if (travel <= 1f) add("The reading area must change height during the switch")
        // The reading area hangs from the header: its top edge never moves.
        val top = frames.map { it.top }
        if (top.max() - top.min() > 2f) add("The top edge drifted %.1f px; it must stay put".format(top.max() - top.min()))
        val header = frames.map { it.headerBottom }
        if (header.max() - header.min() > 1f) add("The header moved %.1f px".format(header.max() - header.min()))
        // The reading area and the control bar move as one: the gap between them is constant.
        val gap = frames.map { it.controlsTop - it.bottom }
        if (gap.max() - gap.min() > 2f) add("The reading area trails the controls by up to %.1f px".format(gap.max() - gap.min()))
        // One continuous movement, for the reading area, the control bar and each steady button.
        addAll(shapeProblems("bottom edge", frames.map { it.bottom }, 0.35f))
        addAll(shapeProblems("controls", frames.map { it.controlsTop }, 0.35f))
        steadyButtons.forEachIndexed { index, tag ->
            addAll(shapeProblems(tag.removePrefix("podcast-") + " button", frames.map { it.buttonsLeft[index] }, 0.30f))
        }
        // It lands within the designed 240 ms plus the 60 ms entry delay, and is then still: no flash.
        val late = frames.filter { it.time >= 320 }
        if (late.isNotEmpty() && late.maxOf { it.bottom } - late.minOf { it.bottom } > 1f) add("The reading area was still moving after 320 ms")
        val flashes = late.filter { it.changedPixels > 0 }
        if (flashes.isNotEmpty()) add("The controls still changed after landing: " + flashes.joinToString { "t=${it.time}ms ${it.changedPixels}px" })
    }

    private fun withPlayer(animations: Boolean, body: () -> Unit) {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val episode = PodcastEpisode(
            "transition-episode", "transition-show", "transition-guid", "把时间留给声音：一次长途旅行的记录",
            description = (1..35).joinToString("") { "<p>第 $it 段。在路上听见城市与远方的故事，慢慢整理沿途的观察。本期从日常生活出发，聊一聊声音、旅行，以及那些值得记住的片刻。</p>" },
            audioUrl = "https://example.invalid/synthetic.mp3", durationSeconds = 2345, pubDate = "2026-11-12",
        )
        val show = PodcastSummary("transition-show", "合成声音档案", feedUrl = "https://example.invalid/feed", author = "合成主播", followed = true)
        val track = episode.toTrack(show)
        MockWebServer().use { server ->
            val cover = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888).let { bitmap ->
                android.graphics.Canvas(bitmap).drawColor(android.graphics.Color.rgb(98, 110, 80))
                ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); bitmap.recycle() }.toByteArray()
            }
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when {
                    request.path?.contains("/episodes/transition-episode") == true -> MockResponse().setHeader("Content-Type", "application/json").setBody(Gson().toJson(episode))
                    request.path?.contains("/cover") == true -> MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(cover))
                    else -> MockResponse().setResponseCode(404)
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            val serverUrl = server.url("/").toString()
            compose.runOnIdle {
                vm.repository.session.configure(serverUrl, true)
                vm.repository.session.write("wildstring_session=transition; Path=/; Max-Age=3600")
                vm.repository.session.bindAccount(Account("transition-user", "transition-user"))
                vm.settings.bindAccount(vm.repository.session.activeServerId, "transition-user")
                vm.settings.interfaceAnimations(animations)
                vm.repository.rememberPlaybackTrack(track)
                compose.activity.setContent {
                    MaterialTheme(colorScheme = classicLightColors) {
                        Surface(Modifier.fillMaxSize()) {
                            BoxWithConstraints(Modifier.fillMaxSize()) {
                                PodcastPlayerScreen(vm, MusicState(current = track, duration = track.durationMs), wide = maxWidth >= 840.dp, dragEnabled = true,
                                    onBack = {}, onDismiss = {}, onDragOffset = { _, _ -> }, onQueue = {}, onSleep = {})
                            }
                        }
                    }
                }
            }
            try {
                compose.waitUntil(10_000) { runBlocking { vm.repository.cachedPodcastEpisode(episode.id) } != null }
                body()
            } finally {
                compose.mainClock.autoAdvance = true
                compose.runOnIdle { vm.settings.interfaceAnimations(true); vm.repository.session.invalidate() }
            }
        }
    }

    private fun switchTo(tab: String, frames: Int): List<Frame> {
        compose.mainClock.autoAdvance = false
        compose.onNodeWithTag(tab).performClick()
        val recorded = record(frames)
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        return recorded
    }

    @Test fun coverToArticleMovesAsOneContinuousCurve() = withPlayer(animations = true) {
        compose.onNodeWithTag("podcast-cover-tab").performClick()
        compose.onNodeWithTag("podcast-controls-full").assertIsDisplayed()
        compose.waitForIdle()
        val frames = switchTo("podcast-article-tab", 45)
        assertTrue("The reading area never appeared", frames.size > 15)
        val problems = continuityProblems(frames)
        assertTrue(problems.joinToString("\n") + "\n" + table(frames), problems.isEmpty())
    }

    @Test fun articleToCoverMovesAsOneContinuousCurve() = withPlayer(animations = true) {
        compose.onNodeWithTag("podcast-article-tab").performClick()
        compose.onNodeWithTag("podcast-controls-compact").assertIsDisplayed()
        compose.waitForIdle()
        val frames = switchTo("podcast-cover-tab", 45)
        assertTrue("The cover never appeared", frames.size > 15)
        val problems = continuityProblems(frames)
        assertTrue(problems.joinToString("\n") + "\n" + table(frames), problems.isEmpty())
    }

    @Test fun switchingWithAnimationsOffLandsImmediately() = withPlayer(animations = false) {
        compose.onNodeWithTag("podcast-cover-tab").performClick()
        compose.onNodeWithTag("podcast-controls-full").assertIsDisplayed()
        compose.waitForIdle()
        val frames = switchTo("podcast-article-tab", 12)
        val final = frames.last()
        val intermediate = frames.drop(3).filter { abs(it.bottom - final.bottom) > 1f || abs(it.top - final.top) > 1f }
        assertTrue("With animations off the layout must land at once\n" + table(frames), intermediate.isEmpty())
    }

    @Test fun wideWindowShowsCoverArticleAndFullControlsTogether() = withPlayer(animations = true) {
        val width = compose.activity.resources.displayMetrics.run { widthPixels / density }
        assumeTrue("Needs a window of at least 840dp; this one is %.0fdp".format(width), width >= 840f)
        compose.waitForIdle()
        compose.onNodeWithTag("podcast-article-surface").assertIsDisplayed()
        compose.onNodeWithTag("podcast-controls-full").assertIsDisplayed()
        compose.onNodeWithTag("podcast-cover-tab").assertDoesNotExist()
        compose.onNodeWithTag("podcast-view-slot").assertDoesNotExist()
        val article = compose.onNodeWithTag("podcast-article-surface").fetchSemanticsNode().boundsInRoot
        val controls = compose.onNodeWithTag("podcast-controls-full").fetchSemanticsNode().boundsInRoot
        assertTrue("The controls must sit beside the article, not under it", controls.right <= article.left + 1f)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        directory.mkdirs()
        val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(directory, "podcast-wide.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }
}
