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
        val reads = java.util.Collections.synchronizedList(mutableListOf<String>())
        val writes = java.util.Collections.synchronizedList(mutableListOf<Pair<String, String>>())
        val autoContinue = AtomicBoolean(false)
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
            fun bodyOf(episodeId: String, write: Pair<String, String>): com.google.gson.JsonObject? =
                if (write.first != episodeId) null else JsonParser.parseString(write.second).asJsonObject
            fun plays(episodeId: String) = synchronized(writes) {
                writes.count { it.first == episodeId && JsonParser.parseString(it.second).asJsonObject.get("event").asString == "play" }
            }
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
                val secondItem = onMain { episodes[1].toTrack(show).mediaItem(vm.repository) }

                // A user start is not an automatic continuation: a server-completed episode replays from 0.
                onMain { player.setMediaItem(item); player.prepare(); player.play() }
                await("User start of a server-completed episode still reads its progress before starting") {
                    synchronized(reads) { reads.count { it == "first" } >= 1 }
                }
                await("User start of a completed episode restarts it from 0 instead of advancing") {
                    onMain { player.isPlaying && podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) == "first" && player.currentPosition in 0..2_000 }
                }
                val startWrite = synchronized(writes) { writes.count { it.first == "first" && bodyOf("first", it)?.get("event")?.asString == "play" } }
                assertEquals("A user start of a server-completed episode opens exactly one play session: ${diagnostics()}", 1, startWrite)
                val startBody = synchronized(writes) { writes.filter { it.first == "first" && bodyOf("first", it)?.get("event")?.asString == "play" } }
                assertEquals("A user start must carry intent=restart: ${diagnostics()}", "restart", startBody.single().let { bodyOf("first", it)!!.get("intent").asString })
                assertEquals("Only automatic continuation skips a completed episode; a user start rewinds to position 0: ${diagnostics()}",
                    0, startBody.single().let { bodyOf("first", it)!!.get("position_seconds").asInt })
                assertFalse("Only automatic continuation skips a completed episode: a user start must not read or play the next episode: ${diagnostics()}",
                    synchronized(reads) { reads.contains("second") })

                // Automatic transitions with no Activity.
                compose.activityRule.scenario.moveToState(Lifecycle.State.DESTROYED)
                val beforeLineReads = synchronized(reads) { reads.toList() }
                onMain { player.pause() }
                onMain { player.setMediaItem(secondItem); player.prepare(); player.play() }
                await("A normal episode plays at its server position") {
                    onMain { player.isPlaying && podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) == "second" && player.currentPosition >= 3000 }
                }
                onMain { player.seekTo(11_500) }
                await("With auto-continue off an automatic ending stays on its own episode") {
                    onMain { player.playbackState == Player.STATE_ENDED && !player.isPlaying && podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) == "second" }
                }
                SystemClock.sleep(500)
                assertTrue("Auto-continue off must not read or play a successor: ${diagnostics()}",
                    synchronized(reads) { reads.drop(beforeLineReads.size) }.none { it in listOf("third", "fourth") })

                // Auto-continue on: a fresh automatic start reads progress, then its ending skips the completed "third".
                autoContinue.set(true)
                val automaticSecond = onMain { episodes[1].toTrack(show).mediaItem(vm.repository) }
                onMain { player.setMediaItem(automaticSecond); player.prepare(); player.play() }
                await("Automatic continuation reads progress before it plays") {
                    onMain { player.isPlaying && podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) == "second" && player.currentPosition >= 3000 }
                }
                assertEquals("Automatic continuation to a playable episode writes one resume play: ${diagnostics()}", 2, plays("second"))
                onMain { player.seekTo(11_500) }
                await("Automatic transition skips a remotely completed episode with no Activity") {
                    onMain { player.isPlaying && podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) == "fourth" && player.currentPosition >= 4000 }
                }
                assertTrue("Automatic transition judges the completed episode from its progress read: ${diagnostics()}", synchronized(reads) { reads.contains("third") })
                assertTrue("Skipping a completed episode is GET-only and opens no progress session: ${diagnostics()}",
                    synchronized(writes) { writes.none { it.first == "third" } })
                assertEquals("The episode after the skipped one starts in one resume session: ${diagnostics()}", 1, plays("fourth"))
                assertTrue("An automatically started episode does not restart: ${diagnostics()}",
                    synchronized(writes) { writes.filter { it.first == "fourth" && bodyOf("fourth", it)?.get("event")?.asString == "play" }
                        .all { bodyOf("fourth", it)?.get("intent")?.asString == "resume" } })

                // Queue context: a completed queued entry stays put instead of following the show line.
                val queueItem = item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(
                    Bundle(item.mediaMetadata.extras).apply { putBoolean("podcast_queue_context", true) }).build()).build()
                val beforeQueueReads = synchronized(reads) { reads.toList() }
                val beforeQueuePlays = synchronized(writes) { plays("first") }
                onMain { player.setMediaItem(queueItem); player.prepare(); player.play() }
                await("Queued completed episode restarts from 0 like any user start") {
                    onMain { player.isPlaying && podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) == "first" && player.currentPosition in 0..2_000 }
                }
                onMain { player.seekTo(11_500) }
                await("A completed queue entry ends on its own episode instead of advancing") {
                    onMain { player.playbackState == Player.STATE_ENDED && !player.isPlaying && podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) == "first" }
                }
                SystemClock.sleep(500)
                val queueReads = synchronized(reads) { reads.drop(beforeQueueReads.size) }
                assertTrue("The completed queue entry still reads its own progress first: ${diagnostics()}", queueReads.firstOrNull() == "first")
                assertFalse("A completed queue entry does not open a successor session in its own line: ${diagnostics()}", queueReads.contains("second"))
                assertEquals("A finished queue entry still opened exactly one play session: ${diagnostics()}", beforeQueuePlays + 1, plays("first"))
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
                val beforeRestoreRead = synchronized(reads) { reads.toList() }
                val beforeRestorePlays = synchronized(writes) { plays("first") }
                onMain { restored.play() }
                await("Restored completed queue entry reads progress and remains paused") {
                    synchronized(reads) { reads.size > beforeRestoreRead.size } &&
                        onMain { !restored.playWhenReady && !restored.isPlaying }
                }
                SystemClock.sleep(500)
                val restoreReads = synchronized(reads) { reads.drop(beforeRestoreRead.size) }
                assertEquals("A restored completed queue entry reads only its own progress, never its show's next episode: ${diagnostics()}", listOf("first"), restoreReads)
                assertEquals("Restored completed queue entry stays on its own episode", "first", onMain { podcastEpisodeId(restored.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) })
                assertEquals("Resuming a restored completed entry opens no restart session: ${diagnostics()}", beforeRestorePlays, plays("first"))
            } finally {
                onMain { controller?.let { it.pause(); it.clearMediaItems(); it.release() } }
            }
        }
    }
}
