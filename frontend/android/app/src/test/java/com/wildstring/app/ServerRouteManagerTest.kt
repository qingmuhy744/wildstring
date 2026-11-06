package com.wildstring.app

import com.wildstring.app.data.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

class ServerRouteManagerTest {
    private class Store(primary: ServerRoute) : ServerRouteSessions {
        override val activeServerId = "fixture"
        override val account = Account("admin", "admin", "owner")
        override val servers = MutableStateFlow(listOf(ServerConfiguration("fixture", primary.url, instanceId = "instance")))
        override var activeRouteUrl: String? = primary.url
        override var manualRoute: String? = null
        val routes = mutableListOf(primary)
        val cookies = mutableMapOf(primary.url to "wildstring_session_http=lan; Path=/; Max-Age=3600")
        override fun routeRecords(): List<ServerRoute> = routes.toList()
        override fun routeCookie(url: String): String? = cookies[url]
        override fun saveRoute(route: ServerRoute, cookie: String) { routes.removeAll { it.url == route.url }; routes.add(route); cookies[route.url] = cookie }
        override fun selectRoute(route: ServerRoute) { activeRouteUrl = route.url }
        override fun setRouteMode(address: String?) { manualRoute = address }
    }
    private val status = """{"configured":true,"authenticated":true,"user":{"id":"admin","username":"admin","profile":"owner"},"server":{"instance_id":"instance","name":"音乐库","connection_policy":"mixed"}}"""

    @Test fun fallbackKeepsWorkingRouteAndManualDoesNotSwitch() = runBlocking {
        MockWebServer().use { first -> MockWebServer().use { second ->
            first.start(); second.start()
            var failed = false
            first.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse = if (failed) MockResponse().setResponseCode(503) else MockResponse().setBody(status) }
            second.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse {
                assertEquals("wildstring_session_http=wan", request.getHeader("Cookie"))
                return MockResponse().setBody(status)
            } }
            val primary = ServerRoute("内网", first.url("/").toString(), true)
            val fallback = ServerRoute("公网", second.url("/").toString(), true)
            val store = Store(primary).apply { saveRoute(fallback, "wildstring_session_http=wan; Path=/; Max-Age=3600") }
            val manager = ServerRouteManager(store)
            failed = true
            manager.probe(); manager.probe()
            assertEquals(fallback.url, store.activeRouteUrl)
            failed = false
            manager.probe()
            assertEquals(fallback.url, store.activeRouteUrl)
            manager.select(primary.url)
            failed = true
            manager.probe(); manager.probe()
            assertEquals(primary.url, store.activeRouteUrl)
            assertEquals(primary.url, store.manualRoute)
            manager.select(null)
            assertEquals(fallback.url, store.activeRouteUrl)
            assertNull(store.manualRoute)
        } }
    }
    @Test fun newRouteUsesExplicitLoginAndIdentityMismatchNeverReceivesPassword() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val store = Store(ServerRoute("主线路", "https://original.invalid/", false))
            val manager = ServerRouteManager(store)
            server.enqueue(MockResponse().setBody("""{"instance_id":"wrong","name":"其他服务器","connection_policy":"mixed"}"""))
            try { manager.add("备用", server.url("/").toString(), true, "admin", "fixture-password"); fail("Expected mismatch") } catch (_: IllegalStateException) { }
            assertEquals(1, server.requestCount)
            assertNull(server.takeRequest().getHeader("Cookie"))
            server.enqueue(MockResponse().setBody("""{"instance_id":"instance","name":"音乐库","connection_policy":"mixed"}"""))
            server.enqueue(MockResponse().setBody("""{"id":"admin","username":"admin","profile":"owner"}""").addHeader("Set-Cookie", "wildstring_session_http=route-only; Path=/; Max-Age=3600"))
            manager.add("备用", server.url("/").toString(), true, "admin", "fixture-password")
            assertEquals(2, store.routes.size)
            assertTrue(store.cookies[server.url("/").toString()]!!.contains("route-only"))
            assertNull(server.takeRequest().getHeader("Cookie"))
            val login = server.takeRequest()
            assertEquals("POST", login.method)
            assertNull(login.getHeader("Cookie"))
            assertTrue(login.body.readUtf8().contains("fixture-password"))
        }
    }
}
