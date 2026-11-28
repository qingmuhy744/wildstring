package com.wildstring.app

import android.app.Application
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import com.wildstring.app.ui.BookMediaTransport
import com.wildstring.app.ui.BookPlaybackController
import java.net.InetAddress
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [37],
    application = Application::class,
    instrumentedPackages = ["com.wildstring.app.data.SessionStore"],
    shadows = [BookPlaybackSyncConflictTest.MemorySessionKey::class],
)
@LooperMode(LooperMode.Mode.INSTRUMENTATION_TEST)
class BookPlaybackSyncConflictTest {
    @Test fun deletingOneBookClearsOnlyItsCachedRows() = runBlocking {
        val context = RuntimeEnvironment.getApplication()
        val database = Room.inMemoryDatabaseBuilder(context, QueueDatabase::class.java).build()
        try {
            val cache = database.books()
            cache.saveBooks(listOf(BookEntity("owner", "deleted", "{}"), BookEntity("owner", "kept", "{}")))
            cache.saveChapters(listOf(BookEbookChapterMetaEntity("owner", "deleted", 0, "Chapter", "key")))
            cache.saveAudioChapters(listOf(BookAudiobookChapterEntity("owner", "deleted", 0, "{}")))
            cache.saveProgress(BookProgressSyncEntity("owner", "deleted", "listening", "{}"))
            cache.saveAnnotation(BookAnnotationSyncEntity("owner", "deleted", "annotation", "{}"))
            cache.deleteBook("owner", "deleted")
            assertEquals(listOf("kept"), cache.books("owner").map { it.bookId })
            assertTrue(cache.chapters("owner", "deleted").isEmpty())
            assertTrue(cache.audioChapters("owner", "deleted").isEmpty())
            assertNull(cache.progress("owner", "deleted", "listening"))
            assertTrue(cache.annotations("owner", "deleted").isEmpty())
        } finally {
            database.close()
        }
    }

    @Implements(value = SessionStore::class, isInAndroidSdk = false)
    class MemorySessionKey {
        @Implementation protected fun key(): SecretKey = secret

        companion object {
            private val secret: SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        }
    }

    private class FakeBookMediaTransport(
        override var isConnected: Boolean = true,
        override var hasActiveSession: Boolean = isConnected,
    ) : BookMediaTransport {
        var connectCount: Int = 0
        var lastMediaItems: List<MediaItem> = emptyList()
        var lastStartIndex: Int = 0
        var lastStartPositionMs: Long = 0L
        private var currentSpeed: Float = 1f
        override val playbackSpeed: Float get() = currentSpeed
        override var isPlaying: Boolean = false
        override var playWhenReady: Boolean = false
        override var playbackState: Int = Player.STATE_READY
        override val playerError: PlaybackException? = null
        override val currentMediaItem: MediaItem? get() = lastMediaItems.getOrNull(lastStartIndex)
        override val currentMediaItemIndex: Int get() = lastStartIndex
        override val currentPosition: Long get() = lastStartPositionMs
        override val duration: Long get() = 60_000L

        override fun connect(onResolved: (Boolean) -> Unit) {
            connectCount++
            isConnected = true
            hasActiveSession = true
            onResolved(true)
        }

        override fun addListener(listener: Player.Listener) = Unit
        override fun removeListener(listener: Player.Listener) = Unit

        override fun setMediaItems(items: List<MediaItem>, startIndex: Int, startPositionMs: Long) {
            lastMediaItems = items
            lastStartIndex = startIndex
            lastStartPositionMs = startPositionMs
        }

        override fun setPlaybackSpeed(speed: Float) {
            currentSpeed = speed
        }

        override fun prepare() = Unit
        override fun play() {
            isPlaying = true
            playWhenReady = true
        }

        override fun pause() {
            isPlaying = false
            playWhenReady = false
        }

        override fun seekTo(positionMs: Long) {
            lastStartPositionMs = positionMs
        }

        override fun seekTo(mediaItemIndex: Int, positionMs: Long) {
            lastStartIndex = mediaItemIndex
            lastStartPositionMs = positionMs
        }

        override fun requestSleepMinutes(onResult: (Int) -> Unit) {
            onResult(0)
        }

        override fun setSleepMinutes(minutes: Int) = Unit
        override fun stopAndClear() {
            lastMediaItems = emptyList()
            lastStartIndex = 0
            lastStartPositionMs = 0L
            isPlaying = false
        }

        override fun release() = Unit
    }

