package com.wildstring.app

import android.graphics.Bitmap
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.Gson
import com.wildstring.app.data.*
import com.wildstring.app.ui.*
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import okio.Buffer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Renders the actual player with a disposable RSS response; no personal media is used. */
class PodcastPlayerLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        directory.mkdirs()
        val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(directory, "$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }

    @Test fun phoneModesKeepMarginsReadingPositionAndControlsWithMotionOnOrOff() {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val episode = PodcastEpisode(
            "layout-episode", "layout-show", "layout-guid", "把时间留给声音：一次长途旅行的记录",
            description = (1..35).joinToString("") { "<p>第 $it 段。在路上听见城市与远方的故事，慢慢整理沿途的观察。本期从日常生活出发，聊一聊声音、旅行，以及那些值得记住的片刻。</p>" },
            audioUrl = "https://example.invalid/synthetic.mp3", durationSeconds = 2345, pubDate = "2026-11-12",
        )
        val show = PodcastSummary("layout-show", "合成声音档案", feedUrl = "https://example.invalid/feed", author = "合成主播", followed = true)
        val track = episode.toTrack(show)
        val dark = mutableStateOf(false)
        val rules = mutableStateOf(false)
        val preference = mutableStateOf(PodcastShowQueuePreference(action = "queue_next"))
        MockWebServer().use { server ->
            val cover = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888).let { bitmap ->
                val canvas = android.graphics.Canvas(bitmap)
                canvas.drawColor(android.graphics.Color.rgb(98, 110, 80))
                val paint = android.graphics.Paint().apply { color = android.graphics.Color.rgb(235, 222, 194) }
                canvas.drawCircle(64f, 64f, 34f, paint)
                ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); bitmap.recycle() }.toByteArray()
            }
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when {
                    request.path?.contains("/episodes/layout-episode") == true -> MockResponse().setHeader("Content-Type", "application/json").setBody(Gson().toJson(episode))
                    request.path?.contains("/cover") == true -> MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(cover))
                    else -> MockResponse().setResponseCode(404)
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            val serverUrl = server.url("/").toString()
            compose.runOnIdle {
                vm.repository.session.configure(serverUrl, true)
                vm.repository.session.write("wildstring_session=layout; Path=/; Max-Age=3600")
                vm.repository.session.bindAccount(Account("layout-user", "layout-user"))
                vm.settings.bindAccount(vm.repository.session.activeServerId, "layout-user")
                vm.settings.interfaceAnimations(true)
                vm.repository.rememberPlaybackTrack(track)
                compose.activity.setContent {
                    CompositionLocalProvider(LocalDarkAppearance provides dark.value) {
                        MaterialTheme(colorScheme = if (dark.value) classicDarkColors else classicLightColors) {
                            Surface(Modifier.fillMaxSize()) {
                                if (rules.value) Column(Modifier.safeDrawingPadding()) {
                                    PodcastFollowedMenu(preference.value, false, null,
                                        { action, _ -> preference.value = preference.value.copy(action = action) }, {}, {}, {})
                                } else BoxWithConstraints(Modifier.fillMaxSize()) {
                                    PodcastPlayerScreen(vm, MusicState(current = track, duration = track.durationMs), wide = maxWidth >= 840.dp, dragEnabled = true,
                                        onBack = {}, onDismiss = {}, onDragOffset = { _, _ -> }, onQueue = {}, onSleep = {})
                                }
                            }
                        }
                    }
                }
            }
            try {
                compose.waitUntil(10_000) { runBlocking { vm.repository.cachedPodcastEpisode(episode.id) } != null }
                for (theme in listOf(false, true)) {
                    compose.runOnIdle { dark.value = theme }
                    val suffix = if (theme) "dark" else "light"
                    compose.onNodeWithTag("podcast-cover-tab").performClick()
                    compose.onNodeWithTag("podcast-controls-full").assertIsDisplayed()
                    capture("podcast-cover-$suffix")
                    compose.onNodeWithTag("podcast-article-tab").performClick()
                    compose.onNodeWithTag("podcast-controls-compact").assertIsDisplayed()
                    val root = compose.onNodeWithTag("podcast-player").fetchSemanticsNode().boundsInRoot
                    val article = compose.onNodeWithTag("podcast-article-surface").fetchSemanticsNode().boundsInRoot
                    assertTrue("Reading surface must retain page margins", article.left > root.left && article.right < root.right)
                    capture("podcast-article-$suffix")
                    compose.onNodeWithTag("podcast-article").performTouchInput { swipeUp() }
                    val scroll = compose.onNodeWithTag("podcast-article").fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
                    assertTrue(scroll > 0f)
                    compose.onNodeWithTag("podcast-cover-tab").performClick()
                    compose.onNodeWithTag("podcast-article-tab").performClick()
                    val restored = compose.onNodeWithTag("podcast-article").fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
                    assertEquals(scroll, restored, 1f)
                }
                compose.runOnIdle { vm.settings.interfaceAnimations(false) }
                compose.onNodeWithTag("podcast-cover-tab").performClick()
                compose.onNodeWithTag("podcast-controls-full").assertIsDisplayed()
                compose.onNodeWithTag("podcast-article-tab").performClick()
                compose.onNodeWithTag("podcast-controls-compact").assertIsDisplayed()
                for (theme in listOf(false, true)) {
                    compose.runOnIdle { dark.value = theme; rules.value = true }
                    val suffix = if (theme) "dark" else "light"
                    capture("podcast-rules-collapsed-$suffix")
                    compose.onNodeWithTag("podcast-follow-menu").performClick()
                    compose.onNodeWithTag("podcast-follow-options").assertIsDisplayed()
                    capture("podcast-rules-expanded-$suffix")
                    compose.onNodeWithTag("podcast-follow-option-queue_last").performClick()
                    compose.onNodeWithTag("podcast-follow-options").assertDoesNotExist()
                }
            } finally {
                compose.runOnIdle { vm.settings.interfaceAnimations(true); vm.repository.session.invalidate() }
            }
        }
    }
}
