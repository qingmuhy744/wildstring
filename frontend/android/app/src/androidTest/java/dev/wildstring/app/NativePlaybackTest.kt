package dev.wildstring.app

import android.content.ComponentName
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.platform.app.InstrumentationRegistry
import dev.wildstring.app.playback.PlaybackService
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

    @Test fun loginCookieStreamingAndFullscreenLyrics() {
        val requests = ConcurrentLinkedQueue<RecordedRequest>()
        val audio = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.mp3").use { it.readBytes() }
        val track = """{"id":"fixture-track","title":"接口测试歌曲","artists":["接口测试艺人"],"album":"接口测试专辑","duration_ms":12000,"has_cover":false,"loved":false,"format":"mp3","status":"available"}"""
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests += request
                    val path = request.requestUrl!!.encodedPath
                    val authenticated = request.getHeader("Cookie")?.contains("wildstring_session=instrumentation") == true
                    fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                    if (path.endsWith("/auth/status")) return json("""{"configured":true,"authenticated":$authenticated}""")
                    if (path.endsWith("/auth/login")) return json("""{"username":"admin"}""").setHeader("Set-Cookie", "wildstring_session=instrumentation; Path=/; Max-Age=3600; HttpOnly")
                    if (!authenticated) return json("""{"detail":"authentication_required"}""").setResponseCode(401)
                    if (path.endsWith("/auth/logout")) return MockResponse().setResponseCode(204).setHeader("Set-Cookie", "wildstring_session=; Max-Age=0; Path=/")
                    if (path.endsWith("/stream")) {
                        val start = request.getHeader("Range")?.substringAfter("bytes=")?.substringBefore('-')?.toIntOrNull() ?: 0
                        if (start >= audio.size) return MockResponse().setResponseCode(416)
                        val response = MockResponse().setHeader("Content-Type", "audio/mpeg").setHeader("Accept-Ranges", "bytes").setBody(Buffer().write(audio, start, audio.size - start))
                        if (request.getHeader("Range") != null) response.setResponseCode(206).setHeader("Content-Range", "bytes $start-${audio.lastIndex}/${audio.size}")
                        return response
                    }
                    if (path.endsWith("/lyrics")) return json("""{"kind":"synced","source":"sidecar_lrc","lines":[{"time_ms":0,"text":"来自测试接口的歌词"},{"time_ms":5000,"text":"下一行测试歌词"}]}""")
                    if (path.endsWith("/listening")) return json("""{"accepted_ms":5000}""")
                    if (path.endsWith("/albums")) return json("""{"items":[{"id":"fixture-album","title":"接口测试专辑","artists":["接口测试艺人"],"track_count":1,"cover_track_id":null}],"total":1,"limit":50,"offset":0}""")
                    if (path.endsWith("/tracks")) return json("""{"items":[$track],"total":1,"limit":50,"offset":0}""")
                    if (path.endsWith("/fixture-track")) return json(track)
                    return MockResponse().setResponseCode(404)
                }
            }
            server.start()
            compose.onNodeWithText("服务器地址").performTextInput(server.url("/").toString())
            compose.onNodeWithText("密码", useUnmergedTree = true).assertExists()
            compose.onAllNodes(hasSetTextAction())[2].performTextInput("test-only-password")
            compose.onNode(isToggleable()).performClick()
            compose.onNodeWithText("连接并登录").performClick()
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
            fun capture(name: String) {
                val file = File(context.getExternalFilesDir(null), name)
                InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { image ->
                    file.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    image.recycle()
                }
            }
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
                capture("tablet-lyrics.png")
            } finally {
                shell("wm size reset")
                shell("wm density reset")
                MediaController.releaseFuture(future)
            }
            assertTrue(requests.filter { it.path?.contains("/stream") == true }.all { it.getHeader("Cookie")?.contains("wildstring_session=instrumentation") == true })
            assertTrue(requests.filter { it.path?.contains("/auth/login") == true }.all { it.getHeader("X-Wildstring-Client") == "android" })
        }
    }
}
