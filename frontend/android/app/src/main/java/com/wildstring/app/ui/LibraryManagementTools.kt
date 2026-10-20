package com.wildstring.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal fun obj(vararg values: Pair<String, Any?>): JsonObject = JsonObject().apply { values.forEach { (key, value) ->
    when(value) { null -> add(key, JsonNull.INSTANCE); is JsonElement -> add(key, value); is Boolean -> addProperty(key, value); is Number -> addProperty(key, value); else -> addProperty(key, value.toString()) }
} }
internal fun JsonObject.text(key: String): String = get(key)?.takeUnless { it.isJsonNull }?.let { if (it.isJsonPrimitive) it.asString else it.toString() }.orEmpty()
private fun fieldText(value: JsonElement?): String = when { value == null || value.isJsonNull -> ""; value.isJsonArray -> value.asJsonArray.joinToString("\n") { it.asString }; value.isJsonPrimitive -> value.asString; else -> value.toString() }
private val metadataFields = listOf("title" to "歌曲名称", "artists" to "歌曲艺人（每行一位）", "album" to "专辑", "album_artists" to "专辑艺人（每行一位）",
    "vocalists" to "演唱", "lyricists" to "作词", "composers" to "作曲", "arrangers" to "编曲", "track_number" to "曲号", "disc_number" to "碟号")
private val arrayFields = setOf("artists", "album_artists", "vocalists", "lyricists", "composers", "arrangers")
private fun parseField(key: String, value: String): JsonElement = when {
    key in arrayFields -> JsonArray().apply { value.lines().map { it.trim() }.filter { it.isNotEmpty() }.forEach { add(it) } }
    key.endsWith("_number") -> if (value.isBlank()) JsonNull.INSTANCE else com.google.gson.JsonPrimitive((value.toIntOrNull() ?: throw IllegalArgumentException("编号应为 1–99999。")).also { require(it in 1..99999) { "编号应为 1–99999。" } })
    value.isBlank() && key != "title" -> JsonNull.INSTANCE
    else -> com.google.gson.JsonPrimitive(value.trim())
}

@Composable
internal fun MetadataPanel(vm: MusicViewModel, track: Track) {
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    var original by remember { mutableStateOf<JsonObject?>(null) }
    val fields = remember { mutableStateMapOf<String, String>() }; var restore by remember { mutableStateOf(setOf<String>()) }
    suspend fun load() {
        original = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "tracks", track.id, "metadata"))
        val effective = original!!.getAsJsonObject("effective")
        metadataFields.forEach { (key, _) -> fields[key] = fieldText(effective.get(key)) }; restore = emptySet()
    }
    LaunchedEffect(track.id) { action.run { load() }; if (action.message == "已完成") action.message = null }
    Column(Modifier.fillMaxSize()) {
      Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(track.title, style = MaterialTheme.typography.titleLarge)
        Text("保存为人工修正。音乐文件不会被自动改写；“恢复文件值”可撤销该字段的人工覆盖。", style = MaterialTheme.typography.bodySmall)
        if (original != null) metadataFields.forEach { (key, label) ->
            OutlinedTextField(fields[key].orEmpty(), { fields[key] = it.take(8000); restore = restore - key }, Modifier.fillMaxWidth(), label = { Text(label) }, enabled = !action.busy && key !in restore, minLines = if (key in arrayFields) 2 else 1)
            if (original!!.getAsJsonObject("overrides")?.has(key) == true) Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(key in restore, { restore = if (it) restore + key else restore - key }); Text("恢复文件值", style = MaterialTheme.typography.bodySmall)
            }
        }
      }
      // Keep the primary action reachable while editing any field or while the IME is open.
      // The enclosing FeatureDialog applies imePadding, so this footer remains above the keyboard.
      Surface(tonalElevation = 2.dp) {
       Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
        ActionStatus(action)
        Button({ focus.clearFocus(); keyboard?.hide(); scope.launch { action.run {
            val record = original ?: return@run
            val overrides = record.getAsJsonObject("overrides").deepCopy()
            val effective = record.getAsJsonObject("effective")
            metadataFields.forEach { (key, _) ->
                if (key in restore) overrides.remove(key)
                else if (fields[key].orEmpty() != fieldText(effective.get(key))) overrides.add(key, parseField(key, fields[key].orEmpty()))
            }
            vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "tracks", track.id, "metadata"), obj("version" to record.get("version"), "overrides" to overrides))
            load(); vm.load(); action.message = "歌曲信息已保存"
        } } }, enabled = original != null && !action.busy, modifier = Modifier.fillMaxWidth()) { Text("保存修改") }
       }
      }
    }
}

