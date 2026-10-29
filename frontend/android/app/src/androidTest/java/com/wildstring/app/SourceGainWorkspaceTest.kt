package com.wildstring.app

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import com.wildstring.app.ui.PlaybackGainPanel
import com.wildstring.app.ui.AvatarSettings
import com.wildstring.app.ui.FeatureDialog
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class SourceGainWorkspaceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private class Fixture : AutoCloseable {
        val server = MockWebServer()
        val paths = java.util.concurrent.ConcurrentLinkedQueue<String>()
        @Volatile var album = 0.0; @Volatile var track = 0.0
        var albumVersion = 0; var trackVersion = 0
        var gainSettings = JsonParser.parseString("""{"version":0,"mode":"off","preamp_db":0,"prevent_clipping":true}""").asJsonObject
        @Volatile var analysisStatus = "none"
        @Volatile var cover = ByteArray(0)
        @Volatile var avatar: ByteArray? = null
        fun avatarVersion() = avatar?.let { java.security.MessageDigest.getInstance("SHA-256").digest(it).joinToString("") { b -> "%02x".format(b) } }
        fun json(text: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(text)
        fun gain() = """{"track_id":"song-one","album_id":"album-one","factor":1,"requested_db":${album+track},"applied_db":${album+track},"limited":false,"peak_known":true,"settings":$gainSettings,"album":{"version":$albumVersion,"gain_db":$album},"track":{"version":$trackVersion,"gain_db":$track},"analysis":{"status":"$analysisStatus","error":null}}"""
        init {
            server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse = synchronized(this@Fixture) {
                val path = request.requestUrl!!.encodedPath
                paths += request.method + " " + path
                if (path == "/api/v1/tracks/song-one/cover") {
                    assertNotNull(request.getHeader("Cookie"))
                    assertEquals("768", request.requestUrl!!.queryParameter("size"))
                    return@synchronized MockResponse().setHeader("Content-Type", "image/jpeg").setBody(okio.Buffer().write(cover))
                }
                if (path == "/api/v1/auth/avatar") return@synchronized when (request.method) {
                    "POST" -> { avatar = request.body.readByteArray(); json("""{"version":"${avatarVersion()}"}""") }
                    "DELETE" -> { avatar = null; MockResponse().setResponseCode(204) }
                    else -> avatar?.let { MockResponse().setHeader("Content-Type", "image/png").setBody(okio.Buffer().write(it)) } ?: json("{}").setResponseCode(404)
                }
                val body = request.body.readUtf8().takeIf { it.isNotBlank() }?.let { JsonParser.parseString(it).asJsonObject } ?: JsonObject()
                when {
                    path.endsWith("/auth/status") -> json("""{"configured":true,"authenticated":${request.getHeader("Cookie") != null},"user":{"id":"source-alice","username":"alice","profile":"owner"}}""")
                    path.endsWith("/auth/login") -> json("{}").setHeader("Set-Cookie", "wildstring_session=source-alice; Path=/; Max-Age=3600")
                    path == "/api/v1/auth/avatar/info" -> json("""{"version":${avatarVersion()?.let { "\"$it\"" } ?: "null"}}""")
                    path == "/api/v1/playback/gain-settings" -> {
                        if (request.method == "PUT") {
                            assertEquals(gainSettings.number("version"), body.number("version"))
                            gainSettings = body.deepCopy().apply { addProperty("version", body.number("version") + 1) }
                        }
                        json(gainSettings.toString())
                    }
                    path == "/api/v1/tracks/song-one/playback-gain" -> {
                        if (request.method == "PUT") { if (body.text("scope") == "album") { assertEquals(albumVersion.toLong(), body.number("version")); album = body.get("gain_db").asDouble; albumVersion++ } else { assertEquals(trackVersion.toLong(), body.number("version")); track = body.get("gain_db").asDouble; trackVersion++ } }
                        json(gain())
                    }
                    path.endsWith("/albums") || path.endsWith("/tracks") -> json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                    else -> json("{}").setResponseCode(404)
                }
            } }
            server.start(java.net.InetAddress.getByName("127.0.0.1"),0)
        }
        override fun close() { server.close() }
    }
    private fun connect(fixture: Fixture): MusicViewModel {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val address = fixture.server.url("/").newBuilder().host("127.0.0.1").build().toString()
        val login = compose.runOnIdle { vm.connect(address, "alice", "synthetic-password", true) }
        compose.waitUntil(20_000) { login.isCompleted && vm.state.value.connected && !vm.state.value.connecting }
        // Connected state can arrive before the login window returns touch focus.
        compose.waitUntil(10_000) { compose.runOnIdle { compose.activity.hasWindowFocus() } }
        return vm
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val folder = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let { java.io.File(it) } ?: instrumentation.targetContext.getExternalFilesDir(null)!!
        folder.mkdirs(); val image = instrumentation.uiAutomation.takeScreenshot()!!
        java.io.File(folder,name).outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }; image.recycle()
    }
    @Test fun retiredPluginRouteDirectsOwnersToWebWithoutLoadingConfiguration() {
        Fixture().use { fixture ->
            val vm = connect(fixture)
            compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Surface { FeatureDialog(vm, "source-plugins") {} } } } }
            compose.onNodeWithText("此项服务端管理请在网页端进行。").assertIsDisplayed()
            compose.onNodeWithText("合成来源插件").assertDoesNotExist()
            assertFalse(fixture.paths.any { it.contains("/manage/source-plugins") })
            capture("source-plugins-web-guidance.png")
        }
    }
    @Test fun manualAlbumAndTrackGainSaveIndependentlyWithVersions() {
        Fixture().use { fixture ->
            val vm = connect(fixture)
            val track = Track("song-one","合成摇滚",listOf("合成乐队"),"合成专辑",12000,albumId="album-one")
            compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Surface { PlaybackGainPanel(vm, track) } } } }
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("整张专辑增减 dB") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("整张专辑增减 dB").performScrollTo().performTextReplacement("-3")
            compose.onNodeWithText("保存专辑调整").performScrollTo().performClick()
            compose.waitUntil(10_000) { fixture.album == -3.0 }
            compose.waitUntil(20_000) { compose.onAllNodesWithText("手动调整已保存。").fetchSemanticsNodes().isNotEmpty() }
            compose.waitForIdle()
            compose.onNodeWithText("本曲额外微调 dB").performScrollTo().performTextReplacement("-2")
            compose.onNodeWithText("保存单曲调整").performScrollTo().performClick()
            compose.waitUntil(10_000) { fixture.track == -2.0 }
            compose.waitUntil(10_000) { compose.onAllNodesWithText("请求 -5.0 dB · 实际 -5.0 dB").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("请求 -5.0 dB · 实际 -5.0 dB").performScrollTo().assertExists()
            capture("playback-gain-native.png")
            assertEquals(1,fixture.albumVersion); assertEquals(1,fixture.trackVersion)
        }
    }
    @Test fun coverDownloadReadsAuthenticatedImageAndRejectsInvalidOrOversizedResponses() {
        Fixture().use { fixture ->
            val vm = connect(fixture)
            val bitmap = android.graphics.Bitmap.createBitmap(8, 8, android.graphics.Bitmap.Config.ARGB_8888)
            val output = java.io.ByteArrayOutputStream()
            bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, output); bitmap.recycle()
            fixture.cover = output.toByteArray()
            assertArrayEquals(fixture.cover, runBlocking { vm.repository.coverImage("song-one") })
            listOf("invalid image".toByteArray(), ByteArray(4 * 1024 * 1024 + 1)).forEach { bytes ->
                vm.repository.cache.clear()
                fixture.cover = bytes
                try { runBlocking { vm.repository.coverImage("song-one") }; fail("Invalid cover must not be saved") }
                catch (_: java.io.IOException) { }
            }
            assertEquals(3, fixture.paths.count { it == "GET /api/v1/tracks/song-one/cover" })
            assertFalse(fixture.paths.any { it == "PUT /api/v1/playback/state" })
        }
    }
    @Test fun automaticGainModePersistsWhenPanelIsReopened() {
        Fixture().use { fixture ->
            val vm = connect(fixture)
            val track = Track("song-one", "合成摇滚", listOf("合成乐队"), "合成专辑", 12000, albumId = "album-one")
            val generation = androidx.compose.runtime.mutableIntStateOf(0)
            compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Surface {
                androidx.compose.runtime.key(generation.intValue) { PlaybackGainPanel(vm, track) }
            } } } }
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("保存均衡设置") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("自动响度均衡：关闭").performClick()
            compose.onNodeWithText("单曲 ReplayGain", useUnmergedTree = true).performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("自动响度模式已保存。").fetchSemanticsNodes().isNotEmpty() }
            assertEquals("track", fixture.gainSettings.text("mode"))
            fixture.analysisStatus = "running"
            compose.runOnIdle { generation.intValue++ }
            compose.waitUntil(10_000) { compose.onAllNodesWithText("自动响度均衡：单曲 ReplayGain").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("自动响度均衡：单曲 ReplayGain").assertIsDisplayed()
            compose.onNodeWithText("均衡前级 dB（-12 至 12）").performTextReplacement("3")
            val reads = fixture.paths.count { it == "GET /api/v1/tracks/song-one/playback-gain" }
            compose.waitUntil(10_000) { fixture.paths.count { it == "GET /api/v1/tracks/song-one/playback-gain" } > reads }
            compose.onNodeWithText("均衡前级 dB（-12 至 12）").assertTextContains("3")
            compose.onNodeWithText("保存均衡设置").performScrollTo().performClick()
            compose.waitUntil(10_000) { fixture.gainSettings.get("preamp_db").asDouble == 3.0 }
            assertEquals("track", fixture.gainSettings.text("mode"))
        }
    }
    @Test fun retiredAlbumLyricScanRouteDirectsOwnersToWebWithoutStartingWork() {
        Fixture().use { fixture ->
            val vm = connect(fixture)
            compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Surface { FeatureDialog(vm, "lyric-scans", albumId = "album-one") {} } } } }
            compose.onNodeWithText("此项服务端管理请在网页端进行。").assertIsDisplayed()
            compose.onNodeWithTag("lyric-scans-panel").assertDoesNotExist()
            compose.onNodeWithText("开始后台扫描").assertDoesNotExist()
            assertFalse(fixture.paths.any { it.contains("/manage/lyric-scan") })
        }
    }
    @Test fun uploadedAvatarDisplaysAndCanBeResetWithoutAcceptingAnotherAccountOwner() {
        Fixture().use { fixture ->
            val vm = connect(fixture)
            val bitmap = android.graphics.Bitmap.createBitmap(80, 40, android.graphics.Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(android.graphics.Color.rgb(69, 140, 145))
            val output = java.io.ByteArrayOutputStream(); bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); bitmap.recycle()
            val bytes = output.toByteArray()
            runBlocking { vm.repository.saveAvatar(bytes, vm.repository.session.cacheScope()!!) }
            compose.runOnUiThread { vm.settings.avatarChanged(); compose.activity.setContent { MaterialTheme { Surface { AvatarSettings(vm) } } } }
            compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription("用户头像").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("选择头像").assertIsDisplayed()
            capture("avatar-native.png")
            compose.onNodeWithContentDescription("用户头像").assertIsDisplayed()
            compose.onNodeWithText("恢复默认头像").performClick()
            compose.waitUntil(10_000) { fixture.avatar == null && compose.onAllNodesWithText("已恢复默认头像。").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("用户头像").assertDoesNotExist()
            val calls = fixture.paths.count { it == "POST /api/v1/auth/avatar" }
            runBlocking {
                try { vm.repository.saveAvatar(bytes, "old-owner"); fail("A stale account owner must not upload") }
                catch (_: kotlinx.coroutines.CancellationException) { }
            }
            assertEquals(calls, fixture.paths.count { it == "POST /api/v1/auth/avatar" })
        }
    }
}
