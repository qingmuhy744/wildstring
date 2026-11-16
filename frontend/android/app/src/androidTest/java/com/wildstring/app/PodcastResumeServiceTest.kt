@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
package com.wildstring.app

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.Gson
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import com.wildstring.app.playback.PlaybackService
import com.wildstring.app.playback.mediaItem
import com.wildstring.app.ui.MusicViewModel
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Exercise the real service after destroying its Activity and ViewModel. */
class PodcastResumeServiceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun <T> onMain(block: () -> T): T {
        val value = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { value.set(runCatching(block)) }
        return value.get().getOrThrow()
    }
    private var diagnostics: () -> String = { "" }
    private fun await(message: String, condition: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < until) { if (condition()) return; SystemClock.sleep(40) }
        assertTrue("$message: ${diagnostics()}", condition())
    }

    @Test fun completedReadsAndAutomaticTransitionsWaitForProgressWithOnlyServiceAlive() {
        val vm = onMain { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val show = PodcastSummary("resume-show", "合成续听节目", feedUrl = "https://example.invalid/feed")
        val episodes = listOf("first", "second", "third", "fourth").map { id ->
            PodcastEpisode(id, show.id, id, id, audioUrl = "https://example.invalid/audio.mp3", durationSeconds = 12)
        }
        val detail = PodcastDetail(show, episodes)
        val reads = ConcurrentLinkedQueue<String>()
        val writes = ConcurrentLinkedQueue<Pair<String, String>>()
        val ready = CountDownLatch(1)
        val release = CountDownLatch(1)
        val autoContinue = AtomicBoolean(false)
        val pauseCompletedRead = AtomicBoolean(false)
        val completedReady = CountDownLatch(1)
        val completedRelease = CountDownLatch(1)
        val audio = instrumentation.context.assets.open("playback.mp3").use { it.readBytes() }
        var controller: MediaController? = null
        MockWebServer().use { server ->
            fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    if (path.endsWith("/auth/status")) return json("""{"configured":true,"authenticated":${request.getHeader("Cookie") != null},"user":{"id":"resume-user","username":"resume","profile":"listener"}}""")
                    if (path.endsWith("/auth/login")) return json("{}").setHeader("Set-Cookie", "wildstring_session=resume; Path=/; Max-Age=3600")
                    if (path.endsWith("/resume-mode")) return json("""{"resume_mode":"auto"}""")
                    if (path.endsWith("/queue/preferences")) return json(Gson().toJson(PodcastQueuePreferences(autoContinue = autoContinue.get())))
                    if (path.endsWith("/podcasts/queue")) return json("""{"version":0,"items":[]}""")
                    if (path.endsWith("/podcasts/${show.id}")) return json(Gson().toJson(detail))
                    if (path.endsWith("/podcasts")) return json(Gson().toJson(listOf(show)))
                    if (path.endsWith("/stream")) return audioStreamFixture(request, audio, "audio/mpeg", "\"podcast-resume\"")
                    if (path.endsWith("/progress")) {
                        val id = path.substringBeforeLast('/').substringAfterLast('/')
                        if (request.method == "GET") {
                            reads += id
                            if (id == "second") { ready.countDown(); release.await(10, TimeUnit.SECONDS) }
                            if (id == "first" && pauseCompletedRead.get()) { completedReady.countDown(); completedRelease.await(10, TimeUnit.SECONDS) }
                            val completed = id in listOf("first", "third")
                            val position = if (id == "fourth") 4 else if (id == "second") 3 else 12
                            return json("""{"episode_id":"$id","position_seconds":$position,"duration_seconds":12,"completed":$completed,"version":0,"device_id":"","session_id":"","sequence":0}""")
                        }
                        val body = request.body.readUtf8(); writes += id to body
                        val update = JsonParser.parseString(body).asJsonObject
                        update.addProperty("episode_id", id); update.addProperty("version", 1)
                        update.addProperty("completed", update.get("event").asString == "ended")
                        return json(update.toString())
                    }
                    if (episodes.any { path.endsWith("/episodes/${it.id}") }) return json(Gson().toJson(episodes.first { path.endsWith("/${it.id}") }))
                    if (path.endsWith("/albums") || path.endsWith("/tracks")) return json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                    if (path.endsWith("/lyrics")) return json("""{"kind":"none","lines":[]}""")
                    return MockResponse().setResponseCode(404)
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            val address = server.url("/").toString()
            try {
                val login = onMain { vm.settings.quality(0); vm.connect(address, "resume", "synthetic-password", true) }
                await("Synthetic login") { login.isCompleted && vm.state.value.connected && !vm.state.value.loading }
                await("Initial controller") { onMain { vm.controller != null } }
                val future = onMain { MediaController.Builder(instrumentation.targetContext,
                    SessionToken(instrumentation.targetContext, ComponentName(instrumentation.targetContext, PlaybackService::class.java))).buildAsync() }
                controller = future.get(10, TimeUnit.SECONDS)
                val player = checkNotNull(controller)
                diagnostics = { onMain { "id=${player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")} playing=${player.isPlaying} ready=${player.playWhenReady} state=${player.playbackState} position=${player.currentPosition} error=${player.playerError} sync=${vm.podcastProgress.message.value} reads=$reads writes=$writes" } }
                val item = onMain { episodes.first().toTrack(show).mediaItem(vm.repository) }
                onMain { player.setMediaItem(item); player.prepare(); player.play() }
                val successorRead = ready.await(10, TimeUnit.SECONDS)
                assertTrue("Completed first episode must advance even when automatic continuation is off: ${diagnostics()}", successorRead)
                assertTrue("Completed episodes never open a progress session", writes.none { it.first == "first" })
                assertFalse("Successor cannot make sound before its progress read", onMain { player.isPlaying })
                release.countDown()
                await("Service-only successor resumes at server position") {
                    onMain { player.isPlaying && podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) == "second" && player.currentPosition >= 3000 }
                }
                assertEquals(1, writes.count { it.first == "second" && JsonParser.parseString(it.second).asJsonObject.get("event").asString == "play" })
                compose.activityRule.scenario.moveToState(Lifecycle.State.DESTROYED)
                autoContinue.set(true)
                onMain { player.seekTo(11_500) }
                await("Automatic transition skips remotely completed episode with no Activity") {
                    onMain { player.isPlaying && podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) == "fourth" && player.currentPosition >= 4000 }
                }
                assertTrue(reads.containsAll(listOf("first", "second", "third", "fourth")))
                assertTrue("Completed automatic successor must remain GET-only", writes.none { it.first == "third" })
                assertEquals(1, writes.count { it.first == "fourth" && JsonParser.parseString(it.second).asJsonObject.get("event").asString == "play" })
                assertTrue(writes.all { JsonParser.parseString(it.second).asJsonObject.get("intent").asString == "resume" })
                val queueItem = item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(
                    Bundle(item.mediaMetadata.extras).apply { putBoolean("podcast_queue_context", true) }).build()).build()
                onMain { player.setMediaItem(queueItem); player.prepare(); player.play() }
                await("Completed last queued episode stays in its queue") {
                    reads.count { it == "first" } >= 2 && onMain { vm.podcastProgress.message.value == AppLanguage.string(R.string.podcast_already_completed) }
                }
                await("Queue context is saved alongside the playlist") {
                    instrumentation.targetContext.getSharedPreferences("playback-context", android.content.Context.MODE_PRIVATE)
                        .getStringSet(vm.repository.session.storageScope(), emptySet())?.contains(item.mediaId) == true
                }
                val reopenedSession = SessionStore(instrumentation.targetContext)
                assertNotEquals("Request owners change after SessionStore reconstruction", vm.repository.session.cacheScope(), reopenedSession.cacheScope())
                assertEquals(vm.repository.session.storageScope(), reopenedSession.storageScope())
                assertTrue("Queue context survives request owner regeneration",
                    instrumentation.targetContext.getSharedPreferences("playback-context", android.content.Context.MODE_PRIVATE)
                        .getStringSet(reopenedSession.storageScope(), emptySet())?.contains(item.mediaId) == true)
                onMain { player.release(); controller = null; instrumentation.targetContext.stopService(Intent(instrumentation.targetContext, PlaybackService::class.java)) }
                instrumentation.waitForIdleSync()
                val restoredFuture = onMain { MediaController.Builder(instrumentation.targetContext,
                    SessionToken(instrumentation.targetContext, ComponentName(instrumentation.targetContext, PlaybackService::class.java))).buildAsync() }
                controller = restoredFuture.get(10, TimeUnit.SECONDS)
                val restored = checkNotNull(controller)
                await("Restored queued episode retains its playback context") {
                    onMain { restored.currentMediaItem?.mediaMetadata?.extras?.getBoolean("podcast_queue_context") == true }
                }
                val beforeRestoreRead = reads.size
                onMain { restored.play() }
                await("Restored completed queue entry reads progress") { reads.size > beforeRestoreRead }
                SystemClock.sleep(500)
                assertEquals("Queue must not continue into its show after service restoration", beforeRestoreRead + 1, reads.size)
                assertEquals("first", onMain { podcastEpisodeId(restored.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) })
                assertFalse(onMain { restored.isPlaying })
                assertTrue("Completed queue entries remain GET-only", writes.none { it.first == "first" })
                pauseCompletedRead.set(true)
                onMain { restored.setMediaItem(item); restored.prepare(); restored.play() }
                assertTrue(completedReady.await(10, TimeUnit.SECONDS))
                onMain { restored.pause() }
                val readsBeforePause = reads.size
                completedRelease.countDown()
                SystemClock.sleep(500)
                assertEquals("Pause during completed progress read cancels successor playback", readsBeforePause, reads.size)
                assertFalse(onMain { restored.isPlaying })
            } finally {
                release.countDown()
                completedRelease.countDown()
                onMain { controller?.let { it.pause(); it.clearMediaItems(); it.release() } }
            }
        }
    }
}
