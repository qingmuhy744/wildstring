@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun MobileShortcuts(discovery: Boolean = false, open: (String) -> Unit) {
    val entries = if (discovery) listOf(Triple("daily", "每日推荐", Icons.Default.AutoAwesome), Triple("ai", "AI 找歌", Icons.Default.Search), Triple("external", "发现新音乐", Icons.Default.Explore))
        else listOf(Triple("offline", "离线保存", Icons.Default.Download), Triple("statistics", "收听统计", Icons.Default.BarChart))
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).testTag(if (discovery) "discovery-shortcuts" else "personal-shortcuts"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        entries.forEach { (route, title, icon) ->
            FilledTonalButton({ open(route) }, Modifier.weight(1f), shape = androidx.compose.foundation.shape.RoundedCornerShape(16.dp), contentPadding = PaddingValues(vertical = 12.dp, horizontal = 4.dp)) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(icon, null, Modifier.size(22.dp))
                    Text(title, style = MaterialTheme.typography.labelMedium, maxLines = 1)
                }
            }
        }
    }
}

@Composable
internal fun FeatureDialog(vm: MusicViewModel, route: String, track: Track? = null, playlist: Playlist? = null, albumId: String? = null, dismiss: () -> Unit) {
    val account by vm.state.collectAsStateWithLifecycle()
    val title = when (route) {
        "assistant" -> "野弦助手"; "notifications" -> "通知与任务"
        "connections" -> "模型连接"; "research" -> "联网与记忆"; "channels" -> "通知设置"
        "external" -> "发现新音乐"; "rankings" -> "收听排行"; "daily" -> "每日推荐"; "ai" -> "AI 找歌与歌单"; "offline" -> "离线保存"; "statistics" -> "收听统计"; "devices" -> "其他设备继续"
        "playlist" -> if (playlist == null) "新建歌单" else "编辑歌单"; "order" -> "歌单排序"; "multi" -> "多选加入歌单"
        "lyric-scans" -> "歌词补全与洗版"; "gain" -> "响度均衡与手动调整"; "source-plugins" -> "数据源 ZIP 插件"
        "metadata" -> "编辑歌曲信息"; "lyrics" -> "编辑歌词"; "suggestions" -> "更新元数据与建议"; else -> "曲库管理"
    }
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = androidx.compose.ui.platform.LocalView.current
        val darkBars = LocalDarkAppearance.current || LocalRedCloth.current
        // Dialog reapplies its platform window parameters in a SideEffect. Apply the
        // user's app theme afterwards so a system-light dialog cannot reset dark icons.
        LaunchedEffect(view, darkBars) {
            (view.parent as? androidx.compose.ui.window.DialogWindowProvider)?.window?.let { window ->
                androidx.core.view.WindowCompat.enableEdgeToEdge(window)
                if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
                androidx.core.view.WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !darkBars; isAppearanceLightNavigationBars = !darkBars
                }
            }
        }
        Surface(Modifier.fillMaxSize().testTag("feature-$route")) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
                TopAppBar(title = { Text(title) }, navigationIcon = { IconButton(dismiss) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } })
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (route) {
                        "assistant", "notifications" -> AgentWorkspace(vm, if (route == "notifications") "notifications" else "chat")
                        "connections", "research", "channels" -> AgentWorkspace(vm, route)
                        "daily" -> DailyPanel(vm)
                        "rankings" -> RankingsPanel(vm)
                        "external" -> ExternalMusicPanel(vm)
                        "ai" -> AiPanel(vm)
                        "offline" -> OfflinePanel(vm)
                        "statistics" -> StatisticsPanel(vm)
                        "devices" -> DevicesPanel(vm)
                        "playlist" -> PlaylistEditor(vm, playlist, dismiss)
                        "order" -> playlist?.let { PlaylistOrder(vm, it, dismiss) }
                        "multi" -> MultiSelectPanel(vm, dismiss)
                        "gain" -> track?.let { PlaybackGainPanel(vm, it) }
                        else -> if (account.account?.role == "admin") when (route) {
                            "metadata" -> track?.let { MetadataPanel(vm, it) }
                            "lyrics" -> track?.let { LyricsEditorPanel(vm, it) }
                            "suggestions" -> track?.let { SuggestionsPanel(vm, it) }
                            "source-plugins" -> SourcePluginsPanel(vm)
                            "lyric-scans" -> LyricScansPanel(vm, albumId)
                            else -> ManagementPanel(vm)
                        } else Text("需要管理员权限。", Modifier.padding(24.dp))
                    }
                }
            }
        }
    }
}

