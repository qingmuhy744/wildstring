package com.wildstring.app

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Only runs against the explicitly supplied disposable synthetic server, never the user's library. */
class AgentRealBackendTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun realApiDraftApprovalIdempotentApplyLocalAssistantInspectionAndInbox() {
        val endpoint = InstrumentationRegistry.getArguments().getString("realBackend")
        assumeTrue("Pass realBackend for the disposable synthetic instance", endpoint != null)
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        compose.runOnIdle { vm.repository.session.invalidate(); vm.connect(endpoint!!, "admin", "disposable-browser-test-password", true) }
        compose.waitUntil(20_000) { vm.state.value.connected && !vm.state.value.connecting }
        var conversationId: String? = null; var playlistId: String? = null
        try { runBlocking {
            val agent = vm.agent
            assertEquals(1L, agent.request("capabilities").number("version"))
            val tracks = vm.repository.tracks("测试曲").items
            assertTrue("A synthetic catalog must be provided", tracks.size >= 2)
            val draft = agent.request("drafts", "POST", jsonBody("kind" to "playlist", "title" to "Android 实际 API 草案",
                "payload" to jsonBody("name" to "Android 0.4.0 临时歌单", "track_ids" to jsonStrings(tracks.take(2).map { it.id }))))
            assertEquals("pending", draft.text("status")); val id = draft.text("id")
            agent.refreshInbox(force = true)
            val pendingNotice = agent.inbox.value.items.first { it.text("draft_id") == id }
            assertTrue(pendingNotice.text("read_at").isBlank())
            agent.refreshInbox(); assertTrue(agent.inbox.value.items.first { it.text("id") == pendingNotice.text("id") }.text("read_at").isBlank())
            val approved = agent.request("drafts/$id/approve", "POST", jsonBody("version" to draft.number("version")))
            assertEquals("approved", approved.text("status"))
            val body = jsonBody("version" to approved.number("version"), "idempotency_key" to "android-real-$id")
            val applied = agent.request("drafts/$id/apply", "POST", body)
            assertEquals("applied", applied.text("status")); playlistId = applied.getAsJsonObject("result").text("playlist_id")
            val repeated = agent.request("drafts/$id/apply", "POST", body)
            assertEquals(playlistId, repeated.getAsJsonObject("result").text("playlist_id"))
            val playlist = vm.repository.api().playlist(vm.repository.url("api", "v1", "playlists", playlistId!!))
            assertEquals(2, playlist.trackCount)
            val conversation = agent.request("conversations", "POST", jsonBody("title" to "Android 本地助手测试", "connection_id" to null))
            conversationId = conversation.text("id")
            val answer = agent.request("conversations/$conversationId/messages", "POST", jsonBody("content" to "测试曲", "connection_id" to null, "max_calls" to 2))
            assertTrue(answer.objects("messages").any { it.text("role") == "assistant" && it.text("content").isNotBlank() })
            assertEquals("local_fallback", answer.objects("runs").last().text("status"))
            val task = agent.request("tasks", "POST", jsonBody("max_tracks" to 2, "max_calls" to 0, "use_ai" to false))
            var latest = task
            repeat(100) {
                if (latest.text("status") in listOf("succeeded", "partial", "failed", "paused_authorization", "paused_budget")) return@repeat
                delay(100); latest = agent.request("tasks/${task.text("id")}")
            }
            assertEquals("succeeded", latest.text("status")); assertTrue(latest.getAsJsonObject("counts").number("processed") in 1L..2L)
            agent.readNotification(pendingNotice.text("id"))
            assertTrue(agent.inbox.value.items.first { it.text("id") == pendingNotice.text("id") }.text("read_at").isNotBlank())
            assertTrue(agent.inbox.value.items.any { it.text("task_id") == task.text("id") })
        } } finally {
            runBlocking {
                conversationId?.let { runCatching { vm.agent.request("conversations/$it", "DELETE") } }
                playlistId?.let { id -> runCatching { val playlist = vm.repository.api().playlist(vm.repository.url("api", "v1", "playlists", id)); vm.repository.api().deletePlaylist(vm.repository.url("api", "v1", "playlists", id), playlist.version) } }
            }
            compose.runOnIdle { vm.repository.session.invalidate() }
        }
    }
}
