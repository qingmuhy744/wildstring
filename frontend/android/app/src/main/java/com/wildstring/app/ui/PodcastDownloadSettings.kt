package com.wildstring.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.wildstring.app.data.PodcastDownloadQueueInfo
import com.wildstring.app.data.PodcastDownloadSettings
import com.wildstring.app.data.PodcastSummary
import com.wildstring.app.data.friendlyError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PodcastDownloadSettingsDialog(vm: MusicViewModel, podcast: PodcastSummary, onDismiss: () -> Unit, onSaved: () -> Unit) {
    val owner = vm.repository.session.cacheScope()
    val state by vm.state.collectAsStateWithLifecycle()
    val canManageServer = state.account?.profile in listOf("owner", "librarian")
    var slowDownload by remember(podcast.id, podcast.slowDownload) { mutableStateOf(podcast.slowDownload) }
    var value by remember(owner, podcast.id) { mutableStateOf<PodcastDownloadSettings?>(null) }
    var error by remember(owner, podcast.id) { mutableStateOf<String?>(null) }
    var busy by remember(owner, podcast.id) { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(owner, podcast.id, reload) {
        value = null; error = null
        try {
            val loaded = vm.repository.podcastDownloadSettings(podcast.id)
            if (owner == vm.repository.session.cacheScope()) value = loaded
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (owner == vm.repository.session.cacheScope()) error = friendlyError(e) }
    }
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text("自动下载设置") },
        text = {
            Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState())) {
                Text(podcast.title, style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(8.dp))
                val current = value
                if (current == null && error == null) CircularProgressIndicator(Modifier.size(24.dp))
                if (current != null) {
                    if (!current.active) Text("已取消关注，自动下载暂停。重新关注后恢复此设置。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val policies = listOf("none" to "关闭", "latest_3" to "最新 3 集", "latest_5" to "最新 5 集",
                        "latest_10" to "最新 10 集", "unplayed" to "所有未听完单集", "all" to "全部历史单集")
                    var policyMenu by remember { mutableStateOf(false) }
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("自动下载", style = MaterialTheme.typography.bodyLarge)
                        Box {
                            OutlinedButton(
                                onClick = { policyMenu = true },
                                enabled = !busy && current.active,
                                shape = RoundedCornerShape(10.dp),
                                contentPadding = PaddingValues(start = 14.dp, end = 8.dp),
                                modifier = Modifier.height(40.dp).testTag("podcast-auto-download-policy"),
                            ) {
                                Text(policies.firstOrNull { it.first == current.downloadPolicy }?.second ?: "关闭", fontSize = 14.sp, maxLines = 1, softWrap = false)
                                Icon(Icons.Default.ArrowDropDown, contentDescription = null, modifier = Modifier.size(20.dp))
                            }
                            DropdownMenu(expanded = policyMenu, onDismissRequest = { policyMenu = false }) {
                                policies.forEach { (key, label) ->
                                    DropdownMenuItem(
                                        text = { Text(label) },
                                        leadingIcon = if (current.downloadPolicy == key) {
                                            { Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }
                                        } else null,
                                        onClick = { policyMenu = false; value = current.copy(downloadPolicy = key) },
                                    )
                                }
                            }
                        }
                    }
                    if (current.downloadPolicy != "none") {
                        Row(
                            Modifier.fillMaxWidth().clickable(enabled = !busy && current.active) {
                                value = current.copy(retentionPolicy = if (current.retentionPolicy == "delete_after_played") "keep" else "delete_after_played")
                            },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(current.retentionPolicy == "delete_after_played", enabled = !busy && current.active,
                                onCheckedChange = { value = current.copy(retentionPolicy = if (it) "delete_after_played" else "keep") })
                            Column {
                                Text("听完后自动移除")
                                Text("手动保存的单集不受影响", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
                if (canManageServer) {
                    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("平缓下载", style = MaterialTheme.typography.bodyLarge)
                        Switch(
                            checked = slowDownload,
                            onCheckedChange = { slowDownload = it },
                            enabled = !busy,
                            modifier = Modifier.testTag("podcast-slow-download-switch"),
                        )
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = { reload++ }, enabled = !busy) { Text("重新读取设置") } }
            }
        },
        confirmButton = { TextButton(enabled = !busy && (value?.active == true || canManageServer), onClick = {
            scope.launch {
                busy = true; error = null
                try {
                    val current = value
                    if (current != null && current.active) {
                        vm.repository.updatePodcastDownloadSettings(podcast.id, current, owner)
                    }
                    if (canManageServer && slowDownload != podcast.slowDownload) {
                        val updated = vm.repository.updatePodcastServerSettings(podcast.id, slowDownload, podcast.maxRetries, podcast.retryBackoffBase, owner)
                        if (owner == vm.repository.session.cacheScope()) vm.podcastBrowser.remember(updated)
                    }
                    if (owner == vm.repository.session.cacheScope()) { onSaved(); onDismiss() }
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) { if (owner == vm.repository.session.cacheScope()) error = friendlyError(e) }
                finally { busy = false }
            }
        }) { Text(if (busy) "保存中…" else "保存设置") } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("取消") } })
}

