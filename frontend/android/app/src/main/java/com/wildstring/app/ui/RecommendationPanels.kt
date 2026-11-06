@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import android.text.format.DateFormat
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.automirrored.filled.PlaylistAdd
import androidx.compose.material.icons.automirrored.filled.PlaylistPlay
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.gson.JsonObject
import com.wildstring.app.R
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter

internal val recommendationSourceLabels = linkedMapOf("personal" to R.string.recommendation_source_personal, "community" to R.string.recommendation_source_community,
    "discovery" to R.string.recommendation_source_discovery, "revisit" to R.string.recommendation_source_revisit,
    "lastfm_similar" to R.string.recommendation_source_lastfm_similar, "lastfm_charts" to R.string.recommendation_source_lastfm_charts, "lastfm_tags" to R.string.recommendation_source_lastfm_tags)
@Composable internal fun recommendationSource(id: String): String = recommendationSourceLabels[id]?.let { stringResource(it) } ?: if (id == "ai") "AI" else id
internal fun recommendationIssue(code: String): String = when {
    code.contains("budget") -> "AI 预算不足，保留本地结果"
    code.contains("connection") || code.contains("not_found") -> "所选连接不可用，保留本地结果"
    code.contains("unavailable") || code.contains("failed") || code.contains("timeout") -> "暂时无法获取，已使用可用来源"
    code.contains("disabled") || code.contains("not_configured") -> "来源未启用或未配置"
    code.contains("empty") || code.contains("no_match") -> "暂无可用匹配"
    else -> "本次未能使用此来源"
}

