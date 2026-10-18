package com.wildstring.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import okio.Buffer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.ConcurrentLinkedQueue

class RecommendationExperienceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private class Fixture : java.io.Closeable {
        val server = MockWebServer(); val requests = ConcurrentLinkedQueue<Pair<String, String>>()
        val track = """{"id":"local-a","title":"真实本库歌曲","artists":["合成艺人"],"album":"合成专辑","duration_ms":12000,"format":"mp3","status":"available","has_cover":false,"loved":false}"""
        var preferences = """{"version":1,"use_ai":false,"use_lastfm":false,"count":20,"connection_id":"local","sources":["personal","community","discovery","revisit"],"lastfm_tags":[],"external_enabled":true,"external_refresh_days":7,"external_sources":["lastfm_charts"],"external_use_ai":false,"external_call_limit":6}"""
        var wanted = false
        val warnings = """[{"source":"ai","code":"budget_exhausted"}]"""
        val sources = """[{"id":"personal","status":"ok","matched":1},{"id":"lastfm_charts","status":"unavailable","matched":0,"error_code":"source_unavailable"}]"""
        fun daily() = """{"id":"daily","date":"2026-10-17","engine":"local","connection_id":"local","source_status":$sources,"warnings":$warnings,"degraded":true,"items":[{"track":$track,"reason":"很久没听的收藏","source_ids":["revisit"]}]}"""
        fun external() = """{"id":"external-batch","status":"ready","connection_id":"local","generated_at":"2026-10-17T00:00:00Z","next_refresh_at":"2026-10-24T00:00:00Z","cached":true,"stale":false,"warnings":[],"source_status":[{"id":"lastfm_charts","status":"ok","matched":1,"candidate_count":2,"unmatched":1}],"items":[{"external_id":"outside","name":"想去寻找的新声音","artists":["库外艺人"],"album":null,"source_url":"https://www.last.fm/music/Synthetic/song","reason":"公共榜单中的真实候选","evidence":[{"source":"lastfm_charts","summary":"公共榜单资料"}],"local_track":null,"wanted":$wanted},{"external_id":"inside","name":"真实本库歌曲","artists":["合成艺人"],"source_url":"https://www.last.fm/music/Local/song","reason":"本地匹配","evidence":[],"local_track":$track,"wanted":false}]}"""
        init {
            val audio = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.mp3").use { it.readBytes() }
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = synchronized(this) {
                    val path = request.requestUrl!!.encodedPath; val query = request.requestUrl!!.encodedQuery.orEmpty()
                    val body = request.body.readUtf8(); requests += "${request.method} $path?$query" to body
                    fun json(value: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(value)
                    val user = """{"id":"experience-user","username":"alice","role":"admin","enabled":true,"version":1}"""
                    if (path.endsWith("/auth/login")) return@synchronized json(user).setHeader("Set-Cookie", "wildstring_session=experience; Path=/; Max-Age=3600; HttpOnly")
                    if (path.endsWith("/auth/status")) { val connected = request.getHeader("Cookie")?.contains("experience") == true; return@synchronized json("""{"configured":true,"authenticated":$connected,"user":${if (connected) user else "null"}}""") }
                    if (path.endsWith("/agent/connections")) return@synchronized json("""{"items":[{"id":"personal-one","name":"我的模型","model":"synthetic-one","scope":"personal","enabled":true,"daily_call_budget":20,"daily_calls_used":20},{"id":"shared-one","name":"共享模型","model":"synthetic-two","scope":"instance","enabled":true,"daily_call_budget":30,"daily_calls_used":4}],"total":2}""")
                    if (path.endsWith("/agent/notifications")) return@synchronized json("""{"items":[],"total":0,"unread_count":0,"high_watermark":0,"next_cursor":"test-cursor"}""")
                    if (path.endsWith("/recommendations/preferences")) {
                        if (request.method == "PUT") preferences = JsonParser.parseString(body).asJsonObject.apply { addProperty("version", 2) }.toString()
                        return@synchronized json(preferences)
                    }
                    if (path.contains("/recommendations/daily")) return@synchronized json(daily())
                    if (path.endsWith("/recommendations/rankings")) return@synchronized json("""{"scope":"${request.requestUrl!!.queryParameter("scope")}","period":"30d","metric":"plays","items":[{"rank":1,"track":$track,"play_count":8,"listened_ms":120000,"reason":"汇总"}],"total":1,"limit":20,"offset":0}""")
                    if (path.endsWith("/recommendations/external/feedback")) { wanted = JsonParser.parseString(body).asJsonObject.text("action") == "want"; return@synchronized json("""{"ok":true}""") }
                    if (path.contains("/recommendations/external")) return@synchronized json(external())
                    if (path.endsWith("/ai/discover")) return@synchronized json("""{"title":"本地候选歌单","mode":"local","connection_id":"personal-one","source_status":$sources,"warnings":$warnings,"degraded":true,"items":[{"track":$track,"reason":"本地检索","source_ids":["personal"]}]}""")
                    if (path.endsWith("/stream")) return@synchronized MockResponse().setHeader("Content-Type", "audio/mpeg").setBody(Buffer().write(audio))
                    if (path.endsWith("/lyrics")) return@synchronized json("""{"kind":"none","lines":[]}""")
                    if (path.endsWith("/listening") || path.endsWith("/recommendations/feedback")) return@synchronized json("{}")
                    if (path.endsWith("/playback/state")) return@synchronized json("""{"version":0,"track_ids":[],"position_ms":0,"index":0,"mode":"sequential"}""")
                    if (path.endsWith("/tracks")) return@synchronized json("""{"items":[$track],"total":1,"limit":50,"offset":0}""")
                    if (path.endsWith("/albums") || path.endsWith("/artists") || path.endsWith("/playlists")) return@synchronized json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                    json("{}").setResponseCode(404)
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
        }
        override fun close() = server.close()
    }
    private fun connect(fixture: Fixture): MusicViewModel {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val address = fixture.server.url("/").newBuilder().host("127.0.0.1").build().toString()
        compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.appearance("light"); vm.sharing.mode("off"); vm.connect(address, "alice", "synthetic-password", true) }
        compose.waitUntil(20_000) { vm.state.value.connected && !vm.state.value.loading }
        return vm
    }
    private fun open(name: String) { compose.onNodeWithTag("nav-search").performClick(); compose.onNodeWithText(name, substring = false).performClick() }
    private fun cleanup(vm: MusicViewModel) { compose.runOnIdle { vm.controller?.stop(); vm.controller?.clearMediaItems(); vm.repository.session.invalidate() } }
    private fun capture(name: String) {
        compose.waitForIdle(); val instrumentation = InstrumentationRegistry.getInstrumentation(); instrumentation.uiAutomation.waitForIdle(500, 5_000)
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: return
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let { java.io.File(it) } ?: instrumentation.targetContext.getExternalFilesDir(null)!!
        directory.mkdirs(); java.io.File(directory, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }
    @Test fun dailyPreferencesShareConnectionsAndRankingsOnlyExposePlayableAggregate() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                open("每日推荐")
                compose.waitUntil(10_000) { compose.onAllNodesWithText("真实本库歌曲", substring = true).fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("不感兴趣", substring = false).assertDoesNotExist()
                compose.onNodeWithTag("daily-more-local-a").performClick()
                compose.onNodeWithText("不感兴趣", substring = false).assertIsDisplayed()
                InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                compose.onNodeWithText("推荐依据", substring = false).performClick()
                compose.onNodeWithText("AI：AI 预算不足，保留本地结果").assertExists()
                compose.onNodeWithTag("recommendation-settings").performClick()
                compose.onNodeWithTag("recommendation-source-community").performClick()
                compose.onNodeWithTag("ai-connection-choice").performScrollTo().performClick()
                compose.onNodeWithText("我的模型 · synthetic-one").performClick()
                compose.onNodeWithText("保存偏好").performClick()
                compose.waitUntil(10_000) { fixture.requests.any { it.first.startsWith("PUT ") } }
                val saved = JsonParser.parseString(fixture.preferences).asJsonObject
                assertEquals("personal-one", saved.text("connection_id")); assertFalse(saved["sources"].asJsonArray.any { it.asString == "community" })
                capture("recommendation-daily-phone.png")
                compose.onNode(hasText("收听排行", substring = false) and hasAnyAncestor(hasTestTag("daily-recommendations"))).performClick()
                compose.onNodeWithText("大家常听", substring = false).performClick()
                compose.waitUntil(10_000) { fixture.requests.any { it.first.contains("/rankings?") && it.first.contains("scope=community") } }
                compose.onNodeWithText("所有用户的汇总收听排行，不展示其他账号信息。").assertExists()
                compose.onNode(hasText("真实本库歌曲") and hasAnyAncestor(hasTestTag("listening-rankings"))).performClick()
                compose.waitUntil(10_000) { vm.state.value.current?.id == "local-a" }
                capture("recommendation-rankings-phone.png")
            } finally { cleanup(vm) }
        }
    }
    @Test fun aiDiscoveryExplicitlySelectsSameConnectionAndShowsActualFallback() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                open("AI 找歌")
                compose.onNodeWithText("本地找歌（不使用模型）").assertExists()
                compose.onNodeWithTag("ai-connection-choice").performClick()
                compose.onNodeWithText("我的模型 · synthetic-one").performClick()
                compose.onNodeWithText("个人连接 · 每日预算 20 次 · 已用 20 次").assertExists()
                compose.onNodeWithText("想听什么？").performTextInput("想听摇滚")
                compose.onNodeWithText("生成候选").performClick()
                compose.waitUntil(10_000) { fixture.requests.any { it.first.contains("/ai/discover?") } }
                val body = JsonParser.parseString(fixture.requests.first { it.first.contains("/ai/discover?") }.second).asJsonObject
                assertEquals("personal-one", body.text("connection_id"))
                compose.waitUntil(10_000) { compose.onAllNodesWithText("AI：AI 预算不足，保留本地结果").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("当前使用本地检索").assertExists()
            } finally { cleanup(vm) }
        }
    }
    @Test fun externalMusicHasNoFakePlaybackSupportsWantAndManualRefreshFrequency() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                open("发现新音乐")
                compose.waitUntil(10_000) { compose.onAllNodesWithText("想去寻找的新声音").fetchSemanticsNodes().isNotEmpty() }
                compose.onAllNodes(hasText("播放", substring = false) and hasAnyAncestor(hasTestTag("external-item-outside"))).assertCountEquals(0)
                compose.onNodeWithText("库外音乐 · 需自行获取后导入").assertExists()
                capture("recommendation-external-phone.png")
                compose.onAllNodesWithText("复制歌名").onFirst().performClick()
                compose.onNodeWithText("已复制艺人和歌名").assertExists()
                compose.onNode(hasText("想听", substring = false) and hasAnyAncestor(hasTestTag("external-item-outside"))).performScrollTo().performClick()
                compose.waitUntil(10_000) { fixture.wanted }
                compose.waitUntil(10_000) { compose.onAllNodesWithText("已想听").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("external-music").performScrollToNode(hasTestTag("external-music-settings"))
                compose.onNodeWithTag("external-music-settings").performClick()
                compose.onNodeWithText("每 7 天（推荐）").performClick(); compose.onNodeWithText("仅手动").performClick()
                compose.onNodeWithText("保存设置").performClick()
                compose.waitUntil(10_000) { JsonParser.parseString(fixture.preferences).asJsonObject.number("external_refresh_days") == 0L }
                val prefs = JsonParser.parseString(fixture.preferences).asJsonObject
                assertFalse(prefs.flag("external_use_ai")); assertEquals("local", prefs.text("connection_id"))
            } finally { cleanup(vm) }
        }
    }
}
