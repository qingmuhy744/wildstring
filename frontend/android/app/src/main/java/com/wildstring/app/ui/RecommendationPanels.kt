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
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter

internal val recommendationSourceLabels = linkedMapOf("personal" to R.string.recommendation_source_personal, "community" to R.string.recommendation_source_community,
    "discovery" to R.string.recommendation_source_discovery, "revisit" to R.string.recommendation_source_revisit,
    "lastfm_similar" to R.string.recommendation_source_lastfm_similar, "lastfm_charts" to R.string.recommendation_source_lastfm_charts, "lastfm_tags" to R.string.recommendation_source_lastfm_tags)
internal fun localizeDiscoveryTitle(title: String): String = when (title) {
    "曲库里的发现" -> AppLanguage.string(R.string.rec_panel_discover_title_library)
    "为你选的歌" -> AppLanguage.string(R.string.rec_panel_discover_title_for_you)
    "曲库中没有可推荐的歌曲" -> AppLanguage.string(R.string.rec_panel_discover_title_empty)
    else -> title
}
internal fun localizeRecommendationReason(reason: String): String = when (reason) {
    "来自你的收藏" -> AppLanguage.string(R.string.rec_panel_reason_favorite)
    "根据你之前的收听反馈" -> AppLanguage.string(R.string.rec_panel_reason_feedback)
    "来自你听过或收藏的艺人" -> AppLanguage.string(R.string.rec_panel_reason_artist)
    "重听曲库里的熟悉旋律" -> AppLanguage.string(R.string.rec_panel_reason_familiar)
    "探索曲库中尚未听过的歌曲", "探索本曲库中你尚未听过的歌曲" -> AppLanguage.string(R.string.rec_panel_reason_unplayed)
    "来自曲库用户近30天的实际收听热度" -> AppLanguage.string(R.string.rec_panel_reason_community_30d)
    "你已超过30天没有重听这首歌" -> AppLanguage.string(R.string.rec_panel_reason_revisit_30d)
    "Last.fm 公共来源中找到与本库标题、艺人一致的歌曲" -> AppLanguage.string(R.string.rec_panel_reason_lastfm_public)
    "根据你听过或收藏歌曲的 Last.fm 相似关系，在本地曲库找到" -> AppLanguage.string(R.string.rec_panel_reason_lastfm_similar)
    "从本地曲库中选取" -> AppLanguage.string(R.string.rec_panel_reason_local_pick)
    else -> reason
}
@Composable internal fun recommendationSource(id: String): String = recommendationSourceLabels[id]?.let { stringResource(it) } ?: if (id == "ai") "AI" else id
internal fun recommendationIssue(code: String): String = when {
    code.contains("budget") -> AppLanguage.string(R.string.rec_panel_issue_budget)
    code.contains("connection") || code.contains("not_found") -> AppLanguage.string(R.string.rec_panel_issue_connection)
    code.contains("unavailable") || code.contains("failed") || code.contains("timeout") -> AppLanguage.string(R.string.rec_panel_issue_unavailable)
    code.contains("disabled") || code.contains("not_configured") -> AppLanguage.string(R.string.rec_panel_issue_disabled)
    code.contains("empty") || code.contains("no_match") -> AppLanguage.string(R.string.rec_panel_issue_empty)
    else -> AppLanguage.string(R.string.rec_panel_issue_default)
}

