package com.wildstring.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.media3.common.Player
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import okhttp3.mockwebserver.*
import okio.Buffer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** New phone workflows exercise real Compose controls, Media3 playback and private files. */
class MobileCompletionTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val gson = Gson()
    private fun dismissKeyboard() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val info = automation.serviceInfo
        val previous = info.flags
        try {
            info.flags = info.flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            automation.serviceInfo = info
            if (automation.windows.any { it.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD }) {
                // A disappearing dialog can leave a stale IME accessibility window.
                // Global BACK then navigates the app instead of hiding that keyboard.
                compose.runOnUiThread {
                    val focused = if (android.os.Build.VERSION.SDK_INT >= 29) android.view.inspector.WindowInspector.getGlobalWindowViews()
                        .firstOrNull { it.isAttachedToWindow && it.hasWindowFocus() } else null
                    val view = focused ?: compose.activity.window.decorView
                    androidx.core.view.ViewCompat.getWindowInsetsController(view)?.hide(androidx.core.view.WindowInsetsCompat.Type.ime())
                }
                compose.waitUntil(5_000) { automation.windows.none { it.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD } }
                automation.waitForIdle(300, 5_000)
            }
        } finally { info.flags = previous; automation.serviceInfo = info }
        compose.waitForIdle()
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        // Semantics can precede the compositor frame in the emulator.
        instrumentation.uiAutomation.waitForIdle(500, 5_000)
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: return
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let { java.io.File(it) }
            ?: instrumentation.targetContext.getExternalFilesDir(null)!!
        directory.mkdirs(); java.io.File(directory, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }
    private class Fixture(val count: Int = 3) : java.io.Closeable {
        val server = MockWebServer()
        val failPage = AtomicBoolean(false)
        val headCode = AtomicInteger(200)
        val disconnected = AtomicBoolean(false)
        val requests = ConcurrentLinkedQueue<String>()
        val mutations = ConcurrentLinkedQueue<Pair<String, String>>()
        val slow = AtomicBoolean(false)
        val showSuggestions = AtomicBoolean(false)
        val failLyrics = AtomicBoolean(false)
        val applied = AtomicBoolean(false)
        val slowCatalog = AtomicBoolean(false)
        val aacDownloads = AtomicBoolean(false)
        val deletedPlaylist = AtomicBoolean(false)
        val holdPlaylistDetails = AtomicBoolean(false)
        val playlistDetailsRequested = CountDownLatch(1)
        val releasePlaylistDetails = CountDownLatch(1)
        var snapshot = """{"version":0,"device_id":"","track_ids":[],"index":0,"position_ms":0,"mode":"sequential","updated_at":null}"""
        var importSettings = """{"version":1,"enabled":false,"interval_seconds":60,"stable_seconds":120,"download_policy":{"wait_for_album":true,"partial_suffixes":[".part",".tmp"]}}"""
        var lyrics = "第一句\n第二句"
        val audio = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.mp3").use { it.readBytes() }
        fun track(index: Int) = """{"id":"completion-$index","title":"手机测试歌曲 $index","artists":["测试艺人"],"album":"手机测试专辑","duration_ms":12000,"has_cover":false,"loved":false,"format":"mp3","status":"available","play_count":2,"listened_ms":6000,"last_played_at":"2026-10-17T00:00:00Z"}"""
        fun reviewPage(): String {
            val rows = com.google.gson.JsonArray()
            (0..1).forEach { n ->
                val row = JsonParser.parseString("""{"id":"completion-$n","title":"手机测试歌曲 $n","album":"手机测试专辑","album_id":"review-album","artists":["测试艺人"],"has_cover":false,"metadata_version":1,"current":{"title":"手机测试歌曲 $n","album":"人工专辑"},"original":{"title":"原始","album":"文件专辑"},"overrides":{"album":"人工专辑"},"suggestions":[]}""").asJsonObject
                if (!applied.get()) row.add("suggestions", JsonParser.parseString("""[{"id":"pending-$n","metadata_version":1,"provider":"musicbrainz","fields":{"title":"建议标题","album":"建议专辑"},"candidate_digest":"${"a".repeat(64)}","cover_url":"https://coverartarchive.org/candidate.jpg","match":{}},{"id":"stale-$n","metadata_version":0,"provider":"lastfm","fields":{"title":"过期建议"},"candidate_digest":"${"b".repeat(64)}","match":{}}]"""))
                rows.add(row)
            }
            return JsonParser.parseString("""{"album_id":"review-album","provider_names":{"musicbrainz":"MusicBrainz","lastfm":"Last.fm"},"limit":500,"offset":0,"total":2}""").asJsonObject.apply { add("items", rows) }.toString()
        }
        var manual = """{"id":"manual","name":"测试歌单","kind":"manual","version":1,"track_count":3,"cover_track_id":null}"""
        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val url = request.requestUrl!!; val path = url.encodedPath
                    requests += request.method + " " + path + "?" + url.encodedQuery.orEmpty()
                    fun json(value: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(value)
                    val user = """{"id":"completion-user","username":"mobile-admin","role":"admin","enabled":true,"version":1}"""
                    if (path.endsWith("/auth/status")) { val authenticated = request.getHeader("Cookie")?.contains("wildstring_session=completion") == true; return json("""{"configured":true,"authenticated":$authenticated,"user":${if (authenticated) user else "null"}}""") }
                    if (path.endsWith("/auth/login")) return json(user).setHeader("Set-Cookie", "wildstring_session=completion; Path=/; Max-Age=3600; HttpOnly")
                    if (request.method in listOf("POST", "PUT", "DELETE")) mutations += path to request.body.clone().readUtf8()
                    if (path.endsWith("/manage/intake/settings")) {
                        if (request.method == "PUT") { val value = JsonParser.parseString(request.body.readUtf8()).asJsonObject; value.addProperty("version", value.get("version").asInt + 1); importSettings = value.toString() }
                        return json(importSettings)
                    }
                    if (path.endsWith("/auth/logout")) return MockResponse().setResponseCode(204)
                    if (path.endsWith("/playback/state")) {
                        if (request.method == "PUT") { val body = JsonParser.parseString(request.body.readUtf8()).asJsonObject; assertFalse(body.has("updated_at")); if (body["version"].asInt != JsonParser.parseString(snapshot).asJsonObject["version"].asInt) return json("""{"detail":"playback_version_conflict"}""").setResponseCode(409); body.addProperty("version", body["version"].asInt + 1); body.addProperty("updated_at", "2026-10-17T00:00:00Z"); snapshot = body.toString() }
                        return json(snapshot)
                    }
                    if (path.endsWith("/recommendations/preferences")) return json("""{"version":1,"use_ai":false,"use_lastfm":false,"count":20}""")
                    if (path.contains("/recommendations/daily")) return json("""{"id":"daily","date":"2026-10-17","engine":"local","items":[{"track":${track(0)},"reason":"久未重听"}]}""")
                    if (path.endsWith("/ai/discover")) return json("""{"title":"手机 AI 歌单","mode":"local","warning":"ai_unavailable_local_fallback","items":[{"track":${track(1)},"reason":"本地检索"}]}""")
                    if (path.endsWith("/recommendations/feedback") || path.endsWith("/listening")) return json("{}")
                    if (path.endsWith("/listening/summary")) return json("""{"play_count":8,"listened_ms":120000,"tracks_played":3,"favorites":1}""")
                    if (path.endsWith("/lastfm")) return json("""{"configured":false,"connected":false,"scrobble":false,"now_playing":false,"version":1}""")
                    if (path.endsWith("/agent/metadata-review/albums")) return json("""{"items":[{"id":"review-album","title":"手机测试专辑","artists":["测试艺人"],"count":2}],"total":1}""")
                    if (path.endsWith("/agent/metadata-review/accept")) { applied.set(true); return json("""{"status":"applied","draft":{"id":"receipt"}}""") }
                    if (path.endsWith("/agent/metadata-review")) return json(reviewPage())
                    if (path.contains("/manage/")) return when {
                        path.endsWith("/overview") -> json("""{"counts":{"tracks":3,"size_bytes":1000},"albums":1,"artists":1}""")
                        path.endsWith("/intake/settings") -> json("""{"version":1,"enabled":false,"interval_seconds":60,"stable_seconds":120}""")
                        (path.endsWith("/intake/items") || path.endsWith("/jobs")) && request.method == "GET" -> json("""{"items":[],"total":0,"limit":20,"offset":0}""")
                        path.endsWith("/jobs") && request.method == "POST" -> json("""{"id":"test-job","kind":"import","status":"queued","full":false}""").setResponseCode(202)
                        path.endsWith("/metadata") -> json("""{"track_id":"completion-0","version":1,"observed":{"title":"原始"},"overrides":{"album":"人工专辑"},"effective":{"title":"手机测试歌曲 0","artists":["测试艺人"],"album":"人工专辑","album_artists":[],"vocalists":[],"lyricists":[],"composers":[],"arrangers":[],"track_number":1,"disc_number":null}}""")
                        path.endsWith("/lyrics/preview") -> json("""{"kind":"plain","source":"user","lines":[{"time_ms":null,"text":"预览"}]}""")
                        path.endsWith("/lyrics") -> { if (request.method == "PUT" && failLyrics.get()) return json("{\"detail\":\"lyrics_version_conflict\"}").setResponseCode(409); if (request.method == "PUT") lyrics = JsonParser.parseString(request.body.readUtf8()).asJsonObject["text"].asString; json("""{"track_id":"completion-0","version":1,"file_version":"${"a".repeat(64)}","text":${Gson().toJson(lyrics)},"effective":{"kind":"plain","lines":[]}}""") }
                        path.endsWith("/providers/refresh") -> json("""{"queued":1,"already_active":0,"total":1}""")
                        path.contains("/providers/tracks/") -> if (!showSuggestions.get()) json("""{"suggestions":[],"jobs":[]}""") else json("""{"suggestions":[
                            {"id":"already-applied","status":"applied","metadata_version":1,"provider":"musicbrainz","fields":{"title":"不应再次显示的建议"}},
                            {"id":"pending","status":"${if (applied.get()) "applied" else "pending"}","metadata_version":1,"provider":"musicbrainz","fields":{"title":"建议标题"},"cover_url":"https://coverartarchive.org/release/public-candidate/front"},
                            {"id":"stale","status":"pending","metadata_version":0,"provider":"lastfm","fields":{"title":"过期建议"}}
                        ],"jobs":[]}""")
                        path.endsWith("/suggestions/pending/apply") -> { applied.set(true); json("{}") }
                        path.endsWith("/cover-preview") -> MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=", 0)))
                        else -> MockResponse().setResponseCode(404)
                    }
                    if (path.endsWith("/stream")) {
                        if (disconnected.get()) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                        if (request.method == "HEAD") {
                            return audioStreamFixture(request, audio, "audio/mpeg", "\"source-v1\"").setResponseCode(headCode.get())
                        }
                        if (aacDownloads.get() && url.queryParameter("format") == "aac") {
                            val aac = InstrumentationRegistry.getInstrumentation().context.assets.open("aac-full.m4a").use { it.readBytes() }
                            return MockResponse().setHeader("Content-Type", "audio/mp4").setHeader("X-Wildstring-Playback", "transcode").setChunkedBody(Buffer().write(aac), 1024)
                        }
                        val start = request.getHeader("Range")?.substringAfter("bytes=")?.substringBefore('-')?.toIntOrNull() ?: 0
                        val response = MockResponse().setHeader("Content-Type", "audio/mpeg").setHeader("ETag", "\"source-v1\"").setHeader("Accept-Ranges", "bytes").setBody(Buffer().write(audio, start, audio.size - start))
                        if (start > 0) response.setResponseCode(206).setHeader("Content-Range", "bytes $start-${audio.lastIndex}/${audio.size}")
                        if (slow.get()) response.throttleBody(1024, 20, TimeUnit.MILLISECONDS)
                        return response
                    }
                    if (path.endsWith("/lyrics")) return json("""{"kind":"none","lines":[]}""")
                    if (path.endsWith("/albums")) return json("""{"items":[{"id":"completion-album","title":"手机测试专辑","artists":["测试艺人"],"track_count":$count,"cover_track_id":null}],"total":1,"limit":50,"offset":0}""")
                    if (path.endsWith("/artists")) return json("""{"items":[{"id":"person","name":"测试艺人","track_count":$count,"cover_track_id":null}],"total":1,"limit":50,"offset":0}""")
                    if (path.endsWith("/tracks")) {
                        val offset = url.queryParameter("offset")?.toInt() ?: 0
                        if (offset > 0 && failPage.get()) return MockResponse().setResponseCode(503)
                        val limit = url.queryParameter("limit")?.toInt() ?: 50
                        return json("""{"items":[${(offset until minOf(count, offset + limit)).joinToString(",") { track(it) }}],"total":$count,"limit":$limit,"offset":$offset}""")
                    }
                    if (path.endsWith("/playlists")) return if (request.method == "POST") json(manual) else json("""{"items":[${if (deletedPlaylist.get()) "" else manual}],"total":${if (deletedPlaylist.get()) 0 else 1},"limit":${url.queryParameter("limit") ?: "50"},"offset":0}""").apply { if (slowCatalog.get()) setBodyDelay(1200, TimeUnit.MILLISECONDS) }
                    if (path.endsWith("/manual") || path.endsWith("/order")) {
                        if (path.endsWith("/manual") && request.method == "GET" && holdPlaylistDetails.get()) {
                            playlistDetailsRequested.countDown()
                            if (!releasePlaylistDetails.await(20, TimeUnit.SECONDS)) return MockResponse().setResponseCode(504)
                        }
                        if (request.method == "DELETE") deletedPlaylist.set(true)
                        if (request.method == "PUT") {
                            val body = JsonParser.parseString(request.body.readUtf8()).asJsonObject
                            val record = JsonParser.parseString(manual).asJsonObject
                            record.addProperty("name", body["name"].asString); record.addProperty("version", record["version"].asInt + 1); manual = record.toString()
                        }
                        return json(manual)
                    }
                    if (Regex(".*/completion-\\d+$").matches(path)) return json(track(path.substringAfterLast('-').toInt()))
                    return MockResponse().setResponseCode(404)
                }
            }
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
        }
        override fun close() { releasePlaylistDetails.countDown(); server.close() }
    }
    private fun connect(fixture: Fixture): MusicViewModel {
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        val address = fixture.server.url("/").newBuilder().host("127.0.0.1").build().toString()
        compose.runOnIdle { vm.repository.session.invalidate(); vm.settings.quality(0); vm.sharing.mode("off"); vm.connect(address, "mobile-admin", "test-password", true) }
        compose.waitUntil(20_000) { vm.state.value.connected && !vm.state.value.loading }
        return vm
    }
    private fun cleanup(vm: MusicViewModel) { compose.runOnIdle { vm.sleep.cancel(); vm.repository.session.invalidate(); vm.controller?.stop(); vm.controller?.clearMediaItems() } }

    @Test fun collectionFetchesEveryPageAndFailurePreservesPausedQueue() {
        Fixture(257).use { fixture -> val vm = connect(fixture)
            try {
                val first = gson.fromJson(fixture.track(0), Track::class.java)
                compose.runOnIdle { vm.play(listOf(first)); vm.controller!!.pause(); vm.controller!!.seekTo(1000); vm.openAlbum(Album("completion-album", "手机测试专辑", listOf("测试艺人"), 257, null)) }
                compose.waitUntil(10_000) { !vm.state.value.loading }
                val oldEntry = compose.runOnIdle { vm.controller!!.currentMediaItem!!.mediaId }
                fixture.failPage.set(true)
                compose.onNodeWithText("播放全部").performClick()
                compose.waitUntil(15_000) { !vm.state.value.collecting && vm.state.value.error != null }
                assertEquals(oldEntry, compose.runOnIdle { vm.controller!!.currentMediaItem!!.mediaId })
                assertEquals(1, compose.runOnIdle { vm.controller!!.mediaItemCount }); assertFalse(compose.runOnIdle { vm.controller!!.playWhenReady })
                fixture.failPage.set(false)
                compose.onNodeWithText("播放全部").performClick()
                compose.waitUntil(20_000) { !vm.state.value.collecting && compose.runOnIdle { vm.controller!!.mediaItemCount == 257 } }
                assertTrue(fixture.requests.any { it.contains("offset=200") })
                compose.runOnIdle { vm.controller!!.pause(); vm.controller!!.seekTo(0, 11_500); vm.sleep.endOfTrack(vm.controller!!.currentMediaItem!!.mediaId); vm.controller!!.play() }
                compose.waitUntil(15_000) { vm.sleep.state.value.entryId == null && !vm.state.value.playing }
            } finally { cleanup(vm) }
        }
    }

    @Test fun completeOfflineFileResumesPlaysWithoutNetworkAndRevocationRemovesIt() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                val track = gson.fromJson(fixture.track(0), Track::class.java)
                val downloads = vm.repository.downloads
                downloads.wifiOnly = false; downloads.capacityGb = 4
                fixture.slow.set(true); downloads.enqueue(listOf(track))
                val job = CoroutineScope(Dispatchers.IO).launch { downloads.run {} }
                compose.waitUntil(15_000) { downloads.entries.value.any { it.bytes > 0 && it.state == "downloading" } }
                downloads.pause(track.id); runBlocking { withTimeout(10_000) { job.join() } }
                assertNull(downloads.file(track.id)); assertEquals("paused", downloads.entries.value.single().state)
                fixture.slow.set(false); downloads.resume(track.id)
                runBlocking { withTimeout(15_000) { downloads.run {} } }
                assertEquals(fixture.audio.size.toLong(), downloads.file(track.id)!!.length())
                assertEquals("complete", downloads.entries.value.single().state)
                val fetched = fixture.requests.count { it.startsWith("GET ") && it.contains("/stream") }
                fixture.disconnected.set(true)
                compose.runOnIdle { vm.play(listOf(track)) }
                compose.waitUntil(15_000) { compose.runOnIdle { vm.controller!!.isPlaying } }
                compose.runOnIdle { vm.controller!!.pause() }
                assertEquals("Offline playback must not fetch audio", fetched, fixture.requests.count { it.startsWith("GET ") && it.contains("/stream") })
                assertNotNull(downloads.file(track.id))
                fixture.disconnected.set(false); fixture.headCode.set(403)
                try { downloads.playableFile(vm.repository.originalStream(track.id)); fail("Revoked content must fail") } catch (_: OfflineAccessException) { }
                assertNull(downloads.file(track.id)); assertTrue(downloads.entries.value.isEmpty())
            } finally { cleanup(vm) }
        }
    }

    @Test fun downloadCompletionPolicyCanBeConfiguredFromManagement() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                compose.onNodeWithContentDescription("设置").performClick()
                compose.onNodeWithText("曲库管理", substring = false).performScrollTo().performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithText("下载完成与自动导入设置").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("下载完成与自动导入设置").performScrollTo().performClick()
                compose.onNodeWithText("检查间隔（15–86400 秒）").performTextReplacement("30")
                compose.onNodeWithText("稳定期（5–86400 秒）").performTextReplacement("10")
                compose.onNodeWithText("下载后缀，空格或逗号分隔").performTextReplacement(".part, .uploading")
                compose.onNodeWithText("保存设置").performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { click -> assertTrue(click()) }
                compose.waitUntil(10_000) { fixture.mutations.any { it.first.endsWith("/manage/intake/settings") } }
                val value = JsonParser.parseString(fixture.mutations.last { it.first.endsWith("/manage/intake/settings") }.second).asJsonObject
                assertEquals(30, value.get("interval_seconds").asInt)
                assertEquals(10, value.get("stable_seconds").asInt)
                assertEquals(".uploading", value.getAsJsonObject("download_policy").getAsJsonArray("partial_suffixes")[1].asString)
                assertEquals(1, value.get("version").asInt)
                capture("download-policy-phone.png")
            } finally { cleanup(vm) }
        }
    }

    @Test fun phoneRecommendationAiPlaylistAndManagementEntriesHaveWorkingControls() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                compose.onNodeWithTag("nav-mine").performClick()
                compose.onNodeWithTag("personal-shortcuts").assertIsDisplayed()
                compose.onNodeWithText("每日推荐", substring = false).assertDoesNotExist()
                compose.onNodeWithText("数据源插件", substring = false).assertDoesNotExist()
                capture("mobile-mine-compact.png")
                compose.onNodeWithTag("nav-search").performClick()
                compose.onNodeWithText("每日推荐", substring = false).performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("daily-track-completion-0").fetchSemanticsNodes().isNotEmpty() }
                capture("mobile-daily.png")
                compose.onNodeWithText("保存歌单").performClick()
                compose.waitUntil(10_000) { fixture.mutations.any { it.first.endsWith("/playlists/manual/tracks") } }
                compose.onAllNodesWithContentDescription("返回").onLast().performClick()
                compose.onNodeWithText("AI 找歌", substring = false).performClick()
                // A new Dialog window can attach after the shortcut's click becomes idle.
                compose.waitUntil(10_000) { compose.onAllNodes(hasText("想听什么？") and hasSetTextAction()).fetchSemanticsNodes().size == 1 }
                compose.onNodeWithText("想听什么？").performTextInput("想听摇滚")
                compose.onNodeWithText("生成候选").performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithText("手机 AI 歌单").fetchSemanticsNodes().isNotEmpty() }
                capture("mobile-ai-preview.png")
                compose.onNodeWithText("确认保存歌单").performClick()
                try { compose.waitUntil(10_000) { fixture.mutations.count { it.first.endsWith("/playlists") } >= 2 } }
                catch (error: Throwable) { capture("mobile-ui-failure.png"); compose.onRoot(useUnmergedTree = true).printToLog("MobileCompletionUI"); throw AssertionError("AI save requests=${fixture.requests.toList()} mutations=${fixture.mutations.toList()}", error) }
                compose.onAllNodesWithContentDescription("返回").onLast().performClick()
                compose.onNodeWithTag("nav-mine").performClick()
                compose.onNodeWithContentDescription("新建歌单").performClick()
                compose.onNodeWithText("歌单名称").performTextInput("手机规则歌单")
                compose.onNode(isToggleable()).performClick()
                compose.onNodeWithText("保存歌单").performScrollTo().performClick()
                compose.waitUntil(10_000) { fixture.mutations.any { it.first.endsWith("/playlists") && it.second.contains("\"kind\":\"smart\"") } }
                compose.onNodeWithContentDescription("设置").performClick()
                compose.onNodeWithText("曲库管理", substring = false).performScrollTo().performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithText("曲库概览").fetchSemanticsNodes().isNotEmpty() }
                compose.waitUntil(10_000) { compose.onAllNodes(hasText("导入音乐") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("导入音乐").performClick(); compose.onNodeWithText("开始", substring = false).performClick()
                compose.waitUntil(10_000) { fixture.mutations.any { it.first.endsWith("/manage/jobs") } }
                compose.onAllNodesWithContentDescription("返回").onLast().performClick()
                compose.onNodeWithContentDescription("返回").performClick()
                compose.runOnIdle { vm.openAlbum(Album("completion-album", "手机测试专辑", listOf("测试艺人"), 3, null)) }
                compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription("手机测试歌曲 0的操作").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithContentDescription("手机测试歌曲 0的操作").performClick(); compose.onNodeWithText("编辑歌曲信息").performScrollTo().performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithText("歌曲名称").fetchSemanticsNodes().isNotEmpty() }
                compose.waitUntil(10_000) { compose.onAllNodes(hasText("保存修改") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
                capture("mobile-metadata.png")
                compose.onNodeWithText("歌曲名称").performTextReplacement("手机修正标题")
                capture("mobile-metadata-edit-footer.png")
                // The footer remains visible while the focused field requests the IME.
                // Exercise its real accessibility click action rather than racing a changing
                // keyboard animation with a previously measured screen coordinate.
                compose.onNodeWithText("保存修改").assertIsDisplayed().assertIsEnabled()
                    .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { click -> assertTrue(click()) }
                try { compose.waitUntil(10_000) { fixture.mutations.any { it.first.endsWith("/metadata") } } }
                catch (error: Throwable) { capture("mobile-metadata-save-failure.png"); throw AssertionError("Metadata save requests=${fixture.requests.toList()} mutations=${fixture.mutations.toList()}", error) }
                val saved = JsonParser.parseString(fixture.mutations.first { it.first.endsWith("/metadata") }.second).asJsonObject.getAsJsonObject("overrides")
                assertEquals("手机修正标题", saved["title"].asString); assertEquals("人工专辑", saved["album"].asString); assertFalse(saved.has("artists"))
            } finally { cleanup(vm) }
        }
    }
    @Test fun lyricsConflictPreservesDraftAndSuggestionsRespectStatusAndVersion() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                compose.runOnIdle { vm.openAlbum(Album("completion-album", "手机测试专辑", listOf("测试艺人"), 3, null)) }
                compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription("手机测试歌曲 0的操作").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithContentDescription("手机测试歌曲 0的操作").performClick()
                compose.onNodeWithText("编辑歌词与打点").performScrollTo().performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithText("粘贴歌词，每句一行；也支持 LRC").fetchSemanticsNodes().isNotEmpty() }
                compose.waitUntil(10_000) { compose.onAllNodes(hasText("保存歌词") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("粘贴歌词，每句一行；也支持 LRC").performTextReplacement("新的第一句\n新的第二句")
                fixture.failLyrics.set(true)
                compose.onNodeWithText("保存歌词").performScrollTo().performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { it() }
                compose.waitUntil(10_000) { compose.onAllNodesWithText("内容已变化，请刷新后重试。").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("新的第一句\n新的第二句").assertExists()
                fixture.failLyrics.set(false)
                compose.onNodeWithText("保存歌词").performScrollTo().performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { it() }
                compose.waitUntil(10_000) { compose.onAllNodesWithText("歌词已保存").fetchSemanticsNodes().isNotEmpty() }
                val lyricBody = JsonParser.parseString(fixture.mutations.last { it.first.endsWith("/lyrics") }.second).asJsonObject
                assertEquals("a".repeat(64), lyricBody["file_version"].asString); assertEquals(1, lyricBody["version"].asInt)
                compose.onNodeWithText("开始逐行打点").performScrollTo().performClick()
                compose.onNodeWithText("播放此曲以打点").performScrollTo().performClick()
                compose.waitUntil(15_000) { vm.state.value.playing && !vm.state.value.buffering }
                compose.onNodeWithText("标记下一句（1 / 2）").performScrollTo().performClick()
                val firstMark = vm.position.value
                compose.waitUntil(10_000) { vm.position.value >= firstMark + 600 }
                compose.onNodeWithText("标记下一句（2 / 2）").performScrollTo().performClick()
                compose.onNodeWithText("生成同步歌词").performScrollTo().performClick()
                compose.onNodeWithText("保存歌词").performScrollTo().performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { it() }
                compose.waitUntil(10_000) { fixture.lyrics.startsWith("[") }
                assertEquals(2, fixture.lyrics.lines().size)
                assertTrue(fixture.lyrics.lines().all { it.matches(Regex("\\[\\d{2}:\\d{2}\\.\\d{3}].*")) })
                compose.runOnIdle { vm.controller!!.pause() }
                compose.onAllNodesWithContentDescription("返回").onLast().performClick()
                fixture.showSuggestions.set(true)
                compose.onNodeWithContentDescription("手机测试歌曲 0的操作").performClick()
                compose.onNodeWithText("更新元数据与建议").performScrollTo().performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("metadata-review").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("review-scroll").performScrollToNode(hasTestTag("review-field-title"))
                compose.onNodeWithTag("review-field-title").assertIsOn()
                compose.onNodeWithTag("review-field-album").performScrollTo().assertIsOff()
                compose.onAllNodesWithText("当前值").onFirst().assertExists()
                compose.onAllNodesWithText("建议值").onFirst().assertExists()
                compose.onNodeWithText("建议标题").performScrollTo().assertExists()
                capture("metadata-review-native.png")
                compose.onNodeWithText("接受选中项").performClick()
                compose.waitUntil(10_000) { fixture.applied.get() }
                val apply = JsonParser.parseString(fixture.mutations.last { it.first.endsWith("/metadata-review/accept") }.second).asJsonObject
                assertEquals(2, apply.getAsJsonArray("items").size())
                apply.getAsJsonArray("items").forEach { item -> assertEquals("title", item.asJsonObject.getAsJsonArray("fields").single().asString) }
            } finally { cleanup(vm) }
        }
    }
    @Test fun interruptedOldDownloadCannotReplaceSameTrackAfterNewLogin() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                val downloads = vm.repository.downloads
                val track = gson.fromJson(fixture.track(0), Track::class.java)
                downloads.wifiOnly = false; fixture.slow.set(true); downloads.enqueue(listOf(track.copy(title = "旧账户标题")))
                val firstOwner = vm.repository.session.cacheScope()
                val old = CoroutineScope(Dispatchers.IO).launch { downloads.run {} }
                compose.waitUntil(15_000) { downloads.entries.value.any { it.bytes > 0 } }
                compose.runOnIdle { vm.repository.session.invalidate() }
                compose.waitUntil(10_000) { !vm.state.value.connected }
                val address = fixture.server.url("/").newBuilder().host("127.0.0.1").build().toString()
                compose.runOnIdle { vm.connect(address, "mobile-admin", "test-password", true) }
                compose.waitUntil(15_000) { vm.state.value.connected && !vm.state.value.loading }
                assertNotEquals(firstOwner, vm.repository.session.cacheScope())
                fixture.slow.set(false); downloads.enqueue(listOf(track.copy(title = "新账户标题")))
                runBlocking { withTimeout(15_000) { old.join(); downloads.run {} } }
                assertEquals("新账户标题", downloads.entries.value.single().track.title)
                assertEquals("complete", downloads.entries.value.single().state)
                assertEquals(fixture.audio.size.toLong(), downloads.file(track.id)!!.length())
            } finally { cleanup(vm) }
        }
    }

    @Test fun automaticPlaylistDownloadsUseChosenQualityAndKeepExistingFiles() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                val downloads = vm.repository.downloads
                downloads.wifiOnly = false; downloads.bitrate = 192; fixture.aacDownloads.set(true)
                downloads.followPlaylist("manual", true)
                runBlocking { withContext(Dispatchers.Main) { vm.syncOfflinePlaylists() } }
                compose.waitUntil(20_000) { downloads.entries.value.count { it.state == "complete" } == 3 }
                assertTrue(fixture.requests.any { it.contains("format=aac") && it.contains("bitrate_kbps=192") })
                val entry = downloads.entries.value.first()
                assertEquals(192, entry.bitrate); assertEquals("m4a", entry.audioFormat)
                assertEquals("\"source-v1\"", entry.sourceEtag)
                assertEquals("m4a", downloads.formatForStream(vm.repository.originalStream(entry.track.id)))
                val count = fixture.requests.count { it.startsWith("GET ") && it.contains("/stream") }
                downloads.bitrate = 128
                runBlocking { withContext(Dispatchers.Main) { vm.syncOfflinePlaylists() } }
                assertEquals(count, fixture.requests.count { it.startsWith("GET ") && it.contains("/stream") })
                downloads.followPlaylist("manual", false)
                assertEquals(3, downloads.entries.value.count { it.state == "complete" })
                assertEquals(192, downloads.entries.value.first().bitrate)
            } finally { vm.repository.downloads.bitrate = 0; cleanup(vm) }
        }
    }

    @Test fun longPressPlaylistExposesEditDeleteAndDownloadActions() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                compose.runOnIdle { vm.navigate("mine") }
                compose.waitUntil(10_000) { vm.state.value.playlists.isNotEmpty() && !vm.state.value.loading }
                compose.onNodeWithText("测试歌单", useUnmergedTree = true).performTouchInput { longClick() }
                compose.onNodeWithText("自动下载歌单").assertIsDisplayed()
                fixture.holdPlaylistDetails.set(true)
                compose.onNodeWithText("编辑歌单").performClick()
                compose.waitUntil(10_000) { fixture.playlistDetailsRequested.count == 0L }
                compose.onNodeWithText("歌单名称").assertIsNotEnabled()
                fixture.releasePlaylistDetails.countDown()
                compose.waitUntil(10_000) {
                    compose.onAllNodes(hasText("歌单名称") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
                }
                compose.onNodeWithText("歌单名称").performTextClearance()
                compose.onNodeWithText("歌单名称").performTextInput("长按改名")
                compose.onNodeWithText("保存歌单").performScrollTo().performClick()
                compose.waitUntil(10_000) { vm.state.value.playlists.any { it.name == "长按改名" } }
                dismissKeyboard()
                assertEquals("Closing the editor keyboard must preserve the current tab", "mine", vm.state.value.tab)
                // The editor's IME can leave the saved lazy viewport below/above this row.
                compose.onNodeWithTag("catalog-list").performScrollToIndex(1)
                compose.waitUntil(10_000) { compose.onAllNodesWithText("长按改名", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("长按改名", useUnmergedTree = true).performTouchInput { longClick() }
                compose.onNodeWithText("删除歌单").performClick()
                compose.onNodeWithText("删除", useUnmergedTree = true).performClick()
                compose.waitUntil(10_000) { fixture.deletedPlaylist.get() && vm.state.value.playlists.isEmpty() }
                assertTrue(fixture.requests.any { it.startsWith("DELETE ") && it.contains("/playlists/manual") })
            } finally { fixture.releasePlaylistDetails.countDown(); cleanup(vm) }
        }
    }

    @Test fun minePullToRefreshUsesWaveIndicatorAndRealRequest() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                compose.runOnIdle { vm.navigate("mine") }
                compose.waitUntil(10_000) { vm.state.value.playlists.isNotEmpty() && !vm.state.value.loading }
                val before = fixture.requests.count { it.contains("/playlists?") }
                fixture.slowCatalog.set(true)
                compose.onNodeWithTag("catalog-list").performTouchInput { swipeDown(startY = 80f, endY = 650f, durationMillis = 600) }
                compose.waitUntil(10_000) { fixture.requests.count { it.contains("/playlists?") } > before }
                compose.onNodeWithTag("wildstring-refresh").assertIsDisplayed()
                capture("mine-wave-refresh")
                compose.waitUntil(10_000) { !vm.state.value.loading }
            } finally { cleanup(vm) }
        }
    }

    @Test fun crossDevicePromptRestoresPausedAndPausePublishesWithoutManualClaim() {
        Fixture().use { fixture -> val vm = connect(fixture)
            try {
                compose.runOnIdle { vm.sharing.mode("ask") }
                fixture.snapshot = """{"version":70,"device_id":"other-device","track_ids":["completion-0","completion-1"],"index":1,"position_ms":3000,"mode":"repeat_all","updated_at":"2026-10-17T00:00:00Z"}"""
                runBlocking { withContext(Dispatchers.Main) { vm.checkSharedPlayback() } }
                compose.onNodeWithText("其他设备有可接续的进度").assertIsDisplayed()
                compose.onNodeWithText("载入进度").performClick()
                try { compose.waitUntil(10_000) { vm.state.value.handoff == null && vm.state.value.queue.size == 2 } }
                catch (e: Throwable) {
                    val tree = runCatching { val roots = compose.onAllNodes(isRoot(), useUnmergedTree = true); (0 until roots.fetchSemanticsNodes().size).joinToString("\n") { roots[it].printToString() } }.getOrDefault("UI unavailable")
                    throw AssertionError("handoff=${vm.state.value.handoff != null}, queue=${vm.state.value.queue.size}, error=${vm.state.value.error}\n$tree", e)
                }
                compose.waitUntil(10_000) { compose.runOnIdle { vm.controller!!.currentMediaItemIndex == 1 && vm.controller!!.currentPosition == 3000L } }
                compose.runOnIdle { assertFalse(vm.controller!!.playWhenReady) }
                assertFalse(fixture.mutations.any { it.first.endsWith("/playback/state") })
                compose.runOnIdle { vm.toggle() }
                compose.waitUntil(10_000) { vm.state.value.playing }
                compose.runOnIdle { vm.seek(5000); vm.toggle() }
                compose.waitUntil(10_000) { compose.runOnIdle { !vm.controller!!.playWhenReady && !vm.controller!!.isPlaying } }
                compose.waitUntil(10_000) { JsonParser.parseString(fixture.snapshot).asJsonObject["position_ms"].asLong >= 4900 }
                assertTrue(fixture.mutations.any { it.first.endsWith("/playback/state") })
                val paused = gson.fromJson(fixture.snapshot, SharedPlayback::class.java)
                val writes = fixture.mutations.count { it.first.endsWith("/playback/state") }
                runBlocking { vm.sharing.publish(paused, force = true) }
                assertEquals(writes, fixture.mutations.count { it.first.endsWith("/playback/state") })
                fixture.snapshot = """{"version":90,"device_id":"other-device","track_ids":["completion-0"],"index":0,"position_ms":2000,"mode":"sequential","updated_at":null}"""
                runBlocking { withContext(Dispatchers.Main) { vm.checkSharedPlayback() } }
                compose.runOnIdle { assertNull(vm.state.value.handoff); vm.syncMode("off") }
                runBlocking { withContext(Dispatchers.Main) { vm.checkSharedPlayback() } }
                compose.runOnIdle { assertNull(vm.state.value.handoff); vm.sharing.mode("auto") }
                runBlocking { withContext(Dispatchers.Main) { vm.checkSharedPlayback() } }
                compose.waitUntil(10_000) { vm.state.value.queue.size == 1 }
                compose.waitUntil(10_000) { compose.runOnIdle { vm.controller!!.currentPosition == 2000L } }
                compose.runOnIdle { assertFalse(vm.controller!!.playWhenReady) }
            } finally { vm.sharing.mode("off"); cleanup(vm) }
        }
    }
}
