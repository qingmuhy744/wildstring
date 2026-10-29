package com.wildstring.app

import android.content.Context
import android.content.ContextWrapper
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

class AgentInboxTest {
    private class Store : AutoCloseable {
        private val base = InstrumentationRegistry.getInstrumentation().targetContext
        private val prefix = "agent-inbox-${UUID.randomUUID()}"
        val root = File(base.cacheDir, prefix).apply { mkdirs() }
        val context = object : ContextWrapper(base) {
            override fun getSharedPreferences(name: String, mode: Int) = base.getSharedPreferences("$prefix-$name", mode)
            override fun getCacheDir() = File(root, "cache").apply { mkdirs() }
            override fun getFilesDir() = File(root, "files").apply { mkdirs() }
        }
        val session = SessionStore(context); val settings = AppSettings(context)
        val cache = ClientCache(context, session, settings)
        val client = OkHttpClient.Builder().followRedirects(false).cookieJar(okhttp3.CookieJar.NO_COOKIES)
            .addInterceptor(OriginGuard({ session.endpoint }, profile = session::cacheScope, unauthorized = session::invalidate))
            .addInterceptor(ScopedSessionInterceptor(session::requestState, session::cookieFor, session::cookieFrom)).build()
        val database = Room.inMemoryDatabaseBuilder(context, QueueDatabase::class.java).build()
        val repository = Repository(context, session, client, database, cache, settings, OfflineDownloads(context, session, client))
        val agent = AgentPlatform(repository)
        fun select(server: MockWebServer, user: String) {
            session.configure(server.url("/").toString(), true); session.write("wildstring_session=$user; Path=/; Max-Age=3600"); session.bindAccount(Account(user, user, "listener")); agent.reset()
        }
        override fun close() { session.invalidate(); client.dispatcher.cancelAll(); client.connectionPool.evictAll(); database.close(); root.deleteRecursively() }
    }
    @Test fun fullPagesCatchConcurrentInsertExpiredCursorReadUpdatesAndAccountIsolation() = runBlocking {
        Store().use { store -> MockWebServer().use { server -> MockWebServer().use { second ->
            var clock = 0L; var inserted = false; var expire = false; val cursors = ConcurrentLinkedQueue<String>()
            val notices = linkedMapOf<String, JsonObject>(); val changes = mutableListOf<Pair<Long, JsonObject>>()
            fun put(id: String, read: Boolean = false) {
                clock++; val current = notices[id]
                val notice = jsonBody("id" to id, "title" to "通知 $id", "version" to (current?.number("version")?.plus(1) ?: 1L),
                    "created_at" to java.time.Instant.parse("2026-10-17T12:00:00Z").plusSeconds(id.toLong()).toString(),
                    "read_at" to if (read) "2026-10-17T12:10:00Z" else null)
                notices[id] = notice; changes += clock to notice.deepCopy()
            }
            repeat(270) { put((it + 1).toString()) }
            server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse = synchronized(notices) {
                val url = request.requestUrl!!; fun json(body: JsonObject) = MockResponse().setHeader("Content-Type", "application/json").setBody(body.toString())
                if (url.encodedPath.endsWith("/read-all")) {
                    val snapshot = JsonParser.parseString(request.body.readUtf8()).asJsonObject.number("high_watermark")
                    put("272") // Arrives AFTER the snapshot; must remain unread.
                    val snapshotIds = changes.filter { it.first <= snapshot }.map { it.second.text("id") }.toSet()
                    snapshotIds.forEach { put(it, true) }
                    return@synchronized json(JsonObject())
                }
                if (url.encodedPath.endsWith("/read")) {
                    val ids = JsonParser.parseString(request.body.readUtf8()).asJsonObject.getAsJsonArray("ids")
                    ids.forEach { put(it.asString, true) }; return@synchronized json(JsonObject())
                }
                val cursor = url.queryParameter("cursor")
                if (cursor != null) cursors += cursor
                if (expire && cursor != null) { expire = false; return@synchronized json(jsonBody("detail" to "notification_cursor_expired")).setResponseCode(410) }
                val offset = url.queryParameter("offset")?.toIntOrNull() ?: 0
                if (cursor == null && offset == 100 && !inserted) { put("271"); inserted = true }
                val filtered = if (cursor == null) notices.values.sortedByDescending { it.text("created_at") } else changes.filter { it.first > cursor.removePrefix("c").toLong() }.map { it.second }
                val page = if (cursor == null) filtered.drop(offset).take(100) else filtered.take(100)
                val lastSeq = if (cursor != null && filtered.size >= 100) changes.filter { it.first > cursor.removePrefix("c").toLong() }.take(100).last().first else clock
                json(jsonBody("items" to com.google.gson.JsonArray().apply { page.forEach { add(it.deepCopy()) } }, "total" to filtered.size,
                    "limit" to 100, "offset" to offset, "next_cursor" to "c$lastSeq", "high_watermark" to clock,
                    "unread_count" to notices.values.count { it.text("read_at").isBlank() }))
            } }
            second.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest) = MockResponse().setHeader("Content-Type", "application/json").setBody("""{"items":[],"total":0,"limit":100,"offset":0,"next_cursor":"c0","high_watermark":0,"unread_count":0}""") }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0); second.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            store.select(server, "alice"); store.agent.refreshInbox(force = true)
            assertEquals(271, store.agent.inbox.value.items.size); assertEquals(271, store.agent.inbox.value.unread)
            assertEquals(271, store.agent.inbox.value.items.map { it.text("id") }.toSet().size)
            assertEquals("The FIRST full-page cursor must replay concurrent changes", "c270", cursors.first())
            assertTrue(store.agent.inbox.value.items.all { it.text("read_at").isBlank() })
            // Another device reads one notification. Incremental sync must update without duplication.
            synchronized(notices) { put("270", true) }; store.agent.refreshInbox()
            assertEquals(270, store.agent.inbox.value.unread); assertEquals(271, store.agent.inbox.value.items.size)
            assertTrue(store.agent.inbox.value.items.first { it.text("id") == "270" }.text("read_at").isNotBlank())
            expire = true; store.agent.refreshInbox(); assertNull(store.agent.inbox.value.error); assertEquals(271, store.agent.inbox.value.items.size)
            store.agent.readSnapshot(); assertEquals(1, store.agent.inbox.value.unread)
            assertTrue(store.agent.inbox.value.items.single { it.text("id") == "272" }.text("read_at").isBlank())
            val aliceOwner = store.agent.inbox.value.owner
            store.select(second, "bob"); assertTrue(store.agent.inbox.value.items.isEmpty()); store.agent.refreshInbox()
            assertNotEquals(aliceOwner, store.agent.inbox.value.owner); assertTrue(store.agent.inbox.value.items.isEmpty()); assertEquals(0, store.agent.inbox.value.unread)
        } } }
    }
}
