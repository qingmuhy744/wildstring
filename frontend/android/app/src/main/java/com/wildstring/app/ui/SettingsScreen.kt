@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.painterResource
import com.wildstring.app.R
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.wildstring.app.BuildConfig
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable internal fun delayed(active: Boolean, delayMs: Long): Boolean {
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(active) { visible = false; if (active) { delay(delayMs); visible = true } }
    return active && visible
}

private val LocalSettingsFeedback = staticCompositionLocalOf<() -> Unit> { {} }

@Composable internal fun SettingsScreen(vm: MusicViewModel, bottomBar: @Composable () -> Unit = {}, back: () -> Unit) {
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    val state by vm.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val feedback = LocalTactileFeedback.current
    var usage by remember { mutableStateOf(Triple(0L, 0L, 0L)) }
    var message by remember { mutableStateOf<String?>(null) }
    var clearing by remember { mutableStateOf(false) }
    var profile by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf(false) }
    var servers by remember { mutableStateOf(false) }
    var logout by remember { mutableStateOf(false) }
    var assistant by remember { mutableStateOf(false) }
    var diagnostics by remember { mutableStateOf(false) }
    var feature by remember { mutableStateOf<String?>(null) }
    val inbox by vm.agent.inbox.collectAsStateWithLifecycle()
    LaunchedEffect(preferences, clearing, assistant, feature, servers, state.current?.id) { usage = vm.cacheUsage() }
    fun mb(bytes: Long) = "%.1f MB".format(bytes / 1048576.0)
    CompositionLocalProvider(LocalSettingsFeedback provides tactile {}) {
        SettingsPage(back, bottomBar) {
            SettingsGroup("账号") {
                val acc = state.account
                val header = if (acc != null) {
                    if (!acc.displayName.isNullOrBlank()) "${acc.displayName} (${acc.username}) · ${acc.profileLabel}"
                    else "${acc.username} · ${acc.profileLabel}"
                } else "已连接"
                ListItem(headlineContent = { Text(header) },
                    supportingContent = { Text(state.server) }, leadingContent = { Icon(Icons.Default.AccountCircle, null) })
                SettingsAction("服务器 / 切换服务器", Icons.Default.Dns) { servers = true }
                if (state.account != null) SettingsAction("个人资料", Icons.Default.Badge) { profile = true }
                if (state.account != null) AvatarSettings(vm)
                if (state.account != null) SettingsAction("修改密码", Icons.Default.Lock) { password = true }
            }
            SettingsGroup("Last.fm") { LastfmSettings(vm) }
            SettingsGroup("助手与通知") {
                SettingsAction("野弦助手 / 通知与草案", Icons.Default.AutoAwesome) { assistant = true }
                Text(if (inbox.owner == vm.repository.session.cacheScope() && inbox.unread > 0) "${inbox.unread} 条未读通知" else "对话找歌、确认草案、曲库巡检与 AI 连接",
                    Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SettingsAction("模型连接", Icons.Default.Hub) { feature = "connections" }
                SettingsAction("联网与记忆", Icons.Default.TravelExplore) { feature = "research" }
                SettingsAction("通知设置", Icons.Default.Notifications) { feature = "channels" }
            }
            if (state.account?.isOwner == true) SettingsGroup("资料来源与维护") {
                SettingsAction("曲库管理", Icons.Default.LibraryMusic) { feature = "management" }
                SettingsAction("歌词补全与洗版", Icons.Default.Lyrics) { feature = "lyric-scans" }
                SettingsAction("数据源插件", Icons.Default.Extension) { feature = "source-plugins" }
            }
            SettingsGroup("播放") {
                SettingsAction("播放诊断", Icons.Default.Troubleshoot) { diagnostics = true }
                SettingsAction("其他设备继续", Icons.Default.Devices) { feature = "devices" }
                val syncMode by vm.sharing.mode.collectAsStateWithLifecycle()
                SettingsChoice("跨设备接续", when(syncMode) { "off" -> "关闭"; "auto" -> "自动恢复"; else -> "轻提示" }, Icons.Default.Devices,
                    listOf("off" to "关闭", "ask" to "轻提示（默认）", "auto" to "自动恢复"), syncMode,
                    "暂停时自动保存进度。仅提示其他设备最近 30 分钟内的暂停，每次暂停只提示一次；载入后保持暂停。", vm::syncMode)
                SettingsChoice("播放音质", if (preferences.aacBitrate == 0) "原音" else "AAC · ${preferences.aacBitrate} kbps", Icons.Default.GraphicEq,
                    com.wildstring.app.data.PlaybackRequest.bitrates.map { it to if (it == 0) "原音" else "AAC · $it kbps" }, preferences.aacBitrate,
                    "默认原音。选择 AAC 后，无损音源转码，有损音源直放。切换保留播放位置和暂停状态。", vm.settings::quality)
                SettingsChoice("歌词恢复跟随", "${preferences.lyricFollowSeconds} 秒", Icons.Default.Lyrics,
                    listOf(1, 2, 3, 5, 10).map { it to "$it 秒" }, preferences.lyricFollowSeconds,
                    "滑动或点选歌词后，停止操作多久恢复当前歌词。滚动过程中不计时。", vm.settings::lyricFollowSeconds)
                SettingsChoice("歌词大小", preferences.lyricSize.label, Icons.Default.FormatSize,
                    com.wildstring.app.data.LyricSize.entries.map { it to it.label }, preferences.lyricSize,
                    "调整全屏歌词和逐字高亮的字号，只影响本机播放页。", vm.settings::lyricSize)
            }
            SettingsGroup("外观与触感") {
                SettingsChoice("歌曲列表大小", preferences.songListSize.label, Icons.Default.FormatSize,
                    com.wildstring.app.data.SongListSize.entries.map { it to it.label }, preferences.songListSize,
                    "按习惯选择歌曲列表的显示大小。", vm.settings::songListSize)
                SettingsChoice("播放样式", playbackStyles.first { it.first == preferences.playbackStyle }.second, Icons.Default.Style,
                    playbackStyles, preferences.playbackStyle, change = vm.settings::playbackStyle)
                SettingsChoice("主题", if (preferences.redCloth) "一块红布" else "经典野弦", Icons.Default.Palette,
                    listOf(false to "经典野弦", true to "一块红布"), preferences.redCloth, change = { vm.settings.theme(it) })
                if (!preferences.redCloth) SettingsChoice("日夜模式", when (preferences.appearance) { "light" -> "浅色"; "dark" -> "深色"; else -> "跟随系统" }, Icons.Default.BrightnessAuto,
                    listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色"), preferences.appearance, change = vm.settings::appearance)
                SettingsChoice("桌面图标", if (preferences.redIcon) "红布" else "经典", Icons.Default.Apps,
                    listOf(false to "经典", true to "红布"), preferences.redIcon, "桌面可能需要片刻更新图标。", change = {
                        runCatching { vm.settings.icon(it) }.onFailure { message = "图标切换失败，请重试。" }
                    })
                ListItem(headlineContent = { Text("轻触反馈") }, supportingContent = { Text("播放与关键操作轻反馈，遵循系统设置") },
                    leadingContent = { Icon(Icons.Default.Vibration, null) },
                    trailingContent = { Switch(preferences.haptics, { enabled -> vm.settings.haptics(enabled); if (enabled) feedback(TactileKind.Tap) }) },
                    modifier = Modifier.clickable {
                        val enabled = !preferences.haptics
                        vm.settings.haptics(enabled)
                        if (enabled) feedback(TactileKind.Tap)
                    })
            }
            SettingsGroup("本机缓存") {
                CacheLimit("曲库与歌词", usage.first, preferences.metadataMb, listOf(0, 8, 32, 64)) { vm.settings.limits(it, preferences.artworkMb, preferences.audioMb) }
                CacheLimit("封面", usage.second, preferences.artworkMb, listOf(0, 32, 64, 128)) { vm.settings.limits(preferences.metadataMb, it, preferences.audioMb) }
                CacheLimit("最近播放音频", usage.third, preferences.audioMb, listOf(0, 128, 256, 512, 1024)) { vm.settings.limits(preferences.metadataMb, preferences.artworkMb, it) }
                SettingsAction(if (clearing) "正在清理…" else "清理缓存", Icons.Default.DeleteOutline, enabled = !clearing) {
                    clearing = true
                    scope.launch { vm.clearCache().join(); clearing = false; message = "缓存已清理，播放过程中可能继续产生缓存。" }
                }
                Text("已缓存 ${mb(usage.first + usage.second + usage.third)}。内容优先从本机显示，再联网刷新。短时断网可播放已缓存片段；缓存可能被系统回收。",
                    Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            SettingsGroup("关于") {
                com.wildstring.app.update.UpdateSettings()
                ListItem(headlineContent = { Text("野弦") }, supportingContent = { Text("WildString · ${BuildConfig.VERSION_NAME}") },
                    leadingContent = { Icon(painterResource(R.drawable.ic_wildstring), null, Modifier.size(36.dp), tint = Color.Unspecified) })
                SettingsAction("退出登录", Icons.AutoMirrored.Filled.Logout) { logout = true }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
    if (servers) ServersScreen(vm) { servers = false }
    if (assistant) FeatureDialog(vm, "assistant") { assistant = false }
    if (diagnostics) PlaybackDiagnosticsDialog(vm) { diagnostics = false }
    feature?.let { route -> FeatureDialog(vm, route) { feature = null } }
    if (logout) AlertDialog(onDismissRequest = { logout = false }, title = { Text("退出当前服务器？") }, text = { Text("将清除当前服务器在本机的登录和私密缓存，其他服务器的登录保留。") }, confirmButton = { TextButton({ logout = false; back(); vm.logout() }) { Text("退出登录") } }, dismissButton = { TextButton({ logout = false }) { Text("取消") } })
    if (profile) ProfileDialog(vm) { profile = false }
    if (password) PasswordDialog(vm) { password = false }
}

@Composable private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, Modifier.padding(start = 16.dp), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) { Column(content = content) }
    }
}

@Composable private fun SettingsAction(title: String, icon: ImageVector, enabled: Boolean = true, action: () -> Unit) {
    ListItem(headlineContent = { Text(title) }, leadingContent = { Icon(icon, null) },
        trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) }, modifier = Modifier.clickable(enabled = enabled, onClick = action))
}

@Composable private fun <T> SettingsChoice(title: String, value: String, icon: ImageVector, choices: List<Pair<T, String>>, selected: T,
    description: String? = null, change: (T) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val feedback = LocalSettingsFeedback.current
    ListItem(headlineContent = { Text(title) }, supportingContent = { Text(value) }, leadingContent = { Icon(icon, null) },
        trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) }, modifier = Modifier.testTag("setting-$title").clickable { open = true })
    if (open) AlertDialog(onDismissRequest = { open = false }, title = { Text(title) }, text = {
        Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState())) {
            description?.let { Text(it, Modifier.padding(bottom = 12.dp), style = MaterialTheme.typography.bodySmall) }
            choices.forEach { (id, label) ->
                Row(Modifier.fillMaxWidth().selectable(selected == id, role = Role.RadioButton, onClick = { feedback(); change(id); open = false })
                    .padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected == id, onClick = null)
                    Text(label, Modifier.padding(start = 16.dp))
                }
            }
        }
    }, confirmButton = { TextButton({ open = false }) { Text("取消") } })
}

