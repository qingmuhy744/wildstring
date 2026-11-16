package com.wildstring.app

import com.google.gson.JsonParser
import com.wildstring.app.data.PodcastPreparation
import com.wildstring.app.data.PodcastProgress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

class PodcastProgressNetworkTest {
    @Test fun otherDeviceConflictStopsWritesUntilExplicitResumeTakeover() = PodcastRoutingFixture().use { fixture ->
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

    @Test fun completedEpisodeSkipsOnlyForAutomaticPlayAndAskModeOffersChoice() = PodcastRoutingFixture().use { fixture ->
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
            val result = async { progress.prepare("episode", "Episode", 3_600_000) }
            withTimeout(5000) { progress.prompt.first { it != null } }
            val offered = progress.prompt.value
            assertNotNull(offered)
            assertEquals(120_000L, offered!!.remoteMs)
            assertEquals(2, gets.get())
            assertEquals(1, puts.get())
            progress.answer(false)
            assertEquals(PodcastPreparation.Play(0), result.await())
            assertEquals(2, puts.get())
            assertEquals("restart", JsonParser.parseString(writes.last()).asJsonObject.get("intent").asString)
            assertEquals(0L, JsonParser.parseString(writes.last()).asJsonObject.get("position_seconds").asLong)
            assertTrue(gets.get() >= 3)
            // Restart mode on an unfinished episode is the same rule without a completed flag.
            progress.mode("restart")
            withTimeout(5000) { progress.mode.first { it == "restart" } }
            assertEquals(PodcastPreparation.Play(0), progress.prepare("episode", "Episode", 3_600_000))
            assertEquals(3, puts.get())
            assertEquals("restart", JsonParser.parseString(writes.last()).asJsonObject.get("intent").asString)
            assertFalse(progress.conflict.value)
        }
    }

    @Test fun sameDeviceConflictRetriesOnlyCurrentWriteAndTakeoverConflictStopsAgain() = PodcastRoutingFixture().use { fixture ->
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
                return if (count == 2) json(state(2, update.get("device_id").asString, update.get("session_id").asString))
                    else json("{\"detail\":{\"current\":$remote}}", 409)
            }
        }
        val progress = PodcastProgress(fixture.context, fixture.repository)
        runBlocking {
            assertTrue(progress.prepare("episode", "Episode", 3_600_000) is PodcastPreparation.Play)
            assertEquals(2, puts.get())
            val first = JsonParser.parseString(writes[0]).asJsonObject
            val retried = JsonParser.parseString(writes[1]).asJsonObject
            assertEquals(first.get("session_id"), retried.get("session_id"))
            assertEquals(first.get("sequence"), retried.get("sequence"))
            progress.checkpoint("episode", 30_000, 3_600_000, "progress", true)
            withTimeout(5000) { progress.conflict.first { it } }
            progress.useLocalProgress()
            withTimeout(5000) { while (puts.get() < 4) delay(20) }
            delay(200)
            assertTrue(progress.conflict.value)
            progress.checkpoint("episode", 40_000, 3_600_000, "seek", true)
            delay(200)
            assertEquals(4, puts.get())
            assertEquals("resume", JsonParser.parseString(writes.last()).asJsonObject.get("intent").asString)
        }
    }

    @Test fun offlinePreparationPersistsSessionWithoutInitialPlayAndHeartbeatRetries() = PodcastRoutingFixture().use { fixture ->
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

    @Test fun historicalConflictIsDiscardedEvenWhenItBelongsToSameDevice() = PodcastRoutingFixture().use { fixture ->
        val puts = AtomicInteger()
        fixture.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/api/v1/podcasts/resume-mode") return json("{\"resume_mode\":\"auto\"}")
                if (request.method == "GET") return json(state(0, "", ""))
                val update = JsonParser.parseString(request.body.readUtf8()).asJsonObject
                if (puts.incrementAndGet() == 1) return MockResponse().setResponseCode(503)
                return json("{\"detail\":{\"current\":${state(8, update.get("device_id").asString, "newer-session")}}}", 409)
            }
        }
        val progress = PodcastProgress(fixture.context, fixture.repository)
        runBlocking {
            assertTrue(progress.prepare("episode", "Episode", 3_600_000) is PodcastPreparation.Play)
            progress.leave()
            delay(10_100) // The service retries outbox writes at most once per ten seconds.
            progress.retry()
            withTimeout(5000) { while (puts.get() < 2) delay(20) }
            delay(200)
            progress.retry()
            delay(200)
            assertEquals(2, puts.get())
            assertFalse(progress.conflict.value)
            assertEquals(8L, progress.positions.value["episode"]?.version)
        }
    }

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code)
        .setHeader("Content-Type", "application/json").setBody(body)

    private fun state(version: Int, device: String, session: String, sequence: Long = 1, position: Long = 0, completed: Boolean = false) =
        """{"episode_id":"episode","version":$version,"device_id":"$device","session_id":"$session","sequence":$sequence,"position_seconds":$position,"duration_seconds":3600,"completed":$completed}"""
}