@Composable
internal fun LyricsEditorPanel(vm: MusicViewModel, track: Track) {
    val state by vm.state.collectAsStateWithLifecycle(); val position by vm.position.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    var record by remember { mutableStateOf<JsonObject?>(null) }; var text by remember { mutableStateOf("") }
    var timing by remember { mutableStateOf(false) }; var lines by remember { mutableStateOf<List<String>>(emptyList()) }
    var times by remember { mutableStateOf<List<Long?>>(emptyList()) }; var cursor by remember { mutableIntStateOf(0) }
    suspend fun load() { record = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "tracks", track.id, "lyrics")); text = record!!.text("text") }
    LaunchedEffect(track.id) { action.run { load() } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(track.title, style = MaterialTheme.typography.titleMedium); ActionStatus(action)
        if (!timing) {
            OutlinedTextField(text, { text = it.take(500_000) }, Modifier.fillMaxWidth().heightIn(min = 240.dp), label = { Text("粘贴歌词，每句一行；也支持 LRC") }, enabled = record != null && !action.busy)
            TextButton({
                lines = text.lines().map { it.replace(Regex("\\[[^]]*]"), "").trim() }
                times = lines.map { null }; cursor = 0; timing = true
            }, enabled = text.isNotBlank() && record != null) { Text("开始逐行打点") }
        } else {
            Text("听到一句开始时，点击“标记下一句”。暂停或缓冲时不会记录时间。", style = MaterialTheme.typography.bodySmall)
            if (state.current?.id != track.id) Button({ vm.play(listOf(track)) }) { Text("播放此曲以打点") }
            else Row(verticalAlignment = Alignment.CenterVertically) { TextButton(vm::toggle) { Text(if (state.playing) "暂停" else "播放") }; Text(formatTime(position)); TextButton({ vm.seek(0) }) { Text("回到开头") } }
            lines.forEachIndexed { index, line -> Row(Modifier.fillMaxWidth().clickable { cursor = index }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(cursor == index, { cursor = index }); Text((times.getOrNull(index)?.let(::formatTime) ?: "未标记") + "  " + line.ifBlank { "（间奏）" }, Modifier.weight(1f), color = if (cursor == index) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            } }
            Button({
                if (cursor < lines.size) {
                    val previous = times.take(cursor).filterNotNull().lastOrNull() ?: 0
                    val next = times.drop(cursor + 1).filterNotNull().firstOrNull() ?: Long.MAX_VALUE
                    if (position in previous..next) { times = times.toMutableList().apply { this[cursor] = position }; cursor = (cursor + 1).coerceAtMost(lines.size) }
                    else action.message = "时间需按歌词顺序递增，请调整播放位置。"
                }
            }, enabled = state.current?.id == track.id && state.playing && !state.buffering && cursor < lines.size) { Text("标记下一句（${cursor + 1} / ${lines.size}）") }
            Row {
                TextButton({ val target = (cursor - 1).coerceAtLeast(0); times = times.toMutableList().apply { this[target] = null }; cursor = target }, enabled = times.any { it != null }) { Text("撤销上一句") }
                TextButton({ timing = false }) { Text("取消打点") }
            }
            Button({ text = lines.mapIndexed { i, line -> val ms = times[i]!!; "[%02d:%02d.%03d]%s".format(ms / 60_000, ms / 1000 % 60, ms % 1000, line) }.joinToString("\n"); timing = false }, enabled = times.isNotEmpty() && times.all { it != null }) { Text("生成同步歌词") }
        }
        if (!timing) Row {
            TextButton({ scope.launch { action.run { val preview = vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "tracks", track.id, "lyrics", "preview"), obj("text" to text)); action.message = "预览通过 · ${preview.getAsJsonArray("lines")?.size() ?: 0} 行" } } }, enabled = record != null && !action.busy) { Text("验证预览") }
            Button({ scope.launch { action.run {
                val r = record!!; vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "tracks", track.id, "lyrics"), obj("version" to r.get("version"), "file_version" to r.get("file_version"), "text" to text))
                load(); vm.refreshLyrics(); action.message = "歌词已保存"
            } } }, enabled = record != null && !action.busy) { Text("保存歌词") }
        }
        TextButton({ scope.launch { action.run { val r = record!!; vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "tracks", track.id, "lyrics"), obj("version" to r.get("version"), "file_version" to r.get("file_version"), "text" to null)); load(); vm.refreshLyrics(); action.message = "已恢复文件歌词" } } }, enabled = record != null && !action.busy && !timing) { Text("恢复文件歌词") }
        if (!timing) OnlineLyricsPanel(vm, track) { scope.launch { load() } }
    }
}