@Composable private fun RecommendationEvidence(statuses: List<RecommendationSourceStatus>, warnings: List<RecommendationWarning>, degraded: Boolean, engine: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(if (engine == "ai") stringResource(R.string.rec_panel_evidence_engine_ai) else stringResource(R.string.rec_panel_evidence_engine_local), style = MaterialTheme.typography.labelMedium)
        statuses.filter { it.status != "disabled" }.forEach { source ->
            val status = when (source.status) { "ok" -> stringResource(R.string.rec_panel_evidence_status_matched, source.matched); "empty" -> stringResource(R.string.rec_panel_evidence_status_empty); else -> stringResource(R.string.rec_panel_evidence_status_unavailable) }
            Text("${recommendationSource(source.id)} · $status${if (source.cached) stringResource(R.string.rec_panel_evidence_cached_suffix) else ""}", style = MaterialTheme.typography.bodySmall)
        }
        if (degraded && warnings.isEmpty()) Text(stringResource(R.string.rec_panel_evidence_degraded_hint), style = MaterialTheme.typography.bodySmall)
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
    // Bumped by refresh so a slower background load cannot replace the batch the user just asked for.
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
        if (action.message == DONE_STATUS) action.message = null
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
                                DropdownMenuItem(text = { Text(stringResource(R.string.discover_new_music)) }, leadingIcon = { Icon(Icons.Default.Public, null) }, onClick = { panelMenu = false; external = true }, modifier = Modifier.testTag("daily-external"))
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
                Cover(vm, track.coverId, track.title, Modifier.size(48.dp).clip(RoundedCornerShape(8.dp)))
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
        scope.launch { action.run { preferences = vm.repository.api().saveRecommendationPreferences(updated); settings = false; action.message = AppLanguage.string(R.string.rec_panel_prefs_saved) } }
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
        if (tracks.size < 4) tracks.firstOrNull()?.let { Cover(vm, it.coverId, it.title, Modifier.fillMaxSize()) }
        else Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            tracks.chunked(2).forEach { row ->
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    row.forEach { Cover(vm, it.coverId, it.title, Modifier.weight(1f).fillMaxHeight()) }
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
    AlertDialog(onDismissRequest = dismiss, title = { Text(stringResource(R.string.rec_panel_settings_title)) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            Text(stringResource(R.string.rec_panel_settings_hint), style = MaterialTheme.typography.bodySmall)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.rec_panel_daily_count, value.count), Modifier.weight(1f))
                IconButton({ value = value.copy(count = (value.count - 5).coerceAtLeast(1)) }) { Icon(Icons.Default.Remove, stringResource(R.string.rec_panel_decrease_count)) }
                IconButton({ value = value.copy(count = (value.count + 5).coerceAtMost(50)) }) { Icon(Icons.Default.Add, stringResource(R.string.rec_panel_increase_count)) }
            }
            Text(stringResource(R.string.rec_panel_sources_title), style = MaterialTheme.typography.titleSmall)
            recommendationSourceLabels.forEach { (id, name) ->
                val checked = id in value.sources
                val toggle = { next: Boolean -> value = value.copy(sources = if (next) (value.sources + id).distinct() else value.sources - id) }
                Row(Modifier.fillMaxWidth().clickable { toggle(!checked) }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked, toggle, modifier = Modifier.testTag("recommendation-source-$id"))
                    Text(stringResource(name), Modifier.weight(1f))
                }
            }
            if ("lastfm_tags" in value.sources) OutlinedTextField(tags, { tags = it.take(200) }, label = { Text(stringResource(R.string.rec_panel_public_tags_label)) }, modifier = Modifier.fillMaxWidth())
            Text(stringResource(R.string.rec_panel_daily_schedule_title), style = MaterialTheme.typography.titleSmall)
            Row(Modifier.fillMaxWidth().clickable { value = value.copy(dailyEnabled = !value.dailyEnabled) }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(value.dailyEnabled, { checked -> value = value.copy(dailyEnabled = checked) })
                Text(stringResource(R.string.rec_panel_daily_schedule_label), Modifier.weight(1f))
            }
            if (value.dailyEnabled) {
                OutlinedTextField(
                    value.dailyTime,
                    { input ->
                        val clean = input.filter { it.isDigit() || it == ':' }.take(5)
                        value = value.copy(dailyTime = clean)
                    },
                    label = { Text(stringResource(R.string.rec_panel_daily_time_label)) },
                    placeholder = { Text("00:00") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
            Text(stringResource(R.string.rec_panel_ai_curation_title), style = MaterialTheme.typography.titleSmall)
            AgentConnectionChoice(connections, value.connectionId.takeUnless { it == "local" }) { selected -> value = value.copy(connectionId = selected ?: "local", useAi = selected != null) }
            error?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }, confirmButton = { TextButton({ save(value.copy(useAi = value.connectionId != "local", useLastfm = value.sources.any { it.startsWith("lastfm_") }, lastfmTags = tags.split(',', '，').map(String::trim).filter(String::isNotBlank).distinct().take(3))) }, enabled = !busy && value.sources.isNotEmpty()) { Text(stringResource(R.string.rec_panel_save_preferences)) } }, dismissButton = { TextButton(dismiss) { Text(stringResource(R.string.rec_panel_cancel)) } })
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
        OutlinedTextField(prompt, { prompt = it.take(2000) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.rec_panel_ai_prompt_label)) }, placeholder = { Text(stringResource(R.string.rec_panel_ai_prompt_placeholder)) }, minLines = 2)
        Button({ keyboard?.hide(); scope.launch { action.run { result = vm.repository.agentApi().discover(DiscoveryRequest(prompt, connectionId = connection ?: "local")); draftName = localizeDiscoveryTitle(result!!.title); excluded = emptySet(); action.message = if (result?.mode == "local") AppLanguage.string(R.string.rec_panel_ai_local_search) else AppLanguage.string(R.string.rec_panel_ai_candidates_ready) } } }, enabled = !action.busy && prompt.isNotBlank()) { Text(if (action.busy) stringResource(R.string.rec_panel_ai_finding_music) else stringResource(R.string.rec_panel_ai_generate_candidates)) }
        ActionStatus(action)
        result?.let { draft ->
            val selected = draft.items.filter { it.track.id !in excluded }
            OutlinedTextField(draftName, { draftName = it.take(100) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.rec_panel_playlist_name_label)) }, singleLine = true)
            RecommendationEvidence(draft.sourceStatus, draft.warnings, draft.degraded, draft.mode)
            if (draft.warning != null && draft.warnings.isEmpty()) Text(recommendationIssue(draft.warning), style = MaterialTheme.typography.bodySmall)
            Row {
                TextButton({ vm.play(selected.map { it.track }) }, enabled = selected.isNotEmpty()) { Text(stringResource(R.string.rec_panel_preview_candidates)) }
                TextButton({ scope.launch { action.run { saveRecommendations(vm, draftName, selected); action.message = AppLanguage.string(R.string.rec_panel_playlist_saved) } } }, enabled = !action.busy && selected.isNotEmpty() && draftName.isNotBlank()) { Text(stringResource(R.string.rec_panel_confirm_save_playlist)) }
            }
            LazyColumn(Modifier.weight(1f)) { items(draft.items, key = { it.track.id }) { item -> ListItem(headlineContent = { Text(item.track.title) }, supportingContent = { Text(item.track.artist + " · " + localizeRecommendationReason(item.reason)) }, leadingContent = { Checkbox(item.track.id !in excluded, { checked -> excluded = if (checked) excluded - item.track.id else excluded + item.track.id }) }) } }
        }
    }
}

