package com.wildstring.app

import android.graphics.Bitmap
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.Gson
import com.wildstring.app.data.*
import com.wildstring.app.ui.*
import java.io.File
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PodcastGainTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        directory.mkdirs()
        val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(directory, "$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }

    @Test fun gainWorksInBothModesAndFollowsTheShowWithOfflineArticleErrors() {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val episode = PodcastEpisode("gain-one", "gain-show", "guid", "安静的节目：长标题与本地音量补偿", audioUrl = "https://example.invalid/audio.mp3", durationSeconds = 120)
        val show = PodcastSummary("gain-show", "合成声音档案：把时间留给声音与日常生活", feedUrl = "https://example.invalid/feed")
        val current = mutableStateOf(episode.toTrack(show))
        val dark = mutableStateOf(false)
        var wide = false
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = if (request.path?.contains("/episodes/gain-one") == true)
                    MockResponse().setHeader("Content-Type", "application/json").setBody(Gson().toJson(episode))
                else MockResponse().setResponseCode(503)
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            val serverUrl = server.url("/").toString()
            compose.runOnIdle {
                vm.repository.session.configure(serverUrl, true)
                vm.repository.session.write("wildstring_session=fixture; Path=/; Max-Age=3600")
                vm.repository.session.bindAccount(Account("gain-listener", "gain-listener", "listener"))
                vm.settings.bindAccount(vm.repository.session.activeServerId, "gain-listener")
                vm.settings.interfaceAnimations(false)
                vm.settings.podcastGainDb(show.id, 0)
                compose.activity.setContent {
                    CompositionLocalProvider(LocalDarkAppearance provides dark.value) {
                        MaterialTheme(colorScheme = if (dark.value) classicDarkColors else classicLightColors) {
                            Surface(Modifier.fillMaxSize()) {
                                BoxWithConstraints(Modifier.fillMaxSize()) {
                                    wide = maxWidth >= 840.dp
                                    PodcastPlayerScreen(vm, MusicState(current = current.value, duration = 120_000), wide, false,
                                        {}, {}, { _, _ -> }, {}, {})
                                }
                            }
                        }
                    }
                }
            }
            fun openGain() {
                compose.onNodeWithTag("podcast-controls-more").performClick()
                compose.onNodeWithText(uiString(R.string.podcast_gain_title)).performClick()
                compose.onNodeWithTag("podcast-gain-slider").assertIsDisplayed()
            }
            fun closeGain() { compose.onNodeWithText(uiString(R.string.done)).performClick() }
            fun setGain(db: Float) { compose.onNodeWithTag("podcast-gain-slider").performSemanticsAction(SemanticsActions.SetProgress) { it(db) } }
            try {
                for (theme in listOf(false, true)) {
                    compose.runOnIdle { dark.value = theme }
                    val suffix = "${if (wide) "wide" else "phone"}-${if (theme) "dark" else "light"}"
                    capture("podcast-gain-player-$suffix")
                    openGain()
                    setGain(6f)
                    assertEquals(6, vm.settings.podcastGainDb(show.id))
                    compose.onNodeWithText("+6 dB").assertIsDisplayed()
                    capture("podcast-gain-dialog-$suffix")
                    closeGain()
                    if (!wide) compose.onNodeWithTag("podcast-article-tab").performClick()
                    openGain()
                    compose.onNodeWithText("+6 dB").assertIsDisplayed()
                    compose.onNodeWithText(uiString(R.string.gain_panel_reset)).performClick()
                    compose.onNodeWithText("0 dB").assertIsDisplayed()
                    setGain(9f)
                    closeGain()
                    if (!wide) compose.onNodeWithTag("podcast-cover-tab").performClick()
                }
                compose.runOnIdle { current.value = episode.copy(id = "gain-two").toTrack(show) }
                openGain()
                compose.onNodeWithText("+9 dB").assertIsDisplayed()
                closeGain()
                compose.runOnIdle { current.value = episode.copy(id = "gain-other", podcastId = "other-show").toTrack(show.copy(id = "other-show")) }
                openGain()
                compose.onNodeWithText("0 dB").assertIsDisplayed()
                setGain(3f)
                closeGain()
                compose.runOnIdle { current.value = episode.toTrack(show) }
                openGain()
                compose.onNodeWithText("+9 dB").assertIsDisplayed()
                closeGain()
                assertEquals(3, vm.settings.podcastGainDb("other-show"))
            } finally {
                compose.runOnIdle { vm.repository.session.invalidate() }
            }
        }
    }
}