@Composable
internal fun SuggestionsPanel(vm: MusicViewModel, track: Track) { MetadataReviewPanel(vm, track) }
internal fun statusName(value: String): String = when(value) { "queued" -> "等待中"; "running" -> "执行中"; "completed" -> "已完成"; "completed_with_errors" -> "完成，部分文件需处理"; "failed" -> "失败"; "interrupted" -> "已中断"; "review" -> "待确认"; "conflict" -> "存在冲突"; "ready" -> "准备就绪"; "waiting" -> "等待文件稳定"; "no_match" -> "没有匹配结果"; else -> value }

@Composable
internal fun ManagementPanel(vm: MusicViewModel, initialBatchId: String? = null) {
    var reviewOpen by remember { mutableStateOf(initialBatchId != null) }
    if (reviewOpen) { Column(Modifier.fillMaxSize()) { TextButton({ reviewOpen = false }) { Text("返回曲库管理") }; MetadataReviewPanel(vm, initialBatchId = initialBatchId) }; return }
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    var overview by remember { mutableStateOf<JsonObject?>(null) }; var jobs by remember { mutableStateOf<JsonObject?>(null) }
    var intake by remember { mutableStateOf<JsonObject?>(null) }; var automatic by remember { mutableStateOf<JsonObject?>(null) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }; var confirmJob by remember { mutableStateOf<String?>(null) }
    var pendingOffset by remember { mutableIntStateOf(0) }
    var jobOffset by remember { mutableIntStateOf(0) }
    var editImport by remember { mutableStateOf(false) }
    suspend fun load() {
        overview = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "overview"))
        jobs = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "jobs") + "?limit=20&offset=$jobOffset")
        intake = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "intake", "items") + "?limit=20&offset=$pendingOffset")
        automatic = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "intake", "settings"))
    }
    LaunchedEffect(pendingOffset, jobOffset) { action.run { load() }; while (true) { delay(4000); if (!action.busy && selected == null) runCatching { load() } } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("曲库概览", style = MaterialTheme.typography.titleLarge)
        Button({ reviewOpen = true }) { Text("批量核对资料") }
        overview?.let { info -> val counts = info.getAsJsonObject("counts"); Text("${counts?.text("tracks")} 首 · ${info.text("albums")} 张专辑 · ${info.text("artists")} 位艺人"); Text("音频 ${counts?.get("size_bytes")?.asLong?.div(1024 * 1024) ?: 0} MiB") }
        Row { Button({ confirmJob = "import" }, enabled = !action.busy) { Text("导入音乐") }; Spacer(Modifier.width(12.dp)); OutlinedButton({ confirmJob = "scan" }, enabled = !action.busy) { Text("扫描曲库") } }
        TextButton({ scope.launch { action.run { val result = vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "providers", "refresh"), obj("scope" to "library", "mode" to "missing", "force" to false)); action.message = "已排队 ${result.text("queued")} 首；完成后可批量核对资料" } } }, enabled = !action.busy) { Text("更新整库缺失元数据") }
        automatic?.let { options -> Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(options.get("enabled")?.asBoolean == true, { enabled -> scope.launch { action.run { automatic = vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "intake", "settings"), obj("version" to options.get("version"), "enabled" to enabled, "interval_seconds" to options.get("interval_seconds"), "stable_seconds" to options.get("stable_seconds"))); action.message = "自动发现设置已保存" } } }, enabled = !action.busy)
            Text("自动发现导入源", Modifier.padding(start = 12.dp))
        } }
        if (automatic?.has("download_policy") == true) TextButton({ editImport = true }) { Text("下载完成与自动导入设置") }
        ActionStatus(action)
        Text("待整理", style = MaterialTheme.typography.titleLarge)
        intake?.getAsJsonArray("items")?.forEach { node -> val item = node.asJsonObject
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) {
                Text(item.text("source_path")); Text(statusName(item.text("state")), style = MaterialTheme.typography.bodySmall)
                Text(item.getAsJsonArray("issues")?.joinToString("、") { if (it.asString == "download_incomplete") "同专辑仍有下载标记，等待下载完成" else it.asString }.orEmpty(), style = MaterialTheme.typography.bodySmall)
                Row {
                    if (item.get("can_approve")?.asBoolean == true) TextButton({ selected = item }) { Text("补充并确认") }
                    if (item.text("state") == "failed") TextButton({ scope.launch { action.run { vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "intake", "items", item.text("id"), "retry"), obj("version" to item.get("version"))); load() } } }, enabled = !action.busy) { Text("重试") }
                    TextButton({ scope.launch { action.run { vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "intake", "items", item.text("id"), "ignore"), obj("version" to item.get("version"))); load() } } }, enabled = !action.busy) { Text("忽略") }
                }
            } }
        }
        Row {
            TextButton({ pendingOffset = (pendingOffset - 20).coerceAtLeast(0) }, enabled = pendingOffset > 0 && !action.busy) { Text("上一页") }
            TextButton({ pendingOffset += 20 }, enabled = pendingOffset + 20 < (intake?.get("total")?.asInt ?: 0) && !action.busy) { Text("下一页") }
        }
        Text("后台任务", style = MaterialTheme.typography.titleLarge)
        jobs?.getAsJsonArray("items")?.forEach { node -> val item = node.asJsonObject
            Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                Text((if (item.text("kind") == "import") "导入" else "扫描") + " · " + statusName(item.text("status")))
                item.get("result")?.takeIf { it.isJsonObject }?.asJsonObject?.get("counts")?.takeIf { it.isJsonObject }?.asJsonObject?.let { counts ->
                    Text(counts.entrySet().joinToString(" · ") { (key, value) -> (when(key) { "discovered" -> "发现"; "imported" -> "导入"; "scanned" -> "扫描"; "added" -> "新增"; "updated" -> "更新"; "unchanged" -> "未变化"; "errors" -> "错误"; "missing" -> "缺失"; "unreadable" -> "不可读"; "skipped" -> "跳过"; else -> key }) + " " + value.asString }, style = MaterialTheme.typography.bodySmall)
                }
                if (item.text("error").isNotBlank()) Text(item.text("error"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
        Row {
            TextButton({ jobOffset = (jobOffset - 20).coerceAtLeast(0) }, enabled = jobOffset > 0 && !action.busy) { Text("更近任务") }
            TextButton({ jobOffset += 20 }, enabled = jobOffset + 20 < (jobs?.get("total")?.asInt ?: 0) && !action.busy) { Text("更早任务") }
        }
    }
    confirmJob?.let { kind -> AlertDialog(onDismissRequest = { confirmJob = null }, title = { Text(if (kind == "import") "导入服务端音乐？" else "扫描托管曲库？") }, text = { Text(if (kind == "import") "从服务器配置的导入源复制新音乐，原文件保持不变。" else "重新读取托管音乐的文件信息，保留人工修正。") }, confirmButton = { TextButton({ scope.launch { action.run { vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "jobs"), obj("kind" to kind, "full" to false)); confirmJob = null; load(); action.message = "任务已提交，可以继续听歌" } } }, enabled = !action.busy) { Text("开始") } }, dismissButton = { TextButton({ confirmJob = null }) { Text("取消") } }) }
    if (editImport) automatic?.let { options -> ImportSettingsDialog(vm, options, { editImport = false }) { result -> automatic = result; editImport = false } }
    selected?.let { item -> IntakeApprovalDialog(vm, item, { selected = null }) { scope.launch { action.run { load() } } } }
}

