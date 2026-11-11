@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
package com.wildstring.app

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import com.wildstring.app.data.podcastArtworkClient
import com.wildstring.app.playback.PodcastStreamDataSource
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

/** Real HTTP transports: direction, credentials and resumed byte ranges are observable. */
class PodcastStreamTest {
    @Test fun defaultUsesSourceAfterAuthenticatedCacheProbe() = verify(false, 200, 200)
    @Test fun failedSourceFallsBackToServer() = verify(false, 503, 200)
    @Test fun serverPreferenceSkipsSourceWhenServerWorks() = verify(true, 200, 200)
    @Test fun failedPreferredServerFallsBackToSource() = verify(true, 200, 502)
    @Test fun bothFailedStopAfterOneAttemptEach() = verify(false, 503, 502)
    @Test fun sourcePreferenceStillUsesExistingServerFile() = verify(false, 200, 200, cached = true)
    @Test fun resumedSourceFailureKeepsRangeOnServer() = verify(false, 503, 200, start = 37)

    @Test fun midstreamFailureResumesAlternativeAtFirstUnreadByte() {
        val payload = ByteArray(80) { it.toByte() }
        var start = 0
        var delivered = false
        val primary = object : DataSource {
            override fun addTransferListener(listener: TransferListener) = Unit
            override fun open(spec: DataSpec): Long { start = spec.position.toInt(); return (payload.size - start).toLong() }
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (delivered) throw IOException("Synthetic interrupted connection")
                payload.copyInto(buffer, offset, start, start + 16); delivered = true; return 16
            }
            override fun getUri(): Uri? = null
            override fun close() = Unit
        }
        val source = PodcastStreamDataSource(DataSource.Factory { primary }, DataSource.Factory { ByteArrayDataSource(payload) },
            { "https://example.test/episode.mp3" }, { true })
        try {
            source.open(DataSpec.Builder().setUri("https://wildstring.test/api/v1/podcasts/episodes/episode/stream").setPosition(11).build())
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(32)
            while (true) {
                val read = source.read(buffer, 0, buffer.size)
                if (read == C.RESULT_END_OF_INPUT) break
                output.write(buffer, 0, read)
            }
            assertArrayEquals(payload.copyOfRange(11, payload.size), output.toByteArray())
        } finally { source.close() }
    }

    private fun verify(serverFirst: Boolean, sourceStatus: Int, serverStatus: Int, cached: Boolean = false, start: Long = 0) {
        val payload = ByteArray(256) { it.toByte() }
        MockWebServer().use { origin -> MockWebServer().use { server ->
            origin.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = if (sourceStatus == 200)
                    audioStreamFixture(request, payload, "audio/mpeg", "\"synthetic-audio\"") else MockResponse().setResponseCode(sourceStatus)
            }
            origin.start()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.requestUrl!!.queryParameter("proxy") == "0" && !cached) return MockResponse().setResponseCode(307).setHeader("Location", origin.url("/episode.mp3"))
                    return if (serverStatus == 200) audioStreamFixture(request, payload, "audio/mpeg", "\"synthetic-audio\"") else MockResponse().setResponseCode(serverStatus)
                }
            }
            server.start()
            val client = OkHttpClient.Builder().followRedirects(false).addInterceptor { chain ->
                chain.proceed(chain.request().newBuilder().header("Cookie", "wildstring_session=synthetic-stream").build())
            }.build()
            val transport = PodcastStreamDataSource(OkHttpDataSource.Factory(client), OkHttpDataSource.Factory(podcastArtworkClient()),
                { origin.url("/episode.mp3").toString() }, { serverFirst })
            val uri = Uri.parse(server.url("/api/v1/podcasts/episodes/episode/stream?proxy=1&cache=1").toString())
            try {
                if (sourceStatus != 200 && serverStatus != 200) {
                    try { transport.open(DataSpec.Builder().setUri(uri).build()); fail("Both failed transports must report an error") }
                    catch (_: IOException) { }
                } else {
                    transport.open(DataSpec.Builder().setUri(uri).setPosition(start).build())
                    assertEquals("Keep the private cache addressed by the canonical server URL", uri, transport.uri)
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(64)
                    while (true) {
                        val read = transport.read(buffer, 0, buffer.size)
                        if (read == C.RESULT_END_OF_INPUT) break
                        output.write(buffer, 0, read)
                    }
                    assertArrayEquals(payload.copyOfRange(start.toInt(), payload.size), output.toByteArray())
                }
                val publicRequest = !cached && (!serverFirst || serverStatus != 200)
                assertEquals(if (publicRequest) 1 else 0, origin.requestCount)
                if (publicRequest) {
                    val request = origin.takeRequest(1, TimeUnit.SECONDS)!!
                    assertNull(request.getHeader("Cookie")); assertNull(request.getHeader("Authorization"))
                    if (start > 0) assertEquals("bytes=$start-", request.getHeader("Range"))
                }
                val expectedServer = if (!serverFirst && !cached && sourceStatus != 200) 2 else 1
                assertEquals(expectedServer, server.requestCount)
                repeat(expectedServer) {
                    val request = server.takeRequest(1, TimeUnit.SECONDS)!!
                    assertEquals("wildstring_session=synthetic-stream", request.getHeader("Cookie"))
                    if (start > 0) assertEquals("bytes=$start-", request.getHeader("Range"))
                }
            } finally { transport.close() }
        } }
    }

    @Test fun revokedServerAccessNeverFallsBackToPublicAudio() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setResponseCode(403))
            val publicCalls = java.util.concurrent.atomic.AtomicInteger()
            val transport = PodcastStreamDataSource(OkHttpDataSource.Factory(OkHttpClient()), OkHttpDataSource.Factory(
                podcastArtworkClient().newBuilder().addInterceptor { chain -> publicCalls.incrementAndGet(); chain.proceed(chain.request()) }.build()),
                { server.url("/public.mp3").toString() }, { false })
            try {
                try { transport.open(DataSpec.Builder().setUri(server.url("/api/v1/podcasts/episodes/episode/stream").toString()).build()); fail("Expected access rejection") }
                catch (error: HttpDataSource.InvalidResponseCodeException) { assertEquals(403, error.responseCode) }
                assertEquals(1, server.requestCount); assertEquals(0, publicCalls.get())
            } finally { transport.close() }
        }
    }
}
