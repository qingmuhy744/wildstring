@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.compose.ui.res.stringResource
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private fun externalSourceLabels(): Map<String, String> = linkedMapOf(
    "lastfm_similar" to AppLanguage.string(R.string.ext_music_src_lastfm_similar),
    "lastfm_charts" to AppLanguage.string(R.string.ext_music_src_lastfm_charts),
    "lastfm_tags" to AppLanguage.string(R.string.ext_music_src_lastfm_tags),
    "lastfm_artists" to AppLanguage.string(R.string.ext_music_src_lastfm_artists)
)
private fun musicDate(value: String?): String? = value?.let { runCatching { DateTimeFormatter.ofPattern(AppLanguage.string(R.string.ext_music_date_format), java.util.Locale.getDefault()).withZone(ZoneId.systemDefault()).format(Instant.parse(it)) }.getOrNull() }
internal fun musicSourceUrl(value: String?): String? = value?.takeIf {
    runCatching { val uri = java.net.URI(it); uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null }.getOrDefault(false)
}

@Composable internal fun ExternalMusicPanel(vm: MusicViewModel, back: (() -> Unit)? = null) {
    var result by remember { mutableStateOf<ExternalMusicResult?>(null) }; var preferences by remember { mutableStateOf<RecommendationPreferences?>(null) }
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var connectionsError by remember { mutableStateOf<String?>(null) }
    var settings by remember { mutableStateOf(false) }; var wantedOnly by remember { mutableStateOf(false) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val clipboard = remember(context) { context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager }
    val links = LocalUriHandler.current
    LaunchedEffect(Unit) {
        action.run {
            preferences = vm.repository.api().recommendationPreferences()
            try { connections = vm.agent.all("connections") } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { connectionsError = friendlyError(error) }
            result = vm.repository.agentApi().externalMusic()
        }
        if (action.message == DONE_STATUS) action.message = null
    }
    val entries = result?.items.orEmpty().filter { !wantedOnly || it.wanted }
    LazyColumn(Modifier.fillMaxSize().testTag("external-music"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            back?.let { TextButton(it) { Text(stringResource(R.string.ext_music_back_daily_rec)) } }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.ext_music_title), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                IconButton({ action.message = null; settings = true }, enabled = preferences != null, modifier = Modifier.testTag("external-music-settings")) { Icon(Icons.Default.Tune, stringResource(R.string.ext_music_settings_icon)) }
            }
            Text(stringResource(R.string.ext_music_description), style = MaterialTheme.typography.bodySmall)
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton({ scope.launch { action.run { result = vm.repository.agentApi().refreshExternalMusic() } } }, enabled = !action.busy && preferences?.externalEnabled == true) { Text(if (action.busy) stringResource(R.string.ext_music_discovering) else stringResource(R.string.ext_music_refresh_batch)) }
                FilterChip(wantedOnly, { wantedOnly = !wantedOnly }, label = { Text(stringResource(R.string.ext_music_want_to_listen)) })
            }
            ActionStatus(action)
            result?.let { page ->
                musicDate(page.generatedAt)?.let { Text(stringResource(R.string.ext_music_updated_at, it) + if (page.cached) stringResource(R.string.ext_music_cached_suffix) else "", style = MaterialTheme.typography.labelSmall) }
                musicDate(page.nextRefreshAt)?.let { Text(stringResource(R.string.ext_music_next_update, it), style = MaterialTheme.typography.labelSmall) }
                if (page.stale) Text(stringResource(R.string.ext_music_stale_hint), style = MaterialTheme.typography.bodySmall)
                page.sourceStatus.filter { it.status != "disabled" }.forEach { source -> Text("${externalSourceLabels()[source.id] ?: recommendationSource(source.id)} · ${if (source.status == "ok") stringResource(R.string.ext_music_source_ok, source.candidateCount, source.matched) else if (source.status == "empty") stringResource(R.string.ext_music_source_empty) else stringResource(R.string.ext_music_source_unavailable)}", style = MaterialTheme.typography.bodySmall) }
                page.warnings.forEach { warning -> Text("${externalSourceLabels()[warning.source] ?: recommendationSource(warning.source)}：${recommendationIssue(warning.code)}", style = MaterialTheme.typography.bodySmall) }
            }
        }
        items(entries, key = { it.externalId }) { item ->
            OutlinedCard(Modifier.fillMaxWidth().testTag("external-item-${item.externalId}")) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(item.name, style = MaterialTheme.typography.titleMedium)
                    Text(item.artists.joinToString(" / "), style = MaterialTheme.typography.bodyMedium)
                    item.album?.takeIf(String::isNotBlank)?.let { Text(stringResource(R.string.ext_music_album_prefix, it), style = MaterialTheme.typography.bodySmall) }
                    Text(item.reason, style = MaterialTheme.typography.bodySmall)
                    item.evidence.forEach { Text("${externalSourceLabels()[it.source] ?: recommendationSource(it.source)} · ${it.summary}", style = MaterialTheme.typography.labelSmall) }
                    Text(if (item.localTrack == null) stringResource(R.string.ext_music_external_unimported) else stringResource(R.string.ext_music_in_library), style = MaterialTheme.typography.labelMedium)
                    Row {
                        TextButton({ clipboard?.setPrimaryClip(ClipData.newPlainText("track", item.artists.joinToString(" / ") + " - " + item.name)); action.message = AppLanguage.string(R.string.ext_music_copied_artist_title) }) { Text(stringResource(R.string.ext_music_copy_title)) }
                        musicSourceUrl(item.sourceUrl)?.let { url -> TextButton({ runCatching { links.openUri(url) }.onFailure { action.message = AppLanguage.string(R.string.ext_music_cannot_open_source) } }) { Text(stringResource(R.string.ext_music_view_source)) } }
                        item.localTrack?.let { track -> TextButton({ vm.play(listOf(track)) }) { Text(stringResource(R.string.ext_music_play)) } }
                    }
                    Row {
                        TextButton({ scope.launch { action.run { vm.repository.agentApi().externalMusicFeedback(ExternalMusicFeedback(item.externalId, if (item.wanted) "clear" else "want")); result = vm.repository.agentApi().externalMusic(); action.message = if (item.wanted) AppLanguage.string(R.string.ext_music_cancelled_want) else AppLanguage.string(R.string.ext_music_added_want) } } }, enabled = !action.busy) { Icon(if (item.wanted) Icons.Default.Bookmark else Icons.Default.BookmarkBorder, null); Text(if (item.wanted) stringResource(R.string.ext_music_already_wanted) else stringResource(R.string.ext_music_want)) }
                        TextButton({ scope.launch { action.run { vm.repository.agentApi().externalMusicFeedback(ExternalMusicFeedback(item.externalId, "dismiss")); result = vm.repository.agentApi().externalMusic(); action.message = AppLanguage.string(R.string.ext_music_suggestion_dismissed) } } }, enabled = !action.busy) { Text(stringResource(R.string.ext_music_not_interested)) }
                    }
                }
            }
        }
        if (entries.isEmpty() && !action.busy) item { Text(when {
            wantedOnly -> stringResource(R.string.ext_music_empty_wanted)
            result?.status == "disabled" -> stringResource(R.string.ext_music_empty_disabled)
            result?.status == "unavailable" -> stringResource(R.string.ext_music_empty_unavailable)
            else -> stringResource(R.string.ext_music_empty_default)
        }, Modifier.padding(vertical = 16.dp)) }
    }
    if (settings) preferences?.let { original -> ExternalMusicSettings(original, connections, connectionsError, action.busy, action.message, { settings = false }) { updated -> scope.launch { action.run {
        preferences = vm.repository.api().saveRecommendationPreferences(updated); settings = false
        result = vm.repository.agentApi().externalMusic(); action.message = AppLanguage.string(R.string.ext_music_settings_saved)
    } } } }
}

