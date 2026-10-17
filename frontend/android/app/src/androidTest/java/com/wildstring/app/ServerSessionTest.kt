package com.wildstring.app

import android.content.Context
import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.*
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class ServerSessionTest {
    private fun isolated(): Context {
        val original = InstrumentationRegistry.getInstrumentation().targetContext
        val id = "multi-server-${UUID.randomUUID()}"
        return object : ContextWrapper(original) {
            override fun getCacheDir() = File(original.cacheDir, id).apply { mkdirs() }
            override fun getFilesDir() = File(original.cacheDir, "$id-files").apply { mkdirs() }
            override fun getSharedPreferences(name: String, mode: Int) = original.getSharedPreferences("$id-$name", mode)
        }
    }
    @Test fun legacyEncryptedSessionAccountAndCacheMigrateWithoutLogout() {
        val context = isolated(); val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
        val original = SessionStore(context)
        original.configure("http://127.0.0.1:1234/", true)
        original.write("wildstring_session=legacy-private; Path=/; Max-Age=3600")
        original.bindAccount(Account("old-account", "legacy", "user"))
        val owner = original.storageScope()!!; val id = original.activeServerId!!
        val ciphertext = prefs.getString("server:$id:session_ciphertext", null)!!
        val account = prefs.getString("server:$id:account", null)!!
        prefs.edit().clear().putString("server", "http://127.0.0.1:1234/").putBoolean("local_http", true)
            .putString("session_ciphertext", ciphertext).putString("cache_profile", owner).putString("account", account).commit()
        BoundedFileStore(File(context.cacheDir, "private-metadata-v1")).put("$owner:lyrics:old", "legacy lyrics".toByteArray(), 1024)
        context.getSharedPreferences("cache_owner", Context.MODE_PRIVATE).edit().putString("scope", owner).commit()
        val migrated = SessionStore(context)
        val cache = ClientCache(context, migrated, AppSettings(context))
        try {
            assertEquals(1, migrated.servers.value.size); assertEquals(owner, migrated.storageScope())
            assertEquals("legacy", migrated.account!!.username); assertTrue(migrated.read()!!.contains("legacy-private"))
            assertEquals("legacy lyrics", String(cache.read("lyrics:old")!!.bytes))
            assertFalse(prefs.contains("session_ciphertext")); assertFalse(prefs.contains("server"))
            assertEquals(owner, SessionStore(context).storageScope())
            assertTrue(SessionStore(context).read()!!.contains("legacy-private"))
        } finally { migrated.invalidate(); cache.clear(); context.cacheDir.deleteRecursively(); context.filesDir.deleteRecursively() }
    }
    @Test fun stableStorageTransactionAndSelectionAreAtomic() {
        val context = isolated(); val session = SessionStore(context)
        session.configure("http://127.0.0.1:1234/", true); session.write("wildstring_session=private; Path=/; Max-Age=3600")
        val token = session.cacheScope()!!; val first = session.storageScope()
        val second = session.saveServer(null, "http://127.0.0.1:4321/", "B", true)
        val inside = java.util.concurrent.CountDownLatch(1); val release = java.util.concurrent.CountDownLatch(1)
        val attempted = java.util.concurrent.CountDownLatch(1); val selected = java.util.concurrent.CountDownLatch(1)
        val workers = java.util.concurrent.Executors.newFixedThreadPool(2)
        try {
            val transaction = workers.submit<String?> { session.withStorageScope(token) { storage ->
                inside.countDown(); check(release.await(3, java.util.concurrent.TimeUnit.SECONDS)); storage
            } }
            assertTrue(inside.await(3, java.util.concurrent.TimeUnit.SECONDS))
            val selection = workers.submit { attempted.countDown(); session.selectServer(second.id); selected.countDown() }
            assertTrue(attempted.await(3, java.util.concurrent.TimeUnit.SECONDS))
            assertFalse("A file transaction must finish before B can be selected", selected.await(100, java.util.concurrent.TimeUnit.MILLISECONDS))
            release.countDown(); assertEquals(first, transaction.get(3, java.util.concurrent.TimeUnit.SECONDS)); selection.get(3, java.util.concurrent.TimeUnit.SECONDS)
            assertNull(session.withStorageScope(token) { error("A cannot select B's storage") })
        } finally { release.countDown(); workers.shutdownNow(); session.invalidate(); context.cacheDir.deleteRecursively(); context.filesDir.deleteRecursively() }
    }
    @Test fun serverSwitchRetainsIndependentAccountsMetadataAndCompleteOfflineFiles() = runBlocking {
        val context = isolated(); val session = SessionStore(context); val settings = AppSettings(context)
        val client = OkHttpClient.Builder().addInterceptor(OriginGuard({ session.endpoint }, profile = session::cacheScope, unauthorized = session::invalidate))
            .addInterceptor(ScopedSessionInterceptor(session::requestState, session::cookieFor, session::cookieFrom)).build()
        val cache = ClientCache(context, session, settings); val downloads = OfflineDownloads(context, session, client)
        downloads.wifiOnly = false
        val audio = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.mp3").use { it.readBytes() }
        MockWebServer().use { a -> MockWebServer().use { b ->
            val dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse = audioStreamFixture(request, audio, "audio/mpeg", "\"owner-original\"") }
            a.dispatcher = dispatcher; b.dispatcher = dispatcher; a.start(); b.start()
            try {
                session.configure(a.url("/").toString(), true)
                session.write("wildstring_session=alice; Path=/; Max-Age=3600"); session.bindAccount(Account("alice", "alice", "user"))
                val first = session.activeServerId!!; val firstToken = session.cacheScope()!!; val firstStorage = session.storageScope()
                val track = Track("same-id", "A 的音乐", listOf("A"), album = null, durationMs = 12000, format = "mp3", status = "available")
                cache.put("lyrics:same", "A 的歌词".toByteArray(), firstToken)
                downloads.enqueue(listOf(track)); downloads.run {}; assertNotNull(downloads.file(track.id))
                session.configure(b.url("/").toString(), true)
                assertNull(session.read()); assertNull(session.account); assertNull(cache.read("lyrics:same")); assertNull(downloads.file(track.id))
                session.write("wildstring_session=bob; Path=/; Max-Age=3600"); session.bindAccount(Account("bob", "bob", "user"))
                val second = session.activeServerId!!; val secondToken = session.cacheScope()!!
                cache.put("lyrics:same", "B 的歌词".toByteArray(), secondToken)
                downloads.enqueue(listOf(track.copy(title = "B 的音乐"))); downloads.run {}; assertNotNull(downloads.file(track.id))
                session.selectServer(first)
                assertNotEquals(firstToken, session.cacheScope()); assertEquals(firstStorage, session.storageScope())
                assertEquals("alice", session.account!!.username); assertTrue(session.read()!!.contains("alice"))
                assertEquals("A 的歌词", String(cache.read("lyrics:same")!!.bytes)); assertEquals("A 的音乐", downloads.track(track.id)!!.title)
                cache.put("late", byteArrayOf(4), firstToken); assertNull(cache.read("late"))
                session.invalidate(); assertNull(cache.read("lyrics:same")); assertNull(downloads.file(track.id))
                session.selectServer(second)
                assertNotEquals(secondToken, session.cacheScope()); assertTrue(session.read()!!.contains("bob"))
                assertEquals("bob", session.account!!.username); assertEquals("B 的歌词", String(cache.read("lyrics:same")!!.bytes))
                assertEquals("B 的音乐", downloads.track(track.id)!!.title)
                session.saveServer(second, b.url("/").toString(), "卧室", true)
                assertEquals("卧室", session.servers.value.first { it.id == second }.label); assertTrue(session.hasSession(second))
                session.removeServer(first); assertTrue(session.hasSession(second)); assertEquals(1, session.servers.value.size)
                session.removeServer(second); assertNull(session.cacheScope()); assertNull(downloads.file(track.id))
            } finally { session.invalidate(); client.dispatcher.cancelAll(); client.connectionPool.evictAll(); context.cacheDir.deleteRecursively(); context.filesDir.deleteRecursively() }
        } }
    }
}
