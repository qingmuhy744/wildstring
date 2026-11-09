@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
    val entries = if (discovery) listOf(
        Triple("daily", stringResource(R.string.daily_recommendations), Icons.Default.AutoAwesome),
        Triple("rankings", stringResource(R.string.listening_rankings), Icons.Default.BarChart),
        Triple("external", stringResource(R.string.discover_new_music), Icons.Default.Public)
    ) else listOf(
        Triple("offline", stringResource(R.string.offline_save), Icons.Default.Download),
        Triple("statistics", stringResource(R.string.listening_statistics), Icons.Default.BarChart),
        Triple("settings", stringResource(R.string.settings_title), Icons.Default.Settings)
    )
    val dark = LocalDarkAppearance.current
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(horizontal = 20.dp, vertical = 4.dp).testTag(if (discovery) "discovery-shortcuts" else "personal-shortcuts"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        entries.forEach { (route, title, icon) ->
            val primaryEntry = discovery && route == "daily"
            val container = if (primaryEntry) MaterialTheme.colorScheme.primary.copy(alpha = if (dark) 0.16f else 0.10f) else MaterialTheme.colorScheme.surfaceContainerLow
            val content = if (primaryEntry) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface
            val border = if (primaryEntry) MaterialTheme.colorScheme.primary.copy(alpha = if (dark) 0.42f else 0.32f) else MaterialTheme.colorScheme.outlineVariant
            OutlinedButton(
                onClick = { open(route) },
                modifier = Modifier.weight(1f).fillMaxHeight().heightIn(min = 54.dp),
                shape = RoundedCornerShape(14.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, border),
                colors = ButtonDefaults.outlinedButtonColors(containerColor = container, contentColor = content),
                contentPadding = PaddingValues(vertical = 6.dp, horizontal = 6.dp),
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically)) {
                    Icon(icon, null, Modifier.size(18.dp), tint = if (primaryEntry) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(title, style = MaterialTheme.typography.labelMedium, maxLines = 2, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
        }
    }
}

@Composable
internal fun FeatureDialog(vm: MusicViewModel, route: String, track: Track? = null, playlist: Playlist? = null, albumId: String? = null, initialBatchId: String? = null, onOpenAction: (String, JsonObject?) -> Unit = { _, _ -> }, dismiss: () -> Unit) {
    val account by vm.state.collectAsStateWithLifecycle()
    val title = when (route) {
        "assistant" -> stringResource(R.string.assistant_name); "notifications" -> stringResource(R.string.notifications)
        "drafts" -> stringResource(R.string.playlist_drafts)
        "connections" -> stringResource(R.string.model_connections); "research" -> stringResource(R.string.settings_research); "channels" -> stringResource(R.string.settings_notifications)
        "external" -> stringResource(R.string.discover_new_music); "rankings" -> stringResource(R.string.listening_rankings); "daily" -> stringResource(R.string.daily_recommendations); "ai" -> stringResource(R.string.ai_music_playlists); "offline" -> stringResource(R.string.offline_save); "statistics" -> stringResource(R.string.listening_statistics); "devices" -> stringResource(R.string.settings_music_handoff)
        "playlist" -> if (playlist == null) stringResource(R.string.playlist_new) else stringResource(R.string.playlist_edit); "order" -> stringResource(R.string.playlist_order); "multi" -> stringResource(R.string.playlist_multi_add)
        "lyric-scans" -> stringResource(R.string.lyrics_scan); "gain" -> stringResource(R.string.playback_gain); "source-plugins" -> stringResource(R.string.source_zip_plugins); "management" -> stringResource(R.string.library_management); "album-edit" -> stringResource(R.string.album_edit)
        "metadata" -> stringResource(R.string.track_edit); "lyrics" -> stringResource(R.string.lyrics_edit); "suggestions" -> stringResource(R.string.metadata_suggestions); else -> stringResource(R.string.library_management)
    }
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = androidx.compose.ui.platform.LocalView.current
        val darkBars = LocalDarkAppearance.current
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
                TopAppBar(title = { Text(title) }, navigationIcon = { IconButton(dismiss) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } })
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (route) {
                        "assistant" -> AgentWorkspace(vm, "chat", onOpenAction)
                        "notifications" -> SimpleNotificationsSheet(vm, onOpenAction)
                        "drafts" -> AgentDrafts(vm, initialBatchId)
                        "connections", "management", "source-plugins", "lyric-scans" -> Text(stringResource(R.string.manage_on_web), Modifier.padding(24.dp))
                        "suggestions" -> Text(stringResource(R.string.metadata_review_on_web), Modifier.padding(24.dp))
                        "research" -> AgentResearch(vm)
                        "channels" -> AgentChannels(vm)
                        "daily" -> DailyPanel(vm, openPlayer = { onOpenAction("player", null) }, openQueue = { onOpenAction("queue", null) })
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
                        else -> if (account.account?.profile in listOf("owner", "librarian", "editor")) when (route) {
                            "metadata" -> track?.let { MetadataPanel(vm, it) }
                            "lyrics" -> track?.let { LyricsEditorPanel(vm, it) }
                            "album-edit" -> albumId?.let { AlbumMetadataPanel(vm, it, dismiss) }
                            else -> Text(stringResource(R.string.manage_on_web), Modifier.padding(24.dp))
                        } else Text(stringResource(R.string.metadata_permission_needed), Modifier.padding(24.dp))
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
    AlertDialog(onDismissRequest = dismiss, title = { Text(stringResource(R.string.sleep_timer)) }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(when { timer.entryId != null -> stringResource(R.string.sleep_end_pause); timer.deadline != null -> stringResource(R.string.sleep_remaining, ((timer.deadline!! - now).coerceAtLeast(0) + 59_999) / 60_000); else -> stringResource(R.string.not_enabled) })
            Row { listOf(15, 30, 60).forEach { minutes -> TextButton({ vm.sleep.minutes(minutes); dismiss() }) { Text(stringResource(R.string.minutes_value, minutes)) } } }
            var custom by remember { mutableStateOf("45") }
            OutlinedTextField(custom, { custom = it.filter(Char::isDigit).take(3) }, label = { Text(stringResource(R.string.sleep_custom_minutes)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true)
            TextButton({ custom.toIntOrNull()?.takeIf { it in 1..240 }?.let { vm.sleep.minutes(it); dismiss() } }, enabled = custom.toIntOrNull() in 1..240) { Text(stringResource(R.string.sleep_pause_after)) }
            TextButton({ vm.state.value.entryId?.let { vm.sleep.endOfTrack(it) }; dismiss() }, enabled = player.current != null) { Text(stringResource(R.string.sleep_end_stop)) }
        }
    }, confirmButton = { TextButton({ vm.sleep.cancel(); dismiss() }) { Text(stringResource(R.string.sleep_cancel)) } }, dismissButton = { TextButton(dismiss) { Text(stringResource(R.string.close)) } })
}

/** A local pending flag gives instant feedback and prevents duplicate mutations. */
private val PROCESSING_STATUS get() = AppLanguage.string(R.string.mob_feat_processing)
internal val DONE_STATUS get() = AppLanguage.string(R.string.completed)
internal class FeatureAction {
    var busy by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)
    suspend fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true; message = PROCESSING_STATUS
        try { block(); if (message == PROCESSING_STATUS) message = DONE_STATUS }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { message = friendlyError(e) }
        finally { busy = false }
    }
}
@Composable internal fun ActionStatus(action: FeatureAction) {
    if (action.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    // Loading surfaces already provide the visual progress cue. Keep transient
    // processing text from competing with skeletons and the wave indicator;
    // final messages and errors remain visible after the operation settles.
    action.message?.takeIf { !action.busy }?.let {
        androidx.compose.foundation.text.selection.SelectionContainer {
            Text(if (it == DONE_STATUS) stringResource(R.string.completed) else it, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodySmall)
        }
    }
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
        Text(stringResource(R.string.download_summary, items.count { it.state == "complete" }, items.sumOf { it.bytes } / 1024 / 1024), style = MaterialTheme.typography.titleMedium)
        Row {
            TextButton({ vm.repository.downloads.pauseAll() }, enabled = items.any { it.state in listOf("queued", "downloading") }) { Text(stringResource(R.string.download_pause_all)) }
            TextButton({ vm.repository.downloads.resumeAll(); vm.startDownloads() }, enabled = items.any { it.state in listOf("paused", "failed") }) { Text(stringResource(R.string.download_resume_all)) }
        }
        TextButton({ downloadOptions = !downloadOptions }) { Text(if (downloadOptions) stringResource(R.string.download_settings_collapse) else stringResource(R.string.download_settings_expand)) }
        if (downloadOptions) Column(Modifier.fillMaxWidth().heightIn(max = 300.dp).verticalScroll(rememberScrollState())) { OfflineSettings(vm) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.download_capacity, capacity), Modifier.weight(1f))
            TextButton({ capacity = (capacity / 2).coerceAtLeast(1); vm.repository.downloads.capacityGb = capacity }) { Text(stringResource(R.string.decrease)) }
            TextButton({ capacity = (capacity * 2).coerceAtMost(64); vm.repository.downloads.capacityGb = capacity }) { Text(stringResource(R.string.increase)) }
        }
        if (android.os.Build.VERSION.SDK_INT >= 33 && !notificationsGranted) TextButton({ requestNotifications.launch(android.Manifest.permission.POST_NOTIFICATIONS) }) { Text(stringResource(R.string.download_allow_notifications)) }
        Text(stringResource(R.string.offline_keep_hint), style = MaterialTheme.typography.bodySmall)
        LazyColumn(Modifier.weight(1f)) { items(items, key = { it.track.id }) { item ->
            Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                Text(item.track.title)
                Text(if (item.audioFormat == "m4a" && item.bitrate > 0) downloadQualityLabel(item.bitrate) else stringResource(R.string.download_original_format, item.track.format.uppercase()), style = MaterialTheme.typography.labelSmall)
                Text(when(item.state) { "complete" -> stringResource(R.string.completed); "paused" -> stringResource(R.string.playback_paused); "failed" -> stringResource(R.string.download_failed); "downloading" -> stringResource(R.string.favorite_saving); else -> stringResource(R.string.download_waiting) } + " · ${item.bytes / 1024 / 1024} MiB", style = MaterialTheme.typography.bodySmall)
                item.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (item.state == "downloading" && item.total > 0) LinearProgressIndicator(progress = { (item.bytes.toFloat() / item.total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                Row {
                    if (item.state == "complete") TextButton({ vm.play(listOf(item.track)) }) { Text(stringResource(R.string.play)) }
                    else if (item.state in listOf("queued", "downloading")) TextButton({ vm.repository.downloads.pause(item.track.id) }) { Text(stringResource(R.string.pause)) }
                    else TextButton({ vm.repository.downloads.resume(item.track.id); vm.startDownloads() }) { Text(stringResource(R.string.resume_retry)) }
                    TextButton({ confirm = item }) { Text(stringResource(R.string.delete)) }
                }
            }
        } }
        if (items.isEmpty()) Text(stringResource(R.string.offline_empty_hint), Modifier.padding(vertical = 24.dp))
    }
    confirm?.let { item -> AlertDialog(onDismissRequest = { confirm = null }, title = { Text(stringResource(R.string.offline_delete_title)) }, text = { Text(item.track.title) }, confirmButton = { TextButton({ vm.repository.downloads.remove(item.track.id); confirm = null }) { Text(stringResource(R.string.delete)) } }, dismissButton = { TextButton({ confirm = null }) { Text(stringResource(R.string.cancel)) } }) }
}