@Composable private fun ExternalMusicSettings(original: RecommendationPreferences, connections: List<JsonObject>, connectionError: String?, busy: Boolean, message: String?, dismiss: () -> Unit, save: (RecommendationPreferences) -> Unit) {
    var value by remember { mutableStateOf(original) }; var tags by remember { mutableStateOf(original.lastfmTags.joinToString(", ")) }
    AlertDialog(onDismissRequest = dismiss, title = { Text(stringResource(R.string.ext_music_settings_dialog_title)) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            Row(verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.ext_music_enable_discovery), Modifier.weight(1f)); Switch(value.externalEnabled, { value = value.copy(externalEnabled = it) }) }
            Text(stringResource(R.string.ext_music_enable_discovery_hint), style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.ext_music_refresh_interval_title), style = MaterialTheme.typography.titleSmall)
            Text(stringResource(R.string.ext_music_refresh_interval_hint), style = MaterialTheme.typography.bodySmall)
            SimpleRecommendationChoice(listOf("0" to stringResource(R.string.ext_music_interval_manual), "1" to stringResource(R.string.ext_music_interval_daily), "3" to stringResource(R.string.ext_music_interval_3d), "7" to stringResource(R.string.ext_music_interval_7d), "14" to stringResource(R.string.ext_music_interval_14d), "30" to stringResource(R.string.ext_music_interval_30d)), value.externalRefreshDays.toString()) { value = value.copy(externalRefreshDays = it.toInt()) }
            externalSourceLabels().forEach { (id, name) -> Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(id in value.externalSources, { checked -> value = value.copy(externalSources = if (checked) (value.externalSources + id).distinct() else value.externalSources - id) })
                Text(name)
            } }
            if ("lastfm_tags" in value.externalSources) OutlinedTextField(tags, { tags = it.take(200) }, label = { Text(stringResource(R.string.ext_music_public_tags_label)) }, modifier = Modifier.fillMaxWidth())
            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(value.externalUseAi, { value = value.copy(externalUseAi = it) }); Text(stringResource(R.string.ext_music_ai_curate_label)) }
            if (value.externalUseAi) {
                AgentConnectionChoice(connections, value.connectionId.takeUnless { it == "local" }) { value = value.copy(connectionId = it ?: "local") }
                Text(stringResource(R.string.ext_music_ai_shared_budget_hint), style = MaterialTheme.typography.bodySmall)
                connectionError?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }, confirmButton = { TextButton({ save(value.copy(lastfmTags = tags.split(',', '，').map(String::trim).filter(String::isNotBlank).distinct().take(3))) }, enabled = !busy && (!value.externalEnabled || value.externalSources.isNotEmpty())) { Text(stringResource(R.string.ext_music_save_settings)) } }, dismissButton = { TextButton(dismiss) { Text(stringResource(R.string.ext_music_cancel)) } })
}