@Composable private fun RecommendationEvidence(statuses: List<RecommendationSourceStatus>, warnings: List<RecommendationWarning>, degraded: Boolean, engine: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(if (engine == "ai") "AI 编排 · 仅播放本库音乐" else "本地规则 · 仅播放本库音乐", style = MaterialTheme.typography.labelMedium)
        statuses.filter { it.status != "disabled" }.forEach { source ->
            val status = when (source.status) { "ok" -> "${source.matched} 首匹配"; "empty" -> "暂无匹配"; else -> "暂不可用" }
            Text("${recommendationSource(source.id)} · $status${if (source.cached) " · 缓存" else ""}", style = MaterialTheme.typography.bodySmall)
        }
        if (degraded && warnings.isEmpty()) Text("部分来源暂不可用，已保留可用推荐。", style = MaterialTheme.typography.bodySmall)
        warnings.distinct().forEach { Text("${recommendationSource(it.source)}：${recommendationIssue(it.code)}", style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable internal fun DailyPanel(vm: MusicViewModel, openPlayer: () -> Unit, openQueue: () -> Unit) {
    val current by vm.state.collectAsStateWithLifecycle()
    val resources = LocalResources.current
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    var daily by remember { mutableStateOf<DailyRecommendations?>(null) }
    var preferences by remember { mutableStateOf<RecommendationPreferences?>(null) }
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var connectionsError by remember { mutableStateOf<String?>(null) }
    var settings by remember { mutableStateOf(false) }; var rankings by remember { mutableStateOf(false) }; var external by remember { mutableStateOf(false) }
    var rejected by remember { mutableStateOf(setOf<String>()) }
    var evidence by remember { mutableStateOf(false) }
    var panelMenu by remember { mutableStateOf(false) }
    var trackMenu by remember { mutableStateOf<String?>(null) }
    var selecting by remember { mutableStateOf(false) }
    var selectedIds by remember { mutableStateOf(setOf<String>()) }
    var playlistTracks by remember { mutableStateOf<List<Track>?>(null) }
    var lyricTrack by remember { mutableStateOf<Track?>(null) }
    // Bumped by 换一批 so a slower background load cannot replace the batch the user just asked for.
    var batch by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        val cached = vm.repository.cachedDaily()?.also { daily = it }
        val started = batch
        suspend fun load() {
            vm.repository.daily().let { if (batch == started) daily = it }
            preferences = vm.repository.api().recommendationPreferences()
            try { connections = vm.agent.all("connections") } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { connectionsError = friendlyError(error) }
        }
        // Reopening shows the last batch at once and refreshes it quietly; only a cold start shows progress.
        if (cached == null) action.run { load() }
        else try { load() } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { action.message = friendlyError(error) }
        if (action.message == "已完成") action.message = null
    }
    if (rankings) { RankingsPanel(vm) { rankings = false }; return }
    if (external) { ExternalMusicPanel(vm) {
        external = false
        // Both settings panels edit the same versioned preference resource.
        scope.launch {
            try { preferences = vm.repository.api().recommendationPreferences() }
            catch (cancel: CancellationException) { throw cancel }
            catch (error: Exception) { action.message = friendlyError(error) }
        }
    }; return }
    val entries = daily?.items.orEmpty().filter { it.track.id !in rejected }
    val selectedTracks = entries.map { it.track }.filter { it.id in selectedIds }
    fun endSelection() { selecting = false; selectedIds = emptySet() }
    // Long press starts a selection; clearing the last pick leaves it.
    fun selectTrack(id: String) {
        selectedIds = if (id in selectedIds) selectedIds - id else selectedIds + id
        selecting = selectedIds.isNotEmpty()
    }
    fun enqueue(tracks: List<Track>, next: Boolean = false) {
        action.message = if (vm.addToQueue(tracks, next)) {
            endSelection(); resources.getString(if (next) R.string.daily_queued_next else R.string.daily_queued, tracks.size)
        } else resources.getString(R.string.daily_queue_failed)
    }
    BackHandler(enabled = selecting) { endSelection() }
    Column(Modifier.fillMaxSize()) {
    LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("daily-recommendations"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
            Surface(Modifier.fillMaxWidth().padding(bottom = 12.dp), shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        DailyCoverMosaic(vm, entries.take(4).map { it.track })
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(dailyDate(daily?.date), style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val sources = daily?.sourceStatus.orEmpty().filter { it.status == "ok" && it.matched > 0 }.take(2).map { recommendationSource(it.id) }
                            Text((listOf(stringResource(R.string.daily_summary, entries.size)) + sources).joinToString(" · "),
                                Modifier.testTag("daily-summary"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Box {
                            IconButton({ panelMenu = true }, Modifier.testTag("daily-more-actions")) { Icon(Icons.Default.MoreVert, stringResource(R.string.daily_more)) }
                            DropdownMenu(panelMenu, { panelMenu = false }) {
                                DropdownMenuItem(text = { Text(stringResource(R.string.recommendation_settings)) }, leadingIcon = { Icon(Icons.Default.Tune, null) }, enabled = preferences != null,
                                    onClick = { panelMenu = false; action.message = null; settings = true }, modifier = Modifier.testTag("recommendation-settings"))
                                DropdownMenuItem(text = { Text(stringResource(if (evidence) R.string.recommendation_evidence_hide else R.string.recommendation_evidence)) }, leadingIcon = { Icon(Icons.Outlined.Info, null) },
                                    onClick = { panelMenu = false; evidence = !evidence }, modifier = Modifier.testTag("recommendation-evidence"))
                                HorizontalDivider()
                                DropdownMenuItem(text = { Text(stringResource(R.string.listening_rankings)) }, leadingIcon = { Icon(Icons.Default.Leaderboard, null) }, onClick = { panelMenu = false; rankings = true }, modifier = Modifier.testTag("daily-rankings"))
                                DropdownMenuItem(text = { Text(stringResource(R.string.discover_new_music)) }, leadingIcon = { Icon(Icons.Default.Explore, null) }, onClick = { panelMenu = false; external = true }, modifier = Modifier.testTag("daily-external"))
                            }
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button({
                            vm.play(entries.map { it.track })
                            entries.firstOrNull()?.let { first -> scope.launch { runCatching { vm.repository.feedback(RecommendationFeedback(trackId = first.track.id, action = "accept")).close() } } }
                        }, Modifier.weight(1f).testTag("daily-play"), enabled = entries.isNotEmpty()) {
                            Icon(Icons.Default.PlayArrow, null, Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.play_all))
                        }
                        FilledTonalIconButton({ scope.launch { action.run { batch++; daily = vm.repository.daily(refresh = true); rejected = emptySet(); endSelection() } } },
                            Modifier.testTag("daily-refresh"), enabled = !action.busy) { Icon(Icons.Default.Refresh, stringResource(R.string.daily_refresh)) }
                        FilledTonalIconButton({ scope.launch { action.run {
                            saveRecommendations(vm, resources.getString(R.string.daily_playlist_name, daily?.date.orEmpty()), entries); action.message = resources.getString(R.string.daily_saved)
                        } } }, Modifier.testTag("daily-save"), enabled = !action.busy && entries.isNotEmpty()) { Icon(Icons.AutoMirrored.Filled.PlaylistAdd, stringResource(R.string.daily_save)) }
                    }
                    ActionStatus(action)
                    if (evidence) daily?.let { RecommendationEvidence(it.sourceStatus, it.warnings, it.degraded, it.engine) }
                }
            }
        }
        items(entries, key = { it.track.id }) { item ->
            val track = item.track
            val active = current.current?.id == track.id
            val chosen = track.id in selectedIds
            Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).testTag("daily-track-${track.id}")
                .clip(RoundedCornerShape(12.dp))
                .background(when { chosen -> MaterialTheme.colorScheme.secondaryContainer; active -> MaterialTheme.colorScheme.primary.copy(alpha = .08f); else -> Color.Transparent })
                .semantics { selected = if (selecting) chosen else active }
                .combinedClickable(onClick = { if (selecting) selectTrack(track.id) else vm.play(entries.map { it.track }, entries.indexOf(item)) },
                    onLongClick = { if (selecting) selectTrack(track.id) else { selecting = true; selectedIds = setOf(track.id) } })
                .padding(start = 4.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.width(if (selecting) 40.dp else 28.dp), contentAlignment = Alignment.Center) {
                    if (selecting) Checkbox(chosen, { selectTrack(track.id) }, Modifier.testTag("daily-select-${track.id}"))
                    else if (active) PlaybackIndicator(current.playing, current.buffering)
                    else Text((entries.indexOf(item) + 1).toString().padStart(2, '0'), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.size(48.dp).clip(RoundedCornerShape(8.dp)))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
                    // The source label says why the song is here; the album fills in when no source is known.
                    val source = item.sourceIds.orEmpty().firstNotNullOfOrNull { recommendationSourceLabels[it] }?.let { stringResource(it) }
                    Text(listOfNotNull(track.artist, source ?: track.album?.takeIf(String::isNotBlank)).joinToString(" · "),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!selecting) Box {
                    IconButton({ trackMenu = track.id }, Modifier.testTag("daily-more-${track.id}")) { Icon(Icons.Default.MoreVert, stringResource(R.string.track_actions_named, track.title)) }
                    DropdownMenu(trackMenu == track.id, { trackMenu = null }) {
                        DropdownMenuItem(text = { Text(stringResource(R.string.play_next)) }, leadingIcon = { Icon(Icons.AutoMirrored.Filled.PlaylistPlay, null) }, onClick = { trackMenu = null; enqueue(listOf(track), true) })
                        DropdownMenuItem(text = { Text(stringResource(R.string.queue_add)) }, leadingIcon = { Icon(Icons.AutoMirrored.Filled.QueueMusic, null) }, onClick = { trackMenu = null; enqueue(listOf(track)) })
                        DropdownMenuItem(text = { Text(stringResource(R.string.playlist_add)) }, leadingIcon = { Icon(Icons.Default.LibraryMusic, null) }, onClick = { trackMenu = null; playlistTracks = listOf(track) })
                        DropdownMenuItem(text = { Text(stringResource(R.string.lyrics_view)) }, leadingIcon = { Icon(Icons.Default.Lyrics, null) }, onClick = { trackMenu = null; lyricTrack = track })
                        HorizontalDivider()
                        DropdownMenuItem(text = { Text(stringResource(if (vm.repository.knownTracks[track.id]?.loved ?: track.loved) R.string.favorite_remove else R.string.favorite_add)) },
                            leadingIcon = { Icon(Icons.Default.FavoriteBorder, null) }, enabled = track.id !in current.pendingFavorites,
                            onClick = { trackMenu = null; vm.favorite(track) })
                        listOf("dismiss_track" to R.string.recommendation_not_interested, "less_artist" to R.string.recommendation_less_artist).forEach { (key, name) ->
                            DropdownMenuItem(text = { Text(stringResource(name)) }, leadingIcon = { Icon(if (key == "dismiss_track") Icons.Default.DoNotDisturb else Icons.Default.PersonOff, null) },
                                onClick = { trackMenu = null; scope.launch { action.run { vm.repository.feedback(RecommendationFeedback(trackId = track.id, action = key)).close(); rejected = rejected + track.id } } }, enabled = !action.busy)
                        }
                    }
                }
            }
        }
        if (entries.isEmpty() && !action.busy) item { Text(stringResource(R.string.daily_empty), Modifier.padding(vertical = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
    if (selecting) DailySelectionBar(selectedTracks.size, allSelected = selectedTracks.size == entries.size,
        close = ::endSelection, toggleAll = { if (selectedTracks.size == entries.size) endSelection() else selectedIds = entries.map { it.track.id }.toSet() },
        playNext = { enqueue(selectedTracks, true) }, enqueue = { enqueue(selectedTracks) }, addToPlaylist = { playlistTracks = selectedTracks })
    // The dialog covers the app shell, so it carries the same mini player instead of a lookalike.
    else Box(Modifier.testTag("daily-mini-player")) { MiniPlayer(vm, current, onQueue = openQueue, expand = openPlayer) }
    }
    playlistTracks?.let { tracks -> RecommendationPlaylistDialog(vm, tracks, { playlistTracks = null }) {
        playlistTracks = null; endSelection(); action.message = it
    } }
    lyricTrack?.let { track -> RecommendationLyricsDialog(vm, track) { lyricTrack = null } }
    if (settings) preferences?.let { original -> RecommendationSettings(original, connections, connectionsError, action.busy, action.message, { settings = false }) { updated ->
        scope.launch { action.run { preferences = vm.repository.api().saveRecommendationPreferences(updated); settings = false; action.message = "偏好已保存，下次换一批生效" } }
    } }
}

@Composable private fun dailyDate(date: String?): String {
    val locale = LocalConfiguration.current.locales[0]
    return remember(date, locale) {
        runCatching { LocalDate.parse(date).format(DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, "MMMMd"), locale)) }.getOrNull()
    } ?: stringResource(R.string.daily_recommendations)
}

/** A 2×2 grid of the first covers gives each day's batch its own face; fewer songs show one cover. */
@Composable private fun DailyCoverMosaic(vm: MusicViewModel, tracks: List<Track>) {
    Surface(Modifier.size(76.dp), shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainerHighest) {
        if (tracks.size < 4) tracks.firstOrNull()?.let { Cover(vm, it.id.takeIf { _ -> it.hasCover }, it.title, Modifier.fillMaxSize()) }
        else Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            tracks.chunked(2).forEach { row ->
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    row.forEach { Cover(vm, it.id.takeIf { _ -> it.hasCover }, it.title, Modifier.weight(1f).fillMaxHeight()) }
                }
            }
        }
    }
}

@Composable private fun DailySelectionBar(count: Int, allSelected: Boolean, close: () -> Unit, toggleAll: () -> Unit, playNext: () -> Unit, enqueue: () -> Unit, addToPlaylist: () -> Unit) {
    Surface(Modifier.fillMaxWidth().testTag("daily-selection"), color = MaterialTheme.colorScheme.surfaceContainer) {
        Column {
            HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f))
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(close) { Icon(Icons.Default.Close, stringResource(R.string.done)) }
                Text(stringResource(R.string.daily_selected, count), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                IconButton(toggleAll) { Icon(if (allSelected) Icons.Default.Deselect else Icons.Default.SelectAll, stringResource(if (allSelected) R.string.select_none else R.string.select_all)) }
                IconButton(playNext, Modifier.testTag("daily-selection-play-next")) { Icon(Icons.AutoMirrored.Filled.PlaylistPlay, stringResource(R.string.play_next)) }
                IconButton(enqueue, Modifier.testTag("daily-selection-queue")) { Icon(Icons.AutoMirrored.Filled.QueueMusic, stringResource(R.string.queue_add)) }
                IconButton(addToPlaylist, Modifier.testTag("daily-selection-playlist")) { Icon(Icons.Default.LibraryAdd, stringResource(R.string.playlist_add)) }
            }
        }
    }
}

