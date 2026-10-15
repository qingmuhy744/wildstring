package com.wildstring.app

import com.wildstring.app.data.*
import java.io.IOException
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class NetworkPolicyTest {
    private class Vault : CookieVault { var value: String? = null; override fun read() = value; override fun write(value: String?) { this.value = value } }
    @Test fun addressValidationAndPrefixIsolation() {
        val base = ServerAddress.normalize(" https://music.example.com/music ")
        assertEquals("https://music.example.com/music/", base.toString())
        assertTrue(ServerAddress.contains(base, base.resolve("api/v1/tracks")!!))
        assertFalse(ServerAddress.contains(base, base.resolve("/other")!!))
        listOf("http://music.example.com", "https://user:secret@music.example.com", "https://music.example.com/?token=bad", "https://music.example.com/#bad").forEach {
            assertThrows(IllegalArgumentException::class.java) { ServerAddress.normalize(it, true) }
        }
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.normalize("http://127.0.0.1") }
        assertEquals("127.0.0.1", ServerAddress.normalize("http://127.0.0.1", true).host)
    }
    @Test fun cookieScopedToSelectedServerAndExpires() {
        val vault = Vault(); val base = ServerAddress.normalize("https://music.example.com/music/")
        val jar = SessionCookieJar(vault) { base }
        jar.saveFromResponse(base, listOf(Cookie.parse(base, "wildstring_session=opaque; Max-Age=3600; Path=/; Secure; HttpOnly")!!))
        assertEquals("opaque", jar.loadForRequest(base.resolve("api/v1/tracks")!!).single().value)
        assertTrue(jar.loadForRequest(ServerAddress.normalize("https://other.example.com/")).isEmpty())
        assertTrue(jar.loadForRequest(base.resolve("/unrelated")!!).isEmpty())
        jar.saveFromResponse(base, listOf(Cookie.parse(base, "wildstring_session=; Max-Age=0; Path=/; Secure")!!))
        assertNull(vault.value)
    }
    @Test fun legacyHeaderRetryKeepsCookieAndDoesNotFollowRedirects() {
        MockWebServer().use { server ->
            server.start()
            val base = server.url("/"); val vault = Vault()
            val jar = SessionCookieJar(vault) { base }
            jar.saveFromResponse(base, listOf(Cookie.parse(base, "wildstring_session=opaque; Max-Age=3600; Path=/")!!))
            server.enqueue(MockResponse().setResponseCode(403).setBody("{\"detail\":\"client_header_required\"}"))
            server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://other.example.com/"))
            val client = OkHttpClient.Builder().cookieJar(jar).addInterceptor(OriginGuard({ base })).followRedirects(false).followSslRedirects(false).build()
            client.newCall(Request.Builder().url(base.resolve("api/v1/tracks")!!).build()).execute().use { assertEquals(200, it.code) }
            val first = server.takeRequest(); val retry = server.takeRequest()
            assertEquals("android", first.getHeader("X-Wildstring-Client")); assertEquals("web", retry.getHeader("X-Wildstring-Client"))
            assertEquals("wildstring_session=opaque", retry.getHeader("Cookie"))
            client.newCall(Request.Builder().url(base).build()).execute().use { assertEquals(302, it.code) }
            assertThrows(IOException::class.java) { client.newCall(Request.Builder().url("https://other.example.com/").build()).execute() }
        }
    }
    @Test fun unauthorizedInvalidatesPlaybackButLoginFailureDoesNot() {
        MockWebServer().use { server ->
            server.start(); var invalidations = 0
            val client = OkHttpClient.Builder().addInterceptor(OriginGuard({ server.url("/") }) { invalidations++ }).build()
            listOf("api/v1/auth/login", "api/v1/tracks").forEach { path ->
                server.enqueue(MockResponse().setResponseCode(401))
                client.newCall(Request.Builder().url(server.url(path)).build()).execute().close()
            }
            assertEquals(1, invalidations)
        }
    }
}