@Composable
private fun StatisticsPanel(vm: MusicViewModel) {
    var value by remember { mutableStateOf<ListeningSummary?>(null) }
    val action = remember { FeatureAction() }
    LaunchedEffect(Unit) { action.run { value = vm.repository.api().listeningSummary() } }
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        ActionStatus(action)
        value?.let { Text(stringResource(R.string.play_count_value, it.playCount)); Text(stringResource(R.string.statistics_minutes, it.listenedMs / 1000 / 60)); Text(stringResource(R.string.statistics_tracks, it.playedTracks, it.lovedTracks)) }
        Text(stringResource(R.string.statistics_sort_hint), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun DevicesPanel(vm: MusicViewModel) {
    val resources = androidx.compose.ui.platform.LocalResources.current
    val player by vm.state.collectAsStateWithLifecycle()
    val syncMode by vm.sharing.mode.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    var remote by remember { mutableStateOf<SharedPlayback?>(null) }
    val device = remember { vm.deviceId() }
    LaunchedEffect(Unit) { action.run { remote = vm.repository.api().sharedPlayback() } }
    Column(Modifier.padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(stringResource(R.string.handoff_mode), style = MaterialTheme.typography.titleMedium)
        Text(
            stringResource(R.string.handoff_behavior_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Column {
            listOf(
                "ask" to stringResource(R.string.handoff_ask_option),
                "auto" to stringResource(R.string.handoff_auto_option),
                "off" to stringResource(R.string.handoff_off_option),
            ).forEach { (id, label) ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { vm.syncMode(id) }
                        .padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = syncMode == id, onClick = { vm.syncMode(id) })
                    Text(label, Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        HorizontalDivider()
        Text(stringResource(R.string.handoff_manual), style = MaterialTheme.typography.titleMedium)
        Text(
            stringResource(R.string.handoff_manual_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        ActionStatus(action)
        remote?.let { saved ->
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        if (saved.trackIds.isEmpty()) stringResource(R.string.handoff_empty)
                        else stringResource(R.string.handoff_position, saved.index + 1, saved.trackIds.size, formatTime(saved.positionMs)),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (saved.deviceId == device && saved.trackIds.isNotEmpty()) {
                        Text(stringResource(R.string.handoff_this_device), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = { scope.launch { action.run { vm.resumeShared(saved); action.message = resources.getString(R.string.handoff_loaded) } } },
                    enabled = !action.busy && saved.trackIds.isNotEmpty(),
                ) { Text(stringResource(R.string.handoff_continue)) }
                OutlinedButton(
                    onClick = { scope.launch { action.run { remote = vm.sharePlayback(); action.message = resources.getString(R.string.handoff_synced) } } },
                    enabled = !action.busy && player.queue.isNotEmpty(),
                ) { Text(stringResource(R.string.handoff_upload)) }
            }
        }
        TextButton({ scope.launch { action.run { remote = vm.repository.api().sharedPlayback() } } }, enabled = !action.busy) { Text(stringResource(R.string.handoff_refresh)) }
    }
}

internal suspend fun saveRecommendations(vm: MusicViewModel, name: String, items: List<RecommendationItem>) {
    val owner = vm.repository.session.cacheScope() ?: throw CancellationException(AppLanguage.string(R.string.mob_feat_login_expired))
    fun requireOwner() { if (owner != vm.repository.session.cacheScope()) throw CancellationException(AppLanguage.string(R.string.mob_feat_server_account_changed)) }
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
