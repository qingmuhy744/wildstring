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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
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
    var showQueueDialog by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(owner, podcast.id, reload) {
        value = null; error = null
        try {
            val loaded = vm.repository.podcastDownloadSettings(podcast.id)
            if (owner == vm.repository.session.cacheScope()) {
                value = loaded
                slowDownload = loaded.slowDownload || podcast.slowDownload
            }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (owner == vm.repository.session.cacheScope()) error = friendlyError(e) }
    }
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text(stringResource(R.string.pod_dl_dialog_title)) },
        text = {
            Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState())) {
                Text(podcast.title, style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(8.dp))
                val current = value
                if (current == null && error == null) Column(verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(vertical = 6.dp)) {
                    SkeletonLine(widthFraction = .35f)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        SkeletonBlock(Modifier.weight(1f).height(22.dp), RoundedCornerShape(6.dp))
                        SkeletonBlock(Modifier.width(96.dp).height(48.dp), RoundedCornerShape(10.dp))
                    }
                    SkeletonLine(widthFraction = .42f)
                    SkeletonLine(widthFraction = .8f)
                }
                if (current != null) {
                    if (!current.active) Text(stringResource(R.string.pod_dl_unfollowed_notice), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val policies = listOf(
                        "none" to stringResource(R.string.pod_dl_policy_none),
                        "latest_3" to stringResource(R.string.pod_dl_policy_latest_3),
                        "latest_5" to stringResource(R.string.pod_dl_policy_latest_5),
                        "latest_10" to stringResource(R.string.pod_dl_policy_latest_10),
                        "unplayed" to stringResource(R.string.pod_dl_policy_unplayed),
                        "all" to stringResource(R.string.pod_dl_policy_all),
                    )
                    var policyMenu by remember { mutableStateOf(false) }
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(stringResource(R.string.pod_dl_auto_download_label), style = MaterialTheme.typography.bodyLarge)
                        Box {
                            OutlinedButton(
                                onClick = { policyMenu = true },
                                enabled = !busy && current.active,
                                shape = RoundedCornerShape(10.dp),
                                contentPadding = PaddingValues(start = 14.dp, end = 8.dp),
                                modifier = Modifier.heightIn(min = 48.dp).testTag("podcast-auto-download-policy"),
                            ) {
                                Text(policies.firstOrNull { it.first == current.downloadPolicy }?.second ?: stringResource(R.string.pod_dl_policy_none), fontSize = 14.sp, maxLines = 1, softWrap = false)
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
                                Text(stringResource(R.string.pod_dl_delete_played))
                                Text(stringResource(R.string.pod_dl_manual_unaffected), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
                if (current != null || canManageServer) {
                    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(stringResource(R.string.pod_dl_slow_download), style = MaterialTheme.typography.bodyLarge)
                        Switch(
                            checked = slowDownload,
                            onCheckedChange = { slowDownload = it },
                            enabled = !busy && (current?.active == true || canManageServer),
                            modifier = Modifier.testTag("podcast-slow-download-switch"),
                        )
                    }
                    TextButton(
                        onClick = { showQueueDialog = true },
                        contentPadding = PaddingValues(0.dp),
                        modifier = Modifier.testTag("podcast-open-download-queue"),
                    ) {
                        Text(stringResource(R.string.pod_dl_tasks_title))
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = { reload++ }, enabled = !busy) { Text(stringResource(R.string.pod_dl_reload_settings)) } }
            }
        },
        confirmButton = { TextButton(enabled = !busy && (value?.active == true || canManageServer), onClick = {
            scope.launch {
                busy = true; error = null
                try {
                    val current = value
                    if (current != null && current.active) {
                        vm.repository.updatePodcastDownloadSettings(podcast.id, current.copy(slowDownload = slowDownload), owner)
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
        }) { Text(if (busy) stringResource(R.string.pod_dl_saving) else stringResource(R.string.pod_dl_save)) } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.pod_dl_cancel)) } })
    if (showQueueDialog) {
        PodcastDownloadQueueDialog(vm = vm, onDismiss = { showQueueDialog = false })
    }
}

