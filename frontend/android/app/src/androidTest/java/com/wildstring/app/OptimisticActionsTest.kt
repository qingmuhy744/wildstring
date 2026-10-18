package com.wildstring.app

import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import com.wildstring.app.data.Track
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import com.wildstring.app.ui.MusicViewModel
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real Retrofit requests stay pending while the visible state responds and then rolls back. */
class OptimisticActionsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun favoriteFeedbackBeforeResponseAndFailureRollback() {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val gate = CountDownLatch(1)
        val received = AtomicBoolean(false)
        val loggedIn = AtomicBoolean(false)
        val success = AtomicBoolean(false)
        val holdTracks = AtomicBoolean(false)
        val oldListReceived = AtomicBoolean(false)
        val oldListGate = CountDownLatch(1)
        val track = Track("optimistic", "异步测试", listOf("测试"), "测试专辑", 12000, loved = false, format = "flac")
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    fun json(value: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(value)
                    return when {
                        request.path!!.contains("/auth/status") -> json("""{"configured":true,"authenticated":${loggedIn.get()},"user":${if (loggedIn.get()) """{"id":"optimistic-user","username":"listener","role":"user"}""" else "null"}}""")
                        request.path!!.contains("/auth/login") -> { loggedIn.set(true); json("{}").setHeader("Set-Cookie", "wildstring_session=test-session; Path=/; HttpOnly") }
                        request.path!!.contains("/favorite") -> { received.set(true); gate.await(10, TimeUnit.SECONDS); json("{}").setResponseCode(if (success.get()) 200 else 503) }
                        request.path!!.contains("/tracks") && holdTracks.get() -> {
                            oldListReceived.set(true)
                            oldListGate.await(10, TimeUnit.SECONDS)
                            json("""{"items":[${com.google.gson.Gson().toJson(track)}],"total":1,"limit":50,"offset":0}""")
                        }
                        request.path!!.contains("/tracks") -> json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                        else -> json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                    }
                }
            }
            server.start()
            val address = server.url("/").toString()
            try {
                compose.runOnIdle { vm.connect(address, "listener", "test-password-original", true) }
                compose.waitUntil(15000) { vm.state.value.account?.id == "optimistic-user" && !vm.state.value.loading }
                compose.runOnIdle { vm.repository.knownTracks[track.id] = track; vm.favorite(track); vm.favorite(track) }
                compose.waitUntil(5000) { received.get() && vm.state.value.pendingFavorites.contains(track.id) }
                assertTrue(vm.repository.knownTracks[track.id]!!.loved)
                gate.countDown()
                compose.waitUntil(5000) { !vm.state.value.pendingFavorites.contains(track.id) }
                assertFalse(vm.repository.knownTracks[track.id]!!.loved)
                assertTrue(vm.state.value.error!!.contains("收藏未保存"))
                assertEquals(1, server.requestCount.let { count ->
                    (0 until count).mapNotNull { server.takeRequest(1, TimeUnit.SECONDS) }.count { it.path!!.contains("/favorite") }
                })
                // A list read started before the favorite write must not restore its stale heart.
                success.set(true); holdTracks.set(true)
                runBlocking {
                    val oldList = async(Dispatchers.IO) { vm.repository.tracks() }
                    compose.waitUntil(5000) { oldListReceived.get() }
                    compose.runOnIdle { vm.favorite(track) }
                    compose.waitUntil(5000) { !vm.state.value.pendingFavorites.contains(track.id) && vm.repository.knownTracks[track.id]?.loved == true }
                    oldListGate.countDown()
                    val page = withTimeout(5000) { oldList.await() }
                    assertTrue(page.items.single().loved)
                    assertTrue(vm.repository.knownTracks[track.id]!!.loved)
                }
            } finally { oldListGate.countDown(); gate.countDown(); compose.runOnIdle { vm.repository.session.invalidate() } }
        }
    }
}