    @Test
    fun idleStartupDoesNotConnectBookPlaybackServiceUntilAudiobookOpens() = BookFixture().use { fixture ->
        fixture.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/api/v1/books/book-lazy/audiobook" -> json(
                    """{"total_duration_ms":60000,"chapters":[{"chapter_index":0,"file_index":0,"start_file_ms":0,"end_file_ms":60000,"start_book_ms":0,"duration_ms":60000,"title":"Chapter 1"}]}""",
                )
                "/api/v1/books/book-lazy/listening-progress" -> json(
                    """{"book_id":"book-lazy","chapter_index":0,"chapter_position_ms":0,"book_position_ms":0,"playback_rate":1.0,"completed":false,"version":1,"sequence":1}""",
                )
                else -> MockResponse().setResponseCode(404)
            }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val fakeTransport = FakeBookMediaTransport(isConnected = false, hasActiveSession = false)
        val controller = BookPlaybackController(
            repository = fixture.repository,
            scope = scope,
            context = fixture.context,
            onPlayStarted = {},
            onSessionCleared = {},
            transport = fakeTransport,
        )
        try {
            assertEquals("Idle app launch must not start a second MediaSession service", 0, fakeTransport.connectCount)
            runBlocking {
                val summary = BookSummary(
                    id = "book-lazy",
                    title = "Lazy Book",
                    subtitle = null,
                    authors = emptyList(),
                    libraryId = "lib-1",
                    hasEbook = false,
                    hasAudiobook = true,
                )
                controller.open(summary, autoplay = false)
                withTimeout(5000) {
                    controller.state.first { !it.loading && it.book?.id == "book-lazy" }
                }
            }
            assertEquals("Opening an audiobook connects the book service lazily once", 1, fakeTransport.connectCount)
        } finally {
            controller.release()
            scope.cancel()
        }
    }

    @Test
    fun listening409StopsFutureSavesAndUpdatesControllerConflictLive() = BookFixture().use { fixture ->
        var putCount = 0
        var serverVersion = 1
        var serverChapter = 0
        var serverPositionMs = 1000L
        var serverSpeed = 1.0f

        fixture.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/api/v1/books/book-1/audiobook") {
                    return json(
                        """{"total_duration_ms":120000,"chapters":[""" +
                            """{"chapter_index":0,"file_index":0,"start_file_ms":0,"end_file_ms":60000,"start_book_ms":0,"duration_ms":60000,"title":"Chapter 1"},""" +
                            """{"chapter_index":1,"file_index":1,"start_file_ms":0,"end_file_ms":60000,"start_book_ms":60000,"duration_ms":60000,"title":"Chapter 2"}""" +
                            """]}""",
                    )
                }
                if (request.path != "/api/v1/books/book-1/listening-progress") {
                    return MockResponse().setResponseCode(404)
                }
                if (request.method == "GET") {
                    return json(
                        """{"book_id":"book-1","chapter_index":$serverChapter,"chapter_position_ms":$serverPositionMs,""" +
                            """"book_position_ms":${serverChapter * 60000L + serverPositionMs},"playback_rate":$serverSpeed,"completed":false,"version":$serverVersion,"sequence":1}""",
                    )
                }
                putCount++
                return json(
                    """{"detail":{"code":"book_progress_conflict","current":{"book_id":"book-1","chapter_index":$serverChapter,""" +
                        """"chapter_position_ms":$serverPositionMs,"book_position_ms":${serverChapter * 60000L + serverPositionMs},"playback_rate":$serverSpeed,"completed":false,"version":$serverVersion,"sequence":1}}}""",
                    409,
                )
            }
        }

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val fakeTransport = FakeBookMediaTransport()
        val controller = BookPlaybackController(
            repository = fixture.repository,
            scope = scope,
            context = fixture.context,
            onPlayStarted = {},
            onSessionCleared = {},
            transport = fakeTransport,
        )
        try {
            runBlocking {
                val summary = BookSummary(
                    id = "book-1",
                    title = "Book One",
                    subtitle = null,
                    authors = emptyList(),
                    libraryId = "lib-1",
                    hasEbook = false,
                    hasAudiobook = true,
                )
                controller.open(summary, autoplay = false)
                withTimeout(5000) {
                    controller.state.first { !it.loading && it.book?.id == "book-1" }
                }
                assertFalse(controller.state.value.syncConflict)
                val firstExtras = fakeTransport.lastMediaItems.first().mediaMetadata.extras!!
                val firstToken = firstExtras.getString("syncToken")
                assertNotNull(firstToken)
                assertEquals(1, firstExtras.getInt("baseVersion"))

                // Another device updates the server state.
                serverVersion = 2
                serverChapter = 1
                serverPositionMs = 4500L
                serverSpeed = 1.25f

                val sync = BookSync(fixture.repository, "book-1", "listening", initialVersion = 1)
                val fields = JsonObject().apply {
                    addProperty("chapter_index", 0)
                    addProperty("chapter_position_ms", 2000)
                    addProperty("playback_rate", 1.0f)
                    addProperty("completed", false)
                }
                var threw409 = false
                try {
                    sync.save(fields)
                } catch (_: retrofit2.HttpException) {
                    threw409 = true
                }
                assertTrue(threw409)
                assertTrue(sync.conflict)
                assertEquals("book-1", fixture.repository.bookSyncConflict.value)

                // Subsequent saves remain blocked without issuing extra HTTP requests.
                sync.save(fields)
                assertEquals(1, putCount)

                // Controller observes conflict state live for the active book only.
                withTimeout(5000) { controller.state.first { it.syncConflict } }
                fixture.repository.bookSyncConflict.value = "other-book"
                withTimeout(5000) { controller.state.first { !it.syncConflict } }
                fixture.repository.bookSyncConflict.value = "book-1"
                withTimeout(5000) { controller.state.first { it.syncConflict } }

                // Reloading from server clears conflict, adopts chapter/position/speed, and mints a fresh syncToken.
                controller.reloadFromServer(autoplay = false)
                withTimeout(5000) {
                    controller.state.first { !it.loading && !it.syncConflict && it.index == 1 }
                }
                assertNull(fixture.repository.bookSyncConflict.value)
                assertEquals(1, controller.state.value.index)
                assertEquals(4500L, controller.positionMs.value)
                assertEquals(1.25f, controller.state.value.speed)
                assertEquals(1, fakeTransport.lastStartIndex)
                assertEquals(4500L, fakeTransport.lastStartPositionMs)
                val reloadedExtras = fakeTransport.lastMediaItems.first().mediaMetadata.extras!!
                assertEquals(2, reloadedExtras.getInt("baseVersion"))
                assertNotEquals(firstToken, reloadedExtras.getString("syncToken"))
            }
        } finally {
            controller.release()
            scope.cancel()
        }
    }

    private fun json(body: String, code: Int = 200) = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private class BookFixture : AutoCloseable {
        val context: Application = RuntimeEnvironment.getApplication()
        private val session = SessionStore(context)
        private val settings = AppSettings(context)
        private val cache = ClientCache(context, session, settings)
        private val client = ApplicationModule.client(session, cache)
        private val database = Room.inMemoryDatabaseBuilder(context, QueueDatabase::class.java).build()
        val repository = Repository(
            context,
            session,
            client,
            database,
            cache,
            settings,
            OfflineDownloads(context, session, client),
        )
        val server = MockWebServer()

        init {
            AppLanguage.install(context)
            server.start(InetAddress.getByName("127.0.0.1"), 0)
            session.configure(server.url("/").toString(), true)
            session.write("wildstring_session=synthetic; Path=/; Max-Age=3600")
            session.bindAccount(Account("test", "test", "listener"))
        }

        override fun close() {
            session.invalidate()
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            client.dispatcher.cancelAll()
            client.connectionPool.evictAll()
            database.close()
            server.close()
        }
    }
}