@Composable private fun PasswordDialog(vm: MusicViewModel, dismiss: () -> Unit) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val count = next.codePointCount(0, next.length)
    AlertDialog(onDismissRequest = { if (!busy) dismiss() }, title = { Text("修改密码") },
        text = { Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("修改后，所有设备都需要重新登录。新密码为 12–128 个字符。", fontSize = 12.sp)
            listOf("当前密码" to current, "新密码" to next, "确认新密码" to confirm).forEachIndexed { index, (label, value) ->
                OutlinedTextField(value, { text -> when (index) { 0 -> current = text.take(256); 1 -> next = text.take(256); else -> confirm = text.take(256) } }, label = { Text(label) },
                    singleLine = true, enabled = !busy, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Password))
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
        } },
        confirmButton = { TextButton({
            busy = true; error = null
            scope.launch {
                try { vm.changePassword(current, next); dismiss() }
                catch (e: kotlinx.coroutines.CancellationException) { throw e }
                catch (e: Exception) { error = com.wildstring.app.data.friendlyError(e) }
                finally { busy = false }
            }
        }, enabled = !busy && current.isNotEmpty() && count in 12..128 && confirm == next) { Text(if (busy) "正在修改…" else "保存新密码") } },
        dismissButton = { TextButton(dismiss, enabled = !busy) { Text("取消") } })
}

