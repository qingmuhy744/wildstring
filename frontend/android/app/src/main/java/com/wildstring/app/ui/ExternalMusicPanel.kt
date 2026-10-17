@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val externalSourceLabels = linkedMapOf("lastfm_similar" to "Last.fm 相似歌曲", "lastfm_charts" to "Last.fm 公共榜单", "lastfm_tags" to "Last.fm 公共标签", "lastfm_artists" to "Last.fm 相似艺人")
private fun musicDate(value: String?): String? = value?.let { runCatching { DateTimeFormatter.ofPattern("M月d日 HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(it)) }.getOrNull() }
internal fun musicSourceUrl(value: String?): String? = value?.takeIf {
    runCatching { val uri = java.net.URI(it); uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null }.getOrDefault(false)
}

@Composable internal fun ExternalMusicPanel(vm: MusicViewModel, back: (() -> Unit)? = null) {
    var result by remember { mutableStateOf<ExternalMusicResult?>(null) }; var preferences by remember { mutableStateOf<RecommendationPreferences?>(null) }
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var connectionsError by remember { mutableStateOf<String?>(null) }
    var settings by remember { mutableStateOf(false) }; var wantedOnly by remember { mutableStateOf(false) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current; val links = LocalUriHandler.current
    LaunchedEffect(Unit) {
        action.run {
            preferences = vm.repository.api().recommendationPreferences()
            try { connections = vm.agent.all("connections") } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { connectionsError = friendlyError(error) }
            result = vm.repository.agentApi().externalMusic()
        }
        if (action.message == "已完成") action.message = null
    }
    val entries = result?.items.orEmpty().filter { !wantedOnly || it.wanted }
    LazyColumn(Modifier.fillMaxSize().testTag("external-music"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            back?.let { TextButton(it) { Text("返回每日推荐") } }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("下一首，去发现。", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                IconButton({ action.message = null; settings = true }, enabled = preferences != null, modifier = Modifier.testTag("external-music-settings")) { Icon(Icons.Default.Tune, "新音乐设置") }
            }
            Text("从真实外部资料发现你可能想收藏的音乐。新发现不代表刚发行；你可以自行寻找并下载，放入导入目录。", style = MaterialTheme.typography.bodySmall)
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton({ scope.launch { action.run { result = vm.repository.agentApi().refreshExternalMusic() } } }, enabled = !action.busy && preferences?.externalEnabled == true) { Text(if (action.busy) "正在发现…" else "换一批") }
                FilterChip(wantedOnly, { wantedOnly = !wantedOnly }, label = { Text("想听") })
            }
            ActionStatus(action)
            result?.let { page ->
                musicDate(page.generatedAt)?.let { Text("更新于 $it${if (page.cached) " · 缓存" else ""}", style = MaterialTheme.typography.labelSmall) }
                musicDate(page.nextRefreshAt)?.let { Text("下次更新 $it", style = MaterialTheme.typography.labelSmall) }
                if (page.stale) Text("本次联网未完成，继续展示上次结果。", style = MaterialTheme.typography.bodySmall)
                page.sourceStatus.filter { it.status != "disabled" }.forEach { source -> Text("${externalSourceLabels[source.id] ?: recommendationSource(source.id)} · ${if (source.status == "ok") "${source.candidateCount} 条资料 · ${source.matched} 首在库" else if (source.status == "empty") "暂无资料" else "暂不可用"}", style = MaterialTheme.typography.bodySmall) }
                page.warnings.forEach { warning -> Text("${externalSourceLabels[warning.source] ?: recommendationSource(warning.source)}：${recommendationIssue(warning.code)}", style = MaterialTheme.typography.bodySmall) }
            }
        }
        items(entries, key = { it.externalId }) { item ->
            OutlinedCard(Modifier.fillMaxWidth().testTag("external-item-${item.externalId}")) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(item.name, style = MaterialTheme.typography.titleMedium)
                    Text(item.artists.joinToString(" / "), style = MaterialTheme.typography.bodyMedium)
                    item.album?.takeIf(String::isNotBlank)?.let { Text("专辑 · $it", style = MaterialTheme.typography.bodySmall) }
                    Text(item.reason, style = MaterialTheme.typography.bodySmall)
                    item.evidence.forEach { Text("${externalSourceLabels[it.source] ?: recommendationSource(it.source)} · ${it.summary}", style = MaterialTheme.typography.labelSmall) }
                    Text(if (item.localTrack == null) "库外音乐 · 需自行获取后导入" else "已在曲库", style = MaterialTheme.typography.labelMedium)
                    Row {
                        TextButton({ clipboard.setText(AnnotatedString(item.artists.joinToString(" / ") + " - " + item.name)); action.message = "已复制艺人和歌名" }) { Text("复制歌名") }
                        musicSourceUrl(item.sourceUrl)?.let { url -> TextButton({ runCatching { links.openUri(url) }.onFailure { action.message = "无法打开来源，请稍后重试。" } }) { Text("查看来源") } }
                        item.localTrack?.let { track -> TextButton({ vm.play(listOf(track)) }) { Text("播放") } }
                    }
                    Row {
                        TextButton({ scope.launch { action.run { vm.repository.agentApi().externalMusicFeedback(ExternalMusicFeedback(item.externalId, if (item.wanted) "clear" else "want")); result = vm.repository.agentApi().externalMusic(); action.message = if (item.wanted) "已取消想听" else "已加入想听" } } }, enabled = !action.busy) { Icon(if (item.wanted) Icons.Default.Bookmark else Icons.Default.BookmarkBorder, null); Text(if (item.wanted) "已想听" else "想听") }
                        TextButton({ scope.launch { action.run { vm.repository.agentApi().externalMusicFeedback(ExternalMusicFeedback(item.externalId, "dismiss")); result = vm.repository.agentApi().externalMusic(); action.message = "已移除此建议" } } }, enabled = !action.busy) { Text("不感兴趣") }
                    }
                }
            }
        }
        if (entries.isEmpty() && !action.busy) item { Text(when {
            wantedOnly -> "点“想听”保留想要寻找的音乐。"
            result?.status == "disabled" -> "尚未开启，进入新音乐设置选择来源和更新频率。"
            result?.status == "unavailable" -> "外部资料暂不可用，请检查联网设置后重试。"
            else -> "暂无新发现，可调整来源或手动换一批。"
        }, Modifier.padding(vertical = 16.dp)) }
    }
    if (settings) preferences?.let { original -> ExternalMusicSettings(original, connections, connectionsError, action.busy, action.message, { settings = false }) { updated -> scope.launch { action.run {
        preferences = vm.repository.api().saveRecommendationPreferences(updated); settings = false
        result = vm.repository.agentApi().externalMusic(); action.message = "新音乐设置已保存"
    } } } }
}

@Composable private fun ExternalMusicSettings(original: RecommendationPreferences, connections: List<JsonObject>, connectionError: String?, busy: Boolean, message: String?, dismiss: () -> Unit, save: (RecommendationPreferences) -> Unit) {
    var value by remember { mutableStateOf(original) }; var tags by remember { mutableStateOf(original.lastfmTags.joinToString(", ")) }
    AlertDialog(onDismissRequest = dismiss, title = { Text("新音乐设置") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            Row(verticalAlignment = Alignment.CenterVertically) { Text("启用外部音乐发现", Modifier.weight(1f)); Switch(value.externalEnabled, { value = value.copy(externalEnabled = it) }) }
            Text("只提供资料与收藏建议，不下载、不改动音乐文件。", style = MaterialTheme.typography.bodySmall)
            Text("更新频率", style = MaterialTheme.typography.titleSmall)
            Text("到期后下次打开时更新，也可手动换一批。", style = MaterialTheme.typography.bodySmall)
            SimpleRecommendationChoice(listOf("0" to "仅手动", "1" to "每天", "3" to "每 3 天", "7" to "每 7 天（推荐）", "14" to "每 14 天", "30" to "每 30 天"), value.externalRefreshDays.toString()) { value = value.copy(externalRefreshDays = it.toInt()) }
            externalSourceLabels.forEach { (id, name) -> Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(id in value.externalSources, { checked -> value = value.copy(externalSources = if (checked) (value.externalSources + id).distinct() else value.externalSources - id) })
                Text(name)
            } }
            if ("lastfm_tags" in value.externalSources) OutlinedTextField(tags, { tags = it.take(200) }, label = { Text("公共标签（逗号分隔，最多 3 个）") }, modifier = Modifier.fillMaxWidth())
            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(value.externalUseAi, { value = value.copy(externalUseAi = it) }); Text("AI 结合我的收听信息编排") }
            if (value.externalUseAi) {
                AgentConnectionChoice(connections, value.connectionId.takeUnless { it == "local" }) { value = value.copy(connectionId = it ?: "local") }
                Text("与每日推荐、助手共用连接和每日预算，使用 AI 需明确选择连接。", style = MaterialTheme.typography.bodySmall)
                connectionError?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }, confirmButton = { TextButton({ save(value.copy(lastfmTags = tags.split(',', '，').map(String::trim).filter(String::isNotBlank).distinct().take(3))) }, enabled = !busy && (!value.externalEnabled || value.externalSources.isNotEmpty())) { Text("保存设置") } }, dismissButton = { TextButton(dismiss) { Text("取消") } })
}
