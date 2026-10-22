@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

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
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

internal val recommendationSourceLabels = linkedMapOf("personal" to "我常听", "community" to "大家常听", "discovery" to "本地探索", "revisit" to "很久没听",
    "lastfm_similar" to "Last.fm 相似", "lastfm_charts" to "Last.fm 公共榜单", "lastfm_tags" to "Last.fm 公共标签")
internal fun recommendationSource(id: String): String = recommendationSourceLabels[id] ?: if (id == "ai") "AI" else id
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

@Composable internal fun DailyPanel(vm: MusicViewModel) {
    val current by vm.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    var daily by remember { mutableStateOf<DailyRecommendations?>(null) }
    var preferences by remember { mutableStateOf<RecommendationPreferences?>(null) }
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var connectionsError by remember { mutableStateOf<String?>(null) }
    var settings by remember { mutableStateOf(false) }; var rankings by remember { mutableStateOf(false) }; var external by remember { mutableStateOf(false) }
    var rejected by remember { mutableStateOf(setOf<String>()) }
    var evidence by remember { mutableStateOf(false) }
    var trackMenu by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        action.run {
            preferences = vm.repository.api().recommendationPreferences()
            try { connections = vm.agent.all("connections") } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { connectionsError = friendlyError(error) }
            daily = vm.repository.agentApi().daily()
        }
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
    LazyColumn(Modifier.fillMaxSize().testTag("daily-recommendations"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("属于你的每日推荐", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                IconButton({ action.message = null; settings = true }, enabled = preferences != null, modifier = Modifier.testTag("recommendation-settings")) { Icon(Icons.Default.Tune, "推荐设置") }
            }
            Text("${entries.size} 首 · 今日的临时歌单", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row {
                TextButton({ scope.launch { action.run { daily = vm.repository.agentApi().refreshDaily(); rejected = emptySet() } } }, enabled = !action.busy) { Text(if (action.busy) "正在生成…" else "换一批") }
                TextButton({ rankings = true }) { Text("收听排行") }
                TextButton({ external = true }) { Text("发现新音乐") }
            }
            ActionStatus(action)
            TextButton({ evidence = !evidence }) { Text(if (evidence) "收起推荐依据" else "推荐依据") }
            if (evidence) daily?.let { RecommendationEvidence(it.sourceStatus, it.warnings, it.degraded, it.engine) }
        }
        item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button({ vm.play(entries.map { it.track }); entries.firstOrNull()?.let { first -> scope.launch { runCatching { vm.repository.feedback(RecommendationFeedback(trackId = first.track.id, action = "accept")).close() } } } }, enabled = entries.isNotEmpty()) { Text("播放推荐") }
            TextButton({ scope.launch { action.run { saveRecommendations(vm, "每日推荐 ${daily?.date.orEmpty()}", entries); action.message = "已保存为歌单" } } }, enabled = !action.busy && entries.isNotEmpty()) { Text("保存歌单") }
        } }
        items(entries, key = { it.track.id }) { item ->
            val active = current.current?.id == item.track.id
            Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).testTag("daily-track-${item.track.id}")
                .clip(RoundedCornerShape(10.dp))
                .background(if (active) MaterialTheme.colorScheme.primary.copy(alpha = .08f) else androidx.compose.ui.graphics.Color.Transparent)
                .semantics { selected = active }
                .combinedClickable(onClick = { vm.play(entries.map { it.track }, entries.indexOf(item)) }, onLongClick = { trackMenu = item.track.id }),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.width(24.dp), contentAlignment = Alignment.Center) {
                    if (active) PlaybackIndicator(current.playing, current.buffering)
                    else Text((entries.indexOf(item) + 1).toString().padStart(2, '0'), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Cover(vm, item.track.id.takeIf { item.track.hasCover }, item.track.title, Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(item.track.title, color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
                    Text(listOfNotNull(item.track.artist, item.track.album?.takeIf(String::isNotBlank)).joinToString(" · "),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Box {
                    IconButton({ trackMenu = item.track.id }, Modifier.testTag("daily-more-${item.track.id}")) { Icon(Icons.Default.MoreVert, "${item.track.title}的更多操作") }
                    DropdownMenu(trackMenu == item.track.id, { trackMenu = null }) {
                    DropdownMenuItem(text = { Text(if (vm.repository.knownTracks[item.track.id]?.loved ?: item.track.loved) "取消收藏" else "收藏") },
                        leadingIcon = { Icon(Icons.Default.FavoriteBorder, null) }, enabled = item.track.id !in current.pendingFavorites,
                        onClick = { trackMenu = null; vm.favorite(item.track) })
                    listOf("dismiss_track" to "不感兴趣", "less_artist" to "少推荐此艺人").forEach { (key, name) ->
                        DropdownMenuItem(text = { Text(name) }, leadingIcon = { Icon(if (key == "dismiss_track") Icons.Default.DoNotDisturb else Icons.Default.PersonOff, null) },
                            onClick = { trackMenu = null; scope.launch { action.run { vm.repository.feedback(RecommendationFeedback(trackId = item.track.id, action = key)).close(); rejected = rejected + item.track.id } } }, enabled = !action.busy)
                    }
                    }
                }
            }
        }
        if (entries.isEmpty() && !action.busy) item { Text("暂无推荐，可增加曲库或调整偏好后换一批。") }
    }
    if (settings) preferences?.let { original -> RecommendationSettings(original, connections, connectionsError, action.busy, action.message, { settings = false }) { updated ->
        scope.launch { action.run { preferences = vm.repository.api().saveRecommendationPreferences(updated); settings = false; action.message = "偏好已保存，下次换一批生效" } }
    } }
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
            recommendationSourceLabels.forEach { (id, name) -> Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(id in value.sources, { checked -> value = value.copy(sources = if (checked) (value.sources + id).distinct() else value.sources - id) }, modifier = Modifier.testTag("recommendation-source-$id"))
                Text(name, Modifier.weight(1f))
            } }
            if ("lastfm_tags" in value.sources) OutlinedTextField(tags, { tags = it.take(200) }, label = { Text("公共标签（逗号分隔，最多 3 个）") }, modifier = Modifier.fillMaxWidth())
            Text("每日定时生成", style = MaterialTheme.typography.titleSmall)
            Row(verticalAlignment = Alignment.CenterVertically) {
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
