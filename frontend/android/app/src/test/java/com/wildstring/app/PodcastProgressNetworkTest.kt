package com.wildstring.app

import android.app.Application
import androidx.room.Room
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import java.net.InetAddress
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowSystemClock

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [37], application = Application::class,
    instrumentedPackages = ["com.wildstring.app.data.SessionStore"],
    shadows = [PodcastProgressNetworkTest.MemorySessionKey::class])
@LooperMode(LooperMode.Mode.INSTRUMENTATION_TEST)
class PodcastProgressNetworkTest {
    @Test fun restartFollowsOurPendingWriteWithoutReportingAnotherDevice() = verifyRestartDuringOwnWrite(false)

    @Test fun restartFollowsOurAcknowledgementWhenTheReadSnapshotIsOlder() = verifyRestartDuringOwnWrite(true)

    @Test fun restartStillStopsWhenAnotherDeviceWinsDuringOurPendingWrite() = verifyRestartDuringOwnWrite(false, true)

    private fun verifyRestartDuringOwnWrite(delayRead: Boolean, otherDeviceWins: Boolean = false) = ProgressFixture().use { fixture ->
        val server = BookmarkServer(fixture)
        val progress = PodcastProgress(fixture.context, fixture.repository)
        runBlocking {
            progress.prepare("episode", "Episode", 3_600_000)
            withTimeout(5000) { while (server.current.get().deviceId != progress.deviceId()) delay(20) }
            val oldSession = server.current.get().sessionId
            server.blockWrite.set(true)
            progress.checkpoint("episode", 42_000, 3_600_000, "pause", true)
            assertTrue(server.writeEntered.await(5, TimeUnit.SECONDS))
            server.blockRead.set(delayRead)
            try {
                val restart = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
                    progress.prepare("episode", "Episode", 3_600_000, requestedMs = 0, explicitRestart = true)
                }
                if (delayRead) {
                    assertTrue(server.readEntered.await(5, TimeUnit.SECONDS))
                    server.releaseWrite.countDown()
                    withTimeout(5000) {
                        while (true) {
                            val row = fixture.repository.database.podcasts().get(fixture.repository.session.storageScope()!!, "episode")
                            val local = row?.let { com.google.gson.Gson().fromJson(it.payload, EpisodeCheckpoint::class.java) }
                            if (local?.remote?.positionSeconds == 42L) break
                            delay(20)
                        }
                    }
                    server.releaseRead.countDown()
                }
                assertEquals(PodcastPreparation.Play(0), withTimeout(2000) { restart.await() })
                if (otherDeviceWins) server.takeOver(9)
                server.releaseWrite.countDown()
                withTimeout(5000) { while (server.writes.size < 3 ||
                    (server.current.get().sessionId == oldSession && !progress.conflict.value)) delay(20) }
                if (otherDeviceWins) {
                    withTimeout(5000) { progress.conflict.first { it } }
                    assertEquals("other", server.current.get().deviceId)
                    assertEquals(9L, server.current.get().positionSeconds)
                    assertEquals("A real conflict must not trigger an automatic reclaim", 3, server.writes.size)
                } else {
                    assertFalse("Our own successful upload must not look like another device", progress.conflict.value)
                    assertNotEquals(oldSession, server.current.get().sessionId)
                    assertEquals(0L, server.current.get().positionSeconds)
                }
                assertEquals("restart", server.writes.last().intent)
            } finally {
                server.releaseRead.countDown()
                server.releaseWrite.countDown()
            }
        }
    }
    @Test fun resumePreservesOwnPendingPointWithoutReapplyingAnyMode() = ProgressFixture().use { fixture ->
        val server = BookmarkServer(fixture)
        val progress = PodcastProgress(fixture.context, fixture.repository)
        runBlocking {
            progress.prepare("episode", "Episode", 3_600_000)
            withTimeout(5000) { while (server.writes.isEmpty()) delay(20) }
            val session = server.writes.first().sessionId
            progress.setPromptHosted(true)
            for (mode in listOf("auto", "ask", "restart")) {
                progress.mode(mode)
                withTimeout(5000) { progress.mode.first { it == mode } }
                progress.checkpoint("episode", 150_000, 3_600_000, "pause", true)
                withTimeout(5000) { while (server.current.get().positionSeconds != 150L) delay(20) }
                val before = server.writes.size
                assertEquals(PodcastPreparation.Play(150_500), progress.prepare("episode", "Episode", 3_600_000,
                    fallbackMs = 150_500, start = PodcastStart.RESUME))
                withTimeout(5000) { while (server.writes.size <= before) delay(20) }
                assertNull(progress.prompt.value)
                assertEquals(session, server.writes.last().sessionId)
                assertEquals("resume", server.writes.last().intent)
            }
            server.takeOver(20)
            assertEquals(PodcastPreparation.Play(20_000), progress.prepare("episode", "Episode", 3_600_000,
                fallbackMs = 150_500, start = PodcastStart.RESUME))
            withTimeout(5000) { while (server.current.get().deviceId != progress.deviceId()) delay(20) }
            server.takeOver(3600, completed = true)
            val before = server.writes.size
            assertEquals(PodcastPreparation.Completed, progress.prepare("episode", "Episode", 3_600_000,
                fallbackMs = 20_000, start = PodcastStart.RESUME))
            assertEquals(before, server.writes.size)
        }
    }

    @Test fun transientReadFailuresUseLocalPointButAuthenticationErrorsDoNot() = ProgressFixture().use { fixture ->
        val server = BookmarkServer(fixture)
        val progress = PodcastProgress(fixture.context, fixture.repository)
        runBlocking {
            progress.prepare("episode", "Episode", 3_600_000)
            withTimeout(5000) { while (server.writes.isEmpty()) delay(20) }
            server.readMode.set("slow")
            val started = System.nanoTime()
            assertEquals(PodcastPreparation.Play(25_000), progress.prepare("episode", "Episode", 3_600_000,
                fallbackMs = 25_000, start = PodcastStart.RESUME))
            assertTrue("One total read budget bounds preparation", (System.nanoTime() - started) / 1_000_000 < 2500)
            server.readMode.set("503")
            assertEquals(PodcastPreparation.Play(26_000), progress.prepare("episode", "Episode", 3_600_000,
                fallbackMs = 26_000, start = PodcastStart.RESUME))
            server.readMode.set("401")
            val rejected = runCatching { progress.prepare("episode", "Episode", 3_600_000,
                fallbackMs = 27_000, start = PodcastStart.RESUME) }
            assertEquals("401", server.reads.last())
            // The real auth interceptor may clear the active owner before Retrofit delivers the 401.
            // Both cancellation (null) and an error must keep preparation from returning fallback audio.
            assertNull("Authentication failure must not prepare offline playback", rejected.getOrNull())
        }
    }

    @Test fun endingRequiresAcceptedCompletionFromTheSameSession() = ProgressFixture().use { fixture ->
        val server = BookmarkServer(fixture)
        val progress = PodcastProgress(fixture.context, fixture.repository)
        runBlocking {
            progress.prepare("episode", "Episode", 3_600_000)
            withTimeout(5000) { while (server.writes.isEmpty()) delay(20) }
            assertTrue(progress.finish("episode", 3_600_000, 3_600_000))
            progress.prepare("episode", "Episode", 3_600_000, explicitRestart = true)
            withTimeout(5000) { while (server.current.get().completed) delay(20) }
            server.takeOver(20)
            assertFalse(progress.finish("episode", 3_600_000, 3_600_000))
            assertFalse(server.current.get().completed)
            assertTrue(progress.conflict.value)
        }
    }

    private inner class BookmarkServer(fixture: ProgressFixture) {
        val current = AtomicReference(EpisodeProgress("episode", version = 1, sessionId = "other-session",
            deviceId = "other", sequence = 1, positionSeconds = 30, durationSeconds = 3600))
        val writes = CopyOnWriteArrayList<PodcastProgressUpdate>()
        val reads = CopyOnWriteArrayList<String>()
        val readMode = AtomicReference("normal")
        val blockWrite = AtomicBoolean(false)
        val writeEntered = CountDownLatch(1)
        val releaseWrite = CountDownLatch(1)
        val blockRead = AtomicBoolean(false)
        val readEntered = CountDownLatch(1)
        val releaseRead = CountDownLatch(1)
        private val mode = AtomicReference("auto")
        fun takeOver(position: Long, completed: Boolean = false) {
            synchronized(current) { current.set(current.get().copy(version = current.get().version + 1,
                sessionId = java.util.UUID.randomUUID().toString(), deviceId = "other", sequence = 1,
                positionSeconds = position, completed = completed)) }
        }
        init {
            fixture.server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val gson = com.google.gson.Gson()
                    if (request.path == "/api/v1/podcasts/resume-mode") {
                        if (request.method == "PUT") mode.set(JsonParser.parseString(request.body.readUtf8()).asJsonObject.get("resume_mode").asString)
                        return json("""{"resume_mode":"${mode.get()}"}""")
                    }
                    if (request.method == "GET") {
                        val selected = readMode.get(); reads += selected
                        val snapshot = current.get()
                        if (blockRead.compareAndSet(true, false)) {
                            readEntered.countDown()
                            check(releaseRead.await(5, TimeUnit.SECONDS))
                        }
                        return when (selected) {
                            "slow" -> json(gson.toJson(current.get())).setBodyDelay(5, java.util.concurrent.TimeUnit.SECONDS)
                            "503" -> json("{}", 503)
                            "401" -> json("{}", 401)
                            else -> json(gson.toJson(snapshot))
                        }
                    }
                    val write = gson.fromJson(request.body.readUtf8(), PodcastProgressUpdate::class.java)
                    writes += write
                    if (blockWrite.compareAndSet(true, false)) {
                        writeEntered.countDown()
                        check(releaseWrite.await(5, TimeUnit.SECONDS))
                    }
                    synchronized(current) {
                        val old = current.get()
                        val same = write.sessionId == old.sessionId && write.deviceId == old.deviceId
                        if (!same && write.baseVersion != old.version) return json("""{"detail":{"current":${gson.toJson(old)}}}""", 409)
                        if (!same || write.sequence > old.sequence) current.set(EpisodeProgress("episode", old.version + 1,
                            write.sessionId, write.deviceId, write.sequence, write.positionSeconds, write.durationSeconds,
                            write.event == "ended" || (old.completed && write.intent == "resume")))
                        return json(gson.toJson(current.get()))
                    }
                }
            }
        }
    }

    /** Replace only the hardware-backed key; SessionStore still encrypts and decrypts real credentials. */
    @Implements(value = SessionStore::class, isInAndroidSdk = false)
    class MemorySessionKey {
        @Implementation protected fun key(): SecretKey = secret
        companion object {
            private val secret: SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        }
    }

    @Test fun otherDeviceConflictStopsWritesUntilExplicitResumeTakeover() = ProgressFixture().use { fixture ->
        val puts = AtomicInteger()
        val gets = AtomicInteger()
        val writes = CopyOnWriteArrayList<String>()
        fixture.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/api/v1/podcasts/resume-mode") return json("{\"resume_mode\":\"auto\"}")
                if (request.path != "/api/v1/podcasts/episodes/episode/progress") return MockResponse().setResponseCode(404)
                if (request.method == "GET") {
                    gets.incrementAndGet()
                    return json(state(if (puts.get() >= 2) 9 else 0, if (puts.get() >= 2) "other-device" else "", "other-session"))
                }
                val body = request.body.readUtf8()
                writes.add(body)
                return when (puts.incrementAndGet()) {
                    2 -> json("{\"detail\":{\"code\":\"podcast_progress_conflict\",\"current\":${state(9, "other-device", "other-session")}}}", 409)
                    else -> {
                        val update = JsonParser.parseString(body).asJsonObject
                        json(state(10, update.get("device_id").asString, update.get("session_id").asString,
                            update.get("sequence").asLong, update.get("position_seconds").asLong))
                    }
                }
            }
        }
        val progress = PodcastProgress(fixture.context, fixture.repository)
        runBlocking {
            assertTrue(progress.prepare("episode", "Episode", 3_600_000) is PodcastPreparation.Play)
            withTimeout(5000) { while (puts.get() < 1) delay(20) }
            assertEquals(1, puts.get())
            progress.checkpoint("episode", 30_000, 3_600_000, "progress", true)
            withTimeout(5000) { progress.conflict.first { it } }
            progress.checkpoint("episode", 35_000, 3_600_000, "pause", true)
            progress.checkpoint("episode", 40_000, 3_600_000, "seek", true)
            delay(500)
            assertEquals(2, puts.get())
            progress.useLocalProgress()
            withTimeout(5000) { progress.conflict.first { !it } }
            assertEquals(3, puts.get())
            val claim = JsonParser.parseString(writes.last()).asJsonObject
            assertEquals("resume", claim.get("intent").asString)
            assertEquals(40L, claim.get("position_seconds").asLong)
            assertEquals(9L, claim.get("base_version").asLong)
            val before = gets.get()
            progress.prepare("episode", "Episode", 3_600_000)
            assertTrue(gets.get() > before)
        }
    }

    @Test fun completedEpisodeSkipsOnlyForAutomaticPlayAndAskModeOffersChoice() = ProgressFixture().use { fixture ->
        val completed = AtomicBoolean(true)
        val mode = java.util.concurrent.atomic.AtomicReference("auto")
        val puts = AtomicInteger()
        val gets = AtomicInteger()
        val writes = CopyOnWriteArrayList<String>()
        fixture.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/api/v1/podcasts/resume-mode") {
                    if (request.method == "PUT") mode.set(JsonParser.parseString(request.body.readUtf8()).asJsonObject.get("resume_mode").asString)
                    return json("{\"resume_mode\":\"${mode.get()}\"}")
                }
                if (request.path != "/api/v1/podcasts/episodes/episode/progress") return MockResponse().setResponseCode(404)
                if (request.method == "GET") {
                    gets.incrementAndGet()
                    val version = if (mode.get() == "restart") 5 else 3
                    return json(state(version, "remote", "previous", position = 120, completed = completed.get()))
                }
                puts.incrementAndGet()
                val body = request.body.readUtf8()
                writes.add(body)
                val update = JsonParser.parseString(body).asJsonObject
                return json(state(4, update.get("device_id").asString, update.get("session_id").asString, position = update.get("position_seconds").asLong))
            }
        }
        val progress = PodcastProgress(fixture.context, fixture.repository)
        runBlocking {
            // Automatic continuation of a server-completed episode: skip it without opening a session.
            assertEquals(PodcastPreparation.Completed, progress.prepare("episode", "Episode", 3_600_000, automatic = true))
            assertEquals(0, puts.get())
            assertEquals(1, gets.get())
            assertFalse(progress.owns("episode"))
            // A user starting that same episode replays it from the start and claims a restart session.
            assertEquals(PodcastPreparation.Play(0), progress.prepare("episode", "Episode", 3_600_000))
            withTimeout(5000) { while (puts.get() < 1) delay(20) }
            assertEquals(1, puts.get())
            val restart = JsonParser.parseString(writes.single()).asJsonObject
            assertEquals("restart", restart.get("intent").asString)
            assertEquals(0L, restart.get("position_seconds").asLong)
            assertEquals("play", restart.get("event").asString)
            assertTrue(progress.owns("episode"))
            assertFalse(progress.conflict.value)
            // Ask mode still offers the choice, and "from the start" writes another restart claim.
            completed.set(false)
            progress.setPromptHosted(true)
            progress.mode("ask")
            withTimeout(5000) { progress.mode.first { it == "ask" } }
            val getsBeforeAsk = gets.get()
            val putsBeforeAsk = puts.get()
            val result = async { progress.prepare("episode", "Episode", 3_600_000) }
            withTimeout(5000) { progress.prompt.first { it != null } }
            val offered = progress.prompt.value
            assertNotNull(offered)
            assertEquals(120_000L, offered!!.remoteMs)
            // The prompt is offered without any write; the answering branch decides what is claimed.
            assertEquals(getsBeforeAsk + 1, gets.get())
            assertEquals(putsBeforeAsk, puts.get())
            progress.answer(false)
            assertEquals(PodcastPreparation.Play(0), result.await())
            withTimeout(5000) { while (puts.get() < 2) delay(20) }
            assertEquals(2, puts.get())
            assertEquals("restart", JsonParser.parseString(writes.last()).asJsonObject.get("intent").asString)
            assertEquals(0L, JsonParser.parseString(writes.last()).asJsonObject.get("position_seconds").asLong)
            assertTrue(gets.get() >= 3)
            // Restart mode on an unfinished episode is the same rule without a completed flag.
            progress.mode("restart")
            withTimeout(5000) { progress.mode.first { it == "restart" } }
            assertEquals(PodcastPreparation.Play(0), progress.prepare("episode", "Episode", 3_600_000))
            withTimeout(5000) { while (puts.get() < 3) delay(20) }
            assertEquals(3, puts.get())
            assertEquals("restart", JsonParser.parseString(writes.last()).asJsonObject.get("intent").asString)
            assertFalse(progress.conflict.value)
        }
    }

    @Test fun sameDeviceNewSessionConflictStopsWithoutAutomaticRetry() = ProgressFixture().use { fixture ->
        val puts = AtomicInteger()
        val writes = CopyOnWriteArrayList<String>()
        fixture.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/api/v1/podcasts/resume-mode") return json("{\"resume_mode\":\"auto\"}")
                if (request.method == "GET") return json(state(5, "other-device", "other-session"))
                val body = request.body.readUtf8(); writes.add(body)
                val update = JsonParser.parseString(body).asJsonObject
                val count = puts.incrementAndGet()
                val remote = if (count == 1) state(1, update.get("device_id").asString, "previous-local")
                    else state(5, "other-device", "other-session")
                return json("{\"detail\":{\"current\":$remote}}", 409)
            }
        }
        val progress = PodcastProgress(fixture.context, fixture.repository)
        runBlocking {
            assertTrue(progress.prepare("episode", "Episode", 3_600_000) is PodcastPreparation.Play)
            withTimeout(5000) { progress.conflict.first { it } }
            assertEquals(1, puts.get())
            val first = JsonParser.parseString(writes[0]).asJsonObject
            progress.checkpoint("episode", 30_000, 3_600_000, "progress", true)
            progress.useLocalProgress()
            withTimeout(5000) { while (puts.get() < 2) delay(20) }
            delay(200)
            assertNotEquals(first.get("session_id"), JsonParser.parseString(writes[1]).asJsonObject.get("session_id"))
            assertTrue(progress.conflict.value)
            progress.checkpoint("episode", 40_000, 3_600_000, "seek", true)
            delay(200)
            assertEquals(2, puts.get())
            assertEquals("resume", JsonParser.parseString(writes.last()).asJsonObject.get("intent").asString)
        }
    }

    @Test fun offlinePreparationPersistsSessionWithoutInitialPlayAndHeartbeatRetries() = ProgressFixture().use { fixture ->
        val puts = AtomicInteger()
        fixture.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/api/v1/podcasts/resume-mode") return json("{\"resume_mode\":\"auto\"}")
                if (request.method == "GET") return MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AFTER_REQUEST)
                puts.incrementAndGet()
                val update = JsonParser.parseString(request.body.readUtf8()).asJsonObject
                assertEquals("resume", update.get("intent").asString)
                return json(state(1, update.get("device_id").asString, update.get("session_id").asString,
                    update.get("sequence").asLong, update.get("position_seconds").asLong))
            }
        }
        val progress = PodcastProgress(fixture.context, fixture.repository)
        runBlocking {
            assertEquals(PodcastPreparation.Play(15_000), progress.prepare("episode", "Episode", 3_600_000, fallbackMs = 15_000))
            assertEquals(0, puts.get())
            progress.checkpoint("episode", 20_000, 3_600_000, "progress", true)
            withTimeout(5000) { while (puts.get() < 1) delay(20) }
            assertEquals(1, puts.get())
        }
    }

    @Test fun historicalConflictIsDiscardedEvenWhenItBelongsToSameDevice() = ProgressFixture().use { fixture ->
        val puts = AtomicInteger()
        val releaseFirst = CountDownLatch(1)
        fixture.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/api/v1/podcasts/resume-mode") return json("{\"resume_mode\":\"auto\"}")
                if (request.method == "GET") return json(state(0, "", ""))
                val update = JsonParser.parseString(request.body.readUtf8()).asJsonObject
                if (puts.incrementAndGet() == 1) {
                    check(releaseFirst.await(5, TimeUnit.SECONDS))
                    return MockResponse().setResponseCode(503)
                }
                return json("{\"detail\":{\"current\":${state(8, update.get("device_id").asString, "newer-session")}}}", 409)
            }
        }
        val progress = PodcastProgress(fixture.context, fixture.repository)
        runBlocking {
            assertTrue(progress.prepare("episode", "Episode", 3_600_000) is PodcastPreparation.Play)
            try {
                withTimeout(5000) { while (puts.get() < 1) delay(20) }
                progress.leave()
            } finally {
                releaseFirst.countDown()
            }
            ShadowSystemClock.advanceBy(Duration.ofSeconds(11)) // The outbox retry is throttled by Android's clock.
            progress.retry()
            withTimeout(5000) { progress.positions.first { it["episode"]?.version == 8L } }
            assertEquals(2, puts.get())
            assertFalse(progress.conflict.value)
            val row = fixture.repository.database.podcasts().get(fixture.repository.session.storageScope()!!, "episode")
            val saved = com.google.gson.Gson().fromJson(row!!.payload, EpisodeCheckpoint::class.java)
            assertEquals(8L, saved.remote.version)
            assertFalse(saved.dirty)
            ShadowSystemClock.advanceBy(Duration.ofSeconds(11))
            progress.retry()
            delay(200)
            assertEquals(2, puts.get())
        }
    }

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code)
        .setHeader("Content-Type", "application/json").setBody(body)

    private fun state(version: Int, device: String, session: String, sequence: Long = 1, position: Long = 0, completed: Boolean = false) =
        """{"episode_id":"episode","version":$version,"device_id":"$device","session_id":"$session","sequence":$sequence,"position_seconds":$position,"duration_seconds":3600,"completed":$completed}"""

    private class ProgressFixture : AutoCloseable {
        val context = RuntimeEnvironment.getApplication()
        private val session = SessionStore(context)
        private val settings = AppSettings(context)
        private val cache = ClientCache(context, session, settings)
        private val client = ApplicationModule.client(session, cache)
        private val database = Room.inMemoryDatabaseBuilder(context, QueueDatabase::class.java).build()
        val repository = Repository(context, session, client, database, cache, settings, OfflineDownloads(context, session, client))
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
