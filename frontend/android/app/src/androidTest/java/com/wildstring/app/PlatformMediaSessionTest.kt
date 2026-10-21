@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
package com.wildstring.app

import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.SystemClock
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.media3.common.Player
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.Track
import com.wildstring.app.ui.MusicViewModel
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicReference
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Reads the actual Android platform session used by SystemUI, not our in-app duration fallback. */
class PlatformMediaSessionTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun <T> onMain(block: () -> T): T {
        val result = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }
    private fun await(message: String, condition: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < until) { if (condition()) return; SystemClock.sleep(40) }
        assertTrue(message, condition())
    }
    private fun platform(): MediaController {
        val manager = instrumentation.targetContext.getSystemService(MediaSessionManager::class.java)
        var controller: MediaController? = null
        await("WildString must advertise one active platform session") {
            val matching = try {
                instrumentation.uiAutomation.adoptShellPermissionIdentity("android.permission.MEDIA_CONTENT_CONTROL")
                manager.getActiveSessions(null).filter { it.packageName == instrumentation.targetContext.packageName }
            } finally { instrumentation.uiAutomation.dropShellPermissionIdentity() }
            assertTrue("A second media session must not be created", matching.size <= 1)
            controller = matching.singleOrNull(); controller != null
        }
        return checkNotNull(controller)
    }
    private fun progress(controller: MediaController, paused: Boolean, atLeast: Long = 0) {
        await("System metadata must expose the whole finite song and seek action") {
            val metadata = controller.metadata; val state = controller.playbackState
            metadata != null && kotlin.math.abs(metadata.getLong(MediaMetadata.METADATA_KEY_DURATION) - 12000L) < 150 && state != null &&
                state.actions and PlaybackState.ACTION_SEEK_TO != 0L && state.position >= atLeast &&
                state.position != PlaybackState.PLAYBACK_POSITION_UNKNOWN && state.lastPositionUpdateTime > 0 &&
                (if (paused) state.state == PlaybackState.STATE_PAUSED && state.playbackSpeed == 0f
                else state.state == PlaybackState.STATE_PLAYING && state.playbackSpeed > 0f)
        }
    }
    @Test fun originalChunkedAacSeekPauseAndBackgroundExposePlatformProgress() {
        val vm = onMain { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val assets = instrumentation.context.assets
        val original = assets.open("lossless.flac").use { it.readBytes() }
        val full = assets.open("aac-full.m4a").use { it.readBytes() }
        val tail = assets.open("aac-tail-6000.m4a").use { it.readBytes() }
        val mp3 = assets.open("playback.mp3").use { it.readBytes() }
        val requests = ConcurrentLinkedQueue<String>()
        val track = Track("system-progress", "系统进度合成测试", listOf("合成音频"), "平台媒体会话", 12000, format = "flac")
        try { MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.requestUrl!!; val path = url.encodedPath; requests += request.path.orEmpty()
                fun json(value: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(value)
                if (path.endsWith("/auth/status")) return json("""{"configured":true,"authenticated":${request.getHeader("Cookie") != null},"user":{"id":"media-user","username":"media","profile":"listener"}}""")
                if (path.endsWith("/auth/login")) return json("{}").setHeader("Set-Cookie", "wildstring_session=media; Path=/; Max-Age=3600")
                if (path.endsWith("/playback")) {
                    if (path.contains("/lossy/")) return json("""{"mode":"original","reason":"lossy_passthrough","output":{"codec":"mp3","bitrate_kbps":128},"duration_ms":12000,"start_ms":0,"stream_url":"/api/v1/tracks/lossy/stream"}""")
                    val start = url.queryParameter("start_ms")?.toLongOrNull() ?: 0
                    return json("""{"mode":"transcode","reason":"lossless_to_aac","output":{"codec":"aac","bitrate_kbps":192},"duration_ms":12000,"start_ms":$start,"stream_url":"/api/v1/tracks/system-progress/stream?format=aac&bitrate_kbps=192&start_ms=$start"}""")
                }
                if (path.endsWith("/stream")) {
                    if (path.contains("/lossy/")) return audioStreamFixture(request, mp3, "audio/mpeg", "\"system-progress-lossy\"")
                    val aac = url.queryParameter("format") == "aac"; val start = url.queryParameter("start_ms")?.toLongOrNull() ?: 0
                    return audioStreamFixture(request, if (!aac) original else if (start >= 6000) tail else full, if (aac) "audio/mp4" else "audio/flac", "\"system-progress-$start\"", encoding = aac)
                }
                if (path.endsWith("/albums") || path.endsWith("/tracks")) return json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                if (path.endsWith("/lyrics")) return json("""{"kind":"none","lines":[]}""")
                if (path.endsWith("/listening") || path.endsWith("/feedback")) return json("{}")
                return MockResponse().setResponseCode(404)
            } }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            val address = server.url("/").newBuilder().host("127.0.0.1").build().toString()
            onMain { vm.settings.quality(0); vm.connect(address, "media", "synthetic-password", true) }
            await("Fixture account login") { vm.state.value.connected }
            await("Media3 controller connected") { onMain { vm.controller != null } }
            onMain { vm.play(listOf(track)); vm.controller!!.repeatMode = Player.REPEAT_MODE_ONE }
            await("Original audio is playing") { onMain { vm.controller!!.isPlaying } }
            val system = platform()
            progress(system, paused = false)
            system.transportControls.pause(); progress(system, paused = true)
            system.transportControls.seekTo(1000)
            await("Original system seek reaches player") { onMain { kotlin.math.abs(vm.controller!!.currentPosition - 1000) < 200 } }
            onMain { vm.settings.quality(192) }
            await("Chunked AAC is ready") { vm.state.value.playbackQuality == "AAC · 192 kbps" && onMain { vm.controller!!.playbackState == Player.STATE_READY } }
            progress(system, paused = true)
            system.transportControls.seekTo(6000)
            await("System seek must request AAC tail") { requests.any { it.contains("format=aac") && it.contains("start_ms=6000") } && onMain { vm.controller!!.playbackState == Player.STATE_READY } }
            progress(system, paused = true, atLeast = 5900)
            assertEquals(12000L, system.metadata!!.getLong(MediaMetadata.METADATA_KEY_DURATION))
            val report = onMain { checkNotNull(vm.playbackHealth.diagnostics).invoke() }
            assertEquals(12000L, report.platform_duration_ms)
            assertEquals("transcode", report.actual_mode); assertTrue(report.platform_seek_supported)
            assertFalse(report.render().contains(track.title)); assertFalse(report.render().contains(address))
            compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            system.transportControls.play(); progress(system, paused = false, atLeast = 5900)
            val first = system.playbackState!!
            val extrapolated = first.position + ((SystemClock.elapsedRealtime() - first.lastPositionUpdateTime) * first.playbackSpeed).toLong()
            SystemClock.sleep(400)
            val next = system.playbackState!!
            val nextPosition = next.position + ((SystemClock.elapsedRealtime() - next.lastPositionUpdateTime) * next.playbackSpeed).toLong()
            assertTrue("SystemUI can advance progress while the activity is stopped", nextPosition > extrapolated + 200)
            system.transportControls.pause(); progress(system, paused = true, atLeast = 5900)
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            onMain { vm.play(listOf(track.copy(id = "lossy", title = "有损直放合成测试", format = "mp3"))) }
            await("AAC selection must preserve lossy original playback") { vm.state.value.playbackQuality == "原音 · MP3" && onMain { vm.controller!!.isPlaying } }
            progress(system, paused = false)
            assertTrue(requests.any { it == "/api/v1/tracks/lossy/stream" })
        } } finally {
            runCatching { compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED) }
            onMain { vm.settings.quality(0); vm.controller?.stop(); vm.controller?.clearMediaItems(); vm.repository.session.invalidate() }
        }
    }
}
