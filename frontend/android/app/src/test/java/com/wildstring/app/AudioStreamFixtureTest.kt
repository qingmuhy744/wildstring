package com.wildstring.app

import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

class AudioStreamFixtureTest {
    @Test fun headKeepsTheConnectionCleanForTheNextLyricResponse() {
        val bytes = ByteArray(8192) { 42 }
        for (encoding in listOf(false, true)) MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = if (request.path == "/stream")
                    audioStreamFixture(request, bytes, "audio/mp4", "\"audio-v1\"", encoding)
                else MockResponse().setHeader("Content-Type", "application/json").setBody("{\"text\":\"updated\"}")
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            val client = OkHttpClient.Builder().retryOnConnectionFailure(false).readTimeout(2, TimeUnit.SECONDS).build()
            try {
                client.newCall(Request.Builder().url(server.url("/stream")).head().build()).execute().use { response ->
                    assertEquals(200, response.code); assertEquals("audio/mp4", response.header("Content-Type"))
                    assertEquals(if (encoding) "none" else "bytes", response.header("Accept-Ranges"))
                    assertEquals(if (encoding) null else bytes.size.toString(), response.header("Content-Length"))
                    assertEquals(if (encoding) null else "\"audio-v1\"", response.header("ETag"))
                    assertEquals(0, response.body!!.bytes().size)
                }
                client.newCall(Request.Builder().url(server.url("/lyrics")).build()).execute().use { response ->
                    assertEquals(200, response.code); assertEquals("{\"text\":\"updated\"}", response.body!!.string())
                }
                assertEquals(0, server.takeRequest(2, TimeUnit.SECONDS)!!.sequenceNumber)
                assertEquals("HEAD and lyrics must reuse the same clean HTTP connection", 1, server.takeRequest(2, TimeUnit.SECONDS)!!.sequenceNumber)
            } finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
        }
    }
}
