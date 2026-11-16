package com.wildstring.app

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.Gson
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Render real destinations and controls with a disposable account and server. */
class PodcastResumeUiTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
        val output = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        output.mkdirs()
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Test fun showMenuResumeDialogAccountChoicesAndConflictTakeoverRenderInBothThemes() {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val show = PodcastSummary("resume-ui-show", "把时间留给声音与日常生活", feedUrl = "https://example.invalid/feed", followed = true)
        val episode = PodcastEpisode("resume-ui-episode", show.id, "guid", "一段很长的单集标题：从日常声音中找回自己的节奏", audioUrl = "https://example.invalid/audio.mp3", durationSeconds = 12, positionSeconds = 3)
        val mode = AtomicReference("auto")
        val conflict = AtomicBoolean(false)
        val current = AtomicReference("""{"episode_id":"${episode.id}","position_seconds":3,"duration_seconds":12,"completed":false,"version":0,"device_id":"","session_id":"","sequence":0}""")
        val audio = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.mp3").use { it.readBytes() }
        MockWebServer().use { server ->
            fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    if (path.endsWith("/auth/status")) return json("""{"configured":true,"authenticated":${request.getHeader("Cookie") != null},"user":{"id":"resume-ui","username":"resume-ui","profile":"listener"}}""")
                    if (path.endsWith("/auth/login")) return json("{}").setHeader("Set-Cookie", "wildstring_session=resume-ui; Path=/; Max-Age=3600")
                    if (path.endsWith("/resume-mode")) {
                        if (request.method == "PUT") mode.set(JsonParser.parseString(request.body.readUtf8()).asJsonObject.get("resume_mode").asString)
                        return json("""{"resume_mode":"${mode.get()}"}""")
                    }
                    if (path.endsWith("/queue/preferences")) return json(Gson().toJson(PodcastQueuePreferences(autoContinue = false)))
                    if (path.endsWith("/podcasts/queue")) return json("""{"version":0,"items":[]}""")
                    if (path.endsWith("/podcasts/${show.id}")) return json(Gson().toJson(PodcastDetail(show, listOf(episode))))
                    if (path.endsWith("/podcasts")) return json(Gson().toJson(listOf(show)))
                    if (path.endsWith("/episodes/${episode.id}")) return json(Gson().toJson(episode))
                    if (path.endsWith("/stream")) return audioStreamFixture(request, audio, "audio/mpeg", "\"resume-ui\"")
                    if (path.endsWith("/progress")) {
                        if (request.method == "GET") return json(current.get())
                        if (conflict.get()) {
                            current.set("""{"episode_id":"${episode.id}","position_seconds":6,"duration_seconds":12,"completed":false,"version":9,"device_id":"another-device","session_id":"another-session","sequence":1}""")
                            return json("""{"detail":{"current":${current.get()}}}""", 409)
                        }
                        val update = JsonParser.parseString(request.body.readUtf8()).asJsonObject
                        val remote = JsonParser.parseString(current.get()).asJsonObject
                        if (update.get("base_version") != remote.get("version") && update.get("session_id") != remote.get("session_id")) {
                            return json("""{"detail":{"current":${current.get()}}}""", 409)
                        }
                        update.addProperty("episode_id", episode.id); update.addProperty("version", remote.get("version").asInt + 1); update.addProperty("completed", update.get("event")?.asString == "ended")
                        current.set(update.toString())
                        return json(current.get())
                    }
                    if (path.endsWith("/albums") || path.endsWith("/tracks") || path.endsWith("/playlists")) return json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                    if (path.endsWith("/lyrics")) return json("""{"kind":"none","lines":[]}""")
                    return MockResponse().setResponseCode(404)
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            val address = server.url("/").toString()
            val login = compose.runOnIdle { vm.settings.interfaceAnimations(false); vm.connect(address, "resume-ui", "synthetic-password", true) }
            compose.waitUntil(15_000) { login.isCompleted && vm.state.value.connected && !vm.state.value.loading }
            compose.waitUntil(10_000) { vm.controller != null }
            compose.runOnIdle { vm.settings.interfaceAnimations(false) }
            for (theme in listOf("light", "dark")) {
                compose.runOnIdle { vm.settings.appearance(theme); vm.openPodcast(show.id) }
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("podcast-episode-${episode.id}").fetchSemanticsNodes().isNotEmpty() }
                val width = compose.activity.resources.configuration.screenWidthDp
                val suffix = "${if (width >= 600) "pad" else "phone"}-$theme"
                capture("podcast-resume-show-$suffix")
                compose.onNodeWithTag("podcast-episode-actions-${episode.id}").performClick()
                compose.onNodeWithText(uiString(R.string.podcast_resume_restart)).assertIsDisplayed()
                capture("podcast-resume-menu-$suffix")
                compose.onNodeWithText(uiString(R.string.podcast_resume_restart)).performClick()
                compose.waitUntil(10_000) { vm.state.value.playing }
                compose.runOnIdle { vm.controller!!.pause() }
                compose.runOnIdle { vm.navigate("search") }
                compose.onNodeWithContentDescription(uiString(R.string.settings_title)).performClick()
                compose.onNodeWithTag("setting-category-podcast").performScrollTo().performClick()
                val tag = uiString(R.string.settings_podcast_resume)
                compose.onNodeWithTag("setting-$tag").performScrollTo().performClick()
                capture("podcast-resume-settings-$suffix")
                compose.onNodeWithTag("setting-option-$tag-ask").performClick()
                compose.waitUntil(5000) { vm.podcastProgress.mode.value == "ask" }
                repeat(2) {
                    if (compose.onAllNodesWithTag("settings-back").fetchSemanticsNodes().isNotEmpty()) compose.onNodeWithTag("settings-back").performClick()
                }
                val remoteVersion = JsonParser.parseString(current.get()).asJsonObject.get("version").asInt + 100
                current.set("""{"episode_id":"${episode.id}","position_seconds":3,"duration_seconds":12,"completed":false,"version":$remoteVersion,"device_id":"another-device","session_id":"another-session","sequence":1}""")
                compose.runOnIdle { vm.playPodcastEpisode(episode, show) }
                compose.waitUntil(10_000) { vm.podcastProgress.prompt.value != null }
                capture("podcast-resume-ask-$suffix")
                compose.onNodeWithText(uiString(R.string.pod_scr_continue_listening), useUnmergedTree = true).performClick()
                compose.waitUntil(10_000) { vm.state.value.playing }
                compose.onNodeWithTag("mini-player-open").performClick()
                conflict.set(true)
                compose.runOnIdle { vm.podcastProgress.checkpoint(episode.id, 4000, 12000, "seek", true) }
                compose.waitUntil(5000) { vm.podcastProgress.conflict.value }
                compose.runOnIdle { vm.controller!!.pause() }
                compose.onNodeWithText(uiString(R.string.podcast_use_local_progress)).assertIsDisplayed()
                capture("podcast-resume-conflict-$suffix")
                conflict.set(false)
                compose.onNodeWithText(uiString(R.string.podcast_use_local_progress)).performClick()
                compose.waitUntil(5000) { !vm.podcastProgress.conflict.value }
                compose.onNodeWithText(uiString(R.string.podcast_use_local_progress)).assertDoesNotExist()
                capture("podcast-resume-takeover-$suffix")
                compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
                assertEquals("ask", mode.get())
                // Back on the show page with the player closed: a completed episode's menu offers
                // "mark unplayed", and a progress notice is reported as the page's snackbar.
                compose.runOnIdle { vm.openPodcast(show.id) }
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("podcast-episode-actions-${episode.id}").fetchSemanticsNodes().isNotEmpty() }
                compose.runOnIdle { vm.markPodcastEpisodeCompleted(episode.id, true) }
                compose.waitUntil(10_000) { JsonParser.parseString(current.get()).asJsonObject.get("completed").asBoolean }
                compose.onNodeWithTag("podcast-episode-actions-${episode.id}").performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithText(uiString(R.string.podcast_mark_unplayed)).fetchSemanticsNodes().isNotEmpty() }
                capture("podcast-resume-menu-completed-$suffix")
                compose.onNodeWithText(uiString(R.string.podcast_mark_unplayed)).performClick()
                compose.waitUntil(10_000) { !JsonParser.parseString(current.get()).asJsonObject.get("completed").asBoolean }
                // The row's own "已听完" badge must be gone first, so the page has no reason to show it.
                compose.waitUntil(10_000) { compose.onAllNodesWithText(uiString(R.string.podcast_already_completed)).fetchSemanticsNodes().isEmpty() }
                compose.runOnIdle { vm.podcastProgress.completed() }
                // "已听完" is informational: the page must stay quiet, the player still reports inline.
                compose.waitForIdle()
                compose.onAllNodesWithTag("podcast-page-notice").assertCountEquals(0)
                compose.onAllNodesWithText(uiString(R.string.podcast_already_completed)).assertCountEquals(0)
                capture("podcast-resume-show-quiet-$suffix")
                // Sync failures are actionable, so they float above the mini player instead.
                val syncFailed = uiString(R.string.pod_prog_sync_failed_check_network)
                compose.runOnIdle { vm.podcastProgress.syncProblem() }
                // The notice auto-dismisses after 2.8s; hold the test clock while it is captured.
                compose.mainClock.autoAdvance = false
                try {
                    compose.mainClock.advanceTimeBy(100)
                    compose.onNodeWithTag("podcast-page-notice").assertIsDisplayed()
                    compose.onNodeWithText(syncFailed).assertIsDisplayed()
                    capture("podcast-resume-show-notice-$suffix")
                    compose.mainClock.advanceTimeBy(3_000)
                    compose.onAllNodesWithTag("podcast-page-notice").assertCountEquals(0)
                } finally { compose.mainClock.autoAdvance = true }
            }
            compose.runOnIdle { vm.controller?.pause(); vm.controller?.clearMediaItems() }
        }
    }
}
