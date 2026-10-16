package com.wildstring.app

import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.ui.MusicViewModel
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Fixtures belong to the test APK. This exercises the real app navigation and screen restoration. */
class NativeNavigationTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun shell(command: String) {
        ParcelFileDescriptor.AutoCloseInputStream(InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)).use { it.readBytes() }
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        directory.mkdirs()
        // Allow SurfaceFlinger to present the frame after Compose has completed its layout.
        android.os.SystemClock.sleep(500)
        val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(directory, name).outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }
    @Test fun nativeDestinationsPreserveCatalogAndAdaptToTablet() {
        val requests = AtomicInteger()
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        compose.runOnIdle { vm.settings.theme(false); vm.settings.appearance("light") }
        val cover = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888).let { bitmap ->
            val canvas = android.graphics.Canvas(bitmap)
            canvas.drawColor(android.graphics.Color.rgb(37, 72, 60))
            val paint = android.graphics.Paint().apply { color = android.graphics.Color.rgb(218, 177, 130); isAntiAlias = true }
            canvas.drawCircle(64f, 32f, 22f, paint)
            paint.color = android.graphics.Color.rgb(160, 70, 45)
            canvas.drawRect(0f, 68f, 96f, 96f, paint)
            ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); bitmap.recycle() }.toByteArray()
        }
        val user = """{"id":"navigation-user","username":"ui-test","role":"user","enabled":true,"version":1}"""
        val track = """{"id":"navigation-track","title":"布局测试歌曲","artists":["测试艺人"],"duration_ms":12000,"has_cover":true,"loved":false,"format":"mp3","status":"available"}"""
        val albums = (1..20).joinToString(",") { """{"id":"album-$it","title":"布局测试专辑 ${it.toString().padStart(2, '0')}","artists":["测试艺人"],"track_count":1,"cover_track_id":"cover-$it"}""" }
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    fun json(value: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(value)
                    val authenticated = request.getHeader("Cookie")?.contains("wildstring_session=navigation") == true
                    if (path.endsWith("/auth/status")) return json("""{"configured":true,"authenticated":$authenticated,"user":${if (authenticated) user else "null"}}""")
                    if (path.endsWith("/auth/login")) return json(user).setHeader("Set-Cookie", "wildstring_session=navigation; Path=/; Max-Age=3600; HttpOnly")
                    if (!authenticated) return MockResponse().setResponseCode(401)
                    if (path.endsWith("/auth/logout")) return MockResponse().setResponseCode(204)
                    if (path.endsWith("/cover")) return MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(cover))
                    requests.incrementAndGet()
                    return when {
                        path.endsWith("/albums") -> json("""{"items":[$albums],"total":20,"limit":50,"offset":0}""")
                        path.endsWith("/artists") -> json("""{"items":[{"id":"artist","name":"测试艺人","track_count":1}],"total":1,"limit":50,"offset":0}""")
                        path.endsWith("/playlists") -> json("""{"items":[{"id":"playlist","name":"布局测试歌单","kind":"manual","track_count":1}],"total":1,"limit":50,"offset":0}""")
                        path.endsWith("/tracks") -> json("""{"items":[$track],"total":1,"limit":50,"offset":0}""")
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            server.start()
            try {
                compose.onAllNodes(hasSetTextAction())[0].performTextReplacement(server.url("/").toString())
                compose.onAllNodes(hasSetTextAction())[1].performTextReplacement("ui-test")
                compose.onAllNodes(hasSetTextAction())[2].performTextReplacement("test-password-original")
                compose.activityRule.scenario.onActivity { activity -> WindowCompat.getInsetsController(activity.window, activity.window.decorView).hide(WindowInsetsCompat.Type.ime()) }
                compose.onNode(isToggleable()).performScrollTo().apply {
                    if (fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ToggleableState] != androidx.compose.ui.state.ToggleableState.On) performClick()
                }
                compose.onNodeWithText("连接并登录").performScrollTo().performClick()
                compose.waitUntil(15_000) { vm.state.value.albums.size == 20 && !vm.state.value.loading }
                compose.onNodeWithTag("bottom-navigation").assertIsDisplayed()
                compose.onNodeWithTag("nav-library").assertIsSelected()
                val tabBounds = listOf("albums", "tracks", "artists").map { compose.onNodeWithTag("catalog-$it").fetchSemanticsNode().boundsInRoot }
                assertTrue("Native tabs must not overlap", tabBounds.zipWithNext().all { (a, b) -> a.right <= b.left + 1f })
                capture("native-phone-library.png")
                compose.onNodeWithTag("album-grid").performScrollToIndex(16)
                compose.onNodeWithText("布局测试专辑 17").assertIsDisplayed()
                val count = requests.get()
                compose.onNodeWithContentDescription("设置").performClick()
                compose.onNodeWithTag("settings-page").assertIsDisplayed()
                compose.onNodeWithTag("bottom-navigation").assertDoesNotExist()
                capture("native-phone-settings.png")
                compose.onNodeWithTag("settings-back").performClick()
                compose.onNodeWithText("布局测试专辑 17").assertIsDisplayed()
                assertEquals(count, requests.get())
                compose.onNodeWithContentDescription("设置").performClick()
                // Configuration changes retain the destination, and tablets constrain the settings column.
                shell("wm size 1600x1000"); shell("wm density 160")
                compose.waitUntil(15_000) { compose.onNodeWithTag("settings-page").fetchSemanticsNode().size.width > 1200 }
                capture("native-tablet-settings.png")
                assertTrue(compose.onNodeWithTag("settings-scroll").fetchSemanticsNode().size.width <= 720)
                compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
                compose.onNodeWithTag("navigation-rail").assertIsDisplayed()
                assertEquals("Opening and closing settings must not reload the catalog", count, requests.get())
                capture("native-tablet-library.png")
                shell("wm size reset"); shell("wm density reset")
                compose.waitUntil(15_000) { compose.onAllNodesWithTag("bottom-navigation").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("album-grid").performScrollToIndex(16)
                compose.onNodeWithTag("nav-search").performClick()
                compose.onNodeWithTag("catalog-search").performTextInput("测试")
                compose.onNodeWithContentDescription("清空搜索").performClick()
                compose.onNodeWithTag("catalog-search").assert(hasText("", substring = false))
                assertEquals("", vm.state.value.query)
                compose.onNodeWithTag("catalog-search").performImeAction()
                compose.onNodeWithTag("nav-mine").performClick()
                compose.waitUntil(15_000) { vm.state.value.playlists.isNotEmpty() }
                compose.onNodeWithText("布局测试歌单").assertIsDisplayed()
                capture("native-phone-mine.png")
                compose.onNodeWithText("最近听过").performClick()
                compose.waitUntil(15_000) { vm.state.value.kind == "recent" && !vm.state.value.loading }
                compose.onNodeWithContentDescription("返回曲库").performClick()
                compose.waitUntil(15_000) { vm.state.value.kind == "playlists" }
                compose.onNodeWithTag("nav-library").performClick()
                compose.onNodeWithText("布局测试专辑 17").assertIsDisplayed()
                compose.onNodeWithTag("catalog-tracks").performClick()
                compose.waitUntil(15_000) { vm.state.value.tracks.isNotEmpty() }
                compose.onNodeWithText("布局测试歌曲").assertIsDisplayed()
                compose.onNodeWithTag("catalog-artists").performClick()
                compose.waitUntil(15_000) { vm.state.value.artists.isNotEmpty() }
                compose.onNodeWithText("测试艺人").assertIsDisplayed()
            } catch (failure: Throwable) {
                runCatching { capture("native-navigation-failure.png") }
                throw failure
            } finally {
                shell("wm size reset"); shell("wm density reset")
                compose.runOnIdle { vm.settings.theme(false); vm.settings.appearance("system"); vm.logout() }
                compose.waitUntil(10_000) { !vm.state.value.connected }
            }
        }
    }
}
