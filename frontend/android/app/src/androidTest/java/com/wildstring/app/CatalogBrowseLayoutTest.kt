package com.wildstring.app

import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.google.gson.Gson
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.AfterClass
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test

/** Real catalog navigation against a disposable library, including the indexed phone grid. */
class CatalogBrowseLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    companion object {
        private fun shell(command: String) {
            ParcelFileDescriptor.AutoCloseInputStream(InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)).use { it.readBytes() }
        }
        @BeforeClass @JvmStatic fun prepareWindow() {
            shell("wm density 160")
            shell("wm size 390x844")
            val deadline = android.os.SystemClock.elapsedRealtime() + 30_000
            while (InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration.screenWidthDp != 390) {
                check(android.os.SystemClock.elapsedRealtime() < deadline)
                android.os.SystemClock.sleep(50)
            }
        }
        @AfterClass @JvmStatic fun restoreWindow() {
            shell("wm size reset")
            shell("wm density reset")
        }
    }

    private fun activity() = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
        .filterIsInstance<MainActivity>().single()

    private fun window(width: Int, height: Int) {
        shell("wm size ${width}x$height")
        compose.waitUntil(30_000) { compose.runOnIdle {
            activity().window.decorView.let { it.width == width && it.height == height }
        } }
        compose.waitForIdle()
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
        android.os.SystemClock.sleep(300)
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        directory.mkdirs()
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun loaded(vm: MusicViewModel, kind: String) {
        compose.waitUntil(15_000) { vm.state.value.let { it.kind == kind && !it.loading } }
        assertNull(vm.state.value.error)
    }

    private fun connect(vm: MusicViewModel, fixture: Fixture) {
        compose.runOnIdle { vm.settings.orientation("auto"); vm.settings.interfaceAnimations(false) }
        val login = compose.runOnIdle { vm.connect(fixture.server.url("/").toString(), "catalog", "synthetic-password", true) }
        compose.waitUntil(20_000) { login.isCompleted && !vm.state.value.connecting && !vm.state.value.loading }
        assertTrue("Connection failed: ${vm.state.value.error}", vm.state.value.connected)
        compose.onNodeWithTag("nav-library").performClick()
    }

    @Test fun indexedCatalogKeepsGridMenusRolesAndNavigationUsable() {
        val vm = compose.runOnIdle { ViewModelProvider(activity())[MusicViewModel::class.java] }
        Fixture().use { fixture -> try {
            connect(vm, fixture)
            for ((profile, size) in listOf("phone" to (390 to 844), "pad" to (1200 to 800))) {
                window(size.first, size.second)
                for (mode in listOf("light", "dark")) {
                    compose.runOnIdle { vm.settings.appearance(mode) }
                    compose.waitUntil(15_000) { compose.onAllNodesWithTag("appearance-$mode").fetchSemanticsNodes().isNotEmpty() }
                    compose.onNodeWithTag("catalog-albums").performClick()
                    loaded(vm, "albums")
                    compose.runOnIdle { vm.sort("title") }
                    loaded(vm, "albums")
                    compose.waitUntil(15_000) { vm.state.value.browseIndex != null }
                    compose.onNodeWithTag("catalog-result-count").assertDoesNotExist()
                    val first = compose.onNodeWithTag("album-cover-0", true).fetchSemanticsNode().boundsInRoot
                    val second = compose.onNodeWithTag("album-cover-1", true).fetchSemanticsNode().boundsInRoot
                    val third = compose.onNodeWithTag("album-cover-2", true).fetchSemanticsNode().boundsInRoot
                    assertEquals("Covers must share a row", first.top, second.top, 1f)
                    assertEquals("Covers must be square", first.width, first.height, 1f)
                    assertEquals("Covers must have equal width", first.width, second.width, 1f)
                    assertTrue(first.right < second.left)
                    if (profile == "phone") assertTrue("Phone must wrap after two albums", third.top > first.bottom)
                    else assertEquals("Pad must use additional columns", first.top, third.top, 1f)
                    val rail = compose.onNodeWithTag("alphabet-rail").fetchSemanticsNode().boundsInRoot
                    assertTrue(second.right < rail.left)
                    capture("catalog-$profile-albums-$mode")
                    compose.onNodeWithTag("catalog-sort").performClick()
                    compose.onNodeWithTag("catalog-sort-order-desc").performClick()
                    loaded(vm, "albums")
                    assertEquals("desc", vm.state.value.order)
                    compose.onNodeWithTag("catalog-item-0").performClick()
                    loaded(vm, "tracks")
                    assertEquals("album-0", vm.state.value.collectionId)
                    compose.runOnIdle { vm.back() }
                    loaded(vm, "albums")

                    compose.onNodeWithTag("catalog-artists").performClick()
                    loaded(vm, "artists")
                    compose.onNodeWithTag("catalog-result-count").assertDoesNotExist()
                    compose.onNodeWithText(uiString(R.string.lyricists)).performClick()
                    loaded(vm, "artists")
                    assertEquals("lyricist", vm.state.value.role)
                    capture("catalog-$profile-artists-$mode")

                    compose.onNodeWithTag("catalog-tracks").performClick()
                    loaded(vm, "tracks")
                    compose.waitUntil(15_000) { vm.state.value.browseIndex != null }
                    val action = compose.onNodeWithTag("track-action-0").fetchSemanticsNode().boundsInRoot
                    val nextAction = compose.onNodeWithTag("track-action-1").fetchSemanticsNode().boundsInRoot
                    assertEquals(action.right, nextAction.right, 1f)
                    assertTrue(action.width >= with(compose.density) { 48f * density } - 1f)
                    assertTrue(action.right < compose.onNodeWithTag("alphabet-rail").fetchSemanticsNode().boundsInRoot.left)
                    capture("catalog-$profile-tracks-$mode")
                    compose.onNodeWithTag("track-action-0").performClick()
                    compose.onNodeWithTag("song-actions-sheet").assertIsDisplayed()
                    compose.onNodeWithText(uiString(R.string.queue_add)).performScrollTo().performClick()
                    compose.waitUntil(15_000) { vm.state.value.queue.any { it.trackId == "track-0" } }
                    compose.onNodeWithTag("song-actions-sheet").assertDoesNotExist()
                }
            }
        } finally {
            compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.interfaceAnimations(true) }
        } }
    }

    @Test fun albumSearchRetainsCountsLoadingEmptyErrorAndPermissionStates() {
        val vm = compose.runOnIdle { ViewModelProvider(activity())[MusicViewModel::class.java] }
        Fixture().use { fixture -> try {
            connect(vm, fixture)
            for ((profile, size) in listOf("phone" to (390 to 844), "pad" to (1200 to 800))) {
                window(size.first, size.second)
                for (mode in listOf("light", "dark")) {
                    compose.runOnIdle { vm.settings.appearance(mode) }
                    compose.waitUntil(15_000) { compose.onAllNodesWithTag("appearance-$mode").fetchSemanticsNodes().isNotEmpty() }
                    compose.runOnIdle { vm.search("result-$profile-$mode"); vm.kind("albums") }
                    loaded(vm, "albums")
                    compose.onNodeWithTag("catalog-result-count").assertTextEquals(uiString(R.string.album_count, 12))
                    compose.runOnIdle { vm.kind("artists") }
                    loaded(vm, "artists")
                    compose.onNodeWithTag("catalog-result-count").assertTextEquals(uiString(R.string.artist_count, 12))
                    fixture.loading = CountDownLatch(1)
                    compose.runOnIdle { vm.search("loading-$profile-$mode"); vm.kind("albums") }
                    compose.waitUntil(15_000) { compose.onAllNodesWithTag("album-skeleton-1").fetchSemanticsNodes().isNotEmpty() }
                    val first = compose.onNodeWithTag("album-skeleton-0").fetchSemanticsNode().boundsInRoot
                    val second = compose.onNodeWithTag("album-skeleton-1").fetchSemanticsNode().boundsInRoot
                    assertEquals(first.top, second.top, 1f)
                    capture("catalog-$profile-loading-$mode")
                    fixture.loading.countDown()
                    loaded(vm, "albums")
                    for (query in listOf("empty", "error", "denied")) {
                        compose.runOnIdle { vm.search("$query-$profile-$mode"); vm.kind("albums") }
                        compose.waitUntil(15_000) { !vm.state.value.loading }
                        if (query == "empty") compose.onNodeWithText(uiString(R.string.catalog_no_matches)).assertIsDisplayed()
                        else {
                            assertNotNull("$query must explain failure", vm.state.value.error)
                            compose.onNodeWithTag("catalog-result-count").assertDoesNotExist()
                        }
                        capture("catalog-$profile-$query-$mode")
                    }
                }
            }
        } finally {
            fixture.loading.countDown()
            compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.interfaceAnimations(true) }
        } }
    }

    private class Fixture : AutoCloseable {
        val server = MockWebServer()
        @Volatile var loading = CountDownLatch(1)
        private val gson = Gson()
        private val tracks = (0..11).map { Track("track-$it", if (it == 0) "男二号和一段很长很长的合成歌曲标题用于验证截断" else "合成歌曲 $it", listOf("合成艺人和很长的名字"), "合成专辑", 195000, albumId = "album-0") }
        private val albums = (0..11).map { Album("album-$it", if (it == 0) "十一月的肖邦和一段很长的合成专辑标题用于验证两行截断" else "合成专辑 $it", listOf("合成艺人与很长很长的名字"), 12, null) }
        private val artists = (0..11).map { Artist("artist-$it", "合成艺人 $it", 12, null) }

        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val url = request.requestUrl!!
                    val path = url.encodedPath
                    val query = url.queryParameter("q").orEmpty()
                    fun json(value: Any) = MockResponse().setHeader("Content-Type", "application/json").setBody(gson.toJson(value))
                    fun page(values: List<Any>): MockResponse {
                        if (query.startsWith("loading")) loading.await(15, TimeUnit.SECONDS)
                        if (query.startsWith("denied")) return json(mapOf("detail" to "forbidden")).setResponseCode(403)
                        if (query.startsWith("error")) return json(mapOf("detail" to "synthetic_failure")).setResponseCode(500)
                        val items = if (query.startsWith("empty")) emptyList() else values
                        val offset = url.queryParameter("offset")?.toInt() ?: 0
                        val limit = url.queryParameter("limit")?.toInt() ?: 50
                        return json(mapOf("items" to items.drop(offset).take(limit), "total" to items.size, "offset" to offset, "limit" to limit))
                    }
                    return when {
                        path.endsWith("/auth/status") -> json(mapOf("configured" to true, "authenticated" to (request.getHeader("Cookie") != null), "user" to mapOf("id" to "catalog-user", "username" to "catalog", "profile" to "listener")))
                        path.endsWith("/auth/login") -> json(emptyMap<String, Any>()).setHeader("Set-Cookie", "wildstring_session=catalog; Path=/; Max-Age=3600")
                        path.endsWith("/tracks") -> page(tracks)
                        path.endsWith("/albums") -> page(albums)
                        path.endsWith("/artists") -> page(artists)
                        path.endsWith("/browse-index") -> json(BrowseIndex(url.queryParameter("kind")!!, 12,
                            (listOf("0–9") + ('A'..'Z').map { it.toString() } + "#").map { BrowseGroup(it, if (it == "H") 0 else null, if (it == "H") 12 else 0) }))
                        path.endsWith("/favorites/ids") -> json(mapOf("ids" to emptyList<String>()))
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            server.start()
        }
        override fun close() { loading.countDown(); server.shutdown() }
    }
}