@Composable internal fun RankingsPanel(vm: MusicViewModel, back: (() -> Unit)? = null) {
    var scope by remember { mutableStateOf("personal") }; var period by remember { mutableStateOf("30d") }; var metric by remember { mutableStateOf("plays") }
    var ranking by remember { mutableStateOf<ListeningRankings?>(null) }; val action = remember { FeatureAction() }; val coroutine = rememberCoroutineScope()
    suspend fun load() { ranking = vm.repository.api().listeningRankings(scope, period, metric) }
    LaunchedEffect(scope, period, metric) { action.run { ranking = null; load() }; if (action.message == DONE_STATUS) action.message = null }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("listening-rankings")) {
        back?.let { TextButton(it) { Text(stringResource(R.string.rec_panel_back_daily_rec)) } }
        PrimaryTabRow(if (scope == "personal") 0 else 1) { listOf("personal" to stringResource(R.string.rec_panel_ranking_personal), "community" to stringResource(R.string.rec_panel_ranking_community)).forEach { (id, label) -> Tab(scope == id, { scope = id }, text = { Text(label) }) } }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            SimpleRecommendationChoice(listOf("7d" to stringResource(R.string.rec_panel_ranking_7d), "30d" to stringResource(R.string.rec_panel_ranking_30d), "90d" to stringResource(R.string.rec_panel_ranking_90d), "all" to stringResource(R.string.rec_panel_ranking_all)), period) { period = it }
            SimpleRecommendationChoice(listOf("plays" to stringResource(R.string.rec_panel_metric_plays), "listened_ms" to stringResource(R.string.rec_panel_metric_duration)), metric) { metric = it }
            IconButton({ coroutine.launch { action.run { load() } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, stringResource(R.string.rec_panel_refresh_rankings)) }
        }
        Text(if (scope == "community") stringResource(R.string.rec_panel_rankings_community_hint) else stringResource(R.string.rec_panel_rankings_personal_hint), style = MaterialTheme.typography.bodySmall)
        ActionStatus(action)
        ranking?.let { page ->
            Row { Button({ vm.play(page.items.map { it.track }) }, enabled = page.items.isNotEmpty()) { Text(stringResource(R.string.rec_panel_play_rankings)) }
                Text(stringResource(R.string.rec_panel_top_count, page.items.size), Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall) }
            LazyColumn(Modifier.weight(1f)) {
                items(page.items, key = { it.track.id }) { item -> ListItem(headlineContent = { Text(item.track.title) }, supportingContent = { Text(stringResource(R.string.rec_panel_track_ranking_summary, item.track.artist, item.playCount, item.listenedMs / 60000)) }, leadingContent = { Text(item.rank.toString()) }, modifier = Modifier.clickable { vm.play(page.items.map { it.track }, page.items.indexOf(item)) }) }
                if (page.items.isEmpty()) item { Text(stringResource(R.string.rec_panel_no_listening_records), Modifier.padding(16.dp)) }
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
