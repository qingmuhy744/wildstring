package com.wildstring.app

import android.graphics.Bitmap
import android.view.KeyEvent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonParser
import com.wildstring.app.data.AppSettings
import com.wildstring.app.ui.MusicViewModel
import java.io.File
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real app destinations and language recreation, using only a disposable local server. */
class SettingsExperienceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private class Fixture : AutoCloseable {
        val server = MockWebServer()
        @Volatile var language = "en"
        private fun account() = """{"id":"settings-user","username":"settings-test","profile":"owner","language":"$language","enabled":true,"version":1}"""
        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                    return when {
                        path.endsWith("/auth/login") -> json(account()).setHeader("Set-Cookie", "wildstring_session=settings-test; Path=/; Max-Age=3600; HttpOnly")
                        path.endsWith("/auth/status") -> json("""{"configured":true,"authenticated":true,"user":${account()},"version":"0.8.2"}""")
                        path.endsWith("/auth/preferences") -> {
                            language = JsonParser.parseString(request.body.readUtf8()).asJsonObject.get("language").asString
                            json(account())
                        }
                        path.endsWith("/auth/logout") -> MockResponse().setResponseCode(204)
                        path.endsWith("/albums") -> json("""{"items":[{"id":"settings-album","title":"中文专辑名","artists":["测试艺人"],"track_count":1}],"total":1,"limit":50,"offset":0}""")
                        path.endsWith("/tracks") || path.endsWith("/playlists") -> json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                        path.endsWith("/libraries") -> json("""{"items":[{"id":"library-1","name":"Library A"},{"id":"library-2","name":"Library B"}]}""")
                        path.endsWith("/lastfm") -> json("""{"configured":false,"connected":false,"scrobble":false,"now_playing":false,"version":0}""")
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
        }
        override fun close() = server.close()
    }

    private fun connect(fixture: Fixture): MusicViewModel {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        runBlocking { vm.connect(fixture.server.url("/").toString(), "settings-test", "public-test-password", true).join() }
        compose.waitUntil(15_000) { vm.state.value.connected && !vm.state.value.loading && vm.state.value.albums.isNotEmpty() }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Discover").fetchSemanticsNodes().isNotEmpty() }
        return vm
    }

    private fun settings() {
        compose.onNodeWithContentDescription(compose.activity.getString(R.string.settings_title)).performClick()
        compose.onNodeWithTag("setting-category-account").assertIsDisplayed()
    }

    private fun category(name: String) {
        compose.onNodeWithTag("setting-category-$name").performScrollTo().performClick()
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val root = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir") ?: return
        val screenshot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: return
        File(root).mkdirs()
        File(root, name).outputStream().use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        screenshot.recycle()
    }

    @Test fun assistantSettingsStayInPreferencesAndChatUsesItsOwnDestination() {
        Fixture().use { fixture ->
            val vm = connect(fixture)
            try {
                settings()
                category("assistant")
                compose.onNodeWithTag("setting-inbox").assertIsDisplayed()
                compose.onNodeWithText(uiString(R.string.settings_research)).assertIsDisplayed()
                compose.onNodeWithText(uiString(R.string.settings_notifications)).assertIsDisplayed()
                compose.onNodeWithText(uiString(R.string.settings_assistant)).assertDoesNotExist()
                compose.onNodeWithTag("agent-chat-input").assertDoesNotExist()
                compose.onNodeWithTag("agent-tab-drafts").assertDoesNotExist()
                capture("assistant-preferences-en.png")
                compose.onNodeWithTag("settings-back").performClick()
                compose.onNodeWithTag("settings-back").performClick()
                compose.onNodeWithTag("nav-assistant").performClick()
                compose.onNodeWithTag("agent-chat-input").assertIsDisplayed()
                compose.onNodeWithTag("settings-page").assertDoesNotExist()
            } finally { runBlocking { vm.logout().join() } }
        }
    }

    @Test fun categoriesKeepCapacityControlsInChildPagesAndRestoreAfterRecreation() {
        Fixture().use { fixture ->
            val vm = connect(fixture)
            try {
                settings()
                listOf("account", "playback", "podcast", "appearance", "storage", "assistant", "about").forEach {
                    compose.onNodeWithTag("setting-category-$it").performScrollTo().assertIsDisplayed()
                }
                compose.onNodeWithTag("setting-audio-cache").assertDoesNotExist()
                capture("settings-categories-en.png")
                category("storage")
                compose.onNodeWithTag("setting-audio-cache").performScrollTo().performClick()
                compose.onNodeWithTag("setting-option-audio-cache-32768").performScrollTo().assertIsDisplayed()
                capture("settings-cache-capacities-en.png")
                compose.onNodeWithTag("setting-option-audio-cache-32768").performClick()
                compose.runOnIdle { assertEquals(32768, vm.settings.state.value.audioMb) }
                compose.activityRule.scenario.recreate()
                compose.onNodeWithTag("setting-audio-cache").assertIsDisplayed().performClick()
                compose.onNodeWithTag("setting-option-audio-cache-32768").performScrollTo().assertIsSelected()
                compose.onNodeWithTag("setting-option-audio-cache-2048").performScrollTo().performClick()
                val reopened = AppSettings(InstrumentationRegistry.getInstrumentation().targetContext)
                reopened.bindAccount(vm.repository.session.activeServerId, vm.state.value.account!!.id)
                assertEquals(2048, reopened.state.value.audioMb)
                compose.onNodeWithTag("settings-back").performClick()
                compose.onNodeWithTag("setting-category-storage").assertIsDisplayed()
                compose.onNodeWithTag("setting-audio-cache").assertDoesNotExist()
                category("playback")
                InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
                compose.onNodeWithTag("setting-category-playback").assertIsDisplayed()
                compose.onNodeWithTag("settings-back").performClick()
                compose.onNodeWithTag("discovery-page").assertIsDisplayed()
            } finally { runBlocking { vm.logout().join() } }
        }
    }

    @Test fun languageSelectionRecreatesTheAppAndLocalizesDiscoveryAndSettings() {
        Fixture().use { fixture ->
            val vm = connect(fixture)
            try {
                compose.onNodeWithText("Recently added albums").assertIsDisplayed()
                compose.onNodeWithText("Daily mix").assertIsDisplayed()
                compose.onNodeWithText("中文专辑名").assertIsDisplayed()
                compose.onNodeWithText("最近添加的专辑").assertDoesNotExist()
                capture("discovery-localized-en.png")
                settings()
                category("account")
                compose.onNodeWithText("Custom profile picture").performScrollTo().assertIsDisplayed()
                compose.onNodeWithText("Connect Last.fm").performScrollTo().assertIsDisplayed()
                capture("settings-account-en.png")
                compose.onNodeWithTag("settings-back").performClick()
                category("about")
                compose.onNodeWithText("Check for updates").assertIsDisplayed()
                compose.onNodeWithTag("settings-back").performClick()
                category("appearance")
                compose.onNodeWithTag("setting-language").performScrollTo().performClick()
                compose.onNodeWithTag("setting-option-language-zh").performClick()
                compose.waitUntil(10_000) { fixture.language == "zh" && compose.onAllNodesWithText("外观与语言").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("语言").assertIsDisplayed()
                compose.onNodeWithTag("settings-back").performClick()
                compose.onNodeWithText("缓存与下载").assertIsDisplayed()
                capture("settings-categories-zh.png")
                compose.onNodeWithTag("settings-back").performClick()
                compose.onNodeWithText("最近添加的专辑").assertIsDisplayed()
                compose.onNodeWithText("每日推荐").assertIsDisplayed()
                compose.onNodeWithText("中文专辑名").assertIsDisplayed()
                compose.onNodeWithText("Discover").assertDoesNotExist()
                capture("discovery-localized-zh.png")
                settings()
                category("storage")
                compose.onNodeWithTag("setting-audio-cache").performClick()
                compose.onNodeWithText("取消").assertIsDisplayed()
                compose.onNodeWithTag("setting-option-audio-cache-8192").performScrollTo().performClick()
                assertEquals(8192, vm.settings.state.value.audioMb)
                capture("settings-cache-zh.png")
            } finally { runBlocking { vm.logout().join() } }
        }
    }
}
