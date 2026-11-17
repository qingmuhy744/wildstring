@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
package com.wildstring.app

import androidx.media3.exoplayer.ExoPlayer
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.Gson
import com.wildstring.app.data.*
import com.wildstring.app.ui.PodcastQueueController
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

/** A delayed preparation must never play after a newer show selection or account reset. */
class PodcastPlayRequestTest {
    @Test fun newerSelectionCancelsDelayedShowPreparation() = verifyDelayedPreparation(reset = false)
    @Test fun accountResetCancelsDelayedShowPreparation() = verifyDelayedPreparation(reset = true)

    @Test fun cachedShowKeepsTheSelectedEpisodeAndContinuationOrder() = PodcastRoutingFixture().use { fixture ->
        val show = PodcastSummary("batch", "Synthetic batch", feedUrl = "https://example.invalid/batch.xml")
        val episodes = (0 until 50).map { index ->
            PodcastEpisode("batch-$index", show.id, "$index", "Episode $index", audioUrl = "https://example.invalid/$index.mp3")
        }
        fixture.server.enqueue(MockResponse().setHeader("Content-Type", "application/json")
            .setBody(Gson().toJson(PodcastDetail(show, episodes))))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        var player: ExoPlayer? = null
        try {
            runBlocking {
                fixture.repository.podcastDetail(show.id)
                withContext(Dispatchers.Main) { player = ExoPlayer.Builder(fixture.context).build() }
                val played = CompletableDeferred<Pair<List<String>, Int>>()
                val controller = PodcastQueueController(fixture.repository, AppSettings(fixture.context), fixture.context, scope,
                    { "synthetic-device" }, { player }, {},
                    { tracks, index, _, _ -> played.complete(tracks.map { it.id } to index) },
                    { owner -> check(owner == fixture.session.cacheScope()) }, { emptyMap() })
                withContext(Dispatchers.Main) { controller.playEpisode(episodes[17], show, null) }
                val (ids, index) = withTimeout(5000) { played.await() }
                assertEquals(episodes.map { "podcast_ep_${it.id}" }, ids)
                assertEquals(17, index)
                assertEquals(episodes[17].id, fixture.repository.cachedPodcastEpisode(episodes[17].id)?.id)
                assertNotNull(fixture.repository.cachedTrack(ids[index]))
                assertFalse(controller.followsQueue())
            }
        } finally {
            scope.cancel()
            InstrumentationRegistry.getInstrumentation().runOnMainSync { player?.release() }
        }
    }

    private fun verifyDelayedPreparation(reset: Boolean) = PodcastRoutingFixture().use { fixture ->
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val gson = Gson()
        fun show(id: String) = PodcastSummary(id, id, feedUrl = "https://example.invalid/$id.xml")
        fun episode(show: String) = PodcastEpisode("$show-episode", show, show, show, audioUrl = "https://example.invalid/$show.mp3")
        fixture.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val id = request.path?.substringAfterLast('/')
                if (id !in listOf("old", "new")) return MockResponse().setResponseCode(404)
                if (id == "old") {
                    entered.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                }
                return MockResponse().setHeader("Content-Type", "application/json")
                    .setBody(gson.toJson(PodcastDetail(show(id!!), listOf(episode(id)))))
            }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val played = CopyOnWriteArrayList<String>()
        var player: ExoPlayer? = null
        try {
            runBlocking {
                withContext(Dispatchers.Main) { player = ExoPlayer.Builder(fixture.context).build() }
                val controller = PodcastQueueController(fixture.repository, AppSettings(fixture.context), fixture.context, scope,
                    { "synthetic-device" }, { player }, {},
                    { tracks, index, _, _ -> played += tracks[index].id },
                    { owner -> check(owner == fixture.session.cacheScope()) }, { emptyMap() })
                val old = withContext(Dispatchers.Main) { controller.playEpisode(episode("old"), show("old"), null) }
                assertTrue("The old request must be in flight", entered.await(5, TimeUnit.SECONDS))
                if (reset) withContext(Dispatchers.Main) { controller.reset() }
                else {
                    val newer = withContext(Dispatchers.Main) { controller.playEpisode(episode("new"), show("new"), null) }
                    withTimeout(5000) { newer.join() }
                    assertEquals(listOf("podcast_ep_new-episode"), played.toList())
                }
                release.countDown()
                withTimeout(5000) { old.join() }
                assertTrue("Superseded playback preparation must be cancelled", old.isCancelled)
                assertEquals(if (reset) emptyList<String>() else listOf("podcast_ep_new-episode"), played.toList())
            }
        } finally {
            release.countDown()
            scope.cancel()
            InstrumentationRegistry.getInstrumentation().runOnMainSync { player?.release() }
        }
    }
}
