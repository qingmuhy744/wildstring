package com.wildstring.app

import android.graphics.Bitmap
import coil.request.ErrorResult
import coil.request.ImageRequest
import coil.request.SuccessResult
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class PodcastArtworkTest {
    @Test fun podcastCoverUsesAuthenticatedServerAndPrivateCache() = PodcastRoutingFixture().use { fixture ->
        val bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        bitmap.recycle()
        fixture.server.enqueue(MockResponse().setBody(Buffer().write(bytes)).setHeader("Content-Type", "image/png"))
        val loader = ApplicationModule.images(fixture.context, fixture.client)
        try {
            val showCover = fixture.repository.podcastArtwork("show")
            assertEquals(showCover, fixture.repository.cover("podcast_ep_episode"))
            val request = ImageRequest.Builder(fixture.context).data(showCover).size(96).build()
            assertTrue(runBlocking { loader.execute(request) } is SuccessResult)
            val received = fixture.server.takeRequest()
            assertEquals("/api/v1/podcasts/show/cover", received.path)
            assertTrue(received.getHeader("Cookie")!!.contains("wildstring_session=synthetic"))
            loader.memoryCache?.clear()
            assertTrue(runBlocking { loader.execute(request) } is SuccessResult)
            assertEquals(1, fixture.server.requestCount)
            assertEquals(0, fixture.origin.requestCount)
        } finally { loader.shutdown() }
    }

    @Test fun directoryCoverUsesServerBeforeTheShowIsAdded() = PodcastRoutingFixture().use { fixture ->
        val item = com.wildstring.app.data.PodcastDirectoryResult(
            "12345", "Directory", "Author", "https://feeds.example.test/show", fixture.origin.url("/art.jpg").toString(),
            emptyList(), false, false, null, "directory-key",
        )
        val bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        bitmap.recycle()
        fixture.server.enqueue(MockResponse().setBody(Buffer().write(bytes)).setHeader("Content-Type", "image/png"))
        val loader = ApplicationModule.images(fixture.context, fixture.client)
        try {
            val url = fixture.repository.podcastDirectoryArtwork(item)
            val request = ImageRequest.Builder(fixture.context).data(url).size(96).build()
            assertTrue(runBlocking { loader.execute(request) } is SuccessResult)
            val received = fixture.server.takeRequest()
            assertEquals("/api/v1/podcasts/directory-cover/directory-key", received.path)
            assertTrue(received.getHeader("Cookie")!!.contains("wildstring_session=synthetic"))
            assertEquals(0, fixture.origin.requestCount)
            assertEquals(fixture.repository.podcastArtwork("show"), fixture.repository.podcastDirectoryArtwork(item.copy(catalogPodcastId = "show")))
            assertNull(fixture.repository.podcastDirectoryArtwork(item.copy(artworkKey = null)))
        } finally { loader.shutdown() }
    }

    @Test fun failedCoverAndLegacyForeignArtworkNeverContactOrigin() = PodcastRoutingFixture().use { fixture ->
        fixture.server.enqueue(MockResponse().setResponseCode(502))
        val loader = ApplicationModule.images(fixture.context, fixture.client)
        try {
            val request = ImageRequest.Builder(fixture.context).data(fixture.repository.podcastArtwork("show")).build()
            assertTrue(runBlocking { loader.execute(request) } is ErrorResult)
            try {
                fixture.client.newCall(Request.Builder().url(fixture.origin.url("/old-art.jpg")).build()).execute().close()
                fail("Expected foreign artwork to be rejected")
            } catch (_: java.io.IOException) { }
            assertEquals(1, fixture.server.requestCount)
            assertEquals(0, fixture.origin.requestCount)
        } finally { loader.shutdown() }
    }
}