@Composable private fun RecommendationSettings(original: RecommendationPreferences, connections: List<JsonObject>, error: String?, busy: Boolean, message: String?, dismiss: () -> Unit, save: (RecommendationPreferences) -> Unit) {
    var value by remember { mutableStateOf(original) }; var tags by remember { mutableStateOf(original.lastfmTags.joinToString(", ")) }
    AlertDialog(onDismissRequest = dismiss, title = { Text("推荐设置") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            Text("每个账号单独保存。只从所选来源推荐本库可播放的音乐。", style = MaterialTheme.typography.bodySmall)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("每天 ${value.count} 首", Modifier.weight(1f))
                IconButton({ value = value.copy(count = (value.count - 5).coerceAtLeast(1)) }) { Icon(Icons.Default.Remove, "减少推荐数量") }
                IconButton({ value = value.copy(count = (value.count + 5).coerceAtMost(50)) }) { Icon(Icons.Default.Add, "增加推荐数量") }
            }
            Text("推荐来源", style = MaterialTheme.typography.titleSmall)
            recommendationSourceLabels.forEach { (id, name) ->
                val checked = id in value.sources
                val toggle = { next: Boolean -> value = value.copy(sources = if (next) (value.sources + id).distinct() else value.sources - id) }
                Row(Modifier.fillMaxWidth().clickable { toggle(!checked) }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked, toggle, modifier = Modifier.testTag("recommendation-source-$id"))
                    Text(stringResource(name), Modifier.weight(1f))
                }
            }
            if ("lastfm_tags" in value.sources) OutlinedTextField(tags, { tags = it.take(200) }, label = { Text("公共标签（逗号分隔，最多 3 个）") }, modifier = Modifier.fillMaxWidth())
            Text("每日定时生成", style = MaterialTheme.typography.titleSmall)
            Row(Modifier.fillMaxWidth().clickable { value = value.copy(dailyEnabled = !value.dailyEnabled) }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(value.dailyEnabled, { checked -> value = value.copy(dailyEnabled = checked) })
                Text("按设定时间自动生成每日推荐", Modifier.weight(1f))
            }
            if (value.dailyEnabled) {
                OutlinedTextField(
                    value.dailyTime,
                    { input ->
                        val clean = input.filter { it.isDigit() || it == ':' }.take(5)
                        value = value.copy(dailyTime = clean)
                    },
                    label = { Text("每天生成时间 (HH:MM)") },
                    placeholder = { Text("00:00") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
            Text("AI 编排", style = MaterialTheme.typography.titleSmall)
            AgentConnectionChoice(connections, value.connectionId.takeUnless { it == "local" }) { selected -> value = value.copy(connectionId = selected ?: "local", useAi = selected != null) }
            error?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }, confirmButton = { TextButton({ save(value.copy(useAi = value.connectionId != "local", useLastfm = value.sources.any { it.startsWith("lastfm_") }, lastfmTags = tags.split(',', '，').map(String::trim).filter(String::isNotBlank).distinct().take(3))) }, enabled = !busy && value.sources.isNotEmpty()) { Text("保存偏好") } }, dismissButton = { TextButton(dismiss) { Text("取消") } })
}

@Composable internal fun AiPanel(vm: MusicViewModel) {
    val keyboard = LocalSoftwareKeyboardController.current
    var excluded by remember { mutableStateOf(setOf<String>()) }; var draftName by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }; var result by remember { mutableStateOf<DiscoveryResult?>(null) }
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var connection by remember { mutableStateOf<String?>(null) }
    var connectionError by remember { mutableStateOf<String?>(null) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { try { connections = vm.agent.all("connections") } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { connectionError = friendlyError(error) } }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        AgentConnectionChoice(connections, connection, !action.busy) { connection = it }
        connectionError?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        OutlinedTextField(prompt, { prompt = it.take(2000) }, Modifier.fillMaxWidth(), label = { Text("想听什么？") }, placeholder = { Text("来半小时我很久没听过的摇滚") }, minLines = 2)
        Button({ keyboard?.hide(); scope.launch { action.run { result = vm.repository.agentApi().discover(DiscoveryRequest(prompt, connectionId = connection ?: "local")); draftName = result!!.title; excluded = emptySet(); action.message = if (result?.mode == "local") "当前使用本地检索" else "已生成候选，请预览后保存" } } }, enabled = !action.busy && prompt.isNotBlank()) { Text(if (action.busy) "正在找歌…" else "生成候选") }
        ActionStatus(action)
        result?.let { draft ->
            val selected = draft.items.filter { it.track.id !in excluded }
            OutlinedTextField(draftName, { draftName = it.take(100) }, Modifier.fillMaxWidth(), label = { Text("歌单名称") }, singleLine = true)
            RecommendationEvidence(draft.sourceStatus, draft.warnings, draft.degraded, draft.mode)
            if (draft.warning != null && draft.warnings.isEmpty()) Text(recommendationIssue(draft.warning), style = MaterialTheme.typography.bodySmall)
            Row {
                TextButton({ vm.play(selected.map { it.track }) }, enabled = selected.isNotEmpty()) { Text("试听候选") }
                TextButton({ scope.launch { action.run { saveRecommendations(vm, draftName, selected); action.message = "歌单已保存" } } }, enabled = !action.busy && selected.isNotEmpty() && draftName.isNotBlank()) { Text("确认保存歌单") }
            }
            LazyColumn(Modifier.weight(1f)) { items(draft.items, key = { it.track.id }) { item -> ListItem(headlineContent = { Text(item.track.title) }, supportingContent = { Text(item.track.artist + " · " + item.reason) }, leadingContent = { Checkbox(item.track.id !in excluded, { checked -> excluded = if (checked) excluded - item.track.id else excluded + item.track.id }) }) } }
        }
    }
}