@Composable
private fun IntakeApprovalDialog(vm: MusicViewModel, item: JsonObject, dismiss: () -> Unit, saved: () -> Unit) {
    val fields = remember(item.text("id")) { mutableStateMapOf<String, String>().apply {
        val effective = item.getAsJsonObject("metadata") ?: JsonObject()
        metadataFields.take(4).forEach { (key, _) -> put(key, fieldText(item.getAsJsonObject("overrides")?.get(key) ?: effective.get(key))) }
    } }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text("补充待整理信息") }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            metadataFields.take(4).forEach { (key, title) -> OutlinedTextField(fields[key].orEmpty(), { fields[key] = it.take(8000) }, label = { Text(title) }, enabled = !action.busy) }
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        val overrides = item.getAsJsonObject("overrides")?.deepCopy() ?: JsonObject()
        fields.forEach { (key, value) -> overrides.add(key, parseField(key, value)) }
        vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "intake", "items", item.text("id"), "approve"), obj("version" to item.get("version"), "overrides" to overrides))
        dismiss(); saved()
    } } }, enabled = !action.busy) { Text("确认并导入") } }, dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text("取消") } })
}

@Composable
internal fun MetadataRefreshPrompt(vm: MusicViewModel, scopeName: String, id: String?, dismiss: () -> Unit) {
    var missing by remember { mutableStateOf(true) }; var force by remember { mutableStateOf(false) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text("更新元数据") }, text = {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(missing, { missing = it }); Text("只补缺失信息") }
            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(force, { force = it }); Text("重新联网查询") }
            Text("联网结果生成建议，确认后应用。", style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        val result = vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "providers", "refresh"), obj("scope" to scopeName, "id" to id, "mode" to if (missing) "missing" else "all", "force" to force))
        val queued = result.number("queued").toInt(); val active = result.number("already_active").toInt(); val upgraded = result.number("upgraded").toInt(); val intents = result.number("refresh_intents").toInt()
        action.message = "新增排队 $queued 首 · 已有任务 $active 首" + if (upgraded + intents > 0) " · 已更新刷新意图 ${upgraded + intents} 首" else ""; vm.notify(action.message!!); dismiss()
    } } }, enabled = !action.busy) { Text(if (action.busy) "正在提交…" else "开始更新") } }, dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text("取消") } })
}