@Composable
internal fun SleepDialog(vm: MusicViewModel, dismiss: () -> Unit) {
    val timer by vm.sleep.state.collectAsStateWithLifecycle()
    val player by vm.state.collectAsStateWithLifecycle()
    var now by remember { mutableLongStateOf(android.os.SystemClock.elapsedRealtime()) }
    LaunchedEffect(timer.deadline) { while (timer.deadline != null) { now = android.os.SystemClock.elapsedRealtime(); kotlinx.coroutines.delay(1000) } }
    AlertDialog(onDismissRequest = dismiss, title = { Text("睡眠定时") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(when { timer.entryId != null -> "播完本曲后暂停"; timer.deadline != null -> "剩余约 ${((timer.deadline!! - now).coerceAtLeast(0) + 59_999) / 60_000} 分钟"; else -> "未开启" })
            Row { listOf(15, 30, 60).forEach { minutes -> TextButton({ vm.sleep.minutes(minutes); dismiss() }) { Text("$minutes 分钟") } } }
            var custom by remember { mutableStateOf("45") }
            OutlinedTextField(custom, { custom = it.filter(Char::isDigit).take(3) }, label = { Text("自定义分钟（1–240）") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true)
            TextButton({ custom.toIntOrNull()?.takeIf { it in 1..240 }?.let { vm.sleep.minutes(it); dismiss() } }, enabled = custom.toIntOrNull() in 1..240) { Text("按此时间暂停") }
            TextButton({ vm.state.value.entryId?.let { vm.sleep.endOfTrack(it) }; dismiss() }, enabled = player.current != null) { Text("播完本曲停止") }
        }
    }, confirmButton = { TextButton({ vm.sleep.cancel(); dismiss() }) { Text("取消定时") } }, dismissButton = { TextButton(dismiss) { Text("关闭") } })
}