@Composable
fun PodcastDownloadQueueDialog(
    vm: MusicViewModel,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var queueInfo by remember { mutableStateOf<PodcastDownloadQueueInfo?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var tab by remember { mutableStateOf<String?>(null) }
    var retrying by remember { mutableStateOf(false) }

    val loadQueue: suspend () -> Unit = {
        try {
            queueInfo = vm.repository.podcastDownloadQueue()
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = friendlyError(e)
        }
    }

    LaunchedEffect(Unit) {
        while (true) {
            loadQueue()
            delay(2000L)
        }
    }

    val activeTab = tab ?: when {
        (queueInfo?.totalPending ?: 0) > 0 -> "active"
        (queueInfo?.failedCount ?: 0) > 0 -> "failed"
        (queueInfo?.recentCompleted?.size ?: 0) > 0 -> "completed"
        else -> "active"
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .testTag("podcast-download-queue-dialog"),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .widthIn(max = 840.dp)
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "关闭")
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = "服务器下载任务",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            text = "查看单集缓存、自动下载与平缓下载实时进度",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(onClick = { scope.launch { loadQueue() } }) {
                        Icon(Icons.Default.Refresh, contentDescription = "刷新下载状态")
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FilterChip(
                        selected = activeTab == "active",
                        onClick = { tab = "active" },
                        label = { Text("进行中 (${queueInfo?.totalPending ?: 0})") },
                    )
                    FilterChip(
                        selected = activeTab == "failed",
                        onClick = { tab = "failed" },
                        label = { Text("需重试 (${queueInfo?.failedCount ?: 0})") },
                    )
                    FilterChip(
                        selected = activeTab == "completed",
                        onClick = { tab = "completed" },
                        label = { Text("已完成 (${queueInfo?.recentCompleted?.size ?: 0})") },
                    )
                }

                notice?.let { msg ->
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = MaterialTheme.colorScheme.secondaryContainer,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = msg,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }

                error?.let { msg ->
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = MaterialTheme.colorScheme.errorContainer,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = msg,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(onClick = { scope.launch { loadQueue() } }) {
                                Text("重试")
                            }
                        }
                    }
                }

                val info = queueInfo
                LazyColumn(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (info == null && error == null) {
                        item {
                            Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(Modifier.size(28.dp))
                            }
                        }
                    } else if (activeTab == "active") {
                        val downloading = info?.downloading.orEmpty()
                        val queued = info?.queued.orEmpty()
                        if (downloading.isEmpty() && queued.isEmpty()) {
                            item {
                                Surface(
                                    shape = RoundedCornerShape(12.dp),
                                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Column(
                                        modifier = Modifier.padding(24.dp),
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                        verticalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        Text("当前没有进行中的下载任务", style = MaterialTheme.typography.titleSmall)
                                        Text(
                                            "播放时自动缓存、开启节目自动下载或手动保存到服务器后，实时进度会显示在这里。",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        } else {
                            item {
                                Text(
                                    text = "${info?.activeCount ?: 0} 集正在下载 · ${info?.queuedCount ?: 0} 集排队等待",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            items(downloading, key = { "dl:${it.episodeId}" }) { task ->
                                val pct = task.progressPct?.coerceIn(0.0, 100.0)?.toInt()
                                Surface(
                                    shape = RoundedCornerShape(12.dp),
                                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Column(
                                        modifier = Modifier.padding(14.dp),
                                        verticalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Column(Modifier.weight(1f)) {
                                                Text(
                                                    text = task.episodeTitle.ifBlank { "单集" },
                                                    style = MaterialTheme.typography.bodyMedium,
                                                    fontWeight = FontWeight.Medium,
                                                    maxLines = 1,
                                                    overflow = TextOverflow.Ellipsis,
                                                )
                                                Text(
                                                    text = task.podcastTitle,
                                                    style = MaterialTheme.typography.labelSmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                    maxLines = 1,
                                                    overflow = TextOverflow.Ellipsis,
                                                )
                                            }
                                            Spacer(Modifier.width(8.dp))
                                            Text(
                                                text = if (task.status == "retrying") "重试等待 (${task.attempt ?: 1}/${task.maxRetries ?: 3})"
                                                else if (pct != null) "$pct%" else "下载中",
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.primary,
                                                fontWeight = FontWeight.SemiBold,
                                            )
                                        }
                                        if (pct != null) {
                                            LinearProgressIndicator(
                                                progress = { pct / 100f },
                                                modifier = Modifier.fillMaxWidth().height(6.dp),
                                            )
                                        } else {
                                            LinearProgressIndicator(modifier = Modifier.fillMaxWidth().height(6.dp))
                                        }
                                        Row(
                                            modifier = Modifier.fillMaxWidth(),
                                            horizontalArrangement = Arrangement.SpaceBetween,
                                        ) {
                                            Text(
                                                text = (if (task.slowMode) "平缓下载 · " else "") + (task.speedHuman ?: "正在拉取数据…"),
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                            Text(
                                                text = if (!task.downloadedHuman.isNullOrBlank()) "${task.downloadedHuman} / ${task.totalHuman ?: "未知"}" else "连接中…",
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    }
                                }
                            }
                            itemsIndexed(queued, key = { _, item -> "q:${item.episodeId}" }) { idx, task ->
                                Surface(
                                    shape = RoundedCornerShape(12.dp),
                                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Row(
                                        modifier = Modifier.padding(14.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Column(Modifier.weight(1f)) {
                                            Text(
                                                text = task.episodeTitle.ifBlank { "单集" },
                                                style = MaterialTheme.typography.bodyMedium,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                            Text(
                                                text = task.podcastTitle,
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                        Spacer(Modifier.width(8.dp))
                                        Text(
                                            text = "排队 #${idx + 1}",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }
                    } else if (activeTab == "failed") {
                        val failed = info?.failed.orEmpty()
                        if (failed.isEmpty()) {
                            item {
                                Surface(
                                    shape = RoundedCornerShape(12.dp),
                                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Column(
                                        modifier = Modifier.padding(24.dp),
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                        verticalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        Text("没有需要重试的单集", style = MaterialTheme.typography.titleSmall)
                                        Text(
                                            "下载遇到问题时，可以在这里查看原因并重新拉取。",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        } else {
                            item {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        text = "下载失败 (${failed.size})",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    FilledTonalButton(
                                        onClick = {
                                            scope.launch {
                                                retrying = true
                                                try {
                                                    val res = vm.repository.retryFailedPodcastDownloads()
                                                    notice = "已将 ${res.retriedCount} 个失败任务重新加入队列"
                                                    loadQueue()
                                                    if (res.retriedCount > 0) tab = "active"
                                                } catch (e: CancellationException) {
                                                    throw e
                                                } catch (e: Exception) {
                                                    error = friendlyError(e)
                                                } finally {
                                                    retrying = false
                                                }
                                            }
                                        },
                                        enabled = !retrying,
                                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                                        modifier = Modifier.height(32.dp),
                                    ) {
                                        Text(if (retrying) "重试中…" else "全部重试", fontSize = 12.sp)
                                    }
                                }
                            }
                            items(failed, key = { "fail:${it.episodeId}" }) { task ->
                                Surface(
                                    shape = RoundedCornerShape(12.dp),
                                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Row(
                                        modifier = Modifier.padding(14.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                            Text(
                                                text = task.episodeTitle.ifBlank { "单集" },
                                                style = MaterialTheme.typography.bodyMedium,
                                                fontWeight = FontWeight.Medium,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                            Text(
                                                text = task.podcastTitle,
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                            Text(
                                                text = task.error?.takeIf { it.isNotBlank() } ?: "源站下载未成功，请检查网络或重试",
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.error,
                                            )
                                        }
                                        Spacer(Modifier.width(8.dp))
                                        OutlinedButton(
                                            onClick = {
                                                scope.launch {
                                                    try {
                                                        vm.repository.savePodcastEpisode(task.episodeId, true)
                                                        loadQueue()
                                                        tab = "active"
                                                    } catch (e: CancellationException) {
                                                        throw e
                                                    } catch (e: Exception) {
                                                        error = friendlyError(e)
                                                    }
                                                }
                                            },
                                            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                            modifier = Modifier.height(32.dp),
                                        ) {
                                            Text("重试", fontSize = 12.sp)
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        val completed = info?.recentCompleted.orEmpty()
                        if (completed.isEmpty()) {
                            item {
                                Surface(
                                    shape = RoundedCornerShape(12.dp),
                                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Column(
                                        modifier = Modifier.padding(24.dp),
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                        verticalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        Text("暂无近期完成记录", style = MaterialTheme.typography.titleSmall)
                                        Text(
                                            "后续完成的服务器下载任务会显示在这里。",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        } else {
                            item {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        text = "近期已完成 (${completed.size})",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    TextButton(
                                        onClick = {
                                            scope.launch {
                                                try {
                                                    vm.repository.clearCompletedPodcastDownloads()
                                                    notice = "已清除完成记录，已下载的音频仍保留"
                                                    loadQueue()
                                                } catch (e: CancellationException) {
                                                    throw e
                                                } catch (e: Exception) {
                                                    error = friendlyError(e)
                                                }
                                            }
                                        },
                                    ) {
                                        Text("清除记录", fontSize = 12.sp)
                                    }
                                }
                            }
                            items(completed, key = { "done:${it.episodeId}" }) { task ->
                                Surface(
                                    shape = RoundedCornerShape(12.dp),
                                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Row(
                                        modifier = Modifier.padding(14.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Column(Modifier.weight(1f)) {
                                            Text(
                                                text = task.episodeTitle.ifBlank { "单集" },
                                                style = MaterialTheme.typography.bodyMedium,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                            Text(
                                                text = task.podcastTitle,
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                        Spacer(Modifier.width(8.dp))
                                        Text(
                                            text = "✓ 已下载",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.primary,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
