package com.wildstring.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.media3.common.Player
import com.wildstring.app.data.*
import kotlinx.coroutines.runBlocking
import okio.Buffer
import com.wildstring.app.ui.MusicViewModel
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Two independent actual HTTP servers, using real login/manager/logout controls. */
class MultiServerUiTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun login(url: String, user: String) {
        compose.onAllNodes(hasSetTextAction())[0].performTextReplacement(url)
        compose.onAllNodes(hasSetTextAction())[1].performTextReplacement(user)
        compose.onAllNodes(hasSetTextAction())[2].performTextReplacement("public-test-password")
        compose.activityRule.scenario.onActivity { activity -> WindowCompat.getInsetsController(activity.window, activity.window.decorView).hide(WindowInsetsCompat.Type.ime()) }
        // IME resizing moves physical tap targets on fresh emulators. This
        // fixture tests server isolation; invoke enabled controls semantically.
        compose.onNode(isToggleable()).apply {
            if (fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ToggleableState] != androidx.compose.ui.state.ToggleableState.On)
                performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { click -> assertTrue(click()) }
            assertIsOn()
        }
        compose.waitUntil(10000) { compose.onAllNodes(hasText("连接并登录") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("连接并登录").assertIsEnabled()
            .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { click -> assertTrue(click()) }
    }
    private fun manager() {
        compose.onNodeWithContentDescription("设置").performClick()
        compose.onNodeWithText("服务器 / 切换服务器").performScrollTo().performClick()
        compose.onNodeWithTag("server-manager").assertIsDisplayed()
    }
    private fun serverAction(tag: String) {
        compose.onNode(hasScrollToIndexAction() and hasAnyAncestor(hasTestTag("server-manager")))
            .performScrollToNode(hasTestTag(tag))
        compose.onNodeWithTag(tag).performClick()
    }
    @Test fun switchingKeepsEachLoginAndLogoutOnlyClearsTheSelectedServer() {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.theme(false); vm.settings.appearance("light") }
        compose.waitUntil(10000) { !vm.state.value.connected }
        val aRequests = ConcurrentLinkedQueue<RecordedRequest>(); val bRequests = ConcurrentLinkedQueue<RecordedRequest>()
        val revoked = AtomicBoolean(false)
        val audio = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.mp3").use { it.readBytes() }
        fun fixture(name: String, requests: ConcurrentLinkedQueue<RecordedRequest>) = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request; val path = request.requestUrl!!.encodedPath
                val token = if (name == "甲") "first" else "second"
                fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                val authenticated = request.getHeader("Cookie")?.contains("wildstring_session=$token") == true
                val user = """{"id":"$name-user","username":"$name","profile":"listener","enabled":true,"version":1}"""
                if (path.endsWith("/auth/status")) return if (revoked.get()) MockResponse().setResponseCode(401) else json("""{"configured":true,"authenticated":$authenticated,"user":${if (authenticated) user else "null"}}""")
                if (path.endsWith("/auth/login")) return json(user).setHeader("Set-Cookie", "wildstring_session=$token; Max-Age=3600; Path=/; HttpOnly")
                if (path.endsWith("/auth/logout")) return MockResponse().setResponseCode(204)
                if (!authenticated) return MockResponse().setResponseCode(401)
                if (path.endsWith("/albums")) return json("""{"items":[{"id":"same-album","title":"$name 的专辑","artists":["$name"],"track_count":1}],"total":1,"limit":50,"offset":0}""")
                if (path.endsWith("/tracks")) return json("""{"items":[{"id":"same-track","title":"$name 的歌曲","artists":["$name"],"album":"$name 的专辑","duration_ms":12000,"has_cover":false,"loved":false,"format":"mp3","status":"available"}],"total":1,"limit":50,"offset":0}""")
                if (path.endsWith("/stream")) return audioStreamFixture(request, audio, "audio/mpeg", "\"$token-v1\"")
                if (path.endsWith("/lyrics")) return json("""{"kind":"none","lines":[]}""")
                if (path.endsWith("/listening")) return json("""{"accepted_ms":5000}""")
                if (path.endsWith("/recommendations/feedback")) return MockResponse().setResponseCode(204)
                if (path.endsWith("/playback/state")) return json("""{"version":1,"device_id":"test-device","track_ids":["same-track"],"index":0,"position_ms":0,"mode":"sequential"}""")
                if (path.endsWith("/lastfm")) return json("""{"configured":false,"connected":false,"scrobble":false,"now_playing":false,"version":0}""")
                return MockResponse().setResponseCode(404)
            }
        }
        MockWebServer().use { a -> MockWebServer().use { b ->
            a.dispatcher = fixture("甲", aRequests); b.dispatcher = fixture("乙", bRequests); a.start(); b.start()
            try {
                android.util.Log.i("MultiServerStage", "login A")
                login(a.url("/").toString(), "甲")
                compose.waitUntil(15000) { vm.state.value.account?.username == "甲" && vm.state.value.connected }
                val aId = vm.repository.session.activeServerId!!
                compose.waitUntil(15000) { !vm.state.value.loading && compose.onAllNodesWithText("甲 的歌曲", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
                compose.onNode(hasText("甲 的歌曲") and hasClickAction())
                    .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { click -> assertTrue(click()) }
                compose.waitUntil(15000) { compose.runOnIdle { vm.controller?.isPlaying == true && vm.controller!!.currentPosition >= 1200 } }
                android.util.Log.i("MultiServerStage", "A is playing, share snapshot")
                runBlocking { vm.sharing.publish(SharedPlayback(trackIds = listOf("same-track")), claim = true) }
                android.util.Log.i("MultiServerStage", "open server manager")
                compose.onNodeWithContentDescription("收起播放器").performClick()
                manager()
                compose.onNodeWithTag("server-add").performClick()
                compose.onNodeWithTag("server-name").performTextReplacement("卧室服务")
                compose.onNodeWithTag("server-url").performTextReplacement(b.url("/").toString())
                compose.onNodeWithTag("server-local-http").performClick()
                compose.onNodeWithTag("server-save").performClick()
                compose.waitUntil(10000) { vm.repository.session.servers.value.any { it.name == "卧室服务" } }
                val bId = vm.repository.session.servers.value.first { it.name == "卧室服务" }.id
                serverAction("server-select-$bId")
                compose.waitUntil(10000) { vm.state.value.server == b.url("/").toString() && !vm.state.value.connected && !vm.state.value.connecting }
                assertTrue(vm.repository.session.hasSession(aId))
                android.util.Log.i("MultiServerStage", "login B")
                login(b.url("/").toString(), "乙")
                compose.waitUntil(15000) { vm.state.value.account?.username == "乙" && vm.state.value.connected }
                android.util.Log.i("MultiServerStage", "B connected, assert privacy")
                assertEquals("乙", vm.repository.session.account!!.username)
                assertFalse(compose.runOnIdle { vm.controller!!.isPlaying }); assertTrue(vm.state.value.queue.isEmpty())
                assertTrue("A listening events must never reach B", bRequests.none { it.requestUrl!!.encodedPath.endsWith("/listening") })
                assertTrue("A snapshots must never reach B", bRequests.none { it.requestUrl!!.encodedPath.endsWith("/playback/state") })
                manager()
                serverAction("server-select-$aId")
                compose.waitUntil(15000) { vm.state.value.connected && vm.state.value.account?.username == "甲" && !vm.state.value.loading }
                assertEquals("甲 的专辑", vm.state.value.albums.single().title)
                assertTrue(vm.state.value.queue.isEmpty()); assertNull(vm.state.value.current)
                assertEquals(1, aRequests.count { it.requestUrl!!.encodedPath.endsWith("/auth/login") })
                compose.onNodeWithContentDescription("设置").performClick()
                compose.onAllNodesWithText("退出登录 / 更换服务器").assertCountEquals(0)
                compose.onNodeWithText("退出登录", substring = false).performScrollTo().performClick()
                compose.onAllNodesWithText("退出登录", substring = false).onLast().performClick()
                compose.waitUntil(15000) { !vm.state.value.connected && !vm.repository.session.hasSession(aId) }
                assertTrue(vm.repository.session.hasSession(bId))
                compose.onNodeWithTag("connection-servers").performScrollTo().performClick()
                serverAction("server-select-$bId")
                compose.waitUntil(15000) { vm.state.value.connected && vm.state.value.account?.username == "乙" }
                assertEquals(1, bRequests.count { it.requestUrl!!.encodedPath.endsWith("/auth/login") })
                assertTrue(aRequests.filter { it.requestUrl!!.encodedPath.endsWith("/albums") }.all { it.getHeader("Cookie")?.contains("wildstring_session=first") == true })
                assertTrue(bRequests.filter { it.requestUrl!!.encodedPath.endsWith("/albums") }.all { it.getHeader("Cookie")?.contains("wildstring_session=second") == true })
                manager()
                serverAction("server-edit-$bId")
                compose.onNodeWithTag("server-name").performTextReplacement("客厅服务")
                compose.onNodeWithTag("server-save").performClick()
                compose.waitUntil(10000) { vm.repository.session.servers.value.any { it.name == "客厅服务" } }
                assertTrue(vm.repository.session.hasSession(bId))
                serverAction("server-delete-$aId")
                compose.onNodeWithText("删除", substring = false).performClick()
                compose.waitUntil(10000) { vm.repository.session.servers.value.none { it.id == aId } }
                assertTrue(vm.repository.session.hasSession(bId))
                compose.onNodeWithTag("servers-back").performClick()
                compose.onNodeWithTag("app-repository").performScrollTo().assertIsDisplayed()
                compose.onNodeWithTag("app-check-update").assertIsDisplayed()
                val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
                val output = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let { java.io.File(it) }
                    ?: checkNotNull(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null))
                output.mkdirs(); compose.waitForIdle()
                automation.takeScreenshot()?.let { image -> java.io.File(output, "multi-server-settings-updater.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; image.recycle() }
                // A new 401 after reconnecting is not the superseded expiry from the previous visit.
                revoked.set(true)
                runBlocking { runCatching { vm.repository.status() } }
                compose.waitUntil(10000) { !vm.state.value.connected && !vm.repository.session.hasSession(bId) }
                assertNull(vm.repository.session.read())
                compose.onNodeWithText("连接并登录").assertExists()
            } catch (failure: Throwable) {
                android.util.Log.e("MultiServerStage", "Failure before cleanup: connected=${vm.state.value.connected}, connecting=${vm.state.value.connecting}, error=${vm.state.value.error}; A paths=${aRequests.map { it.requestUrl!!.encodedPath }}; B paths=${bRequests.map { it.requestUrl!!.encodedPath }}", failure)
                throw failure
            } finally { compose.runOnIdle { vm.repository.session.invalidate(); vm.deleteServer(vm.repository.session.activeServerId.orEmpty()) } }
        } }
    }
}