@Composable internal fun RankingsPanel(vm: MusicViewModel, back: (() -> Unit)? = null) {
    var scope by remember { mutableStateOf("personal") }; var period by remember { mutableStateOf("30d") }; var metric by remember { mutableStateOf("plays") }
    var ranking by remember { mutableStateOf<ListeningRankings?>(null) }; val action = remember { FeatureAction() }; val coroutine = rememberCoroutineScope()
    suspend fun load() { ranking = vm.repository.api().listeningRankings(scope, period, metric) }
    LaunchedEffect(scope, period, metric) { action.run { ranking = null; load() }; if (action.message == "已完成") action.message = null }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("listening-rankings")) {
        back?.let { TextButton(it) { Text("返回每日推荐") } }
        PrimaryTabRow(if (scope == "personal") 0 else 1) { listOf("personal" to "我常听", "community" to "大家常听").forEach { (id, label) -> Tab(scope == id, { scope = id }, text = { Text(label) }) } }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            SimpleRecommendationChoice(listOf("7d" to "近 7 天", "30d" to "近 30 天", "90d" to "近 90 天", "all" to "全部时间"), period) { period = it }
            SimpleRecommendationChoice(listOf("plays" to "播放次数", "listened_ms" to "收听时长"), metric) { metric = it }
            IconButton({ coroutine.launch { action.run { load() } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, "刷新排行") }
        }
        Text(if (scope == "community") "所有用户的汇总收听排行，不展示其他账号信息。" else "仅依据本账号收听记录。", style = MaterialTheme.typography.bodySmall)
        ActionStatus(action)
        ranking?.let { page ->
            Row { Button({ vm.play(page.items.map { it.track }) }, enabled = page.items.isNotEmpty()) { Text("播放排行") }
                Text("前 ${page.items.size} 首", Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall) }
            LazyColumn(Modifier.weight(1f)) {
                items(page.items, key = { it.track.id }) { item -> ListItem(headlineContent = { Text(item.track.title) }, supportingContent = { Text("${item.track.artist} · ${item.playCount} 次 · ${item.listenedMs / 60000} 分钟") }, leadingContent = { Text(item.rank.toString()) }, modifier = Modifier.clickable { vm.play(page.items.map { it.track }, page.items.indexOf(item)) }) }
                if (page.items.isEmpty()) item { Text("还没有收听记录。", Modifier.padding(16.dp)) }
            }
        }
    }
}

@Composable internal fun SimpleRecommendationChoice(options: List<Pair<String, String>>, selected: String, choose: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box { TextButton({ open = true }) { Text(options.firstOrNull { it.first == selected }?.second ?: selected); Icon(Icons.Default.ArrowDropDown, null) }
        DropdownMenu(open, { open = false }) { options.forEach { (id, title) -> DropdownMenuItem(text = { Text(title) }, onClick = { choose(id); open = false }) } }
    }
}