@Composable private fun ProfileDialog(vm: MusicViewModel, dismiss: () -> Unit) {
    val account = vm.state.value.account ?: return
    var username by remember { mutableStateOf(account.username) }
    var displayName by remember { mutableStateOf(account.displayName.orEmpty()) }
    var email by remember { mutableStateOf(account.email.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val usernameValid = username.trim().length in 1..32 && username.trim().all { it.isLetterOrDigit() || it in "_-." }
    val emailValid = email.isBlank() || (email.contains('@') && email.length <= 254)
    val changed = username.trim() != account.username || displayName.trim() != account.displayName.orEmpty() || email.trim() != account.email.orEmpty()

    AlertDialog(onDismissRequest = { if (!busy) dismiss() }, title = { Text("修改个人资料") },
        text = { Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("登录 ID 用于账号登录，昵称用于界面展示与活动记录。邮箱仅作为账号资料保存。", fontSize = 12.sp)
            OutlinedTextField(username, { username = it.take(32) }, label = { Text("登录 ID") },
                singleLine = true, enabled = !busy)
            OutlinedTextField(displayName, { displayName = it.take(50) }, label = { Text("昵称") },
                singleLine = true, enabled = !busy)
            OutlinedTextField(email, { email = it.take(254) }, label = { Text("邮箱（仅资料保存）") },
                singleLine = true, enabled = !busy,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Email))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
        } },
        confirmButton = { TextButton({
            busy = true; error = null
            scope.launch {
                try {
                    vm.updateProfile(username.trim(), displayName.trim(), email.trim())
                    dismiss()
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    error = com.wildstring.app.data.friendlyError(e)
                } finally {
                    busy = false
                }
            }
        }, enabled = !busy && usernameValid && emailValid && changed) { Text(if (busy) "正在保存…" else "保存资料") } },
        dismissButton = { TextButton(dismiss, enabled = !busy) { Text("取消") } })
}

