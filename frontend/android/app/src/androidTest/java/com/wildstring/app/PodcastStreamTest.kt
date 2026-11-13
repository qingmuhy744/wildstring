@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
package com.wildstring.app

import android.content.Context
import android.content.ContextWrapper
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.*
import com.wildstring.app.playback.mediaItem
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetAddress
import java.util.UUID
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

internal class PodcastRoutingFixture : AutoCloseable {
    private val base = InstrumentationRegistry.getInstrumentation().targetContext
    private val prefix = "podcast-routing-${UUID.randomUUID()}"
    private val root = File(base.cacheDir, prefix).apply { mkdirs() }
    val context = object : ContextWrapper(base) {
        override fun getSharedPreferences(name: String, mode: Int) = base.getSharedPreferences("$prefix-$name", mode)
        override fun getCacheDir() = File(root, "cache").apply { mkdirs() }
        override fun getFilesDir() = File(root, "files").apply { mkdirs() }
    }
    val session = SessionStore(context)
    private val settings = AppSettings(context)
    private val cache = ClientCache(context, session, settings)
    val client = ApplicationModule.client(session, cache)
    private val database = Room.inMemoryDatabaseBuilder(context, QueueDatabase::class.java).build()
    val repository = Repository(context, session, client, database, cache, settings, OfflineDownloads(context, session, client))
    val server = MockWebServer()
    val origin = MockWebServer()
    init {
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        origin.start(InetAddress.getByName("127.0.0.1"), 0)
        session.configure(server.url("/").toString(), true)
        session.write("wildstring_session=synthetic; Path=/; Max-Age=3600")
        session.bindAccount(Account("test", "test", "listener"))
        val show = PodcastSummary("show", "Show", feedUrl = "https://example.com/feed", coverUrl = origin.url("/art.jpg").toString())
        val episode = PodcastEpisode("episode", "show", "guid", "Episode", audioUrl = origin.url("/audio.mp3").toString())
        repository.rememberPlaybackTrack(episode.toTrack(show))
    }
    override fun close() {
        session.invalidate(); client.dispatcher.cancelAll(); client.connectionPool.evictAll(); database.close()
        server.close(); origin.close(); root.deleteRecursively()
    }
}

class PodcastStreamTest {
    @Test fun restoredPodcastTrackRetainsShowIdentityForLocalGain() = PodcastRoutingFixture().use { fixture ->
        val episode = PodcastEpisode("second", "show", "guid-2", "Second episode", audioUrl = "https://example.invalid/audio.mp3")
        val show = PodcastSummary("show", "Synthetic show", feedUrl = "https://example.invalid/feed")
        val track = episode.toTrack(show)
        kotlinx.coroutines.runBlocking {
            fixture.repository.rememberPodcastEpisode(episode, show)
            val restored = checkNotNull(fixture.repository.cachedTrack(track.id))
            val item = restored.mediaItem(fixture.repository)
            assertEquals("show", item.mediaMetadata.extras?.getString("podcast_id"))
            assertEquals(track.id, item.mediaMetadata.extras?.getString("track_id"))
            assertEquals(fixture.session.cacheScope(), item.mediaMetadata.extras?.getString("profile"))
        }
    }

    @Test fun playbackUsesAuthenticatedServerAndPreservesRange() = PodcastRoutingFixture().use { fixture ->
        val payload = ByteArray(256) { it.toByte() }
        fixture.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = audioStreamFixture(request, payload, "audio/mpeg", "\"synthetic\"")
        }
        val source = OkHttpDataSource.Factory(fixture.client).createDataSource()
        try {
            val uri = Uri.parse(fixture.repository.originalStream("podcast_ep_episode"))
            source.open(DataSpec.Builder().setUri(uri).setPosition(37).build())
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(64)
            while (true) {
                val count = source.read(buffer, 0, buffer.size)
                if (count == C.RESULT_END_OF_INPUT) break
                output.write(buffer, 0, count)
            }
            assertArrayEquals(payload.copyOfRange(37, payload.size), output.toByteArray())
            val request = fixture.server.takeRequest()
            assertEquals("1", request.requestUrl!!.queryParameter("proxy"))
            assertEquals("1", request.requestUrl!!.queryParameter("cache"))
            assertEquals("bytes=37-", request.getHeader("Range"))
            assertTrue(request.getHeader("Cookie")!!.contains("wildstring_session=synthetic"))
            assertEquals(0, fixture.origin.requestCount)
        } finally { source.close() }
    }

    @Test fun serverFailureDoesNotFallBackToOrigin() = PodcastRoutingFixture().use { fixture ->
        fixture.server.enqueue(MockResponse().setResponseCode(502))
        val source = OkHttpDataSource.Factory(fixture.client).createDataSource()
        try {
            try { source.open(DataSpec(Uri.parse(fixture.repository.originalStream("podcast_ep_episode")))); fail("Expected server error") }
            catch (error: HttpDataSource.InvalidResponseCodeException) { assertEquals(502, error.responseCode) }
            assertEquals(1, fixture.server.requestCount)
            assertEquals(0, fixture.origin.requestCount)
        } finally { source.close() }
    }
}
