package com.wildstring.app.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val lyricLevels = listOf("无歌词", "静态歌词", "逐行动态", "双语逐行动态", "逐字动态", "双语逐字动态")
private val lyricStates = mapOf("running" to "扫描中", "queued" to "等待", "paused" to "已暂停", "completed" to "扫描结束", "cancelled" to "已取消", "ready" to "可升级", "review" to "待核对", "no_match" to "未匹配", "failed" to "失败", "locked" to "已锁定", "skipped_goal" to "已满足目标", "skipped_scanned" to "已扫跳过", "stale" to "歌曲已变化", "applied" to "已启用", "restored" to "已恢复")

@Composable internal fun LyricScansPanel(vm: MusicViewModel, albumId: String? = null) {
    val focus = LocalFocusManager.current; val keyboard = LocalSoftwareKeyboardController.current
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    val list = rememberLazyListState()
    var goal by remember { mutableIntStateOf(5) }; var mode by remember { mutableStateOf("upgrade") }
    var preference by remember { mutableStateOf("timing") }; var profile by remember { mutableStateOf("low") }
    var interval by remember { mutableStateOf("10") }; var force by remember { mutableStateOf(false) }
    var defaults by remember { mutableStateOf<JsonObject?>(null) }; var editDefaults by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<Long?>(null) }; var batch by remember { mutableStateOf<JsonObject?>(null) }
    var history by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var historyOpen by remember { mutableStateOf(false) }
    var offset by remember { mutableIntStateOf(0) }; var selected by remember { mutableStateOf<Set<String>>(emptySet()) }
    var confirm by remember { mutableStateOf<String?>(null) }; var previewTrack by remember { mutableStateOf<Track?>(null) }
    val endpoint = "manage/lyric-scans"
    fun options() = jsonBody("scope" to if (albumId == null) "library" else "album", "scope_id" to albumId,
        "mode" to mode, "goal" to if (mode == "missing") 1 else goal, "preference" to preference,
        "rate_profile" to profile, "interval_seconds" to (interval.toIntOrNull() ?: 10), "force" to force)
    suspend fun load(id: String? = batch?.text("id"), page: Int = offset) {
        history = vm.repository.feature(endpoint).objects().filter { albumId == null || it.getAsJsonObject("options").text("scope_id") == albumId }
        if (id != null) batch = vm.repository.feature("$endpoint/$id", query = mapOf("offset" to page.toString(), "limit" to "50"))
    }
    fun control(command: String) { scope.launch { action.run {
        batch?.let { vm.repository.feature("$endpoint/${it.text("id")}/control", "POST", jsonBody("action" to command)) }
        confirm = null; load()
    } } }
    LaunchedEffect(albumId) { action.run { load(); defaults = vm.repository.feature("manage/lyric-scan-settings"); profile = defaults!!.text("default_profile") }; if (action.message == "已完成") action.message = null }
    LaunchedEffect(batch?.text("id")) { if (batch != null) list.animateScrollToItem(1) }
    LaunchedEffect(goal, mode, preference, profile, interval, force) { preview = null }
    LaunchedEffect(batch?.text("id"), batch?.text("status"), offset) {
        while (batch?.text("status") == "running") { delay(2000); action.run { load() }; if (action.message == "已完成") action.message = null }
    }
    LazyColumn(Modifier.fillMaxSize().testTag("lyric-scans-panel"), state = list, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(if (albumId == null) "全库歌词补全与洗版" else "专辑歌词补全与洗版", style = MaterialTheme.typography.titleLarge)
                Text("慢速查找更好的歌词，确认后启用；锁定歌曲跳过，原歌词可恢复。", style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(mode == "upgrade", { mode = "upgrade" }, { Text("歌词洗版") }, enabled = !action.busy)
                    FilterChip(mode == "missing", { mode = "missing" }, { Text("仅补缺失") }, enabled = !action.busy)
                }
                if (mode == "upgrade") {
                    Text("目标等级")
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        lyricLevels.drop(1).forEachIndexed { i, label -> FilterChip(goal == i + 1, { goal = i + 1 }, { Text(label) }, enabled = !action.busy) }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(preference == "timing", { preference = "timing" }, { Text("逐字优先") }, enabled = !action.busy)
                    FilterChip(preference == "bilingual", { preference = "bilingual" }, { Text("双语优先") }, enabled = !action.busy)
                }
                Text("请求频率")
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("low" to "低频", "medium" to "中频", "high" to "高频", "custom" to "自定义").forEach { (key, label) ->
                        FilterChip(profile == key, { profile = key }, { Text(label + if (key == "custom") "" else " ${defaults?.number(key + "_seconds")}秒") }, enabled = !action.busy, modifier = Modifier.testTag("lyric-rate-$key"))
                    }
                }
                if (profile == "custom") OutlinedTextField(interval, { interval = it }, label = { Text("请求间隔（1–120秒）") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { focus.clearFocus(); keyboard?.hide() }), enabled = !action.busy)
                Text("后台默认低频；每来源串行、不突发放量。双语逐字指原文逐字高亮、译文同步显示。", style = MaterialTheme.typography.bodySmall)
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(force, { force = it }, enabled = !action.busy); Text("强制重扫已查记录和缓存") }
                ActionStatus(action)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton({ scope.launch { action.run { preview = vm.repository.feature("$endpoint/preview", "POST", options()).number("total") } } }, enabled = !action.busy && interval.toIntOrNull() in 1..120) { Text("检查扫描范围") }
                    TextButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Text("刷新任务") }
                }
                preview?.let { total ->
                    Text("本次范围：$total 首")
                    Button({ scope.launch { action.run { batch = vm.repository.feature(endpoint, "POST", options()); offset = 0; selected = emptySet(); load() } } }, enabled = !action.busy && total > 0) { Text("开始后台扫描") }
                }
                TextButton({ editDefaults = !editDefaults }) { Text("扫描频率默认设置") }
                if (editDefaults) defaults?.let { settings ->
                    listOf("low" to "低频", "medium" to "中频", "high" to "高频").forEach { (key, label) ->
                        val field = key + "_seconds"
                        OutlinedTextField(settings.number(field).toString(), { text -> text.toIntOrNull()?.let { value -> defaults = settings.deepCopy().apply { addProperty(field, value) } } }, label = { Text("$label 间隔（秒）") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), enabled = !action.busy)
                    }
                    Text("后台默认频率")
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("low" to "低频", "medium" to "中频", "high" to "高频").forEach { (key, label) -> FilterChip(settings.text("default_profile") == key, { defaults = settings.deepCopy().apply { addProperty("default_profile", key) } }, { Text(label) }, enabled = !action.busy) }
                    }
                    val valid = settings.number("low_seconds") >= settings.number("medium_seconds") && settings.number("medium_seconds") >= settings.number("high_seconds") && listOf("low_seconds", "medium_seconds", "high_seconds").all { settings.number(it) in 1..120 }
                    Button({ scope.launch { action.run { defaults = vm.repository.feature("manage/lyric-scan-settings", "PUT", settings); action.message = "默认频率已保存，新建任务使用新设置。" } } }, enabled = !action.busy && valid) { Text("保存频率默认值") }
                }
                HorizontalDivider()
                TextButton({ historyOpen = !historyOpen }) { Text("最近的扫描任务（${history.size}）") }
                if (historyOpen) history.forEach { entry -> TextButton({ scope.launch { action.run { offset = 0; selected = emptySet(); load(entry.text("id"), 0) } } }, enabled = !action.busy) { Text("${entry.number("total")} 首 · ${lyricStates[entry.text("status")]} · ${java.text.DateFormat.getDateTimeInstance().format(java.util.Date(entry.number("created_at") * 1000))}") } }
            }
        }
        batch?.let { current ->
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${lyricStates[current.text("status")]} · ${current.number("total")} 首", style = MaterialTheme.typography.titleMedium)
                    current.getAsJsonObject("options")?.number("interval_seconds")?.takeIf { it > 0 }?.let { Text("本任务每来源请求间隔：$it 秒", style = MaterialTheme.typography.bodySmall) }
                    Text(current.getAsJsonObject("counts").entrySet().joinToString(" · ") { "${lyricStates[it.key] ?: it.key} ${it.value.asInt}" })
                    current.objects("cooldowns").forEach { Text("${it.text("plugin_id")} 正在冷却：${it.text("reason")}", style = MaterialTheme.typography.bodySmall) }
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (current.text("status") == "running") OutlinedButton({ control("pause") }, enabled = !action.busy) { Text("暂停扫描") }
                        if (current.text("status") == "paused") OutlinedButton({ control("resume") }, enabled = !action.busy) { Text("继续扫描") }
                        if (current.text("status") in listOf("running", "paused")) TextButton({ confirm = "cancel" }, enabled = !action.busy) { Text("取消任务") }
                        else TextButton({ control("retry_failed") }, enabled = !action.busy) { Text("仅重试失败") }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton({ selected = current.objects().filter { it.text("status") == "ready" }.map { it.text("id") }.toSet() }, enabled = !action.busy) { Text("选择本页可升级") }
                        Button({ confirm = "apply" }, enabled = !action.busy && selected.isNotEmpty()) { Text("确认选中（${selected.size}）") }
                    }
                }
            }
            items(current.objects(), key = { it.text("id") }) { item ->
                ElevatedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(item.text("id") in selected, { checked -> selected = if (checked) selected + item.text("id") else selected - item.text("id") }, enabled = !action.busy && item.text("status") == "ready")
                        Text(item.text("title"), Modifier.weight(1f)); Text(lyricStates[item.text("status")] ?: item.text("status"), style = MaterialTheme.typography.labelMedium)
                    }
                    val baseline = item.get("baseline")?.takeIf { it.isJsonObject }?.asJsonObject
                    val candidate = item.get("quality")?.takeIf { it.isJsonObject }?.asJsonObject
                    Text((baseline?.text("label") ?: "尚未检查") + (candidate?.let { " → ${it.text("label")}" } ?: ""))
                    if (item.text("error").isNotBlank()) Text("来源问题：${item.text("error")}", style = MaterialTheme.typography.bodySmall)
                    TextButton({ scope.launch { action.run { previewTrack = vm.repository.track(item.text("track_id")) } } }, enabled = !action.busy) { Text("预览与其他候选") }
                    TextButton({ scope.launch { action.run { val path = "manage/tracks/${item.text("track_id")}/lyric-lock"; val lock = vm.repository.feature(path); vm.repository.feature(path, "PUT", lock.deepCopy().apply { addProperty("locked", !lock.flag("locked")) }); action.message = if (lock.flag("locked")) "已解锁，可在新扫描中查询。" else "当前歌词已锁定。" } } }, enabled = !action.busy) { Text("锁定／解锁歌词") }
                    if (item.text("status") == "applied") TextButton({ scope.launch { action.run { vm.repository.feature("manage/lyric-scan-items/${item.text("id")}/restore", "POST"); vm.refreshLyrics(); load() } } }, enabled = !action.busy) { Text("恢复洗版前歌词") }
                } }
            }
            item { Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton({ scope.launch { action.run { offset = (offset - 50).coerceAtLeast(0); selected = emptySet(); load() } } }, enabled = !action.busy && offset > 0) { Text("上一页") }
                Text("${(offset+1).coerceAtMost(current.number("total").toInt())}–${(offset+50).coerceAtMost(current.number("total").toInt())} / ${current.number("total")}")
                TextButton({ scope.launch { action.run { offset += 50; selected = emptySet(); load() } } }, enabled = !action.busy && offset + 50 < current.number("total")) { Text("下一页") }
            } }
        }
    }
    confirm?.let { command -> AlertDialog(onDismissRequest = { if (!action.busy) confirm = null }, title = { Text(if (command == "apply") "启用选中的歌词？" else "取消扫描？") }, text = { Column { Text(if (command == "apply") "共 ${selected.size} 首，已有能力不会降级；歌曲变化或锁定时跳过。" else "已找到的候选保留。") ; ActionStatus(action) } }, confirmButton = { TextButton({ if (command == "cancel") control("cancel") else scope.launch { action.run {
        val result = vm.repository.feature("$endpoint/${batch!!.text("id")}/apply", "POST", jsonBody("item_ids" to jsonStrings(selected.toList())))
        selected = emptySet(); confirm = null; vm.refreshLyrics(); load()
        action.message = "已启用 ${result.objects().count { it.text("status") == "applied" }} 首；冲突 ${result.objects().count { it.text("status") == "conflict" }} 首。"
    } } }, enabled = !action.busy) { Text("确定") } }, dismissButton = { TextButton({ confirm = null }, enabled = !action.busy) { Text("返回") } }) }
    previewTrack?.let { track -> Dialog(onDismissRequest = { previewTrack = null }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) { Column(Modifier.fillMaxSize().padding(16.dp)) { TextButton({ previewTrack = null }) { Text("关闭歌词预览") }; androidx.compose.foundation.lazy.LazyColumn { item { OnlineLyricsPanel(vm, track) { scope.launch { load() } } } } } }
    } }
}