@Composable private fun CacheLimit(label: String, used: Long, value: Int, options: List<Int>, change: (Int) -> Unit) {
    SettingsChoice(label, "${if (value == 0) "关闭" else "$value MB"} · 已用 ${"%.1f".format(used / 1048576.0)} MB", Icons.Default.Storage,
        options.map { it to if (it == 0) "关闭" else "$it MB" }, value, change = change)
}

/** Static vector folds keep the theme inexpensive while music is playing. */
@Composable internal fun RedClothBackdrop() {
    Canvas(Modifier.fillMaxSize().background(Color(0xFFD21A25))) {
        drawRect(Brush.linearGradient(listOf(Color(0xFFE3252B), Color(0xFFD11722), Color(0xFFB40816)),
            start = Offset.Zero, end = Offset(size.width, size.height)))
        // Broad vertical folds, with their own light/shadow gradient, read as draped fabric.
        for (fold in 0..8) {
            val x = size.width * (fold / 8f)
            val width = size.width * .18f
            val path = Path().apply {
                moveTo(x - width * .55f, 0f)
                cubicTo(x + width * .30f, size.height * .28f, x - width * .70f, size.height * .70f, x - width * .05f, size.height)
                lineTo(x + width * .75f, size.height)
                cubicTo(x + width * .10f, size.height * .70f, x + width * 1.10f, size.height * .28f, x + width * .25f, 0f)
                close()
            }
            drawPath(path, Brush.horizontalGradient(listOf(Color(0x00FF6255), Color(0x66FF6255), Color(0x0090000A), Color(0x66800009), Color(0x0090000A)),
                startX = x - width * .55f, endX = x + width * .9f))
        }
        // A faint stationary weave adds cloth texture without a continuously running animation.
        for (thread in 0..100) {
            val x = size.width * thread / 100f
            drawLine(Color.White.copy(alpha = .018f), Offset(x, 0f), Offset(x, size.height), strokeWidth = 1f)
        }
    }
}
