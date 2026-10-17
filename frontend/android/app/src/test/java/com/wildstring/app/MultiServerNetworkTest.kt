package com.wildstring.app

import com.wildstring.app.data.*
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

class MultiServerNetworkTest {
    @Test fun eachOriginUsesItsOwnCookieAndCrossOriginIsRejected() {
        MockWebServer().use { first -> MockWebServer().use { second ->
            first.start(); second.start()
            val current = AtomicReference(ServerRequestState("first-1", first.url("/music/")))
            val cookies = mutableMapOf(first.url("/music/").toString() to "wildstring_session=first; Path=/; Max-Age=3600",
                second.url("/music/").toString() to "wildstring_session=second; Path=/; Max-Age=3600")
            val client = OkHttpClient.Builder().followRedirects(false).addInterceptor(ScopedSessionInterceptor(current::get,
                { cookies[it.endpoint.toString()] }, { state, value -> if (state.selection == current.get().selection) { if (value == null) cookies.remove(state.endpoint.toString()) else cookies[state.endpoint.toString()] = value } })).build()
            first.enqueue(MockResponse().setBody("first")); second.enqueue(MockResponse().setBody("second"))
            client.newCall(Request.Builder().url(first.url("/music/api/v1/tracks")).build()).execute().close()
            current.set(ServerRequestState("second-1", second.url("/music/")))
            client.newCall(Request.Builder().url(second.url("/music/api/v1/tracks")).build()).execute().close()
            assertEquals("wildstring_session=first", first.takeRequest().getHeader("Cookie"))
            val other = second.takeRequest(); assertEquals("wildstring_session=second", other.getHeader("Cookie")); assertNull(other.getHeader("Authorization"))
            assertThrows(IOException::class.java) { client.newCall(Request.Builder().url(first.url("/music/api/v1/tracks")).build()).execute() }
            assertThrows(IOException::class.java) { client.newCall(Request.Builder().url(second.url("/unrelated")).build()).execute() }
            assertEquals(1, first.requestCount); assertEquals(1, second.requestCount)
            client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll()
        } }
    }
    @Test fun queuedApiFromPreviousVisitCannotUseTheNewVisitCookie() {
        MockWebServer().use { server ->
            server.start()
            val client = OkHttpClient.Builder().addInterceptor(SelectionRequestInterceptor("visit-A-1") { "visit-A-2" }).build()
            assertThrows(IOException::class.java) { client.newCall(Request.Builder().url(server.url("api/v1/playlists")).build()).execute() }
            assertEquals(0, server.requestCount)
            client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll()
        }
    }
    @Test fun lateResponseAfterLeavingAndReturningCannotReplaceCookieOrInvalidateSession() {
        MockWebServer().use { server ->
            server.start(); val current = AtomicReference(ServerRequestState("first-1", server.url("/")))
            val cookie = AtomicReference<String?>("wildstring_session=retained; Path=/; Max-Age=3600")
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse {
                entered.countDown(); check(release.await(3, TimeUnit.SECONDS))
                return MockResponse().setResponseCode(401).setHeader("Set-Cookie", "wildstring_session=late; Path=/; Max-Age=3600")
            } }
            var invalidated = false
            val client = OkHttpClient.Builder().addInterceptor(OriginGuard({ current.get().endpoint }, profile = { current.get().selection }, unauthorized = { invalidated = true }))
                .addInterceptor(ScopedSessionInterceptor(current::get, { cookie.get() }, { state, value -> if (state.selection == current.get().selection) cookie.set(value) })).build()
            val executor = Executors.newSingleThreadExecutor()
            try {
                val response = executor.submit<Boolean> { try { client.newCall(Request.Builder().url(server.url("api/v1/tracks")).build()).execute().close(); false } catch (_: IOException) { true } }
                assertTrue(entered.await(3, TimeUnit.SECONDS))
                current.set(ServerRequestState("second-1", ServerAddress.normalize("https://other.example.com/")))
                current.set(ServerRequestState("first-2", server.url("/")))
                release.countDown(); assertTrue(response.get(3, TimeUnit.SECONDS))
                assertFalse(invalidated); assertTrue(cookie.get()!!.contains("retained"))
            } finally { release.countDown(); executor.shutdownNow(); client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll() }
        }
    }
}
