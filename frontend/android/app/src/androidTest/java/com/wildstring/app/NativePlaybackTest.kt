package com.wildstring.app

import android.content.ComponentName
import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.Player
import androidx.lifecycle.ViewModelProvider
import com.wildstring.app.ui.MusicViewModel
import com.wildstring.app.data.CatalogQuery
import kotlinx.coroutines.runBlocking
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.mockwebserver.SocketPolicy
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.playback.PlaybackService
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentLinkedQueue
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Fixtures live only in the test APK; the installed player has no sample catalog. */
class NativePlaybackTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun capture(name: String, resized: Boolean = false) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(context.getExternalFilesDir(null))
        directory.mkdirs()
        val file = File(directory, name)
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        compose.waitForIdle()
        automation.waitForIdle(500, 5_000)
        val deadline = SystemClock.elapsedRealtime() + 15_000
        while (true) {
            val image = checkNotNull(automation.takeScreenshot())
            // SurfaceFlinger can still expose the old portrait buffer after layout has resized.
            val fresh = !resized || (image.width == 1600 && image.height == 1000 &&
                android.graphics.Color.red(image.getPixel(image.width - 20, image.height / 2)) > 8)
            if (fresh) {
                file.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
                image.recycle()
                return
            }
            image.recycle()
            check(SystemClock.elapsedRealtime() < deadline) { "Resized display has not rendered a complete frame" }
            SystemClock.sleep(200)
        }
    }

    @Test fun loginCookieStreamingAndFullscreenLyrics() {
        val previousNight = shellForTest("cmd uimode night").substringAfter("Night mode: ", "auto").trim().substringBefore('\n').let { if (it in listOf("yes", "no", "auto")) it else "auto" }
        try { exercisePlayback() } catch (failure: Throwable) {
            runCatching { capture("failure.png") }
            runCatching { compose.onRoot(useUnmergedTree = true).printToLog("NativeTestUI") }
            throw failure
        } finally { shellForTest("cmd uimode night $previousNight") }
    }

    private fun shellForTest(command: String): String {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        return ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command)).use { String(it.readBytes()) }
    }

    private fun exercisePlayback() {
        val requests = ConcurrentLinkedQueue<RecordedRequest>()
        val offline = AtomicBoolean(false)
        val unauthorized = AtomicBoolean(false)
        val audio = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.mp3").use { it.readBytes() }
        val coverBitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).apply {
            eraseColor(android.graphics.Color.rgb(20, 80, 210))
            val canvas = android.graphics.Canvas(this)
            val paint = android.graphics.Paint().apply { isAntiAlias = true; color = android.graphics.Color.rgb(245, 220, 160) }
            canvas.drawCircle(39f, 25f, 14f, paint)
            paint.color = android.graphics.Color.rgb(220, 95, 40)
            canvas.drawRect(0f, 46f, 64f, 64f, paint)
        }
        val cover = ByteArrayOutputStream().also { coverBitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        coverBitmap.recycle()
        val track = """{"id":"fixture-track","title":"接口测试歌曲","artists":["接口测试艺人"],"album":"接口测试专辑","duration_ms":12000,"has_cover":true,"loved":false,"format":"mp3","status":"available"}"""
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests += request
                    android.util.Log.i("NativeFixture", "${request.method} ${request.requestUrl!!.encodedPath}")
                    val path = request.requestUrl!!.encodedPath
                    if (offline.get()) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START)
                    if (unauthorized.get()) return MockResponse().setResponseCode(401)
                    val authenticated = request.getHeader("Cookie")?.contains("wildstring_session=instrumentation") == true
                    fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                    if (path.endsWith("/auth/status")) return json("""{"configured":true,"authenticated":$authenticated}""")
                    if (path.endsWith("/auth/login")) return json("""{"username":"admin"}""").setHeader("Set-Cookie", "wildstring_session=instrumentation; Path=/; Max-Age=3600; HttpOnly")
                    if (!authenticated) return json("""{"detail":"authentication_required"}""").setResponseCode(401)
                    if (path.endsWith("/auth/logout")) return MockResponse().setResponseCode(204).setHeader("Set-Cookie", "wildstring_session=; Max-Age=0; Path=/")
                    if (path.endsWith("/stream")) {
                        val start = request.getHeader("Range")?.substringAfter("bytes=")?.substringBefore('-')?.toIntOrNull() ?: 0
                        if (start >= audio.size) return MockResponse().setResponseCode(416)
                        val response = MockResponse().setHeader("Content-Type", "audio/mpeg").setHeader("Accept-Ranges", "bytes").setHeader("ETag", "\"fixture-v1\"").setBody(Buffer().write(audio, start, audio.size - start))
                        if (request.getHeader("Range") != null) response.setResponseCode(206).setHeader("Content-Range", "bytes $start-${audio.lastIndex}/${audio.size}")
                        return response
                    }
                    if (path.endsWith("/cover")) return MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(cover))
                    if (path.endsWith("/lyrics")) return json("""{"kind":"synced","source":"sidecar_lrc","lines":[{"time_ms":0,"text":"来自测试接口的歌词"},{"time_ms":5000,"text":"下一行测试歌词"}]}""")
                    if (path.endsWith("/listening")) return json("""{"accepted_ms":5000}""")
                    if (path.endsWith("/albums")) return json("""{"items":[{"id":"fixture-album","title":"接口测试专辑","artists":["接口测试艺人"],"track_count":1,"cover_track_id":null}],"total":1,"limit":50,"offset":0}""")
                    if (path.endsWith("/tracks")) return json("""{"items":[$track],"total":1,"limit":50,"offset":0}""")
                    if (path.endsWith("/fixture-track")) return json(track)
                    return MockResponse().setResponseCode(404)
                }
            }
            server.start()
            compose.onNodeWithText("服务器地址").performTextReplacement(server.url("/").toString())
            compose.onAllNodes(hasSetTextAction())[1].performTextReplacement("admin")
            compose.onNodeWithText("密码", useUnmergedTree = true).assertExists()
            compose.onAllNodes(hasSetTextAction())[2].performTextInput("test-only-password")
            compose.activityRule.scenario.onActivity { activity ->
                WindowCompat.getInsetsController(activity.window, activity.window.decorView).hide(WindowInsetsCompat.Type.ime())
            }
            compose.onNode(isToggleable()).performScrollTo().apply {
                if (fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ToggleableState] != androidx.compose.ui.state.ToggleableState.On) performClick()
            }
            compose.onNodeWithText("连接并登录").performScrollTo().performClick()
            compose.waitUntil(30_000) { compose.onAllNodesWithText("接口测试专辑").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("接口测试专辑").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("接口测试歌曲").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("接口测试歌曲").performClick()
            compose.waitUntil(20_000) { requests.any { it.path?.startsWith("/api/v1/tracks/fixture-track/stream") == true } }
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val future = compose.runOnIdle { MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync() }
            val player = future.get(15, TimeUnit.SECONDS)
            compose.waitUntil(20_000) { compose.runOnIdle { player.playbackState == Player.STATE_READY && player.currentPosition > 250 } }
            compose.runOnIdle { player.pause() }
            compose.onNodeWithText("歌词", useUnmergedTree = true).performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("来自测试接口的歌词").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("来自测试接口的歌词").assertIsDisplayed()
            compose.onNodeWithTag("player-phone").assertExists()
            compose.onAllNodesWithText("示例曲库").assertCountEquals(0)
            compose.onAllNodesWithText("原创示例歌词").assertCountEquals(0)
            capture("phone-lyrics.png")
            val before = compose.runOnIdle { player.currentPosition }
            val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
            fun shell(command: String) {
                ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command)).use { it.readBytes() }
            }
            try {
                shell("wm size 1600x1000")
                shell("wm density 160")
                compose.waitUntil(15_000) { compose.onAllNodesWithTag("player-tablet").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("来自测试接口的歌词").assertIsDisplayed()
                assertTrue(kotlin.math.abs(compose.runOnIdle { player.currentPosition } - before) < 500)
                capture("tablet-lyrics.png", resized = true)
            } finally {
                shell("wm size reset")
                shell("wm density reset")

            }
            val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
            compose.waitUntil(10_000) { vm.audioCache.bytes() >= audio.size }
            compose.waitUntil(10_000) { compose.onAllNodesWithTag("artwork-atmosphere").fetchSemanticsNodes().isNotEmpty() }
            val nightPosition = compose.runOnIdle { player.currentPosition }
            compose.runOnIdle { vm.settings.appearance("system") }
            shellForTest("cmd uimode night yes")
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("appearance-dark").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("player-phone").assertExists()
            capture("classic-dark-phone.png")
            shellForTest("cmd uimode night no")
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("appearance-light").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("player-phone").assertExists()
            assertTrue(kotlin.math.abs(compose.runOnIdle { player.currentPosition } - nightPosition) < 500)
            capture("classic-light-phone.png")
            assertNotNull(runBlocking { vm.repository.cachedCatalog(CatalogQuery()) })
            assertNotNull(runBlocking { vm.repository.cachedLyrics("fixture-track") })
            val buffers = AtomicInteger(0)
            val listener = object : Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) { if (playbackState == Player.STATE_BUFFERING) buffers.incrementAndGet() }
            }
            compose.runOnIdle { player.repeatMode = Player.REPEAT_MODE_ONE; player.play(); player.addListener(listener) }
            compose.waitUntil(10_000) { compose.runOnIdle { player.isPlaying && player.currentPosition > 1000 } }
            val underrunsBefore = vm.playbackHealth.audioUnderruns.get()
            val playingEntry = compose.runOnIdle { player.currentMediaItem!!.mediaId }
            compose.runOnIdle { repeat(2) { vm.addToQueue(vm.state.value.current!!) } }
            compose.waitUntil(10_000) { vm.state.value.queue.size == 3 }
            val originalOrder = vm.state.value.queue.map { it.entryId }
            fun dragEntry(from: String, to: String) {
                val queue = compose.onNodeWithTag("playback-queue")
                val bounds = queue.fetchSemanticsNode().boundsInRoot
                val start = compose.onNodeWithTag("queue-handle-$from").fetchSemanticsNode().boundsInRoot.center - bounds.topLeft
                val end = compose.onNodeWithTag("queue-handle-$to").fetchSemanticsNode().boundsInRoot.center - bounds.topLeft
                queue.performTouchInput { swipe(start, end, durationMillis = 600) }
            }
            compose.onNodeWithContentDescription("播放队列").performClick()
            val queuePosition = compose.runOnIdle { player.currentPosition }
            dragEntry(playingEntry, originalOrder.last())
            compose.waitUntil(10_000) { vm.state.value.queue.last().entryId == playingEntry }
            assertEquals(playingEntry, compose.runOnIdle { player.currentMediaItem!!.mediaId })
            assertTrue(compose.runOnIdle { player.isPlaying })
            assertTrue("Reordering must retain playback position", compose.runOnIdle { player.currentPosition } >= queuePosition)
            compose.waitUntil(10_000) { runBlocking { vm.repository.database.queue().entries().map { it.entryId } } == vm.state.value.queue.map { it.entryId } }
            capture("phone-queue.png")
            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            try {
                shellForTest("wm size 1600x1000"); shellForTest("wm density 160")
                compose.waitUntil(15_000) { compose.onAllNodesWithTag("player-tablet").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithContentDescription("播放队列").performClick()
                dragEntry(playingEntry, originalOrder[1])
                compose.waitUntil(10_000) { vm.state.value.queue.first().entryId == playingEntry }
                assertEquals(playingEntry, compose.runOnIdle { player.currentMediaItem!!.mediaId })
                capture("tablet-queue.png", resized = true)
                compose.onNodeWithContentDescription("播放队列").performClick()
            } finally { shellForTest("wm size reset"); shellForTest("wm density reset") }
            compose.runOnIdle { player.removeMediaItems(1, player.mediaItemCount) }
            // Exercise actual controls during playback and inspect both appearance options.
            compose.onNodeWithContentDescription("返回封面").performClick()
            compose.onNodeWithContentDescription("收起播放器").performClick()
            compose.onNodeWithContentDescription("设置").performClick()
            compose.onNodeWithText("深色", substring = false).performScrollTo().performClick()
            compose.onNodeWithTag("appearance-dark").assertExists()
            compose.onNodeWithText("浅色", substring = false).performScrollTo().performClick()
            compose.onNodeWithTag("appearance-light").assertExists()
            compose.onNodeWithText("跟随系统").performClick()
            compose.onNodeWithText("一块红布").performScrollTo().performClick()
            compose.onNodeWithTag("appearance-red-cloth").assertExists()
            compose.onAllNodesWithText("日夜模式").assertCountEquals(0)
            compose.onNodeWithText("红布", substring = false).performClick()
            compose.onNodeWithText("256 MB").performScrollTo().performClick()
            compose.onNodeWithText("128 MB").performClick()
            compose.waitUntil { vm.settings.state.value.audioMb == 128 && vm.settings.state.value.redCloth && vm.settings.state.value.redIcon }
            capture("red-cloth-settings.png")
            compose.onNodeWithText("完成").performScrollTo().performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("一块红布").fetchSemanticsNodes().isEmpty() }
            compose.onAllNodesWithText("接口测试歌曲").onLast().performClick()
            compose.onNodeWithText("歌词", useUnmergedTree = true).performClick()
            capture("red-cloth-phone.png")
            for (iteration in 0..2) {
                compose.onNodeWithText("返回封面", useUnmergedTree = true).performClick()
                compose.onNodeWithText("歌词", useUnmergedTree = true).performClick()
            }
            compose.waitUntil(5_000) { compose.runOnIdle { player.isPlaying && player.playbackState == Player.STATE_READY } }
            assertEquals("UI actions should not trigger audio rebuffering", 0, buffers.get())
            assertEquals("UI actions should not cause AudioTrack underruns", underrunsBefore, vm.playbackHealth.audioUnderruns.get())
            compose.runOnIdle { player.removeListener(listener); player.pause() }
            try {
                shellForTest("wm size 1600x1000"); shellForTest("wm density 160")
                compose.waitUntil(15_000) { compose.onAllNodesWithTag("player-tablet").fetchSemanticsNodes().isNotEmpty() }
                capture("red-cloth-tablet.png", resized = true)
            } finally { shellForTest("wm size reset"); shellForTest("wm density reset") }
            val streamCount = requests.count { it.path?.contains("/stream") == true }
            offline.set(true)
            compose.runOnIdle { player.stop(); player.seekTo(0); player.prepare(); player.play() }
            compose.waitUntil(20_000) { compose.runOnIdle { player.playbackState == Player.STATE_READY && player.currentPosition > 250 } }
            assertEquals("Replaying cached audio must not require a stream request", streamCount, requests.count { it.path?.contains("/stream") == true })
            compose.runOnIdle { player.pause(); vm.back(); vm.load() }
            compose.waitUntil(30_000) { vm.state.value.offline && !vm.state.value.loading }
            assertTrue(vm.state.value.hasContent)
            assertEquals("接口测试专辑", vm.state.value.albums.single().title)
            offline.set(false); unauthorized.set(true)
            compose.runOnIdle { vm.load() }
            compose.waitUntil(15_000) { !vm.state.value.connected }
            assertNull(runBlocking { vm.repository.cachedCatalog(CatalogQuery()) })
            compose.waitUntil(10_000) { vm.audioCache.bytes() == 0L && runBlocking { vm.repository.database.queue().entries().isEmpty() } }
            assertTrue(requests.filter { it.path?.contains("/stream") == true }.all { it.getHeader("Cookie")?.contains("wildstring_session=instrumentation") == true })
            assertTrue(requests.filter { it.path?.contains("/auth/login") == true }.all { it.getHeader("X-Wildstring-Client") == "android" })
            compose.runOnIdle { MediaController.releaseFuture(future) }
        }
    }
}
