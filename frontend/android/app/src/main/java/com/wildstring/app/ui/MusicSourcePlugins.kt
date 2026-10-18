package com.wildstring.app.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream

@Composable internal fun SourcePluginsPanel(vm: MusicViewModel) {
    val context = LocalContext.current; val uriHandler = LocalUriHandler.current
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    var plugins by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var fields by remember { mutableStateOf<Map<String, Map<String, String>>>(emptyMap()) }
    var savedPlugins by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var savedFields by remember { mutableStateOf<Map<String, Map<String, String>>>(emptyMap()) }
    val tests = remember { mutableStateMapOf<String, FeatureAction>() }
    val busy = action.busy || tests.values.any { it.busy }
    var upgrade by remember { mutableStateOf<JsonObject?>(null) }; var exporting by remember { mutableStateOf<JsonObject?>(null) }
    suspend fun load() {
        plugins = vm.repository.feature("manage/source-plugins").objects()
        fields = plugins.associate { it.text("id") to (it.getAsJsonObject("config")?.entrySet()?.associate { e -> e.key to e.value.asString } ?: emptyMap()) }
        savedPlugins = plugins.associate { it.text("id") to it.toString() }
        savedFields = fields
    }
    val importer = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch { action.run {
            val owner = vm.repository.session.cacheScope()
            val bytes = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)!!.use { input ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val n = input.read(buffer); if (n < 0) break; require(output.size() + n <= 16 * 1024 * 1024) { "插件 ZIP 超过 16 MiB" }; output.write(buffer, 0, n) }
                output.toByteArray()
            } }
            require(owner == vm.repository.session.cacheScope()) { "账号已变化" }
            val url = vm.repository.url("api", "v1", "manage", "source-plugins", "import") + (upgrade?.let { "?expected_version=${it.number("version")}&expected_id=${it.text("id")}" } ?: "")
            val response = vm.repository.api().uploadPlugin(url, bytes.toRequestBody("application/zip".toMediaType()), RequestOwner(owner!!))
            if (!response.isSuccessful) throw AgentApiException(response.code(), "source_plugin_invalid_zip", diagnosticId(response.headers()["X-Wildstring-Trace-Id"]))
            require(owner == vm.repository.session.cacheScope()) { "账号已变化" }
            load(); action.message = "插件已导入并停用，请核对配置后启用。"; upgrade = null
        } }
    }
    val exporter = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        val plugin = exporting
        if (uri != null && plugin != null) scope.launch { action.run {
            withContext(Dispatchers.IO) { vm.repository.api().downloadPlugin(vm.repository.url("api", "v1", "manage", "source-plugins", plugin.text("id"), "export"), RequestOwner(vm.repository.session.cacheScope()!!)).use { body ->
                context.contentResolver.openOutputStream(uri, "wt")!!.use { output -> body.byteStream().use { input ->
                    val buffer = ByteArray(8192); var total = 0
                    while (true) { val n = input.read(buffer); if (n < 0) break; total += n; require(total <= 16 * 1024 * 1024); output.write(buffer, 0, n) }
                } }
            } }; action.message = "插件 ZIP 已导出。"
        } }
    }
    LaunchedEffect(Unit) { action.run { load() }; if (action.message == "已完成") action.message = null }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("数据源 ZIP 插件", style = MaterialTheme.typography.titleLarge)
        Text("独立导入、配置和分享。插件运行 Python 代码，仅导入你信任的包。插件只提供候选，确认后才更新数据库。")
        ActionStatus(action)
        Button({ upgrade = null; importer.launch(arrayOf("application/zip", "application/octet-stream")) }, enabled = !busy) { Text("导入数据源插件 ZIP") }
        plugins.forEach { p -> key(p.text("id")) {
            val id = p.text("id")
            val test = remember { FeatureAction().also { tests[id] = it } }
            val dirty = savedPlugins[id] != p.toString() || savedFields[id] != fields[id]
            HorizontalDivider(); Text(p.text("name"), style = MaterialTheme.typography.titleMedium)
            Text("${p.text("license")} · 插件 ${p.text("plugin_version")} · 配置版本 ${p.number("version")}", style = MaterialTheme.typography.bodySmall)
            TextButton({ uriHandler.openUri(p.text("upstream")) }) { Text("查看上游项目") }
            if (!p.flag("available")) Text("运行环境缺少插件声明的依赖，请按插件说明或升级官方镜像。")
            listOf("enabled" to "启用插件", "metadata_enabled" to "提供元数据与封面", "lyrics_enabled" to "提供歌词").forEach { (key, label) ->
                Row { Text(label, Modifier.weight(1f)); Switch(p.flag(key), { checked -> plugins = plugins.map { value -> if (value === p) value.deepCopy().apply { addProperty(key, checked) } else value } }, enabled = !busy) }
            }
            OutlinedTextField(p.number("priority").toString(), { text -> text.toIntOrNull()?.takeIf { it in 0..100 }?.let { number -> plugins = plugins.map { value -> if (value === p) value.deepCopy().apply { addProperty("priority", number) } else value } } }, label = { Text("来源优先级（0–100，越小越优先）") })
            p.objects("settings").forEach { field ->
                val key = field.text("key"); val id = p.text("id")
                OutlinedTextField(fields[id]?.get(key).orEmpty(), { fields = fields + (id to (fields[id].orEmpty() + (key to it))) }, label = { Text(field.text("label")) }, visualTransformation = if (field.text("type") == "secret") PasswordVisualTransformation() else VisualTransformation.None, singleLine = true)
            }
            TextButton({ scope.launch { action.run {
                val config = JsonObject().apply { fields[p.text("id")]?.forEach { (key, value) -> addProperty(key, value) } }
                vm.repository.feature("manage/source-plugins/${p.text("id")}", "PUT", jsonBody("version" to p.number("version"), "enabled" to p.flag("enabled"), "metadata_enabled" to p.flag("metadata_enabled"), "lyrics_enabled" to p.flag("lyrics_enabled"), "priority" to p.number("priority")).apply { add("config", config) })
                load(); action.message = "插件设置已保存。"
            } } }, enabled = !busy) { Text("保存 ${p.text("name")}") }
            TextButton({ scope.launch { test.run {
                val result = vm.repository.feature("manage/source-plugins/$id/test", "POST")
                test.message = "检索已响应 · 返回 ${result.number("count")} 条候选。"
            } } }, enabled = !busy && !dirty && p.flag("enabled"), modifier = Modifier.testTag("plugin-test-$id")) { Text("测试此插件") }
            if (dirty) Text("请先保存当前插件设置，再测试。", style = MaterialTheme.typography.bodySmall)
            else Column(Modifier.testTag("plugin-test-result-$id")) { ActionStatus(test) }
            Row {
                TextButton({ exporting = p; exporter.launch("wildstring-${p.text("id")}.zip") }, enabled = !busy) { Text("导出 ZIP") }
                TextButton({ upgrade = p; importer.launch(arrayOf("application/zip", "application/octet-stream")) }, enabled = !busy) { Text("升级 ZIP") }
            }
            TextButton({ scope.launch { action.run {
                val response = vm.repository.api().agentDelete(vm.repository.url("api", "v1", "manage", "source-plugins", p.text("id")) + "?version=${p.number("version")}", RequestOwner(vm.repository.session.cacheScope()!!))
                if (!response.isSuccessful) throw AgentApiException(response.code(), "source_plugin_disable_first", null)
                load(); action.message = "插件已卸载，历史候选保留。"
            } } }, enabled = !busy && !p.flag("enabled")) { Text("卸载此插件") }
        } }
        if (plugins.isEmpty()) Text("尚无插件，请导入本次 Release 提供的 QQ、酷狗或网易云 ZIP。")
    }
}

