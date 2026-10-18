package com.wildstring.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class AgentWorkspaceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private class Fixture : AutoCloseable {
        val server = MockWebServer(); val requests = ConcurrentLinkedQueue<Pair<String, JsonObject>>()
        val writes = AtomicInteger(); var status = "pending"; var version = 1; var read = false
        @Volatile var connections = "[]"
        @Volatile var tasks = "[]"
        @Volatile var history = "[]"
        @Volatile var rejectHistoryDelete = false
        @Volatile var memoryContent = ""
        var memoryVersion = 1; var searchEnabled = false
        val trace = "b".repeat(32)
        fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setHeader("X-Wildstring-Trace-Id", trace).setBody(body)
        fun draft() = """{"id":"draft-one","kind":"playlist","title":"久未听的收藏","payload":{"name":"重新听见","track_ids":["song-a","song-b"]},"before":{"name":"原歌单"},"evidence":[{"source":"library","summary":"从本人收藏挑选"}],"status":"$status","version":$version,"created_at":"2026-10-17T12:00:00Z","trace_id":"$trace"}"""
        init {
            server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse = synchronized(this@Fixture) {
                val path = request.requestUrl!!.encodedPath
                val body = request.body.readUtf8().takeIf { it.isNotBlank() }?.let { JsonParser.parseString(it).asJsonObject } ?: JsonObject()
                requests += (request.method + " " + path) to body
                if (request.method != "GET" && path.contains("/agent/")) writes.incrementAndGet()
                if (path.endsWith("/auth/status")) return@synchronized json("""{"configured":true,"authenticated":${request.getHeader("Cookie") != null},"user":{"id":"agent-alice","username":"alice","role":"admin"}}""")
                if (path.endsWith("/auth/login")) return@synchronized json("{}").setHeader("Set-Cookie", "wildstring_session=agent-alice; Path=/; Max-Age=3600")
                if (path == "/api/v1/agent/search-settings") {
                    if (request.method == "PUT") searchEnabled = body.flag("enabled")
                    return@synchronized json("""{"provider":"deepseek","enabled":$searchEnabled,"daily_budget":10,"version":1,"has_api_key":false,"requests_today":0}""")
                }
                if (path == "/api/v1/agent/assistant-preferences") return@synchronized json("""{"retention_days":30,"context_summary":true,"long_term_memory":true}""")
                if (path == "/api/v1/agent/memories" || path == "/api/v1/agent/memories/memory-one") {
                    if (request.method == "POST" || request.method == "PATCH") { memoryContent = body.text("content"); memoryVersion++ }
                    if (request.method == "DELETE") memoryContent = ""
                    val memory = jsonBody("id" to "memory-one", "content" to memoryContent, "version" to memoryVersion)
                    return@synchronized if (request.method == "GET") json("""{"items":${if (memoryContent.isEmpty()) "[]" else "[$memory]"},"total":${if (memoryContent.isEmpty()) 0 else 1},"limit":100,"offset":0}""") else json(memory.toString())
                }
                if (path == "/api/v1/agent/notifications/read") { read = true; return@synchronized json("{}") }
                if (path == "/api/v1/agent/notifications") return@synchronized json("""{"items":[{"id":"notice-one","event_id":"event-one","title":"新草案待确认","summary":"已生成 1 份草案，尚未应用。","severity":"info","draft_id":"draft-one","trace_id":"$trace","created_at":"2026-10-17T12:00:00Z","read_at":${if (read) "\"2026-10-17T12:01:00Z\"" else "null"},"version":${if (read) 2 else 1}}],"total":1,"limit":100,"offset":0,"unread_count":${if (read) 0 else 1},"high_watermark":${if (read) 2 else 1},"next_cursor":"c${if (read) 2 else 1}"}""")
                if (path == "/api/v1/agent/connections") return@synchronized json("""{"items":$connections,"total":${JsonParser.parseString(connections).asJsonArray.size()},"limit":100,"offset":0}""").setBodyDelay(350, java.util.concurrent.TimeUnit.MILLISECONDS)
                if (path == "/api/v1/agent/conversations" && request.method == "GET") return@synchronized json("""{"items":$history,"total":${JsonParser.parseString(history).asJsonArray.size()},"limit":100,"offset":0}""")
                if (path.startsWith("/api/v1/agent/conversations/history-")) {
                    val items = JsonParser.parseString(history).asJsonArray.map { it.asJsonObject }
                    val id = path.substringAfterLast('/')
                    val item = items.firstOrNull { it.text("id") == id } ?: return@synchronized json("{}").setResponseCode(404)
                    if (request.method == "PATCH") { item.addProperty("title", body.text("title")); history = items.joinToString(prefix = "[", postfix = "]") }
                    if (request.method == "DELETE") {
                        if (rejectHistoryDelete) { rejectHistoryDelete = false; return@synchronized json("""{"detail":"conversation_busy"}""").setResponseCode(409) }
                        history = items.filterNot { it.text("id") == id }.joinToString(prefix = "[", postfix = "]")
                        return@synchronized json("{\"ok\":true}")
                    }
                    return@synchronized json(item.toString())
                }
                if (path == "/api/v1/agent/conversations" && request.method == "POST") return@synchronized json("""{"id":"conversation-one","title":"新对话","messages":[],"runs":[]}""")
                if (path.endsWith("/conversation-one/messages")) return@synchronized json("""{"id":"conversation-one","messages":[{"id":"message-user","role":"user","content":"${body.text("content")}"},{"id":"message-ai","role":"assistant","content":"已整理为草案，请查看后确认。"}],"runs":[{"id":"run-one","status":"succeeded","draft_ids":["draft-one"],"trace_id":"$trace"}]}""")
                if (path == "/api/v1/agent/drafts") return@synchronized json("""{"items":[${draft()}],"total":1,"limit":100,"offset":0}""")
                if (path.endsWith("/draft-one/approve")) { assertEquals(version.toLong(), body.number("version")); status = "approved"; version++; return@synchronized json(draft()) }
                if (path.endsWith("/draft-one/apply")) { assertEquals("approved", status); assertEquals(version.toLong(), body.number("version")); assertTrue(body.text("idempotency_key").isNotBlank()); status = "applied"; version++; return@synchronized json(draft()) }
                if (path.endsWith("/draft-one")) return@synchronized json(draft())
                if (path.endsWith("/song-a") || path.endsWith("/song-b")) return@synchronized json("""{"id":"${path.substringAfterLast('/')}","title":"${if (path.endsWith("song-a")) "合成歌曲甲" else "合成歌曲乙"}","artists":["合成艺人"],"duration_ms":12000,"format":"mp3"}""")
                if (path == "/api/v1/agent/tasks" && request.method == "POST") return@synchronized json("""{"id":"task-one","status":"queued"}""")
                if (path == "/api/v1/agent/tasks") return@synchronized json("""{"items":$tasks,"total":${JsonParser.parseString(tasks).asJsonArray.size()},"limit":100,"offset":0}""")
                if (path == "/api/v1/agent/tasks/limited-task") return@synchronized json(JsonParser.parseString(tasks).asJsonArray[0].toString())
                if (path.startsWith("/api/v1/agent/")) return@synchronized json("""{"items":[],"total":0,"limit":100,"offset":0}""")
                if (path.endsWith("/albums") || path.endsWith("/tracks")) return@synchronized json("""{"items":[],"total":0,"limit":50,"offset":0}""")
                json("{}").setResponseCode(404)
            } }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
        }
        override fun close() = server.close()
    }
    private fun vm(): MusicViewModel = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
    private fun connect(vm: MusicViewModel, fixture: Fixture) {
        val address = fixture.server.url("/").newBuilder().host("127.0.0.1").build().toString()
        val login = compose.runOnIdle { vm.connect(address, "alice", "synthetic-password", true) }
        compose.waitUntil(20_000) { login.isCompleted && vm.state.value.connected && !vm.state.value.connecting }
    }
    @Test fun researchSettingsAndExplicitMemoryCanBeSavedEditedAndDeleted() {
        val vm = vm()
        Fixture().use { fixture -> try {
            connect(vm, fixture)
            compose.onNodeWithContentDescription("设置").performClick()
            compose.onNodeWithText("野弦助手 / 通知与草案").performScrollTo().performClick()
            compose.onNodeWithTag("agent-tab-research").performScrollTo().performClick()
            compose.waitUntil(15_000) { fixture.requests.any { it.first == "GET /api/v1/agent/search-settings" } }
            compose.onNodeWithTag("agent-memory-input").performScrollTo().performTextInput("优先录音室版本")
            compose.onNodeWithTag("agent-memory-save").performScrollTo().performClick()
            compose.waitUntil(15_000) { fixture.memoryContent == "优先录音室版本" }
            // Flush focus/IME work before waiting on the follow-up network request.
            compose.waitForIdle()
            compose.waitUntil(15_000) { fixture.requests.count { it.first == "GET /api/v1/agent/memories" } >= 2 }
            compose.waitForIdle()
            compose.onNodeWithTag("agent-research").performScrollToNode(hasText("编辑记忆"))
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("编辑记忆") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("编辑记忆", substring = false).performScrollTo().performClick()
            compose.onNodeWithTag("agent-memory-input").performScrollTo()
            compose.waitForIdle()
            compose.onNodeWithTag("agent-memory-input").performClick()
            compose.waitForIdle()
            compose.onNodeWithTag("agent-memory-input").performTextReplacement("优先原版专辑，保留发行年份")
            compose.onNodeWithTag("agent-memory-save").performScrollTo().performClick()
            compose.waitUntil(15_000) { fixture.memoryContent.contains("保留发行年份") }
            compose.waitForIdle()
            InstrumentationRegistry.getInstrumentation().uiAutomation.waitForIdle(500, 5_000)
            compose.onNodeWithTag("agent-research").performScrollToNode(hasText("删除记忆"))
            compose.waitUntil(15_000) { compose.onAllNodes(hasText("优先原版专辑，保留发行年份") and !hasSetTextAction()).fetchSemanticsNodes().isNotEmpty() }
            compose.waitUntil(10_000) { compose.onAllNodes(hasText("删除记忆") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNode(hasText("优先原版专辑，保留发行年份") and !hasSetTextAction()).assertExists()
            capture("research-memory-phone.png")
            compose.onNodeWithText("删除记忆", substring = false).performScrollTo().assertIsEnabled().performClick()
            compose.waitUntil(5_000) { compose.onAllNodesWithTag("agent-memory-delete-confirm").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("agent-memory-delete-confirm").performClick()
            compose.waitUntil(15_000) { fixture.memoryContent.isEmpty() }
            assertTrue(fixture.requests.any { it.first == "PATCH /api/v1/agent/memories/memory-one" && it.second.number("version") >= 2 })
        } catch (error: Throwable) {
            println("Research fixture requests: ${fixture.requests.map { it.first }}")
            println("Research original failure: ${error.stackTraceToString()}")
            runCatching {
                capture("research-failure-phone.png")
                compose.onAllNodes(isRoot()).onLast().printToLog("ResearchFailure")
            }
            throw error
        } finally { compose.runOnIdle { vm.repository.session.invalidate() } } }
    }
    @Test fun historyRenameDeleteAndBusyFailurePreserveCurrentConversation() {
        val vm = vm()
        Fixture().use { fixture -> try {
            fixture.history = listOf("a", "b").joinToString(prefix = "[", postfix = "]") { id ->
                """{"id":"history-$id","title":"${if (id == "a") "旧名字" else "另一段对话"}","connection_id":null,"messages":[{"id":"message-$id","role":"user","content":"保留内容 $id"}],"runs":[]}"""
            }
            fixture.rejectHistoryDelete = true
            connect(vm, fixture)
            compose.onNodeWithContentDescription("设置").performClick()
            compose.onNodeWithText("野弦助手 / 通知与草案").performScrollTo().performClick()
            compose.waitUntil(15_000) { compose.onAllNodes(hasText("历史") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("历史", substring = false).performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("history-open-history-b").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("history-open-history-b").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("保留内容 b").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("历史", substring = false).performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("history-actions-history-a").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("history-actions-history-a").performClick()
            compose.onNodeWithText("改名", substring = false).performClick()
            compose.onNodeWithTag("conversation-title").performTextReplacement("   ")
            compose.onNodeWithText("保存", substring = false).assertIsNotEnabled()
            compose.onNodeWithTag("conversation-title").performTextReplacement("  夜晚的摇滚歌单  ")
            compose.onNodeWithText("保存", substring = false).performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("conversation-title").fetchSemanticsNodes().isEmpty() }
            assertEquals("夜晚的摇滚歌单", fixture.requests.single { it.first == "PATCH /api/v1/agent/conversations/history-a" }.second.text("title"))
            compose.onNodeWithText("夜晚的摇滚歌单", substring = false).assertExists()
            capture("history-actions-phone.png")
            compose.onNodeWithTag("history-actions-history-a").performClick()
            compose.onNodeWithText("删除", substring = false).performClick()
            compose.onNodeWithText("取消", substring = false).performClick()
            assertFalse(fixture.requests.any { it.first == "DELETE /api/v1/agent/conversations/history-a" })
            compose.onNodeWithTag("history-actions-history-a").performClick()
            compose.onNodeWithText("删除", substring = false).performClick()
            compose.onNodeWithText("删除", substring = false).performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("这段对话正在生成回复", substring = true).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("删除", substring = false).performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("history-open-history-a").fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithText("关闭", substring = false).performClick()
            compose.onNodeWithText("保留内容 b", substring = false).assertExists()
            compose.onNodeWithContentDescription("删除当前对话").performClick()
            compose.onNodeWithText("删除", substring = false).performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("保留内容 b").fetchSemanticsNodes().isEmpty() }
            assertEquals(3, fixture.requests.count { it.first.startsWith("DELETE /api/v1/agent/conversations/") })
        } finally { compose.runOnIdle { vm.repository.session.invalidate() } } }
    }
    @Test fun manualInspectionUsesLegacyConnectionButScheduleRequiresAutomaticAuthorization() {
        val vm = vm()
        Fixture().use { fixture -> try {
            val legacy = """{"id":"legacy","name":"实例 AI（已有配置）","model":"synthetic","enabled":true,"read_only":true,"background_allowed":false,"daily_call_budget":100}"""
            fixture.connections = "[$legacy]"
            connect(vm, fixture)
            compose.runOnIdle { vm.settings.appearance("dark") }
            compose.onNodeWithContentDescription("设置").performClick()
            compose.onNodeWithText("野弦助手 / 通知与草案").performScrollTo().performClick()
            compose.onNodeWithTag("agent-tab-tasks").performClick()
            compose.onNodeWithText("开始巡检", substring = false).performClick()
            compose.onNodeWithTag("inspection-use-ai").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("请选择用于本次巡检的 AI 连接。").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("开始", substring = false).assertIsNotEnabled()
            compose.onNodeWithText("本地找歌（不使用模型）", substring = false).assertDoesNotExist()
            compose.onNodeWithTag("ai-connection-choice").performClick()
            compose.onNodeWithText("实例 AI（已有配置） · synthetic", substring = false).performClick()
            compose.onNodeWithText("开始", substring = false).assertIsEnabled()
            capture("manual-ai-inspection-dark.png", dark = true)
            compose.onNodeWithText("开始", substring = false).performClick()
            compose.waitUntil(15_000) { fixture.requests.any { it.first == "POST /api/v1/agent/tasks" } }
            val submitted = fixture.requests.single { it.first == "POST /api/v1/agent/tasks" }.second
            assertTrue(submitted.flag("use_ai")); assertEquals("legacy", submitted.text("connection_id")); assertEquals(4, submitted.number("max_calls").toInt())
            assertFalse(submitted.has("_manual_ai_authorized"))
            compose.waitUntil(15_000) { compose.onAllNodesWithText("开始曲库巡检", substring = false).fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithText("新建计划", substring = false).performScrollTo().performClick()
            compose.onNodeWithTag("inspection-use-ai").performScrollTo().performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("没有可用于定时巡检的连接。", substring = true).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("保存计划", substring = false).assertIsNotEnabled()
            compose.onNodeWithTag("ai-connection-choice").performScrollTo().performClick()
            compose.onNodeWithText("实例 AI（已有配置） · synthetic", substring = false).assertDoesNotExist()
            compose.onAllNodesWithText("请选择 AI 连接", substring = false).onLast().performClick()
            compose.onNodeWithText("取消", substring = false).performClick()
            fixture.connections = "[$legacy,{\"id\":\"automatic\",\"name\":\"自动巡检模型\",\"model\":\"synthetic\",\"enabled\":true,\"background_allowed\":true,\"daily_call_budget\":100}]"
            compose.onNodeWithText("新建计划", substring = false).performScrollTo().performClick()
            compose.onNodeWithTag("inspection-use-ai").performScrollTo().performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("请选择用于本次巡检的 AI 连接。").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("ai-connection-choice").performScrollTo().performClick()
            compose.onNodeWithText("自动巡检模型 · synthetic", substring = false).performClick()
            compose.onNodeWithText("保存计划", substring = false).assertIsEnabled()
            compose.onNodeWithText("取消", substring = false).performClick()
        } finally { compose.runOnIdle { vm.settings.appearance("system"); vm.repository.session.invalidate() } } }
    }
    @Test fun inspectionFailureAndSkippedAnalysisAreReadableWithoutAutomaticRetry() {
        val vm = vm()
        Fixture().use { fixture -> try {
            fixture.tasks = """[{"id":"limited-task","status":"failed","stage":"completed","counts":{"processed":134,"issues":0,"failed":0,"calls":1},"error_code":"ai_output_limit","results":[],"created_at":"2026-10-18T00:00:00Z"}]"""
            connect(vm, fixture)
            compose.onNodeWithContentDescription("设置").performClick()
            compose.onNodeWithText("野弦助手 / 通知与草案").performScrollTo().performClick()
            compose.onNodeWithTag("agent-tab-tasks").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("详情与恢复").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("详情与恢复").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("阶段：处理结束，未全部完成").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("阶段：处理结束，未全部完成").assertExists()
            compose.onNodeWithText("模型达到输出 Token 上限", substring = true).assertExists()
            compose.onNodeWithText("模型调用 1", substring = true).assertExists()
            compose.onNodeWithText("已完成", substring = false).assertDoesNotExist()
            compose.onNodeWithText("恢复巡检").assertIsDisplayed()
            assertEquals(0, fixture.writes.get())
            capture("inspection-output-limit-phone.png")
            fixture.tasks = """[{"id":"limited-task","status":"succeeded","stage":"completed","counts":{"processed":134,"calls":1},"results":[{"analysis":"规则检查未发现待解释问题，本次未继续调用 AI。","ai_skipped":true,"draft_ids":[]}]}]"""
            compose.onAllNodesWithText("刷新", substring = false).onLast().performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("规则检查说明").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("规则检查未发现待解释问题，本次未继续调用 AI。").assertExists()
            compose.onNodeWithText("恢复巡检").assertDoesNotExist()
            assertEquals(0, fixture.writes.get())
        } finally { compose.runOnIdle { vm.settings.appearance("system"); vm.repository.session.invalidate() } } }
    }
    @Test fun mobileAssistantNotificationAndConcreteApprovalRoundTrip() {
        val vm = vm()
        Fixture().use { fixture -> try {
            connect(vm, fixture)
            compose.onNodeWithContentDescription("设置").performClick()
            compose.onNodeWithText("野弦助手 / 通知与草案").performScrollTo().performClick()
            compose.onNodeWithTag("agent-workspace").assertIsDisplayed()
            compose.onNodeWithTag("agent-tab-notifications").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("新草案待确认").fetchSemanticsNodes().isNotEmpty() }
            assertEquals("Opening the list is read-only", 0, fixture.writes.get())
            compose.onNodeWithText("1 条未读").assertExists()
            capture("agent-notifications-phone.png")
            compose.onNodeWithTag("notice-read-notice-one").performClick()
            compose.waitUntil(15_000) { vm.agent.inbox.value.unread == 0 }
            compose.onNodeWithText("0 条未读").assertExists()
            compose.onNodeWithTag("agent-tab-chat").performClick()
            // The chat tab independently loads connection permissions and history.
            // Wait for the actual editor to leave its loading/disabled state.
            compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag("agent-chat-input") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("agent-chat-input").performTextInput("整理很久没听的收藏")
            compose.onNodeWithTag("agent-chat-send").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("已整理为草案，请查看后确认。").fetchSemanticsNodes().isNotEmpty() }
            compose.activityRule.scenario.onActivity { activity -> androidx.core.view.WindowCompat.getInsetsController(activity.window, activity.window.decorView).hide(androidx.core.view.WindowInsetsCompat.Type.ime()) }
            capture("agent-chat-phone.png")
            compose.runOnIdle { vm.settings.appearance("dark") }
            compose.onNodeWithTag("appearance-dark").assertExists()
            capture("agent-chat-dark-phone.png", dark = true)
            compose.runOnIdle { vm.settings.appearance("system") }
            compose.onNodeWithText("查看生成的草案").performScrollTo().performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("久未听的收藏").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("draft-open-draft-one").performClick()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("1. 合成歌曲甲").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("原歌单 → 重新听见").assertExists()
            compose.onNodeWithText("从本人收藏挑选", substring = true).assertExists()
            assertEquals("pending", fixture.status)
            compose.onNodeWithTag("draft-confirm").performClick()
            compose.onNodeWithTag("draft-confirm-approve").performClick()
            compose.waitUntil(15_000) { fixture.status == "approved" }
            compose.onAllNodesWithText("已批准，尚未应用").onFirst().assertExists()
            compose.onNodeWithTag("draft-confirm").performClick()
            compose.onNodeWithTag("draft-confirm-apply").performClick()
            compose.waitUntil(15_000) { fixture.status == "applied" }
            compose.onAllNodesWithText("已应用").onFirst().assertExists()
            assertEquals(1, fixture.requests.count { it.first.endsWith("/draft-one/apply") })
            capture("agent-draft-phone.png")
        } finally { compose.runOnIdle { vm.settings.appearance("system"); vm.repository.session.invalidate() } } }
    }
    private fun capture(name: String, dark: Boolean = false) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let { java.io.File(it) } ?: instrumentation.targetContext.getExternalFilesDir(null)!!
        directory.mkdirs()
        val deadline = android.os.SystemClock.elapsedRealtime() + 5000
        while (true) {
            val image = instrumentation.uiAutomation.takeScreenshot()!!
            val pixel = image.getPixel(5, image.height / 2)
            val presentedDark = android.graphics.Color.red(pixel) < 80 && android.graphics.Color.green(pixel) < 80 && android.graphics.Color.blue(pixel) < 80
            if (!dark || presentedDark) {
                java.io.File(directory, name).outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; image.recycle(); return
            }
            image.recycle(); check(android.os.SystemClock.elapsedRealtime() < deadline) { "Dark theme has not reached the compositor" }
            android.os.SystemClock.sleep(40)
        }
    }
    @Test fun oldServerReportsUnavailableWithoutMarkingNotificationsRead() {
        val vm = vm()
        Fixture().use { fixture -> try {
            connect(vm, fixture)
            fixture.server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest) = fixture.json("""{"detail":"not_found"}""").setResponseCode(404) }
            runBlocking { vm.agent.refreshInbox(force = true) }
            assertEquals(false, vm.agent.inbox.value.supported)
            assertTrue(vm.agent.inbox.value.error!!.contains("服务端"))
            assertTrue(vm.agent.inbox.value.error!!.contains(fixture.trace))
            assertEquals(0, fixture.writes.get())
        } finally { compose.runOnIdle { vm.repository.session.invalidate() } } }
    }
    @Test fun playbackDiagnosticsCanBeCopiedWithoutLibraryOrCredentials() {
        val vm = vm()
        Fixture().use { fixture -> try {
            connect(vm, fixture)
            compose.onNodeWithContentDescription("设置").performClick()
            compose.onNodeWithText("播放诊断").performScrollTo().performClick()
            compose.onNodeWithTag("playback-diagnostics").assertExists()
            compose.onNodeWithTag("copy-playback-diagnostics").performClick()
            val copied = compose.runOnIdle {
                val context = InstrumentationRegistry.getInstrumentation().targetContext
                context.getSystemService(android.content.ClipboardManager::class.java).primaryClip!!.getItemAt(0).text.toString()
            }
            assertTrue(copied.contains("platform_duration_ms")); assertFalse(copied.contains("alice"))
            assertFalse(copied.contains("wildstring_session")); assertFalse(copied.contains("http://"))
        } finally { compose.runOnIdle { vm.repository.session.invalidate() } } }
    }
}