@Composable
private fun ImportSettingsDialog(vm: MusicViewModel, initial: JsonObject, dismiss: () -> Unit, saved: (JsonObject) -> Unit) {
    var interval by remember { mutableStateOf(initial.text("interval_seconds")) }
    var stable by remember { mutableStateOf(initial.text("stable_seconds")) }
    val policy = initial.getAsJsonObject("download_policy")
    var waitAlbum by remember { mutableStateOf(policy.get("wait_for_album").asBoolean) }
    var suffixes by remember { mutableStateOf(policy.getAsJsonArray("partial_suffixes").joinToString(", ") { it.asString }) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text("下载完成与自动导入") }, text = {
        Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(interval, { interval = it }, label = { Text("检查间隔（15–86400 秒）") })
            OutlinedTextField(stable, { stable = it }, label = { Text("稳定期（5–86400 秒）") })
            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(waitAlbum, { waitAlbum = it }); Text("同专辑有下载标记时整张等待") }
            OutlinedTextField(suffixes, { suffixes = it }, label = { Text("下载后缀，空格或逗号分隔") })
            Text("建议下载器使用独立未完成目录，完成后移入导入源。导入只复制，原件可继续做种。", style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        val check = interval.toIntOrNull(); val duration = stable.toIntOrNull()
        require(check != null && check in 15..86400 && duration != null && duration in 5..86400) { "请检查时间范围" }
        val endings = JsonArray().apply { suffixes.split(Regex("[,\\s]+" )).filter { it.isNotBlank() }.forEach { add(it) } }
        val body = initial.deepCopy().apply { addProperty("interval_seconds", check); addProperty("stable_seconds", duration); add("download_policy", obj("wait_for_album" to waitAlbum, "partial_suffixes" to endings)) }
        saved(vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "intake", "settings"), body))
    } } }, enabled = !action.busy) { Text("保存设置") } }, dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text("取消") } })
}
