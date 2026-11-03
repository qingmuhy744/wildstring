package com.wildstring.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
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
    private class Fixture(val canAddPodcasts: Boolean = true, val profile: String = "owner") : java.io.Closeable {
        val server = MockWebServer(); val requests = ConcurrentLinkedQueue<Pair<String, String>>()
        val track = """{"id":"local-a","title":"真实本库歌曲","artists":["合成艺人"],"album":"合成专辑","duration_ms":12000,"format":"mp3","status":"available","has_cover":false,"loved":false}"""
        var preferences = """{"version":1,"use_ai":false,"use_lastfm":false,"count":20,"connection_id":"local","sources":["personal","community","discovery","revisit"],"lastfm_tags":[],"external_enabled":true,"external_refresh_days":7,"external_sources":["lastfm_charts"],"external_use_ai":false,"external_call_limit":6}"""
        var wanted = false
        @Volatile var podcastAdded = false
        @Volatile var directoryThrottled = false
        val podcast = """{"id":"explore-show","title":"探索测试节目","author":"合成工作室","description":"公开节目简介","feed_url":"https://podcast.example/feed.xml","cover_url":"","total_episodes":1,"followed":true}"""
        val episode = """{"id":"explore-episode","podcast_id":"explore-show","guid":"episode-1","title":"探索后的第一集","audio_url":"https://podcast.example/episode.mp3","duration_seconds":1800,"pub_date":"2026-11-01T00:00:00Z"}"""
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
                    val user = """{"id":"experience-user","username":"alice","profile":"$profile","enabled":true,"version":1}"""
                    if (path.endsWith("/auth/login")) return@synchronized json(user).setHeader("Set-Cookie", "wildstring_session=experience; Path=/; Max-Age=3600; HttpOnly")
                    if (path.endsWith("/auth/status")) { val connected = request.getHeader("Cookie")?.contains("experience") == true; return@synchronized json("""{"configured":true,"authenticated":$connected,"user":${if (connected) user else "null"}}""") }
                    if (path.endsWith("/podcasts/catalog-settings")) return@synchronized json("""{"can_add":$canAddPodcasts,"allow_user_subscriptions":$canAddPodcasts,"version":1}""")
                    if (path.endsWith("/podcasts/discover") || path.endsWith("/podcasts/search")) {
                        if (directoryThrottled) return@synchronized json("""{"detail":{"code":"podcast_search_upstream_rate_limited","retry_after":60}}""").setResponseCode(429)
                        return@synchronized json("""{"results":[{"itunes_id":"12345","title":"探索测试节目","author":"合成工作室","feed_url":"https://podcast.example/feed.xml","artwork_url":"","genres":["社会与文化"],"explicit":false,"catalog_podcast_id":null,"followed":false}],"regions":["${request.requestUrl!!.queryParameter("region") ?: "tw"}"],"explicit_hidden":0,"failed_regions":[]}""")
                    }
                    if (path.endsWith("/podcasts/preview")) return@synchronized json("""{"title":"探索测试节目","author":"合成工作室","description":"<p>公开节目简介</p>","episode_count":1,"latest_episodes":[{"title":"探索后的第一集","pub_date":"2026-11-01"}],"catalog_podcast_id":null,"followed":false}""")
                    if (path.endsWith("/podcasts/explore-show")) return@synchronized json("""{"podcast":$podcast,"episodes":[$episode]}""")
                    if (path.endsWith("/podcasts")) {
                        if (request.method == "POST") { podcastAdded = true; return@synchronized json("""{"podcast":$podcast,"episodes":[$episode]}""") }
                        return@synchronized json(if (podcastAdded) "[$podcast]" else "[]")
                    }
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
        // Login dismisses a separate window; state can be connected before touch focus returns.
        compose.waitUntil(10_000) {
            var focused = false
            InstrumentationRegistry.getInstrumentation().runOnMainSync { focused = compose.activity.hasWindowFocus() }
            focused
        }
        return vm
    }
    private fun open(name: String) {
        compose.onNodeWithTag("nav-search").assertIsDisplayed().performClick()
        val entry = hasText(name, substring = false) and hasClickAction()
        compose.waitUntil(10_000) { compose.onAllNodes(entry).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(entry).assertIsDisplayed().performClick()
    }
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
                open(uiString(R.string.daily_recommendations))
                compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("daily-summary") and hasText(uiString(R.string.daily_summary, 1), substring = true)).fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("daily-summary").assertTextContains(uiString(R.string.recommendation_source_personal), substring = true)
                compose.onNode(hasTestTag("daily-track-local-a") and hasText(uiString(R.string.recommendation_source_revisit), substring = true)).assertExists()
                compose.onNodeWithTag("daily-recommendations").performScrollToNode(hasTestTag("daily-track-local-a"))
                val more = hasTestTag("daily-more-local-a") and hasClickAction()
                // The clickable row merges descendants; target the actual nested button.
                compose.waitUntil(10_000) { compose.onAllNodes(more, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText(uiString(R.string.recommendation_not_interested), substring = false).assertDoesNotExist()
                compose.onNode(more, useUnmergedTree = true).performScrollTo().assertIsDisplayed().performClick()
                compose.onNodeWithText(uiString(R.string.recommendation_not_interested), substring = false).assertIsDisplayed()
                InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                compose.onNodeWithTag("daily-recommendations").performScrollToIndex(0)
                compose.onNodeWithTag("daily-more-actions").performClick()
                compose.onNodeWithTag("recommendation-evidence").performClick()
                compose.onNodeWithText("AI：AI 预算不足，保留本地结果").assertExists()
                compose.onNodeWithTag("daily-more-actions").performClick()
                compose.onNodeWithTag("recommendation-settings").performClick()
                compose.onNodeWithTag("recommendation-source-community").performScrollTo().assertIsOn().performClick().assertIsOff()
                compose.onNodeWithTag("ai-connection-choice").performScrollTo().performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("ai-connection-personal-one").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("ai-connection-personal-one").performClick()
                compose.onNodeWithTag("ai-connection-choice").assertTextContains("我的模型 · synthetic-one")
                compose.onNodeWithText("保存偏好").performClick()
                compose.waitUntil(10_000) { fixture.requests.any { it.first.startsWith("PUT ") } }
                val saved = JsonParser.parseString(fixture.preferences).asJsonObject
                assertEquals("personal-one", saved.text("connection_id")); assertFalse(saved["sources"].asJsonArray.any { it.asString == "community" })
                capture("recommendation-daily-phone.png")
                compose.onNodeWithTag("daily-recommendations").performScrollToIndex(0)
                compose.onNodeWithTag("daily-more-actions").performClick()
                compose.onNodeWithTag("daily-rankings").performClick()
                compose.onNodeWithText("大家常听", substring = false).performClick()
                compose.waitUntil(10_000) { fixture.requests.any { it.first.contains("/rankings?") && it.first.contains("scope=community") } }
                compose.onNodeWithText("所有用户的汇总收听排行，不展示其他账号信息。").assertExists()
                compose.onNode(hasText("真实本库歌曲") and hasAnyAncestor(hasTestTag("listening-rankings"))).performClick()
                compose.waitUntil(10_000) { vm.state.value.current?.id == "local-a" }
                capture("recommendation-rankings-phone.png")
            } catch (error: Exception) {
                capture("recommendation-daily-failure.png")
                throw error
            } finally { cleanup(vm) }
        }
    }
    @Test fun dailySelectionAndLyricsKeepTheCurrentQueueAndPauseState() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                open(uiString(R.string.daily_recommendations))
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("daily-track-local-a").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("daily-play").performClick()
                compose.waitUntil(10_000) { vm.state.value.current?.id == "local-a" }
                compose.runOnIdle { vm.controller?.pause() }
                compose.waitUntil(5_000) { !vm.state.value.playing }
                val entry = vm.state.value.entryId
                val before = compose.runOnIdle { vm.controller!!.currentPosition }
                compose.onNodeWithTag("daily-recommendations").performScrollToNode(hasTestTag("daily-track-local-a"))
                compose.onNode(hasTestTag("daily-more-local-a") and hasClickAction(), useUnmergedTree = true).performScrollTo().performClick()
                compose.onNodeWithText("查看歌词", substring = false).performClick()
                compose.onNodeWithTag("recommendation-lyrics").assertExists()
                compose.onNodeWithText("关闭歌词预览", substring = false).performClick()
                assertEquals(entry, vm.state.value.entryId)
                assertFalse(vm.state.value.playing)
                assertTrue(kotlin.math.abs(compose.runOnIdle { vm.controller!!.currentPosition } - before) < 250)
                // Long press starts the selection with that song already picked.
                compose.onNodeWithTag("daily-recommendations").performScrollToNode(hasTestTag("daily-track-local-a"))
                compose.onNodeWithTag("daily-track-local-a").performTouchInput { longClick() }
                compose.onNodeWithTag("daily-select-local-a", useUnmergedTree = true).assertIsOn()
                compose.onNodeWithTag("daily-selection-play-next").performClick()
                compose.waitUntil(5_000) { vm.state.value.queue.size == 2 }
                assertEquals(entry, vm.state.value.entryId)
                assertFalse(vm.state.value.playing)
                assertEquals(listOf("local-a", "local-a"), vm.state.value.queue.map { it.trackId })
                capture("recommendation-selection-queue.png")
                compose.onNodeWithTag("daily-selection").assertDoesNotExist()
                compose.onNode(hasTestTag("mini-player-open") and hasAnyAncestor(hasTestTag("daily-mini-player"))).performClick()
                compose.waitUntil(5_000) { compose.onAllNodesWithTag("player-visual-stage").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("feature-daily").assertDoesNotExist()
                compose.onNodeWithTag("recommendation-lyrics").assertDoesNotExist()
                compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
                compose.waitUntil(5_000) { compose.onAllNodesWithTag("feature-daily").fetchSemanticsNodes().isNotEmpty() }
                assertEquals(entry, vm.state.value.entryId)
            } finally { cleanup(vm) }
        }
    }

    @Test fun assistantEntryUsesCurrentMobileWorkspace() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                compose.onNodeWithTag("nav-assistant").performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithText("野弦 AI 音乐助手").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("野弦 AI 音乐助手").assertIsDisplayed()
                compose.onNodeWithText("把我很久没听的收藏整理成歌单", substring = true).assertExists()
            } finally { cleanup(vm) }
        }
    }

    @Test fun pausedAssistantPlayerCollapsesAndCanBeReopenedWithoutLosingTheQueue() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                compose.runOnIdle { vm.play(vm.state.value.tracks) }
                compose.waitUntil(10_000) { vm.state.value.playing }
                compose.runOnIdle { vm.controller?.pause() }
                compose.waitUntil(5_000) { !vm.state.value.playing }
                val entry = vm.state.value.entryId
                compose.onNodeWithTag("mini-player").assertExists()
                compose.onNodeWithTag("nav-assistant").performClick()
                compose.onNodeWithTag("mini-player").assertDoesNotExist()
                compose.onNodeWithTag("assistant-paused-player").assertIsDisplayed().performClick()
                assertEquals(entry, vm.state.value.entryId)
                assertFalse(vm.state.value.playing)
                compose.onNodeWithContentDescription(uiString(R.string.play), useUnmergedTree = true).performClick()
                compose.waitUntil(5_000) { vm.state.value.playing }
                InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                compose.waitUntil(5_000) { compose.onAllNodesWithTag("mini-player").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("assistant-paused-player").assertDoesNotExist()
                assertEquals(entry, vm.state.value.entryId)
            } finally { cleanup(vm) }
        }
    }

    @Test fun podcastExplorePreviewsWithoutAddingAndOnlyFollowsOnConfirmation() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                compose.onNodeWithTag("nav-podcast").performClick()
                compose.onNodeWithTag("podcast-open-explore").assertIsDisplayed()
                capture("podcast-explore-entry-phone.png")
                compose.onNodeWithTag("podcast-open-explore").performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("podcast-explore-12345").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("服务器默认", substring = false).performClick()
                compose.onNodeWithText("台湾", substring = false).performClick()
                compose.waitUntil(10_000) { fixture.requests.any { it.first == "GET /api/v1/podcasts/discover?region=tw" } }
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("podcast-explore-12345").fetchSemanticsNodes().isNotEmpty() }
                capture("podcast-explore-list-phone.png")
                compose.onNodeWithTag("podcast-explore-12345").performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithText("公开节目简介").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("探索后的第一集").assertIsDisplayed()
                assertFalse(fixture.podcastAdded)
                assertTrue(fixture.requests.none { it.first.startsWith("POST /api/v1/podcasts?") })
                capture("podcast-explore-preview-phone.png")
                compose.onNodeWithContentDescription("返回探索列表").performClick()
                compose.onNodeWithTag("podcast-explore-search").performTextInput("声音")
                compose.waitUntil(10_000) { fixture.requests.any { it.first.startsWith("GET /api/v1/podcasts/search?q=") } }
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("podcast-explore-12345").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("podcast-explore-12345").performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("podcast-explore-follow").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("podcast-explore-follow").performClick()
                compose.waitUntil(10_000) { vm.state.value.podcastId == "explore-show" }
                compose.onNodeWithTag("podcast-explore").assertDoesNotExist()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("podcast-episode-explore-episode").fetchSemanticsNodes().isNotEmpty() }
                val additions = fixture.requests.filter { it.first.startsWith("POST /api/v1/podcasts?") }
                assertEquals(1, additions.size)
                val added = JsonParser.parseString(additions.single().second).asJsonObject
                assertEquals("https://podcast.example/feed.xml", added.text("feed_url"))
                assertEquals("12345", added.text("itunes_id"))
                assertNull(vm.state.value.current)
            } finally { cleanup(vm) }
        }
    }

    @Test fun podcastExploreCanRetryThrottlingButCannotBypassAddPermissions() {
        Fixture(canAddPodcasts = false, profile = "listener").use { fixture ->
            fixture.directoryThrottled = true
            val vm = connect(fixture)
            try {
                compose.onNodeWithTag("nav-podcast").performClick()
                compose.onNodeWithTag("podcast-open-explore").performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithText("播客目录暂时限制了请求，请稍后重试。").fetchSemanticsNodes().isNotEmpty() }
                fixture.directoryThrottled = false
                compose.onNodeWithText(uiString(R.string.retry), substring = false).performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("podcast-explore-12345").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("podcast-explore-12345").performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("podcast-explore-follow").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("podcast-explore-follow").assertIsNotEnabled()
                compose.onNodeWithText("管理员尚未开放添加节目").assertIsDisplayed()
                assertFalse(fixture.podcastAdded)
                assertTrue(fixture.requests.none { it.first.startsWith("POST /api/v1/podcasts?") })
            } finally { cleanup(vm) }
        }
    }
    @Test fun externalMusicHasNoFakePlaybackSupportsWantAndManualRefreshFrequency() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                open(uiString(R.string.discover_new_music))
                compose.waitUntil(10_000) { compose.onAllNodesWithText("想去寻找的新声音").fetchSemanticsNodes().isNotEmpty() }
                compose.onAllNodes(hasText(uiString(R.string.play), substring = false) and hasAnyAncestor(hasTestTag("external-item-outside"))).assertCountEquals(0)
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