@Composable
fun PodcastDownloadQueueDialog(
    vm: MusicViewModel,
    onDismiss: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val canManageServer = state.account?.profile in listOf("owner", "librarian")
    val scope = rememberCoroutineScope()
    var queueInfo by remember { mutableStateOf<PodcastDownloadQueueInfo?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var tab by remember { mutableStateOf<String?>(null) }
    var retrying by remember { mutableStateOf(false) }

    val loadQueue: suspend () -> Unit = {
        try {
            queueInfo = if (canManageServer) {
                vm.repository.podcastDownloadQueue()
            } else {
                vm.repository.myPodcastDownloadQueue()
            }
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
                        Icon(Icons.Default.Close, contentDescription = stringResource(R.string.pod_dl_close))
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = stringResource(R.string.pod_dl_tasks_title),
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            text = stringResource(R.string.pod_dl_tasks_subtitle),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(onClick = { scope.launch { loadQueue() } }) {
                        Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.pod_dl_refresh_desc))
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FilterChip(
                        selected = activeTab == "active",
                        onClick = { tab = "active" },
                        label = { Text(stringResource(R.string.pod_dl_tab_active, queueInfo?.totalPending ?: 0)) },
                    )
                    FilterChip(
                        selected = activeTab == "failed",
                        onClick = { tab = "failed" },
                        label = { Text(stringResource(R.string.pod_dl_tab_failed, queueInfo?.failedCount ?: 0)) },
                    )
                    FilterChip(
                        selected = activeTab == "completed",
                        onClick = { tab = "completed" },
                        label = { Text(stringResource(R.string.pod_dl_tab_completed, queueInfo?.recentCompleted?.size ?: 0)) },
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
                                Text(stringResource(R.string.pod_dl_retry))
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
                        items(4) {
                            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
                                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                    SkeletonBlock(Modifier.size(44.dp), RoundedCornerShape(8.dp))
                                    Spacer(Modifier.width(12.dp))
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        SkeletonLine(widthFraction = .8f)
                                        SkeletonLine(widthFraction = .5f)
                                    }
                                }
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
                                        Text(stringResource(R.string.pod_dl_no_active_tasks), style = MaterialTheme.typography.titleSmall)
                                        Text(
                                            stringResource(R.string.pod_dl_no_active_tasks_hint),
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        } else {
                            item {
                                Text(
                                    text = stringResource(R.string.pod_dl_active_summary, info?.activeCount ?: 0, info?.queuedCount ?: 0),
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
                                                    text = task.episodeTitle.ifBlank { stringResource(R.string.pod_dl_episode_fallback) },
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
                                                text = if (task.status == "retrying") stringResource(R.string.pod_dl_status_retrying, task.attempt ?: 1, task.maxRetries ?: 3)
                                                else if (pct != null) "$pct%" else stringResource(R.string.pod_dl_status_downloading),
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
                                                text = (if (task.slowMode) stringResource(R.string.pod_dl_slow_prefix) else "") + (task.speedHuman ?: stringResource(R.string.pod_dl_fetching_data)),
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                            Text(
                                                text = if (!task.downloadedHuman.isNullOrBlank()) "${task.downloadedHuman} / ${task.totalHuman?.takeUnless { it == "未知大小" } ?: stringResource(R.string.pod_dl_unknown_total)}" else stringResource(R.string.pod_dl_connecting),
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
                                                text = task.episodeTitle.ifBlank { stringResource(R.string.pod_dl_episode_fallback) },
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
                                            text = stringResource(R.string.pod_dl_queued_rank, idx + 1),
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
                                        Text(stringResource(R.string.pod_dl_no_failed), style = MaterialTheme.typography.titleSmall)
                                        Text(
                                            stringResource(R.string.pod_dl_no_failed_hint),
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
                                        text = stringResource(R.string.pod_dl_failed_count, failed.size),
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    FilledTonalButton(
                                        onClick = {
                                            scope.launch {
                                                retrying = true
                                                try {
                                                    val retriedCount = if (canManageServer) {
                                                        vm.repository.retryFailedPodcastDownloads().retriedCount
                                                    } else {
                                                        failed.forEach { task ->
                                                            vm.repository.savePodcastEpisode(task.episodeId, true)
                                                        }
                                                        failed.size
                                                    }
                                                    notice = AppLanguage.string(R.string.pod_dl_retry_all_notice, retriedCount)
                                                    loadQueue()
                                                    if (retriedCount > 0) tab = "active"
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
                                        modifier = Modifier.heightIn(min = 48.dp),
                                    ) {
                                        Text(if (retrying) stringResource(R.string.pod_dl_retrying) else stringResource(R.string.pod_dl_retry_all), fontSize = 12.sp)
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
                                                text = task.episodeTitle.ifBlank { stringResource(R.string.pod_dl_episode_fallback) },
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
                                                text = localizePodcastTaskError(task.error),
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
                                            modifier = Modifier.heightIn(min = 48.dp),
                                        ) {
                                            Text(stringResource(R.string.pod_dl_retry), fontSize = 12.sp)
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
                                        Text(stringResource(R.string.pod_dl_no_completed), style = MaterialTheme.typography.titleSmall)
                                        Text(
                                            stringResource(R.string.pod_dl_no_completed_hint),
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
                                        text = stringResource(R.string.pod_dl_completed_count, completed.size),
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    if (canManageServer) {
                                        TextButton(
                                            onClick = {
                                                scope.launch {
                                                    try {
                                                        vm.repository.clearCompletedPodcastDownloads()
                                                        notice = AppLanguage.string(R.string.pod_dl_clear_completed_notice)
                                                        loadQueue()
                                                    } catch (e: CancellationException) {
                                                        throw e
                                                    } catch (e: Exception) {
                                                        error = friendlyError(e)
                                                    }
                                                }
                                            },
                                        ) {
                                            Text(stringResource(R.string.pod_dl_clear_records), fontSize = 12.sp)
                                        }
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
                                                text = task.episodeTitle.ifBlank { stringResource(R.string.pod_dl_episode_fallback) },
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
                                            text = stringResource(R.string.pod_dl_downloaded_badge),
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

internal fun localizePodcastTaskError(raw: String?): String {
    val error = raw?.trim().orEmpty()
    if (error.isEmpty() || error == "下载失败") return AppLanguage.string(R.string.pod_dl_default_error)
    when (error) {
        "下载任务已取消", "下载已被停止" -> return AppLanguage.string(R.string.pod_dl_err_cancelled)
        "音频超过大小限制", "播客音频超过大小限制" -> return AppLanguage.string(R.string.pod_dl_err_size_exceeded)
        "音频文件为空" -> return AppLanguage.string(R.string.pod_dl_err_empty_file)
        "源站域名被解析为 fake-ip 地址（198.18.0.0/15），请在服务端开启 WILDSTRING_PODCAST_ALLOW_FAKE_IP 或配置出站代理" -> return AppLanguage.string(R.string.pod_dl_err_fake_ip)
        "播客音频地址指向非公网资源" -> return AppLanguage.string(R.string.pod_dl_err_non_public_url)
        "源站频繁请求限流 (HTTP 429 Too Many Requests)，已启动防限流冷却",
        "源站频繁请求限流 (HTTP 429 Too Many Requests)，已自动切换平缓下载并启动防限流冷却" -> return AppLanguage.string(R.string.pod_dl_err_http_429)
        "源站防盗链或拒绝访问 (HTTP 403 Forbidden)" -> return AppLanguage.string(R.string.pod_dl_err_http_403)
        "音频资源文件不存在 (HTTP 404 Not Found)" -> return AppLanguage.string(R.string.pod_dl_err_http_404)
        "源站服务过载不可用 (HTTP 503)" -> return AppLanguage.string(R.string.pod_dl_err_http_503)
        "网络连接超时，源站响应过慢", "网络请求超时，源站响应过慢" -> return AppLanguage.string(R.string.pod_dl_err_timeout)
        "源站 SSL 证书校验失败" -> return AppLanguage.string(R.string.pod_dl_err_ssl)
    }
    Regex("^第 (\\d+)/(\\d+) 次重试等待中 \\((\\d+)s\\): (.+)$").matchEntire(error)?.let {
        return AppLanguage.string(R.string.pod_dl_err_retry_waiting, it.groupValues[1].toInt(), it.groupValues[2].toInt(), it.groupValues[3].toInt(), localizePodcastTaskError(it.groupValues[4]))
    }
    Regex("^源站 HTTP 请求失败 \\((\\d+)\\)$").matchEntire(error)?.let {
        return AppLanguage.string(R.string.pod_dl_err_upstream_http, it.groupValues[1].toInt())
    }
    Regex("^网络连接失败 \\((.+)\\)$").matchEntire(error)?.let {
        return AppLanguage.string(R.string.pod_dl_err_network_reason, it.groupValues[1])
    }
    Regex("^下载遇到异常: (.+)$").matchEntire(error)?.let {
        return AppLanguage.string(R.string.pod_dl_err_exception_reason, it.groupValues[1])
    }
    return error
}
