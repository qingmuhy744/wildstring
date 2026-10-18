package com.wildstring.app

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import com.wildstring.app.ui.PlaybackGainPanel
import com.wildstring.app.ui.SourcePluginsPanel
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class SourceGainWorkspaceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private class Fixture : AutoCloseable {
        val server = MockWebServer()
        val paths = java.util.concurrent.ConcurrentLinkedQueue<String>()
        @Volatile var album = 0.0; @Volatile var track = 0.0; @Volatile var enabled = false
        var albumVersion = 0; var trackVersion = 0; var pluginVersion = 1
        fun json(text: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(text)
        fun gain() = """{"track_id":"song-one","album_id":"album-one","factor":1,"requested_db":${album+track},"applied_db":${album+track},"limited":false,"peak_known":true,"settings":{"version":0,"mode":"off","preamp_db":0,"prevent_clipping":true},"album":{"version":$albumVersion,"gain_db":$album},"track":{"version":$trackVersion,"gain_db":$track},"analysis":{"status":"none","error":null}}"""
        init {
            server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse = synchronized(this@Fixture) {
                val path = request.requestUrl!!.encodedPath
                paths += request.method + " " + path
                val body = request.body.readUtf8().takeIf { it.isNotBlank() }?.let { JsonParser.parseString(it).asJsonObject } ?: JsonObject()
                when {
                    path.endsWith("/auth/status") -> json("""{"configured":true,"authenticated":${request.getHeader("Cookie") != null},"user":{"id":"source-alice","username":"alice","role":"admin"}}""")
                    path.endsWith("/auth/login") -> json("{}").setHeader("Set-Cookie", "wildstring_session=source-alice; Path=/; Max-Age=3600")
                    path == "/api/v1/tracks/song-one/playback-gain" -> {
                        if (request.method == "PUT") { if (body.text("scope") == "album") { assertEquals(albumVersion.toLong(), body.number("version")); album = body.get("gain_db").asDouble; albumVersion++ } else { assertEquals(trackVersion.toLong(), body.number("version")); track = body.get("gain_db").asDouble; trackVersion++ } }
                        json(gain())
                    }
                    path == "/api/v1/manage/source-plugins/fixture-source" -> { assertEquals(pluginVersion.toLong(), body.number("version")); enabled = body.flag("enabled"); pluginVersion++; json("{}").setBodyDelay(350, java.util.concurrent.TimeUnit.MILLISECONDS) }
                    path == "/api/v1/manage/source-plugins/fixture-source/test" -> json("""{"detail":"source_plugin_configuration_changed"}""").setResponseCode(409)
                    path == "/api/v1/manage/source-plugins" -> json("""{"items":[{"id":"fixture-source","name":"合成来源插件","plugin_version":"1.0.0","version":$pluginVersion,"license":"GPL-3.0-only","upstream":"https://example.com/plugin","available":true,"enabled":$enabled,"metadata_enabled":true,"lyrics_enabled":true,"priority":50,"config":{},"settings":[]}]}""")
                    path.endsWith("/albums") || path.endsWith("/tracks") -> json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                    else -> json("{}").setResponseCode(404)
                }
            } }
            server.start(java.net.InetAddress.getByName("127.0.0.1"),0)
        }
        override fun close() = server.close()
    }
    private fun connect(fixture: Fixture): MusicViewModel {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val address = fixture.server.url("/").newBuilder().host("127.0.0.1").build().toString()
        val login = compose.runOnIdle { vm.connect(address, "alice", "synthetic-password", true) }
        compose.waitUntil(20_000) { login.isCompleted && vm.state.value.connected && !vm.state.value.connecting }
        return vm
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val folder = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let { java.io.File(it) } ?: instrumentation.targetContext.getExternalFilesDir(null)!!
        folder.mkdirs(); val image = instrumentation.uiAutomation.takeScreenshot()!!
        java.io.File(folder,name).outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }; image.recycle()
    }
    @Test fun pluginConfigurationCanBeEnabledAndSavedFromNativePanel() {
        Fixture().use { fixture ->
            val vm = connect(fixture)
            compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Surface { SourcePluginsPanel(vm) } } } }
            try { compose.waitUntil(20_000) { compose.onAllNodesWithText("合成来源插件").fetchSemanticsNodes().isNotEmpty() } }
            catch (error: Throwable) { println("Source fixture paths: ${fixture.paths}"); capture("source-plugin-failure.png"); compose.onAllNodes(isRoot()).onLast().printToLog("SourceFailure"); throw error }
            compose.onAllNodes(isToggleable()).onFirst().performClick()
            compose.onNodeWithTag("plugin-test-fixture-source").performScrollTo().assertIsNotEnabled()
            assertFalse(fixture.paths.any { it.endsWith("/fixture-source/test") })
            compose.onNodeWithText("保存 合成来源插件").performScrollTo().performClick()
            compose.waitUntil(10_000) { fixture.enabled }
            compose.waitUntil(20_000) { compose.onAllNodesWithText("插件设置已保存。").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("插件设置已保存。").performScrollTo().assertExists()
            compose.onNodeWithTag("plugin-test-fixture-source").performScrollTo().assertIsEnabled().performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("插件配置已变化", substring = true)).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("plugin-test-result-fixture-source").performScrollTo().assertIsDisplayed()
            compose.onNodeWithTag("plugin-test-fixture-source").assertIsDisplayed()
            capture("source-plugins-native.png")
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
}
