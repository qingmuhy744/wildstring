package com.wildstring.app

import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.media3.common.Player
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.Gson
import com.wildstring.app.data.Track
import com.wildstring.app.ui.MusicViewModel
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Main's new contracts exercised through real app controls and actual FLAC / fragmented AAC. */
class AccountPlaybackTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val gson = Gson()

    private fun capture(name: String) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(context.getExternalFilesDir(null))
        directory.mkdirs()
        compose.waitForIdle()
        val image = checkNotNull(automation.takeScreenshot())
        File(directory, name).outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }
    private fun login(server: String, username: String) {
        compose.onAllNodes(hasSetTextAction())[0].performTextReplacement(server)
        compose.onAllNodes(hasSetTextAction())[1].performTextReplacement(username)
        compose.onAllNodes(hasSetTextAction())[2].performTextReplacement("test-password-original")
        compose.activityRule.scenario.onActivity { activity -> WindowCompat.getInsetsController(activity.window, activity.window.decorView).hide(WindowInsetsCompat.Type.ime()) }
        // IME resizing can move physical tap targets during fixture setup on a fresh emulator.
        compose.onNode(isToggleable()).apply {
            if (fetchSemanticsNode().config[SemanticsProperties.ToggleableState] != ToggleableState.On)
                performSemanticsAction(SemanticsActions.OnClick) { it() }
            assertIsOn()
        }
        compose.onNodeWithText("连接并登录").performSemanticsAction(SemanticsActions.OnClick) { it() }
        compose.waitUntil(15_000) { compose.onAllNodesWithText("同步测试专辑").fetchSemanticsNodes().isNotEmpty() }
    }
    @Test fun aacAbsoluteTimelineEditedLyricsAndAccountIsolation() {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        compose.runOnIdle { vm.settings.quality(0); vm.settings.theme(false); vm.settings.appearance("system") }
        try { exercise(vm) } catch (error: Throwable) {
            runCatching { capture("account-aac-failure.png") }
            runCatching { compose.onRoot(useUnmergedTree = true).printToLog("AccountPlaybackUI") }
            throw error
        } finally {
            compose.runOnIdle { vm.settings.quality(0); vm.settings.theme(false); vm.settings.appearance("system"); vm.repository.session.invalidate() }
        }
    }
    private fun exercise(vm: MusicViewModel) {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val flac = assets.open("lossless.flac").use { it.readBytes() }
        val aac = assets.open("aac-full.m4a").use { it.readBytes() }
        val tail = assets.open("aac-tail-6000.m4a").use { it.readBytes() }
        val mp3 = assets.open("playback.mp3").use { it.readBytes() }
        val requests = ConcurrentLinkedQueue<String>()
        val account = AtomicReference<String?>(null)
        val lyric = AtomicReference("初始人工歌词")
        val completedAac = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
        val lossless = """{"id":"lossless","title":"无损测试曲目","artists":["合成音频"],"album":"同步测试专辑","duration_ms":12000,"has_cover":false,"loved":true,"format":"flac","status":"available"}"""
        val lossy = lossless.replace("lossless", "lossy").replace("无损", "有损").replace("flac", "mp3")
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val url = request.requestUrl!!
                    val path = url.encodedPath
                    requests += path + (url.encodedQuery?.let { "?$it" } ?: "")
                    fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                    val owner = account.get()
                    val authenticated = owner != null && request.getHeader("Cookie")?.contains("wildstring_session=$owner") == true
                    fun user(name: String) = """{"id":"user-$name","username":"$name","profile":"listener","enabled":true,"version":1}"""
                    if (path.endsWith("/auth/status")) return json("""{"configured":true,"authenticated":$authenticated,"user":${if (authenticated) user(owner!!) else "null"}}""")
                    if (path.endsWith("/auth/login")) {
                        val body = gson.fromJson(request.body.readUtf8(), Map::class.java)
                        val name = body["username"] as String
                        account.set(name)
                        return json(user(name)).setHeader("Set-Cookie", "wildstring_session=$name; Path=/; Max-Age=3600; HttpOnly")
                    }
                    if (!authenticated) return json("""{"detail":"authentication_required"}""").setResponseCode(401)
                    if (path.endsWith("/auth/logout")) { account.set(null); return MockResponse().setResponseCode(204) }
                    if (path.endsWith("/auth/password")) {
                        val body = gson.fromJson(request.body.readUtf8(), Map::class.java)
                        if (body["current_password"] != "test-password-original") return json("""{"detail":"current_password_incorrect"}""").setResponseCode(400)
                        assertEquals("test-password-updated", body["new_password"])
                        account.set(null)
                        return MockResponse().setResponseCode(204).setHeader("Set-Cookie", "wildstring_session=; Path=/; Max-Age=0")
                    }
                    if (path.endsWith("/playback")) {
                        val convert = path.contains("/lossless/")
                        val start = if (convert) url.queryParameter("start_ms")!!.toLong() else 0
                        val bitrate = url.queryParameter("bitrate_kbps")!!.toInt()
                        return json("""{"mode":"${if (convert) "transcode" else "original"}","reason":"${if (convert) "lossless_to_aac" else "lossy_passthrough"}","output":{"codec":"${if (convert) "aac" else "mp3"}","bitrate_kbps":$bitrate},"duration_ms":12000,"start_ms":$start,"stream_url":"${path.removeSuffix("/playback")}/stream${if (convert) "?format=aac&bitrate_kbps=$bitrate&start_ms=$start" else ""}"}""")
                    }
                    if (path.endsWith("/stream")) {
                        val convert = url.queryParameter("format") == "aac" && path.contains("/lossless/")
                        val bytes = if (convert) { if ((url.queryParameter("start_ms")?.toLong() ?: 0) >= 6000) tail else aac }
                            else if (path.contains("/lossless/")) flac else mp3
                        val key = path + "?" + url.encodedQuery.orEmpty()
                        val encoding = convert && if (request.method == "GET") completedAac.add(key) else key !in completedAac
                        return audioStreamFixture(request, bytes, if (convert) "audio/mp4" else if (path.contains("/lossless/")) "audio/flac" else "audio/mpeg",
                            "\"account-${key.hashCode()}\"", encoding)
                    }
                    if (path.endsWith("/lyrics")) return json("""{"kind":"synced","source":"user","lines":[{"time_ms":0,"text":"${lyric.get()}"},{"time_ms":6000,"text":"六秒后的人工歌词"}]}""")
                    if (path.endsWith("/lastfm")) return json("""{"configured":false,"connected":false,"scrobble":false,"now_playing":false,"version":0}""")
                    if (path.endsWith("/listening")) return json("""{"accepted_ms":1000}""")
                    if (path.endsWith("/albums")) return json("""{"items":[{"id":"test-album","title":"同步测试专辑","artists":["合成音频"],"track_count":2,"cover_track_id":null}],"total":1,"limit":50,"offset":0}""")
                    if (path.endsWith("/tracks")) return json("""{"items":[${if (owner == "alice") lossless else lossless.replace("true", "false")},$lossy],"total":2,"limit":50,"offset":0}""")
                    if (path.endsWith("/lossless")) return json(lossless)
                    if (path.endsWith("/lossy")) return json(lossy)
                    return MockResponse().setResponseCode(404)
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            val address = server.url("/").newBuilder().host("127.0.0.1").build().toString()
            login(address, "alice")
            assertEquals("alice", vm.state.value.account!!.username)
            val firstProfile = vm.repository.session.cacheScope()
            compose.onNodeWithText("同步测试专辑").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("无损测试曲目").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("无损测试曲目").performClick()
            compose.waitUntil(15_000) { compose.runOnIdle { vm.controller!!.isPlaying && vm.controller!!.currentPosition > 500 } }
            compose.runOnIdle { vm.controller!!.pause(); vm.seek(0); vm.controller!!.repeatMode = Player.REPEAT_MODE_ONE }
            val originalPosition = compose.runOnIdle { vm.controller!!.currentPosition }
            repeat(3) {
                if (compose.onAllNodesWithContentDescription("设置").fetchSemanticsNodes().isEmpty()) {
                    val back = if (compose.onAllNodesWithContentDescription("返回封面").fetchSemanticsNodes().isNotEmpty()) "返回封面" else "收起播放器"
                    compose.onNodeWithContentDescription(back).performClick()
                }
            }
            compose.waitUntil(5_000) { compose.onAllNodesWithContentDescription("设置").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("设置").performClick()
            compose.onNodeWithText("alice · ${compose.activity.getString(R.string.role_listener)}").assertExists()
            compose.onNodeWithTag("setting-quality").performScrollTo().performClick()
            compose.onNodeWithText("AAC · 192 kbps").performClick()
            try {
                compose.waitUntil(15_000) { vm.state.value.playbackQuality == "AAC · 192 kbps" && compose.runOnIdle { vm.controller!!.playbackState == Player.STATE_READY } }
            } catch (error: Throwable) {
                throw AssertionError("AAC status: label=${vm.state.value.playbackQuality}, state=${compose.runOnIdle { vm.controller!!.playbackState }}, error=${vm.state.value.playbackError}, requests=${requests.toList()}", error)
            }
            assertFalse(compose.runOnIdle { vm.controller!!.playWhenReady })
            assertTrue(kotlin.math.abs(compose.runOnIdle { vm.controller!!.currentPosition } - originalPosition) < 200)
            compose.onNodeWithTag("settings-back").performClick()
            compose.onNodeWithTag("mini-player-open").performClick()
            compose.runOnIdle { vm.seek(6000) }
            compose.waitUntil(15_000) { requests.any { it.contains("/lossless/stream?format=aac") && it.contains("start_ms=6000") } && compose.runOnIdle { vm.controller!!.playbackState == Player.STATE_READY } }
            assertEquals(12000L, compose.runOnIdle { vm.controller!!.duration })
            assertTrue(kotlin.math.abs(compose.runOnIdle { vm.controller!!.currentPosition } - 6000) < 200)
            compose.runOnIdle { vm.settings.quality(320) }
            compose.waitUntil(15_000) { vm.state.value.playbackQuality == "AAC · 320 kbps" && compose.runOnIdle { vm.controller!!.playbackState == Player.STATE_READY } }
            assertTrue(kotlin.math.abs(compose.runOnIdle { vm.controller!!.currentPosition } - 6000) < 200)
            assertFalse(compose.runOnIdle { vm.controller!!.playWhenReady })
            compose.onNodeWithTag("player-visual-stage").performTouchInput { click(androidx.compose.ui.geometry.Offset(4f, 4f)) }
            compose.waitUntil(10_000) { compose.onAllNodesWithText("六秒后的人工歌词").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("六秒后的人工歌词").assertIsDisplayed()
            // READY/bufferedPosition may still describe the previous quality while Media3 drains its loader.
            // Establish a paused, non-loading, stable baseline before attributing new reads to lyric refresh.
            var lastSnapshot: Pair<Int, Long>? = null
            var stableSince = android.os.SystemClock.elapsedRealtime()
            compose.waitUntil(20_000) {
                val snapshot = compose.runOnIdle {
                    val c = vm.controller!!
                    if (!c.playWhenReady && !c.isPlaying && !c.isLoading && c.playbackState == Player.STATE_READY)
                        requests.count { it.contains("/stream") } to c.currentPosition else null
                }
                val now = android.os.SystemClock.elapsedRealtime()
                if (snapshot == null || snapshot != lastSnapshot) {
                    lastSnapshot = snapshot; stableSince = now; false
                } else now - stableSince >= 3_500
            }
            val entryBeforeRefresh = vm.state.value.entryId
            val positionBeforeRefresh = compose.runOnIdle { vm.controller!!.currentPosition }
            val streamsBeforeRefresh = requests.count { it.contains("/stream") }
            lyric.set("网页修改后的人工歌词")
            compose.onNodeWithContentDescription("当前歌曲操作").performClick()
            compose.onNodeWithText("刷新歌词").performClick()
            try {
                compose.waitUntil(10_000) { vm.state.value.lyrics.lines.first().text == "网页修改后的人工歌词" }
            } catch (failure: Throwable) {
                throw AssertionError("Lyric refresh failed: ${vm.state.value.lyricsError}; requests=${requests.toList()}", failure)
            }
            assertFalse(compose.runOnIdle { vm.controller!!.playWhenReady })
            assertEquals(entryBeforeRefresh, vm.state.value.entryId)
            assertEquals(positionBeforeRefresh, compose.runOnIdle { vm.controller!!.currentPosition })
            assertEquals("Lyric refresh must not reopen a settled audio source: ${requests.toList()}", streamsBeforeRefresh, requests.count { it.contains("/stream") })
            capture("aac-lyrics-phone.png")
            // The backend's lossy passthrough must keep original audio and show the actual codec.
            val lossyTrack = gson.fromJson(lossy, Track::class.java)
            compose.runOnIdle { vm.play(listOf(lossyTrack)) }
            compose.waitUntil(15_000) { vm.state.value.playbackQuality == "原音 · MP3" && compose.runOnIdle { vm.controller!!.isPlaying } }
            assertTrue(requests.any { it == "/api/v1/tracks/lossy/stream" })
            compose.runOnIdle { vm.logout() }
            compose.waitUntil(10_000) { !vm.state.value.connected && compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().size == 3 }
            login(address, "bob")
            assertEquals("bob", vm.state.value.account!!.username)
            assertNotEquals(firstProfile, vm.repository.session.cacheScope())
            assertTrue(vm.state.value.queue.isEmpty())
            assertTrue(runBlocking { vm.repository.database.queue().entries().isEmpty() })
            compose.onNodeWithContentDescription("设置").performClick()
            compose.onNodeWithText("bob · ${compose.activity.getString(R.string.role_listener)}").assertExists()
            capture("account-settings.png")
            compose.onNodeWithText(compose.activity.getString(R.string.settings_change_password)).performClick()
            compose.onNodeWithText(compose.activity.getString(R.string.current_password)).performTextInput("wrong-password")
            compose.onNodeWithText(compose.activity.getString(R.string.new_password), substring = false).performTextInput("test-password-updated")
            compose.onNodeWithText(compose.activity.getString(R.string.confirm_password)).performTextInput("test-password-updated")
            compose.onNodeWithText(compose.activity.getString(R.string.password_save)).performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("当前密码不正确。").fetchSemanticsNodes().isNotEmpty() }
            assertTrue(vm.state.value.connected)
            compose.onNodeWithText(compose.activity.getString(R.string.current_password)).performTextReplacement("test-password-original")
            compose.onNodeWithText(compose.activity.getString(R.string.password_save)).performClick()
            compose.waitUntil(10_000) { !vm.state.value.connected }
            compose.onNodeWithText("密码已修改，请重新登录。").assertExists()
            compose.waitUntil(10_000) { vm.audioCache.bytes() == 0L && runBlocking { vm.repository.database.queue().entries().isEmpty() } }
            assertNull(vm.repository.session.cacheScope())
            assertTrue("Ordinary users must not call admin APIs", requests.none { it.contains("/manage/") })
        }
    }
}