@Composable internal fun OnlineLyricsPanel(vm: MusicViewModel, track: Track, applied: () -> Unit) {
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope(); val uriHandler = LocalUriHandler.current
    var result by remember { mutableStateOf<JsonObject?>(null) }; var selected by remember { mutableStateOf<JsonObject?>(null) }; var offset by remember { mutableStateOf("0") }
    suspend fun load() { result = vm.repository.feature("manage/tracks/${track.id}/online-lyrics") }
    LaunchedEffect(track.id) { action.run { load() }; if (action.message == "已完成") action.message = null }
    val running = result?.objects("jobs")?.any { it.text("status") in listOf("queued", "running") } == true
    LaunchedEffect(running, track.id) { while (running) { delay(2000); load() } }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HorizontalDivider(); Text("联网歌词候选", style = MaterialTheme.typography.titleMedium)
        Text("先核对版本、歌手和时长。歌词来源可与元数据不同，确认后才替换数据库歌词。", style = MaterialTheme.typography.bodySmall)
        ActionStatus(action)
        TextButton({ scope.launch { action.run { vm.repository.feature("manage/tracks/${track.id}/online-lyrics", "POST"); load() } } }, enabled = !action.busy && !running) { Text(if (running) "后台正在查询歌词…" else "查找联网歌词") }
        result?.objects()?.forEach { candidate ->
            val match = candidate.getAsJsonObject("match"); val lyrics = candidate.getAsJsonObject("normalized")
            Text("${candidate.text("plugin_id")} · ${match.text("title")} · ${lyrics.text("format").uppercase()} · ${candidate.number("line_count")} 行")
            if (match.flag("version_mismatch")) Text("版本标记不同，请试听核对。")
            TextButton({ uriHandler.openUri(candidate.text("source_url")) }) { Text("查看歌词来源") }
            TextButton({ selected = candidate; offset = "0" }, enabled = !action.busy) { Text("预览并选择歌词") }
        }
        result?.objects("jobs")?.firstOrNull()?.getAsJsonArray("warnings")?.forEach { Text(it.asString, style = MaterialTheme.typography.bodySmall) }
    }
    selected?.let { candidate -> AlertDialog(onDismissRequest = { if (!action.busy) selected = null }, title = { Text("核对并使用歌词？") }, text = {
        Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) {
            Text(candidate.getAsJsonObject("normalized").objects("lines").take(100).joinToString("\n") { it.text("text") })
            OutlinedTextField(offset, { offset = it }, label = { Text("偏移毫秒（正值延后，±60000）") })
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        vm.repository.feature("manage/lyric-candidates/${candidate.text("id")}/apply", "POST", jsonBody("version" to candidate.number("lyrics_version"), "file_version" to candidate.text("file_version"), "offset_ms" to (offset.toIntOrNull() ?: 0)))
        selected = null; load(); applied(); vm.refreshLyrics(); action.message = "歌词已保存，音频文件未修改。"
    } } }, enabled = !action.busy && offset.toIntOrNull() in -60000..60000) { Text("确认使用此歌词") } }, dismissButton = { TextButton({ selected = null }, enabled = !action.busy) { Text("取消") } }) }
}
