package com.wildstring.app

import android.content.ComponentName
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.View
import android.view.ViewTreeObserver
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsActions
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
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.wildstring.app.playback.PlaybackService
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
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

    private data class WindowSpec(val width: Int, val height: Int, val density: Int, val night: Int? = null)
    private lateinit var phoneWindow: WindowSpec
    private lateinit var expectedWindow: WindowSpec
    private val androidMain = Handler(Looper.getMainLooper())

    private fun stage(message: String) = android.util.Log.i("NativeStage", message)

    // Compose queries synchronize with its registered roots. During recreation one
    // of those roots can be an old, detached decor; its frame callback never runs.
    // Keep the Android-window prerequisite independent of Compose/Espresso and bounded.
    private fun <T> onAndroidMain(action: () -> T): T {
        val value = AtomicReference<Result<T>>()
        val done = CountDownLatch(1)
        check(androidMain.post { value.set(runCatching(action)); done.countDown() })
        check(done.await(2, TimeUnit.SECONDS)) { "Android main thread did not answer within 2 seconds" }
        return value.get().getOrThrow()
    }

    private fun resumedActivity(): MainActivity? = ActivityLifecycleMonitorRegistry.getInstance()
        .getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().singleOrNull()

    private fun globalWindows(): List<View> = if (android.os.Build.VERSION.SDK_INT >= 29)
        android.view.inspector.WindowInspector.getGlobalWindowViews() else emptyList()

    private fun windowMatches(activity: MainActivity, spec: WindowSpec): Boolean {
        val decor = activity.window.decorView
        val configuration = activity.resources.configuration
        return decor.isAttachedToWindow && decor.isLaidOut && decor.isShown &&
            decor.width == spec.width && decor.height == spec.height && configuration.densityDpi == spec.density &&
            configuration.orientation == (if (spec.width > spec.height) Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT) &&
            (spec.night == null || configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == spec.night)
    }

    private fun waitForAndroidWindow(label: String, spec: WindowSpec = expectedWindow, dialog: Boolean = false) {
        stage("window begin $label expected=${spec.width}x${spec.height}@${spec.density} night=${spec.night} dialog=$dialog")
        val deadline = SystemClock.elapsedRealtime() + 15_000
        var lastObserved = ""
        while (SystemClock.elapsedRealtime() < deadline) {
            val rendered = CountDownLatch(1)
            val frameReady = AtomicBoolean(false)
            var observer: ViewTreeObserver? = null
            var listener: ViewTreeObserver.OnDrawListener? = null
            var candidate: View? = null
            onAndroidMain {
                val activity = resumedActivity()
                val decor = activity?.window?.decorView
                val configuration = activity?.resources?.configuration
                val observed = "activity=${activity?.hashCode()} decor=${decor?.width}x${decor?.height}@${configuration?.densityDpi} night=${configuration?.uiMode?.and(Configuration.UI_MODE_NIGHT_MASK)} attached=${decor?.isAttachedToWindow} focus=${decor?.hasWindowFocus()}" +
                    if (dialog) " windows=" + globalWindows().joinToString { "${it.javaClass.simpleName}:${it.width}x${it.height}:focus=${it.hasWindowFocus()}:attached=${it.isAttachedToWindow}" } else ""
                if (observed != lastObserved) { stage("window observed $label $observed"); lastObserved = observed }
                if (activity != null && windowMatches(activity, spec)) {
                    val activityDecor = activity.window.decorView
                    val target = if (dialog) globalWindows()
                        .firstOrNull { it !== activityDecor && it.isAttachedToWindow && it.isLaidOut && it.isShown && it.hasWindowFocus() }
                        else activityDecor.takeIf { it.hasWindowFocus() }
                    if (target != null) {
                        candidate = target
                        observer = target.viewTreeObserver
                        var draws = 0
                        listener = ViewTreeObserver.OnDrawListener {
                            if (resumedActivity() !== activity || !windowMatches(activity, spec) ||
                                !target.isAttachedToWindow || !target.hasWindowFocus()) {
                                rendered.countDown()
                            } else if (++draws >= 2) {
                                // Post after onDraw: the same final-size decor must finish two
                                // actual frames, including wm size + density's separate changes.
                                target.post { frameReady.set(true); rendered.countDown() }
                            } else target.postInvalidateOnAnimation()
                        }
                        observer!!.addOnDrawListener(listener)
                        target.postInvalidateOnAnimation()
                    }
                }
            }
            if (candidate != null) rendered.await(minOf(1_500L, maxOf(1L, deadline - SystemClock.elapsedRealtime())), TimeUnit.MILLISECONDS)
            val ready = onAndroidMain {
                if (observer?.isAlive == true && listener != null) observer!!.removeOnDrawListener(listener)
                val activity = resumedActivity()
                frameReady.get() && activity != null && windowMatches(activity, spec) &&
                    candidate?.isAttachedToWindow == true && candidate?.hasWindowFocus() == true &&
                    (dialog || activity.window.decorView === candidate)
            }
            if (ready) { stage("window ready $label"); return }
            // Poll a real readiness condition; no guessed animation-duration delay.
            SystemClock.sleep(25)
        }
        error("Android window was not ready for $label (${spec.width}x${spec.height}@${spec.density}); $lastObserved")
    }

    private fun captureFailure(name: String = "failure.png") {
        // Failure reporting must not enter Compose's potentially blocked synchronization.
        val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "native-failure-screenshot").apply { isDaemon = true } }
        try {
            executor.submit {
                val instrumentation = InstrumentationRegistry.getInstrumentation()
                val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
                    ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
                directory.mkdirs()
                instrumentation.uiAutomation.takeScreenshot()?.let { image ->
                    File(directory, name).outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    image.recycle()
                }
            }.get(3, TimeUnit.SECONDS)
        } finally { executor.shutdownNow() }
    }

    private fun capture(name: String, resized: Boolean = false, style: String? = null) {
        stage("capture begin $name")
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
            if (style != null) {
                compose.mainClock.advanceTimeBy(50)
                compose.waitForIdle()
            }
            val image = checkNotNull(automation.takeScreenshot())
            // SurfaceFlinger can still expose the old portrait buffer after layout has resized.
            val resizedFrame = !resized || (image.width == 1600 && image.height == 1000 &&
                android.graphics.Color.red(image.getPixel(image.width - 20, image.height / 2)) > 8)
            // Semantics can update before the emulator compositor presents the new visual.
            // Check a blank part of the cassette label / record surface in the real screenshot.
            val styleFrame = if (style == null) true else {
                val bounds = compose.onNodeWithTag("playback-visual-$style").fetchSemanticsNode().boundsInRoot
                val side = minOf(bounds.width, bounds.height)
                val x = (bounds.left + side * if (style == "cassette") .85f else .5f).toInt()
                val y = (bounds.top + side * if (style == "cassette") .44f else .18f).toInt()
                if (x !in 0 until image.width || y !in 0 until image.height) false else {
                    val pixel = image.getPixel(x, y)
                    val red = android.graphics.Color.red(pixel)
                    val green = android.graphics.Color.green(pixel)
                    val blue = android.graphics.Color.blue(pixel)
                    if (style == "cassette") kotlin.math.abs(red - 233) < 12 && kotlin.math.abs(green - 221) < 12 && kotlin.math.abs(blue - 196) < 12
                    else red in 15..65 && green in 20..75 && blue in 10..60
                }
            }
            val fresh = resizedFrame && styleFrame
            if (fresh) {
                file.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
                image.recycle()
                stage("capture complete $name")
                return
            }
            image.recycle()
            check(SystemClock.elapsedRealtime() < deadline) { "Display has not rendered a complete ${style ?: "resized"} frame" }
            SystemClock.sleep(200)
        }
    }

    @Test fun loginCookieStreamingAndFullscreenLyrics() {
        stage("test begin")
        val previousNight = shellForTest("cmd uimode night").substringAfter("Night mode: ", "auto").trim().substringBefore('\n').let { if (it in listOf("yes", "no", "auto")) it else "auto" }
        try { exercisePlayback() } catch (failure: Throwable) {
            android.util.Log.e("NativeStage", "test failed", failure)
            runCatching { captureFailure() }
            throw failure
        } finally {
            runCatching { onAndroidMain { resumedActivity()?.let { ViewModelProvider(it)[MusicViewModel::class.java] }?.let { vm -> vm.settings.playbackStyle("cover"); vm.repository.session.invalidate(); vm.controller?.stop(); vm.controller?.clearMediaItems() } } }
            shellForTest("cmd uimode night $previousNight")
            stage("test cleanup complete")
        }
    }

    private fun shellForTest(command: String): String {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        return ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command)).use { String(it.readBytes()) }
    }

    private fun changeSystemNightMode(mode: String) {
        stage("system night $mode")
        shellForTest("cmd uimode night $mode")
    }

    private fun rotate(orientation: Int) {
        stage("rotate $orientation")
        onAndroidMain { checkNotNull(resumedActivity()).requestedOrientation = orientation }
    }

    private fun waitForConfigurationTag(tag: String) {
        expectedWindow = when (tag) {
            "player-tablet" -> WindowSpec(1600, 1000, 160)
            "player-landscape" -> phoneWindow.copy(width = maxOf(phoneWindow.width, phoneWindow.height), height = minOf(phoneWindow.width, phoneWindow.height))
            "player-phone" -> phoneWindow
            "appearance-dark" -> expectedWindow.copy(night = Configuration.UI_MODE_NIGHT_YES)
            "appearance-light" -> expectedWindow.copy(night = Configuration.UI_MODE_NIGHT_NO)
            else -> error("Unknown configuration expectation $tag")
        }
        waitForAndroidWindow(tag)
        compose.onNodeWithTag(tag).assertIsDisplayed()
        stage("semantics ready $tag")
    }

    private fun waitForActivityWindow() {
        // The injected click schedules dialog dismissal on Compose's test clock.
        // Advance that clock without querying/synchronizing any possibly replaced root.
        compose.mainClock.advanceTimeByFrame()
        waitForAndroidWindow("activity")
    }

    private fun waitForDialogWindow(label: String) {
        compose.mainClock.advanceTimeByFrame()
        waitForAndroidWindow(label, dialog = true)
    }

    private fun waitForArtworkWindow() {
        // A Compose dialog can expose semantics before InputDispatcher gives its
        // Android window focus. Send Back only once that actual window is active.
        waitForDialogWindow("artwork")
        compose.onNodeWithTag("artwork-preview").assertIsDisplayed()
        compose.onNodeWithContentDescription("下载封面").assertIsDisplayed()
    }

    private fun exercisePlayback() {
        phoneWindow = onAndroidMain {
            val activity = checkNotNull(resumedActivity())
            WindowSpec(activity.window.decorView.width, activity.window.decorView.height, activity.resources.configuration.densityDpi)
        }
        expectedWindow = phoneWindow
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        compose.runOnIdle { vm.settings.playbackStyle("cover") }
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
                        return audioStreamFixture(request, audio, "audio/mpeg", "\"fixture-v1\"")
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
            stage("login begin")
            compose.onNodeWithText("服务器地址").performTextReplacement(server.url("/").toString())
            compose.onAllNodes(hasSetTextAction())[1].performTextReplacement("admin")
            compose.onNodeWithText("密码", useUnmergedTree = true).assertExists()
            compose.onAllNodes(hasSetTextAction())[2].performTextInput("test-only-password")
            compose.activityRule.scenario.onActivity { activity ->
                WindowCompat.getInsetsController(activity.window, activity.window.decorView).hide(WindowInsetsCompat.Type.ime())
            }
            // Use the actual control action without racing IME/window movement during setup.
            compose.onNode(isToggleable()).apply {
                if (fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.ToggleableState] != androidx.compose.ui.state.ToggleableState.On)
                    performSemanticsAction(SemanticsActions.OnClick) { it() }
                assertIsOn()
            }
            compose.onNodeWithText("连接并登录").performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.waitUntil(30_000) { compose.onAllNodesWithText("接口测试专辑").fetchSemanticsNodes().isNotEmpty() }
            stage("login complete")
            compose.onNodeWithText("接口测试专辑").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("接口测试歌曲").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("接口测试歌曲").performClick()
            compose.waitUntil(20_000) { requests.any { it.path?.startsWith("/api/v1/tracks/fixture-track/stream") == true } }
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val future = compose.runOnIdle { MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync() }
            val player = future.get(15, TimeUnit.SECONDS)
            compose.waitUntil(20_000) { compose.runOnIdle { player.playbackState == Player.STATE_READY && player.currentPosition > 250 } }
            stage("audio ready")
            compose.runOnIdle { player.pause() }
            compose.onNodeWithTag("player-visual-stage").performTouchInput { click(androidx.compose.ui.geometry.Offset(4f, 4f)) }
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
                waitForConfigurationTag("player-tablet")
                compose.onNodeWithText("来自测试接口的歌词").assertIsDisplayed()
                assertTrue(kotlin.math.abs(compose.runOnIdle { player.currentPosition } - before) < 500)
                capture("tablet-lyrics.png", resized = true)
            } finally {
                shell("wm size reset")
                shell("wm density reset")

            }
            waitForConfigurationTag("player-phone")
            compose.waitUntil(10_000) { vm.audioCache.bytes() >= audio.size }
            compose.waitUntil(10_000) { compose.onAllNodesWithTag("artwork-atmosphere").fetchSemanticsNodes().isNotEmpty() }
            val nightPosition = compose.runOnIdle { player.currentPosition }
            compose.runOnIdle { vm.settings.appearance("system") }
            changeSystemNightMode("yes")
            waitForConfigurationTag("appearance-dark")
            compose.onNodeWithTag("player-phone").assertExists()
            capture("classic-dark-phone.png")
            changeSystemNightMode("no")
            waitForConfigurationTag("appearance-light")
            compose.onNodeWithTag("player-phone").assertExists()
            assertTrue(kotlin.math.abs(compose.runOnIdle { player.currentPosition } - nightPosition) < 500)
            capture("classic-light-phone.png")
            // Styles share the same Media3 entry and fully cached audio while paused.
            compose.onNodeWithTag("player-visual-stage").performTouchInput { click(androidx.compose.ui.geometry.Offset(4f, 4f)) }
            val styleEntry = compose.runOnIdle { player.currentMediaItem!!.mediaId }
            val stylePosition = compose.runOnIdle { player.currentPosition }
            val styleStreams = requests.count { it.path?.contains("/stream") == true }
            for ((key, label) in listOf("vinyl" to "黑胶", "cassette" to "磁带", "cover" to "封面")) {
                stage("style begin $key")
                compose.onNodeWithContentDescription("收起播放器").performClick()
                compose.onNodeWithContentDescription("设置").performClick()
                compose.onNodeWithTag("setting-播放样式").performScrollTo().performClick()
                waitForDialogWindow("style choice $key")
                compose.onNode(hasText(label) and hasAnyAncestor(isDialog()), useUnmergedTree = true).performClick()
                waitForActivityWindow()
                compose.onNodeWithTag("settings-back").performClick()
                compose.onNodeWithTag("mini-player-open").performClick()
                compose.mainClock.advanceTimeBy(250)
                compose.waitForIdle()
                // The platform dialog exits on Android's clock, independently of Compose's clock.
                compose.waitUntil(5_000) {
                    runCatching { compose.onNodeWithTag("playback-visual-$key").assertIsDisplayed() }.isSuccess
                }
                compose.onNodeWithTag("playback-visual-$key").assertIsDisplayed()
                compose.onNodeWithContentDescription("播放样式").assertDoesNotExist()
                assertEquals(key, vm.settings.state.value.playbackStyle)
                assertEquals(styleEntry, compose.runOnIdle { player.currentMediaItem!!.mediaId })
                assertFalse(compose.runOnIdle { player.playWhenReady })
                assertTrue(kotlin.math.abs(compose.runOnIdle { player.currentPosition } - stylePosition) < 250)
                compose.onNodeWithTag("playback-visual-$key").performTouchInput { longClick() }
                waitForArtworkWindow()
                if (key == "vinyl") capture("player-artwork-preview.png")
                if (key == "cassette") InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
                else compose.onNodeWithContentDescription("关闭大封面").performClick()
                waitForActivityWindow()
                compose.onNodeWithTag("artwork-preview").assertDoesNotExist()
                compose.onNodeWithTag("playback-visual-$key").assertIsDisplayed()
                assertEquals(styleEntry, compose.runOnIdle { player.currentMediaItem!!.mediaId })
                assertFalse(compose.runOnIdle { player.playWhenReady })
                assertTrue(kotlin.math.abs(compose.runOnIdle { player.currentPosition } - stylePosition) < 250)
                if (key != "cover") {
                    capture("player-$key-phone.png", style = key)
                    val orientation = compose.runOnIdle { compose.activity.requestedOrientation }
                    try {
                        rotate(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE)
                        waitForConfigurationTag("player-landscape")
                        capture("player-$key-landscape.png", style = key)
                        compose.onNodeWithContentDescription("播放").assertIsDisplayed()
                        compose.onNodeWithContentDescription("上一首").assertIsDisplayed()
                        compose.onNodeWithContentDescription("下一首").assertIsDisplayed()
                        val visualBounds = compose.onNodeWithTag("playback-visual-$key").fetchSemanticsNode().boundsInRoot
                        val controlsBounds = compose.onNodeWithContentDescription("播放").fetchSemanticsNode().boundsInRoot
                        val playerBounds = compose.onNodeWithTag("player-landscape").fetchSemanticsNode().boundsInRoot
                        assertTrue("Landscape must retain a large visual", visualBounds.width > playerBounds.height * .45f)
                        assertTrue("Landscape controls belong beside the visual", visualBounds.right < controlsBounds.left)
                        assertEquals(styleEntry, compose.runOnIdle { player.currentMediaItem!!.mediaId })
                        assertTrue(kotlin.math.abs(compose.runOnIdle { player.currentPosition } - stylePosition) < 250)
                    } finally { rotate(orientation) }
                    waitForConfigurationTag("player-phone")
                }
                stage("style complete $key")
            }
            assertEquals("Changing style must not reopen audio", styleStreams, requests.count { it.path?.contains("/stream") == true })
            compose.onNodeWithTag("player-visual-stage").performTouchInput { click(androidx.compose.ui.geometry.Offset(4f, 4f)) }
            assertNotNull(runBlocking { vm.repository.cachedCatalog(CatalogQuery()) })
            assertNotNull(runBlocking { vm.repository.cachedLyrics("fixture-track") })
            val buffers = AtomicInteger(0)
            val playbackEvents = ConcurrentLinkedQueue<String>()
            val listener = object : Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) {
                    playbackEvents += "state=$playbackState position=${player.currentPosition}/${player.duration} loading=${player.isLoading}"
                    if (playbackState == Player.STATE_BUFFERING) buffers.incrementAndGet()
                }
                override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                    playbackEvents += "discontinuity=$reason ${oldPosition.positionMs}->${newPosition.positionMs}"
                }
            }
            compose.runOnIdle { player.repeatMode = Player.REPEAT_MODE_ONE; player.play() }
            // Measure UI work after resume and prebuffering have completed, not startup loading.
            compose.waitUntil(10_000) { compose.runOnIdle {
                player.isPlaying && player.playbackState == Player.STATE_READY && !player.isLoading &&
                    player.currentPosition > 1000 && player.bufferedPosition >= player.duration - 100
            } }
            val underrunsBefore = compose.runOnIdle { player.addListener(listener); vm.playbackHealth.audioUnderruns.get() }
            val playingEntry = compose.runOnIdle { player.currentMediaItem!!.mediaId }
            compose.runOnIdle { repeat(2) { vm.addToQueue(vm.state.value.current!!) } }
            compose.waitUntil(10_000) { vm.state.value.queue.size == 3 }
            val originalOrder = vm.state.value.queue.map { it.entryId }
            fun dragEntry(from: String, to: String) {
                val queue = compose.onNodeWithTag("playback-queue")
                val bounds = queue.fetchSemanticsNode().boundsInRoot
                val start = compose.onNodeWithTag("queue-handle-$from").fetchSemanticsNode().boundsInRoot.center - bounds.topLeft
                val end = compose.onNodeWithTag("queue-handle-$to").fetchSemanticsNode().boundsInRoot.center - bounds.topLeft
                // Let the real layout consume pickup and movement before releasing. A single
                // injected batch can be coalesced on a busy emulator after a density change.
                queue.performTouchInput { down(start); moveTo(start + (end - start) * .2f, delayMillis = 150) }
                queue.performTouchInput {
                    moveTo(end + androidx.compose.ui.geometry.Offset(0f, if (end.y > start.y) 8f else -8f), delayMillis = 450)
                }
                queue.performTouchInput { up() }
            }
            compose.runOnIdle { vm.notify("播放队列操作反馈") }
            compose.waitUntil(5_000) { compose.onAllNodesWithText("播放队列操作反馈").fetchSemanticsNodes().isNotEmpty() }
            val feedbackBounds = compose.onNodeWithTag("mutation-feedback").fetchSemanticsNode().boundsInRoot
            val queueButtonBounds = compose.onNodeWithContentDescription("播放队列").fetchSemanticsNode().boundsInRoot
            assertFalse("Feedback must leave playback controls reachable", feedbackBounds.overlaps(queueButtonBounds))
            capture("phone-player-before-queue.png")
            compose.onNodeWithContentDescription("播放队列").performClick()
            try { compose.waitUntil(10_000) { compose.onAllNodesWithTag("playback-queue").fetchSemanticsNodes().isNotEmpty() } }
            catch (failure: Throwable) {
                runCatching { captureFailure("phone-queue-failure.png") }
                throw failure
            }
            waitForDialogWindow("phone queue")
            val queuePosition = compose.runOnIdle { player.currentPosition }
            dragEntry(playingEntry, originalOrder.last())
            compose.waitUntil(10_000) { vm.state.value.queue.last().entryId == playingEntry }
            assertEquals(playingEntry, compose.runOnIdle { player.currentMediaItem!!.mediaId })
            assertTrue(compose.runOnIdle { player.isPlaying })
            assertTrue("Reordering must retain playback position", compose.runOnIdle { player.currentPosition } >= queuePosition)
            compose.waitUntil(10_000) { runBlocking { vm.repository.database.queue().entries().map { it.entryId } } == vm.state.value.queue.map { it.entryId } }
            capture("phone-queue.png")
            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            waitForActivityWindow()
            compose.onNodeWithTag("playback-queue").assertDoesNotExist()
            try {
                shellForTest("wm size 1600x1000"); shellForTest("wm density 160")
                waitForConfigurationTag("player-tablet")
                capture("tablet-player-before-queue.png", resized = true)
                compose.onNodeWithContentDescription("播放队列").performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("playback-queue").fetchSemanticsNodes().isNotEmpty() }
                // wm size and wm density recreate the activity separately. Wait for the new
                // SurfaceFlinger buffer as well as semantics before injecting coordinates.
                capture("tablet-queue-before-drag.png", resized = true)
                dragEntry(playingEntry, originalOrder[1])
                compose.waitUntil(10_000) { vm.state.value.queue.first().entryId == playingEntry }
                assertEquals(playingEntry, compose.runOnIdle { player.currentMediaItem!!.mediaId })
                capture("tablet-queue.png", resized = true)
                compose.onNodeWithContentDescription("播放队列").performClick()
            } catch (failure: Throwable) {
                runCatching { captureFailure("tablet-queue-failure.png") }
                throw failure
            } finally { shellForTest("wm size reset"); shellForTest("wm density reset") }
            waitForConfigurationTag("player-phone")
            stage("appearance controls begin")
            compose.runOnIdle { player.removeMediaItems(1, player.mediaItemCount) }
            // Exercise actual controls during playback and inspect both appearance options.
            compose.onNodeWithContentDescription("返回封面").performClick()
            compose.onNodeWithContentDescription("收起播放器").performClick()
            compose.onNodeWithContentDescription("设置").performClick()
            compose.onNodeWithTag("setting-日夜模式").performScrollTo().performClick()
            waitForDialogWindow("dark choice")
            compose.onNodeWithText("深色", substring = false).performClick()
            waitForActivityWindow()
            compose.onNodeWithTag("appearance-dark").assertExists()
            compose.onNodeWithTag("setting-日夜模式").performScrollTo().performClick()
            waitForDialogWindow("light choice")
            compose.onNodeWithText("浅色", substring = false).performClick()
            waitForActivityWindow()
            compose.onNodeWithTag("appearance-light").assertExists()
            compose.onNodeWithTag("setting-日夜模式").performScrollTo().performClick()
            waitForDialogWindow("system choice")
            compose.onNodeWithText("跟随系统").performClick()
            waitForActivityWindow()
            compose.onNodeWithTag("setting-主题").performScrollTo().performClick()
            waitForDialogWindow("theme choice")
            compose.onNodeWithText("一块红布").performClick()
            waitForActivityWindow()
            compose.onNodeWithTag("appearance-red-cloth").assertExists()
            compose.onAllNodesWithText("日夜模式").assertCountEquals(0)
            compose.onNodeWithTag("setting-桌面图标").performScrollTo().performClick()
            waitForDialogWindow("icon choice")
            compose.onNodeWithText("红布", substring = false).performClick()
            waitForActivityWindow()
            compose.onNodeWithTag("setting-最近播放音频").performScrollTo().performClick()
            waitForDialogWindow("cache choice")
            compose.onNodeWithText("128 MB").performClick()
            waitForActivityWindow()
            compose.waitUntil { vm.settings.state.value.audioMb == 128 && vm.settings.state.value.redCloth && vm.settings.state.value.redIcon }
            capture("red-cloth-settings.png")
            compose.onNodeWithTag("settings-back").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("一块红布").fetchSemanticsNodes().isEmpty() }
            compose.onAllNodesWithText("接口测试歌曲").onLast().performClick()
            compose.onNodeWithTag("player-visual-stage").performTouchInput { click(androidx.compose.ui.geometry.Offset(4f, 4f)) }
            capture("red-cloth-phone.png")
            for (iteration in 0..2) {
                compose.onNodeWithTag("player-visual-stage").performTouchInput { click(androidx.compose.ui.geometry.Offset(4f, 4f)) }
                compose.onNodeWithTag("player-visual-stage").performTouchInput { click(androidx.compose.ui.geometry.Offset(4f, 4f)) }
            }
            compose.waitUntil(5_000) { compose.runOnIdle { player.isPlaying && player.playbackState == Player.STATE_READY } }
            assertEquals("UI actions should not trigger audio rebuffering: ${playbackEvents.toList()}", 0, buffers.get())
            assertEquals("UI actions should not cause AudioTrack underruns", underrunsBefore, vm.playbackHealth.audioUnderruns.get())
            compose.runOnIdle { player.removeListener(listener); player.pause() }
            try {
                shellForTest("wm size 1600x1000"); shellForTest("wm density 160")
                waitForConfigurationTag("player-tablet")
                capture("red-cloth-tablet.png", resized = true)
                for (style in listOf("vinyl", "cassette")) {
                    compose.runOnIdle { vm.settings.playbackStyle(style) }
                    compose.waitUntil(5_000) { compose.onAllNodesWithTag("playback-visual-$style").fetchSemanticsNodes().isNotEmpty() }
                    compose.mainClock.advanceTimeBy(450)
                    compose.waitForIdle()
                    capture("player-$style-tablet.png", resized = true, style = style)
                }
                compose.runOnIdle { vm.settings.playbackStyle("cover") }
            } finally { shellForTest("wm size reset"); shellForTest("wm density reset") }
            waitForConfigurationTag("player-phone")
            stage("offline begin")
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
            stage("playback assertions complete")
        }
    }
}