/** A local pending flag gives instant feedback and prevents duplicate mutations. */
internal class FeatureAction {
    var busy by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)
    suspend fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true; message = "正在处理…"
        try { block(); if (message == "正在处理…") message = "已完成" }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { message = friendlyError(e) }
        finally { busy = false }
    }
}
@Composable internal fun ActionStatus(action: FeatureAction) {
    if (action.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    action.message?.let { androidx.compose.foundation.text.selection.SelectionContainer { Text(it, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodySmall) } }
}

@Composable
private fun OfflinePanel(vm: MusicViewModel) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var notificationsGranted by remember { mutableStateOf(android.os.Build.VERSION.SDK_INT < 33 ||
        androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) }
    val requestNotifications = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { notificationsGranted = it }
    val items by vm.repository.downloads.entries.collectAsStateWithLifecycle()
    var capacity by remember { mutableIntStateOf(vm.repository.downloads.capacityGb) }
    var confirm by remember { mutableStateOf<OfflineEntry?>(null) }
    var downloadOptions by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Text("${items.count { it.state == "complete" }} 首已完成 · ${items.sumOf { it.bytes } / 1024 / 1024} MiB", style = MaterialTheme.typography.titleMedium)
        Row {
            TextButton({ vm.repository.downloads.pauseAll() }, enabled = items.any { it.state in listOf("queued", "downloading") }) { Text("暂停全部") }
            TextButton({ vm.repository.downloads.resumeAll(); vm.startDownloads() }, enabled = items.any { it.state in listOf("paused", "failed") }) { Text("继续全部") }
        }
        TextButton({ downloadOptions = !downloadOptions }) { Text(if (downloadOptions) "收起下载设置" else "下载设置 · 音质、网络与歌单") }
        if (downloadOptions) Column(Modifier.fillMaxWidth().heightIn(max = 300.dp).verticalScroll(rememberScrollState())) { OfflineSettings(vm) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("总容量限额 $capacity GiB", Modifier.weight(1f))
            TextButton({ capacity = (capacity / 2).coerceAtLeast(1); vm.repository.downloads.capacityGb = capacity }) { Text("减少") }
            TextButton({ capacity = (capacity * 2).coerceAtMost(64); vm.repository.downloads.capacityGb = capacity }) { Text("增加") }
        }
        if (android.os.Build.VERSION.SDK_INT >= 33 && !notificationsGranted) TextButton({ requestNotifications.launch(android.Manifest.permission.POST_NOTIFICATIONS) }) { Text("允许显示下载通知") }
        Text("已完成音乐断网可播放；切换服务器保留各自副本，退出账号会清除该账号的离线音乐。", style = MaterialTheme.typography.bodySmall)
        LazyColumn(Modifier.weight(1f)) { items(items, key = { it.track.id }) { item ->
            Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                Text(item.track.title)
                Text(if (item.audioFormat == "m4a" && item.bitrate > 0) downloadQualityLabel(item.bitrate) else "原音 · ${item.track.format.uppercase()}", style = MaterialTheme.typography.labelSmall)
                Text(when(item.state) { "complete" -> "已完成"; "paused" -> "已暂停"; "failed" -> "下载失败"; "downloading" -> "正在保存"; else -> "等待下载" } + " · ${item.bytes / 1024 / 1024} MiB", style = MaterialTheme.typography.bodySmall)
                item.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (item.state == "downloading" && item.total > 0) LinearProgressIndicator(progress = { (item.bytes.toFloat() / item.total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                Row {
                    if (item.state == "complete") TextButton({ vm.play(listOf(item.track)) }) { Text("播放") }
                    else if (item.state in listOf("queued", "downloading")) TextButton({ vm.repository.downloads.pause(item.track.id) }) { Text("暂停") }
                    else TextButton({ vm.repository.downloads.resume(item.track.id); vm.startDownloads() }) { Text("继续 / 重试") }
                    TextButton({ confirm = item }) { Text("删除") }
                }
            }
        } }
        if (items.isEmpty()) Text("从歌曲操作或专辑、歌单页面选择“离线保存”。", Modifier.padding(vertical = 24.dp))
    }
    confirm?.let { item -> AlertDialog(onDismissRequest = { confirm = null }, title = { Text("删除离线副本？") }, text = { Text(item.track.title) }, confirmButton = { TextButton({ vm.repository.downloads.remove(item.track.id); confirm = null }) { Text("删除") } }, dismissButton = { TextButton({ confirm = null }) { Text("取消") } }) }
}

@Composable
private fun StatisticsPanel(vm: MusicViewModel) {
    var value by remember { mutableStateOf<ListeningSummary?>(null) }
    val action = remember { FeatureAction() }
    LaunchedEffect(Unit) { action.run { value = vm.repository.api().listeningSummary() } }
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        ActionStatus(action)
        value?.let { Text("已播放 ${it.playCount} 次"); Text("累计收听 ${it.listenedMs / 1000 / 60} 分钟"); Text("听过 ${it.playedTracks} 首 · 收藏 ${it.lovedTracks} 首") }
        Text("歌曲列表中可按播放次数、收听时长、最近播放排序。", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun DevicesPanel(vm: MusicViewModel) {
    val player by vm.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    var remote by remember { mutableStateOf<SharedPlayback?>(null) }
    val device = remember { vm.deviceId() }
    LaunchedEffect(Unit) { action.run { remote = vm.repository.api().sharedPlayback() } }
    Column(Modifier.padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        ActionStatus(action)
        Text("暂停时自动保存进度。默认以小提示提供其他设备的进度，载入后保持暂停；可在设置中调整。")
        remote?.let { saved ->
            Text(if (saved.trackIds.isEmpty()) "还没有共享播放记录" else "${saved.trackIds.size} 首 · 第 ${saved.index + 1} 首 · ${formatTime(saved.positionMs)}")
            if (saved.deviceId == device && saved.trackIds.isNotEmpty()) Text("这是本机最近同步的记录", style = MaterialTheme.typography.bodySmall)
            Button({ scope.launch { action.run { vm.resumeShared(saved); action.message = "已继续播放" } } }, enabled = !action.busy && saved.trackIds.isNotEmpty()) { Text("从这条记录继续") }
        }
        OutlinedButton({ scope.launch { action.run { remote = vm.sharePlayback(); action.message = "当前队列与进度已同步" } } }, enabled = !action.busy && player.queue.isNotEmpty()) { Text("同步本机当前播放") }
        TextButton({ scope.launch { action.run { remote = vm.repository.api().sharedPlayback() } } }, enabled = !action.busy) { Text("刷新记录") }
    }
}

internal suspend fun saveRecommendations(vm: MusicViewModel, name: String, items: List<RecommendationItem>) {
    val owner = vm.repository.session.cacheScope() ?: throw CancellationException("登录已失效。")
    fun requireOwner() { if (owner != vm.repository.session.cacheScope()) throw CancellationException("服务器或账号已变化。") }
    val api = vm.repository.api()
    val base = vm.repository.url("api", "v1", "playlists")
    val playlist = api.createPlaylist(PlaylistRequest(name.take(100)))
    requireOwner()
    try { api.addTracks("$base/${playlist.id}/tracks", AddTracks(playlist.version, items.map { it.track.id })); requireOwner() }
    catch (cancel: CancellationException) { throw cancel }
    catch (error: Exception) {
        if (owner == vm.repository.session.cacheScope()) runCatching { api.deletePlaylist("$base/${playlist.id}", playlist.version) }
        throw error
    }
    requireOwner(); vm.load()
}
