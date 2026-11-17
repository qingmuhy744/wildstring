@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
package com.wildstring.app

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.media3.common.Player
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.Gson
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import com.wildstring.app.playback.mediaItem
import com.wildstring.app.ui.MusicViewModel
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real UI and MediaSession commands must keep working while progress uploads cannot complete. */
class PodcastTransportServiceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun <T> onMain(block: () -> T): T {
        val result = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }
    private fun await(message: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + timeoutMs
        while (SystemClock.elapsedRealtime() < until) { if (condition()) return; SystemClock.sleep(40) }
        assertTrue(message, condition())
    }
    private fun capture(name: String, playing: Boolean = true) {
        val action = uiString(if (playing) R.string.pod_player_pause else R.string.pod_player_play)
        compose.waitUntil(5_000) { compose.onAllNodesWithContentDescription(action).fetchSemanticsNodes().isNotEmpty() }
        compose.mainClock.advanceTimeBy(200)
        compose.waitForIdle()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
        val output = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        output.mkdirs()
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Test fun rewindAndResumeStayLocalDuringBlockedUploadsAndConflicts() {
        val vm = onMain { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val show = PodcastSummary("transport-show", "合成播放控制节目", feedUrl = "https://example.invalid/feed")
        val episode = PodcastEpisode("transport-episode", show.id, "guid", "后退十五秒后继续收听",
            audioUrl = "https://example.invalid/audio.wav", durationSeconds = 90)
        // Ninety seconds of synthetic PCM silence allow a real 15-second rewind without a binary fixture.
        val dataSize = 90 * 8000 * 2
        val audio = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt(36 + dataSize); put("WAVEfmt ".toByteArray())
            putInt(16); putShort(1); putShort(1); putInt(8000); putInt(16000); putShort(2); putShort(16)
            put("data".toByteArray()); putInt(dataSize)
        }.array()
        val gets = AtomicInteger()
        val writes = CopyOnWriteArrayList<String>()
        val offlineWrites = AtomicInteger()
        val network = AtomicReference("normal")
        val mode = AtomicReference("auto")
        val blocked = CountDownLatch(1)
        val release = CountDownLatch(1)
        val remote = AtomicReference("""{"episode_id":"${episode.id}","position_seconds":60,"duration_seconds":90,"completed":false,"version":0,"device_id":"","session_id":"","sequence":0}""")
        MockWebServer().use { server ->
            fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code)
                .setHeader("Content-Type", "application/json").setBody(body)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    if (path.endsWith("/auth/status")) return json("""{"configured":true,"authenticated":${request.getHeader("Cookie") != null},"user":{"id":"transport-user","username":"transport","profile":"listener"}}""")
                    if (path.endsWith("/auth/login")) return json("{}").setHeader("Set-Cookie", "wildstring_session=transport; Path=/; Max-Age=3600")
                    if (path.endsWith("/resume-mode")) {
                        if (request.method == "PUT") mode.set(JsonParser.parseString(request.body.readUtf8()).asJsonObject.get("resume_mode").asString)
                        return json("""{"resume_mode":"${mode.get()}"}""")
                    }
                    if (path.endsWith("/queue/preferences")) return json(Gson().toJson(PodcastQueuePreferences(autoContinue = false)))
                    if (path.endsWith("/podcasts/queue")) return json("""{"version":0,"items":[]}""")
                    if (path.endsWith("/podcasts/${show.id}")) return json(Gson().toJson(PodcastDetail(show, listOf(episode))))
                    if (path.endsWith("/episodes/${episode.id}")) return json(Gson().toJson(episode))
                    if (path.endsWith("/podcasts")) return json(Gson().toJson(listOf(show)))
                    if (path.endsWith("/stream")) return audioStreamFixture(request, audio, "audio/wav", "\"transport-audio\"")
                    if (path.endsWith("/progress")) {
                        if (request.method == "GET") { gets.incrementAndGet(); return json(remote.get()) }
                        val body = request.body.readUtf8(); writes += body
                        when (network.get()) {
                            "blocked" -> { blocked.countDown(); check(release.await(20, TimeUnit.SECONDS)) }
                            "offline" -> { offlineWrites.incrementAndGet(); return MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AFTER_REQUEST) }
                            "conflict" -> {
                                remote.set("""{"episode_id":"${episode.id}","version":1000,"device_id":"other-device","session_id":"other-session","sequence":1,"position_seconds":75,"duration_seconds":90,"completed":false}""")
                                return json("""{"detail":{"current":${remote.get()}}}""", 409)
                            }
                        }
                        val update = JsonParser.parseString(body).asJsonObject
                        update.addProperty("episode_id", episode.id)
                        update.addProperty("version", JsonParser.parseString(remote.get()).asJsonObject.get("version").asLong + 1)
                        update.addProperty("completed", false)
                        remote.set(update.toString())
                        return json(remote.get())
                    }
                    if (path.endsWith("/albums") || path.endsWith("/tracks")) return json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                    if (path.endsWith("/lyrics")) return json("""{"kind":"none","lines":[]}""")
                    return MockResponse().setResponseCode(404)
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            val address = server.url("/").toString()
            try {
                val login = onMain { vm.connect(address, "transport", "synthetic-password", true) }
                await("Synthetic account connects") { login.isCompleted && vm.state.value.connected && !vm.state.value.loading }
                await("Controller connects") { onMain { vm.controller != null } }
                val player = onMain { checkNotNull(vm.controller) }
                onMain {
                    val track = vm.repository.rememberPlaybackTrack(episode.toTrack(show))
                    player.setMediaItem(track.mediaItem(vm.repository)); player.prepare(); player.play()
                }
                await("Episode starts from its server bookmark") { onMain { player.isPlaying && player.currentPosition >= 60_000 } }
                val audioManager = instrumentation.targetContext.getSystemService(android.media.AudioManager::class.java)
                val focus = android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setOnAudioFocusChangeListener { }.build()
                val beforeFocus = writes.size
                val beforeFocusReads = gets.get()
                try {
                    assertEquals(android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED, onMain { audioManager.requestAudioFocus(focus) })
                    await("Temporary audio-focus loss suppresses audio without a pause request") {
                        onMain { !player.isPlaying && player.playWhenReady }
                    }
                    SystemClock.sleep(1_000)
                    assertFalse("Audio-focus suppression must not upload a pause event", writes.drop(beforeFocus).any {
                        JsonParser.parseString(it).asJsonObject.get("event").asString == "pause"
                    })
                } finally { onMain { audioManager.abandonAudioFocusRequest(focus) } }
                await("Playback resumes when audio focus returns") { onMain { player.isPlaying } }
                assertEquals("System focus recovery does not inspect cross-device progress", beforeFocusReads, gets.get())
                val system = try {
                    instrumentation.uiAutomation.adoptShellPermissionIdentity("android.permission.MEDIA_CONTENT_CONTROL")
                    instrumentation.targetContext.getSystemService(android.media.session.MediaSessionManager::class.java)
                        .getActiveSessions(null).single { it.packageName == instrumentation.targetContext.packageName }
                } finally { instrumentation.uiAutomation.dropShellPermissionIdentity() }
                onMain { player.pause() }
                await("Phone pauses before another device listens") { onMain { !player.playWhenReady } }
                await("The pause is uploaded before the other device takes over") {
                    JsonParser.parseString(remote.get()).asJsonObject.get("event")?.asString == "pause"
                }
                remote.set("""{"episode_id":"${episode.id}","position_seconds":20,"duration_seconds":90,"completed":false,"version":100,"device_id":"other-device","session_id":"other-session","sequence":1}""")
                val beforeHandoff = gets.get()
                system.transportControls.play()
                await("Explicit system play follows the other device's newer rewind") {
                    gets.get() > beforeHandoff && onMain { player.isPlaying && player.currentPosition in 20_000..23_000 }
                }
                await("The explicit handoff claims a new session") { JsonParser.parseString(remote.get()).asJsonObject.get("session_id").asString != "other-session" }
                val initialSession = JsonParser.parseString(writes.last()).asJsonObject.get("session_id").asString
                compose.onNodeWithTag("mini-player-open").performClick()
                onMain { vm.podcastProgress.mode("ask") }
                await("Ask mode is saved") { vm.podcastProgress.mode.value == "ask" }

                for (theme in listOf("light", "dark")) {
                    onMain { vm.settings.appearance(theme); player.seekTo(60_000) }
                    await("Seeking preserves playback") { onMain { player.isPlaying && player.currentPosition >= 60_000 } }
                    compose.onNodeWithTag("podcast-play-pause").performClick()
                    await("UI pauses playback") { onMain { !player.playWhenReady } }
                    val before = onMain { player.currentPosition }
                    compose.onNodeWithTag("podcast-rewind").performClick()
                    await("Rewind while paused stays paused and moves back fifteen seconds") {
                        onMain { !player.playWhenReady && player.playbackState == Player.STATE_READY && kotlin.math.abs(player.currentPosition - (before - 15_000)) < 1500 }
                    }
                    capture("podcast-transport-paused-$theme", playing = false)
                    val beforeResumeReads = gets.get()
                    compose.onNodeWithTag("podcast-play-pause").performClick()
                    await("UI resume reaches the engine and advances after rewind") {
                        onMain { player.isPlaying && player.currentPosition > before - 14_500 }
                    }
                    capture("podcast-transport-playing-$theme")
                    assertNull("Resume must not open another position prompt", vm.podcastProgress.prompt.value)
                    assertEquals("Explicit resume inspects progress once", beforeResumeReads + 1, gets.get())
                    assertEquals("Own unmodified cloud session is retained", initialSession, JsonParser.parseString(writes.last()).asJsonObject.get("session_id").asString)
                }

                // A stalled server must not hold the UI's seek or the system controller's resume command.
                network.set("blocked")
                compose.onNodeWithTag("podcast-rewind").performClick()
                assertTrue("Seek schedules a background upload", blocked.await(5, TimeUnit.SECONDS))
                system.transportControls.pause()
                await("System controller pauses") { onMain { !player.playWhenReady } }
                val pausedAt = onMain { player.currentPosition }
                system.transportControls.play()
                await("Playback advances before the blocked upload is released", timeoutMs = 2_000) {
                    onMain { player.isPlaying && player.currentPosition > pausedAt + 500 }
                }
                assertEquals("The upload is still blocked", 1L, release.count)
                network.set("offline"); release.countDown()
                onMain { vm.podcastProgress.checkpoint(episode.id, player.currentPosition, player.duration, "seek", true) }
                await("An offline write was attempted") { offlineWrites.get() > 0 }
                onMain { player.pause(); player.seekTo(30_000); player.play() }
                await("Offline progress does not block playback") { onMain { player.isPlaying && player.currentPosition > 30_500 } }

                network.set("conflict")
                onMain { vm.podcastProgress.checkpoint(episode.id, player.currentPosition, player.duration, "seek", true) }
                await("Another device stops uploads") { vm.podcastProgress.conflict.value }
                onMain { player.pause() }
                await("Conflict does not prevent pausing") { onMain { !player.playWhenReady } }
                compose.onNodeWithTag("podcast-rewind").performClick()
                val conflictedAt = onMain { player.currentPosition }
                onMain { player.play() }
                await("Conflict does not prevent local resume") { onMain { player.isPlaying && player.currentPosition > conflictedAt + 500 } }
                capture("podcast-transport-conflict")
                onMain { compose.activity.onBackPressedDispatcher.onBackPressed() }
                compose.onNodeWithTag("mini-player-open").assertIsDisplayed().performClick()
                compose.onNodeWithTag("podcast-rewind").assertIsDisplayed()
                assertTrue("Leaving and reopening the player preserves playback", onMain { player.isPlaying })
                assertTrue("The next explicit resume can claim its selected local target", writes.any {
                    JsonParser.parseString(it).asJsonObject.get("session_id").asString != initialSession
                })
            } finally {
                release.countDown()
                onMain { vm.controller?.pause(); vm.controller?.clearMediaItems(); vm.settings.appearance("system") }
            }
        }
    }
}
