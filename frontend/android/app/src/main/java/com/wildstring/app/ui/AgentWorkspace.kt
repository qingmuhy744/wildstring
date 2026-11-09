@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.compose.animation.core.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.PlaylistAdd
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.FactCheck
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.gson.JsonObject
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Same authenticated business API as Web and MCP; approval always previews a concrete version. */
@Composable internal fun AgentWorkspace(vm: MusicViewModel, initialTab: String = "chat", onOpenAction: (String, JsonObject?) -> Unit = { _, _ -> }) {
    val owner by vm.repository.session.profiles.collectAsStateWithLifecycle()
    key(owner) {
        var tab by remember { mutableStateOf(initialTab) }
        var selected by remember { mutableStateOf<String?>(null) }
        val tabs = listOf("chat" to stringResource(R.string.agent_ws_tab_chat), "notifications" to stringResource(R.string.agent_ws_tab_notifications), "drafts" to stringResource(R.string.agent_ws_tab_drafts), "research" to stringResource(R.string.agent_ws_tab_research), "channels" to stringResource(R.string.agent_ws_tab_channels))
        Column(Modifier.fillMaxSize().testTag("agent-workspace")) {
            PrimaryScrollableTabRow(tabs.indexOfFirst { it.first == tab }.coerceAtLeast(0), edgePadding = 8.dp) {
                tabs.forEach { (id, title) -> Tab(tab == id, { tab = id; selected = null }, text = { Text(title) }, modifier = Modifier.testTag("agent-tab-$id")) }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (tab) {
                    "chat" -> AgentChat(vm) { draft -> selected = draft; tab = "drafts" }
                    "notifications" -> AgentNotifications(vm, { type, id -> selected = id; tab = type }, onOpenAction)
                    "drafts" -> AgentDrafts(vm, selected)
                    "tasks", "connections" -> Text(stringResource(R.string.agent_ws_web_manage_hint), Modifier.padding(24.dp))
                    "research" -> AgentResearch(vm)
                    else -> AgentChannels(vm)
                }
            }
        }
    }
}

@Composable private fun AgentError(message: String?) { message?.let { SelectionContainer { Text(it, Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) } } }
private fun JsonObject.showTrace(): Boolean {
    val status = text("status")
    return text("error_code").isNotBlank() || text("severity") in setOf("error", "warning") || status in setOf("failed", "interrupted", "partial", "unknown", "retry_wait")
}
@Composable private fun AgentTrace(value: JsonObject) {
    if (!value.showTrace()) return
    value.text("trace_id").takeIf { it.isNotBlank() }?.let { SelectionContainer { Text(stringResource(R.string.agent_ws_diagnostic_id, it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
}
@Composable private fun AgentEmpty(text: String) { Text(text, Modifier.padding(vertical = 24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
@Composable private fun AgentCard(content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}
private fun taskLabel(status: String): String = mapOf("queued" to AppLanguage.string(R.string.agent_ws_task_status_queued), "running" to AppLanguage.string(R.string.agent_ws_task_status_running), "retry_wait" to AppLanguage.string(R.string.agent_ws_task_status_retry_wait), "paused_authorization" to AppLanguage.string(R.string.agent_ws_task_status_paused_authorization), "paused_budget" to AppLanguage.string(R.string.agent_ws_task_status_paused_budget), "cancel_requested" to AppLanguage.string(R.string.agent_ws_task_status_cancel_requested), "cancelled" to AppLanguage.string(R.string.agent_ws_task_status_cancelled), "succeeded" to AppLanguage.string(R.string.agent_ws_task_status_succeeded), "partial" to AppLanguage.string(R.string.agent_ws_task_status_partial), "failed" to AppLanguage.string(R.string.agent_ws_task_status_failed), "interrupted" to AppLanguage.string(R.string.agent_ws_task_status_interrupted))[status] ?: status
private fun draftLabel(status: String): String = mapOf("pending" to AppLanguage.string(R.string.agent_ws_draft_status_pending), "approved" to AppLanguage.string(R.string.agent_ws_draft_status_approved), "applied" to AppLanguage.string(R.string.agent_ws_draft_status_applied), "rejected" to AppLanguage.string(R.string.agent_ws_draft_status_rejected))[status] ?: status
private fun localAgentTime(value: String): String = runCatching { Instant.parse(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")) }.getOrDefault(value)

@Composable
internal fun SimpleNotificationsSheet(
    vm: MusicViewModel,
    onOpenAction: (String, JsonObject?) -> Unit = { _, _ -> },
) {
    var selectedDraft by remember { mutableStateOf<String?>(null) }
    if (selectedDraft != null) {
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { selectedDraft = null }) { Text(stringResource(R.string.agent_ws_back_to_notifications)) }
            }
            AgentDrafts(vm, selectedDraft)
        }
    } else {
        AgentNotifications(vm, { type, id ->
            if (type == "drafts") selectedDraft = id
        }, onOpenAction)
    }
}

@Composable internal fun AgentNotifications(vm: MusicViewModel, open: (String, String) -> Unit, openAction: (String, JsonObject?) -> Unit) {
    val state by vm.agent.inbox.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    val owner = vm.repository.session.cacheScope()
    val valid = state.owner == owner
    var filter by rememberSaveable { mutableStateOf("unread") }
    val visible = if (!valid) emptyList() else state.items.filter { notice ->
        when (filter) { "unread" -> notice.text("read_at").isBlank(); "read" -> notice.text("read_at").isNotBlank(); else -> true }
    }
    LaunchedEffect(owner) { vm.agent.refreshInbox() }
    Box(Modifier.fillMaxSize()) {
    LazyColumn(Modifier.fillMaxSize().testTag("agent-notifications"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.agent_ws_unread_count, if (valid) state.unread else 0), Modifier.weight(1f), fontWeight = FontWeight.Medium)
                IconButton({ scope.launch { vm.agent.refreshInbox(force = true) } }, enabled = !state.loading) { Icon(Icons.Default.Refresh, stringResource(R.string.agent_ws_refresh_notifications)) }
                TextButton({ scope.launch { action.run { vm.agent.readSnapshot() } } }, enabled = !action.busy && valid && state.unread > 0) { Text(stringResource(R.string.agent_ws_mark_all_read)) }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("unread" to stringResource(R.string.agent_ws_filter_unread), "read" to stringResource(R.string.agent_ws_filter_read), "all" to stringResource(R.string.agent_ws_filter_all)).forEach { (key, label) ->
                    FilterChip(filter == key, { filter = key }, { Text(label) }, modifier = Modifier.testTag("notice-filter-$key"))
                }
            }
            Text(stringResource(R.string.agent_ws_read_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            AgentError(state.error); ActionStatus(action)
        }
        items(visible, key = { it.text("id") }) { notice ->
            AgentCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (notice.text("read_at").isBlank()) Icon(Icons.Default.Circle, stringResource(R.string.agent_ws_unread_badge), Modifier.padding(end = 8.dp).size(8.dp), tint = MaterialTheme.colorScheme.primary)
                    Text(notice.text("title"), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    if (notice.text("severity") != "info") Icon(Icons.Default.Info, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error)
                }
                Text(notice.text("summary")); Text(localAgentTime(notice.text("created_at")), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                AgentTrace(notice)
                Row {
                    notice.text("draft_id").takeIf { it.isNotBlank() }?.let { TextButton({ open("drafts", it) }) { Text(stringResource(R.string.agent_ws_view_draft)) } }
                    notice.text("task_id").takeIf { it.isNotBlank() }?.let { TextButton({ open("tasks", it) }) { Text(stringResource(R.string.agent_ws_task_result_web)) } }
                    notice.objects("actions").forEach { actionItem ->
                        val target = actionItem.text("target")
                        if (target.isNotBlank()) TextButton({ openAction(target, actionItem.objectOrNull("params")) }) {
                            Text(actionItem.text("label").ifBlank { stringResource(R.string.agent_ws_view_result) })
                        }
                    }
                    if (notice.text("read_at").isBlank()) TextButton({ scope.launch { action.run { vm.agent.readNotification(notice.text("id")) } } }, enabled = !action.busy,
                        modifier = Modifier.testTag("notice-read-${notice.text("id")}")) { Text(stringResource(R.string.agent_ws_mark_read)) }
                }
            }
        }
        if (valid && visible.isEmpty() && !state.loading && state.error == null) item { AgentEmpty(when (filter) { "unread" -> stringResource(R.string.agent_ws_empty_notifications_unread); "read" -> stringResource(R.string.agent_ws_empty_notifications_read); else -> stringResource(R.string.agent_ws_empty_notifications_all) }) }
        item { Spacer(Modifier.height(16.dp)) }
    }
    if (state.loading && visible.isEmpty()) AgentSkeleton()
    }
}

@Composable internal fun AgentDrafts(vm: MusicViewModel, selectedId: String?) {
    var drafts by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }
    var filter by rememberSaveable { mutableStateOf("pending") }
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    fun isPending(draft: JsonObject) = draft.text("status") in listOf("pending", "approved")
    suspend fun load() {
        drafts = vm.agent.all("drafts")
        selectedId?.let { id ->
            selected = drafts.firstOrNull { it.text("id") == id } ?: vm.agent.request("drafts/$id")
            filter = if (selected?.let(::isPending) == true) "pending" else "history"
        }
    }
    val visible = drafts.filter { when (filter) { "pending" -> isPending(it); "history" -> !isPending(it); else -> true } }
        .sortedWith(compareByDescending<JsonObject> { it.text("updated_at").ifBlank { it.text("created_at") } }.thenByDescending { it.text("id") })
    LaunchedEffect(selectedId) { action.run { load() }; if (action.message == AppLanguage.string(R.string.completed) || action.message == "\u5df2\u5b8c\u6210") action.message = null }
    LazyColumn(Modifier.fillMaxSize().testTag("agent-drafts"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_drafts_title), Modifier.weight(1f), fontWeight = FontWeight.Medium); IconButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, stringResource(R.string.agent_ws_refresh_drafts)) } }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("pending" to stringResource(R.string.agent_ws_drafts_tab_pending, drafts.count(::isPending)), "history" to stringResource(R.string.agent_ws_drafts_tab_history, drafts.count { !isPending(it) }), "all" to stringResource(R.string.agent_ws_filter_all)).forEach { (key, label) ->
                    FilterChip(filter == key, { filter = key }, { Text(label) }, modifier = Modifier.testTag("draft-filter-$key"))
                }
            }
            Text(stringResource(R.string.agent_ws_drafts_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            ActionStatus(action)
        }
        if (action.busy && drafts.isEmpty()) item { AgentSkeleton(Modifier.height(420.dp)) }
        if (!action.busy && visible.isEmpty() && action.message == null) item { AgentEmpty(when (filter) { "pending" -> stringResource(R.string.agent_ws_empty_drafts_pending); "history" -> stringResource(R.string.agent_ws_empty_drafts_history); else -> stringResource(R.string.agent_ws_empty_drafts_all) }) }
        items(visible, key = { it.text("id") }) { draft ->
            AgentCard { Text(draft.text("title"), fontWeight = FontWeight.SemiBold); Text(draftLabel(draft.text("status")), color = MaterialTheme.colorScheme.primary); AgentTrace(draft)
                TextButton({ selected = draft }, Modifier.testTag("draft-open-${draft.text("id")}")) { Text(stringResource(R.string.agent_ws_view_diff_and_evidence)) } }
        }
    }
    selected?.let { current -> AgentDraftDetail(vm, current, { selected = null }) { updated -> selected = updated; drafts = drafts.map { if (it.text("id") == updated.text("id")) updated else it } } }
}

internal fun fieldName(key: String) = mapOf("title" to AppLanguage.string(R.string.agent_ws_field_title), "artists" to AppLanguage.string(R.string.agent_ws_field_artists), "album" to AppLanguage.string(R.string.agent_ws_field_album), "album_artists" to AppLanguage.string(R.string.agent_ws_field_album_artists), "track_number" to AppLanguage.string(R.string.agent_ws_field_track_number), "disc_number" to AppLanguage.string(R.string.agent_ws_field_disc_number), "genre" to AppLanguage.string(R.string.agent_ws_field_genre), "date" to AppLanguage.string(R.string.agent_ws_field_date), "lyricists" to AppLanguage.string(R.string.agent_ws_field_lyricists), "composers" to AppLanguage.string(R.string.agent_ws_field_composers), "arrangers" to AppLanguage.string(R.string.agent_ws_field_arrangers), "name" to AppLanguage.string(R.string.agent_ws_field_name), "track_ids" to AppLanguage.string(R.string.agent_ws_field_track_ids))[key] ?: key
internal fun displayValue(value: com.google.gson.JsonElement?): String = when { value == null || value.isJsonNull -> AppLanguage.string(R.string.agent_ws_not_set); value.isJsonPrimitive -> value.asString; value.isJsonArray -> value.asJsonArray.joinToString(" / ") { displayValue(it) }; else -> value.toString() }
@Composable private fun AgentDraftDetail(vm: MusicViewModel, initial: JsonObject, dismiss: () -> Unit, updated: (JsonObject) -> Unit) {
    if (initial.text("kind") in setOf("metadata", "metadata_batch", "cover", "lyrics", "intake")) {
        AlertDialog(onDismissRequest = dismiss,
            title = { Text(initial.text("title")) },
            text = { Text(stringResource(R.string.metadata_review_on_web)) },
            confirmButton = { TextButton(dismiss) { Text(stringResource(R.string.close)) } })
        return
    }
    var draft by remember(initial.text("id"), initial.number("version")) { mutableStateOf(initial) }
    var coverReady by remember(draft.text("id"), draft.number("version")) { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<String?>(null) }
    var tracks by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    val payload = draft.getAsJsonObject("payload") ?: JsonObject()
    val before = draft.getAsJsonObject("before") ?: JsonObject()
    val changes = if (draft.text("kind") in listOf("metadata", "intake")) payload.getAsJsonObject("overrides") ?: JsonObject() else payload
    LaunchedEffect(draft.text("id"), draft.number("version")) {
        val ids = payload.getAsJsonArray("track_ids")?.map { it.asString } ?: listOfNotNull(payload.text("track_id").takeIf { it.isNotBlank() })
        val names = linkedMapOf<String, String>()
        ids.forEach { id -> try { names[id] = vm.repository.track(id).title } catch (error: CancellationException) { throw error } catch (_: Exception) { names[id] = id } }
        tracks = names
    }
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text(draft.text("title")) }, text = {
        Column(Modifier.heightIn(max = 500.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(draftLabel(draft.text("status")), color = MaterialTheme.colorScheme.primary)
            if (draft.objectOrNull("result")?.text("application_mode") == "automatic") Text(stringResource(R.string.agent_ws_applied_by_auto_policy), style = MaterialTheme.typography.bodySmall)
            if (draft.text("kind") == "metadata") Text(stringResource(R.string.agent_ws_track_label, tracks[payload.text("track_id")] ?: payload.text("track_id")))
            if (draft.text("kind") == "intake") Text(stringResource(R.string.agent_ws_intake_source_hint, before.text("source_path")))
            if (draft.text("kind") == "lyrics") {
                Text(stringResource(R.string.agent_ws_lyrics_song_source, before.text("title"), before.text("provider")))
                Text(stringResource(R.string.agent_ws_quality_change, before.getAsJsonObject("current_quality")?.text("label").orEmpty(), before.getAsJsonObject("candidate_quality")?.text("label").orEmpty()))
                Text(stringResource(R.string.agent_ws_offset_ms, payload.number("offset_ms")))
                Text(stringResource(R.string.agent_ws_match_basis, before.text("match")), style = MaterialTheme.typography.bodySmall)
                Text(stringResource(R.string.agent_ws_current_lyrics_preview), fontWeight = FontWeight.Medium)
                before.objects("current_lines").forEach { Text(it.text("text"), style = MaterialTheme.typography.bodySmall) }
                Text(stringResource(R.string.agent_ws_candidate_lyrics_preview), fontWeight = FontWeight.Medium)
                before.objects("candidate_lines").forEach { Text(listOf(it.text("text"), it.text("translation")).filter { v -> v.isNotBlank() }.joinToString(" / "), style = MaterialTheme.typography.bodySmall) }
            }
            if (draft.text("kind") in listOf("cover", "metadata_batch")) CurationDraftPreview(vm, draft) { coverReady = it }
            changes.entrySet().filter { draft.text("kind") !in listOf("lyrics", "cover", "metadata_batch") && it.key !in listOf("track_id", "metadata_version", "playlist_id", "playlist_version", "file_version", "candidate_id") }.forEach { (field, value) ->
                Text(fieldName(field), fontWeight = FontWeight.Medium)
                if (field == "track_ids") {
                    value.asJsonArray.forEachIndexed { index, id -> Text("${index + 1}. ${tracks[id.asString] ?: id.asString}", style = MaterialTheme.typography.bodySmall) }
                } else Text(stringResource(R.string.agent_ws_field_value_change, displayValue(before.get(field)), displayValue(value)), style = MaterialTheme.typography.bodyMedium)
            }
            draft.objects("evidence").forEach { evidence -> Text(stringResource(R.string.agent_ws_evidence_format, evidence.text("source"), evidence.text("summary")), style = MaterialTheme.typography.bodySmall); evidence.text("url").takeIf { it.isNotBlank() }?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.labelSmall) } } }
            Text(stringResource(R.string.agent_ws_draft_version_hint, draft.number("version")), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            draft.objectOrNull("result")?.text("automatic_error")?.takeIf { it.isNotBlank() }?.let { Text(stringResource(R.string.agent_ws_automatic_apply_error, agentError(409, it, null)), color = MaterialTheme.colorScheme.error) }
            if (draft.text("kind") in listOf("metadata_batch", "intake")) Text(stringResource(R.string.agent_ws_batch_intake_web_hint), style = MaterialTheme.typography.bodySmall)
            AgentTrace(draft); ActionStatus(action)
        }
    }, confirmButton = {
        if (draft.text("status") in listOf("pending", "approved") && draft.text("kind") !in listOf("metadata_batch", "intake")) TextButton({ scope.launch { action.run {
            val body = jsonBody("version" to draft.number("version"), "idempotency_key" to "android-${draft.text("id")}-${draft.number("version")}")
            if (draft.text("preview_digest").isNotBlank()) body.addProperty("preview_digest", draft.text("preview_digest"))
            draft = vm.agent.request("drafts/${draft.text("id")}/accept", "POST", body); updated(draft); vm.agent.refreshInbox()
        } } }, enabled = !action.busy && ((draft.text("kind") != "cover" && payload.text("cover_draft_id").isBlank()) || coverReady), modifier = Modifier.testTag("draft-confirm")) { Text(stringResource(R.string.agent_ws_accept_and_apply)) }
    }, dismissButton = { Row { if (draft.text("status") in listOf("pending", "approved")) TextButton({ confirm = "reject" }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_reject)) }; TextButton(dismiss, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_close)) } } })
    if (confirm != null) AlertDialog(onDismissRequest = { if (!action.busy) confirm = null }, title = { Text(stringResource(R.string.agent_ws_reject_draft_title)) },
        text = { Text(draft.text("title")); ActionStatus(action) },
        confirmButton = { TextButton({ scope.launch { action.run {
            draft = vm.agent.request("drafts/${draft.text("id")}/reject", "POST", jsonBody("version" to draft.number("version")))
            updated(draft); confirm = null; vm.agent.refreshInbox()
        } } }, enabled = !action.busy, modifier = Modifier.testTag("draft-confirm-reject")) { Text(stringResource(R.string.agent_ws_confirm_reject)) } },
        dismissButton = { TextButton({ confirm = null }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_cancel)) } })
}

internal fun generateFollowUpSuggestions(content: String): List<Pair<String, String>> {
    val result = mutableListOf<Pair<String, String>>()
    val text = content.lowercase()

    // 1. 联网查询建议
    if (text.contains("联网") || text.contains("平台") || text.contains("全网") || text.contains("日期") || text.contains("榜单") || text.contains("具体平台") || text.contains("未能")) {
        result.add(AppLanguage.string(R.string.agent_ws_suggestion_web_search) to AppLanguage.string(R.string.agent_ws_suggestion_web_search_prompt))
    }

    // 2. 歌单整理建议
    if (text.contains("歌单") || text.contains("做歌单") || text.contains("整理") || text.contains("合并") || text.contains("版本") || text.contains("《") || text.contains("收藏")) {
        result.add(AppLanguage.string(R.string.agent_ws_suggestion_playlist) to AppLanguage.string(R.string.agent_ws_suggestion_playlist_prompt))
    }

    // 3. 歌曲播放建议
    if (text.contains("《") || text.contains("播放次数") || text.contains("首") || text.contains("专辑")) {
        result.add(AppLanguage.string(R.string.agent_ws_suggestion_play) to AppLanguage.string(R.string.agent_ws_suggestion_play_prompt))
    }

    // 4. 风格拓展
    if (text.contains("风格") || text.contains("艺人") || text.contains("歌手") || text.contains("摇滚") || text.contains("民谣") || text.contains("流行")) {
        result.add(AppLanguage.string(R.string.agent_ws_suggestion_style) to AppLanguage.string(R.string.agent_ws_suggestion_style_prompt))
    } else {
        result.add(AppLanguage.string(R.string.agent_ws_suggestion_background) to AppLanguage.string(R.string.agent_ws_suggestion_background_prompt))
    }

    return result.distinctBy { it.first }.take(3)
}

internal fun summarizeConversationTitle(userText: String): String {
    val raw = userText.trim().replace(Regex("\\s+"), " ")
    if (raw.isEmpty()) return AppLanguage.string(R.string.agent_ws_conversation_new)
    var cleaned = raw.replace(
        Regex("^(?:请帮我|帮我|麻烦帮我|麻烦你|麻烦|请问一下|请问|我想让你|我想请你|我想|能不能帮我|能不能|可以帮我|可以|能否帮我|能否|试试这样问我[：:]?)\\s*"),
        ""
    ).trim()
    if (Regex("^查漏补缺[：:]\\s*").containsMatchIn(cleaned)) {
        val topic = cleaned
            .replace(Regex("^查漏补缺[：:]\\s*"), "")
            .replace(Regex("(?:我缺了哪几首|缺了哪几首|缺哪几首|有哪些缺口|缺哪些|我还没有)[？?！!。.]*$"), "")
            .trim()
        if (topic.isNotEmpty()) {
            cleaned = "${topic.take(18).trimEnd()} " + AppLanguage.string(R.string.agent_ws_gap_analysis)
        }
    } else {
        cleaned = cleaned.replace(
            Regex("(?:我缺了哪几首|缺了哪几首|缺哪几首|好吗|可以吗|行吗|好不好|谢谢|一下吧|一下)[？?！!。.]*$"),
            ""
        ).trim()
    }
    cleaned = cleaned.trim(' ', '\t', '\r', '\n', '，', ',', '。', '！', '？', '?', '!', '：', ':', '；', ';', '、', '“', '”', '"', '\'', '‘', '’')
    var firstClause = cleaned.split(Regex("[。！？?!\\n；;]")).firstOrNull()?.trim(' ', '\t', '，', ',', '：', ':').orEmpty()
    if (firstClause.length > 20 && firstClause.contains(Regex("[，,]"))) {
        val subClause = firstClause.split(Regex("[，,]")).firstOrNull()?.trim().orEmpty()
        if (subClause.length >= 4) firstClause = subClause
    }
    val candidate = firstClause.ifEmpty { cleaned.ifEmpty { raw } }
    return if (candidate.length > 24) {
        candidate.take(24).trimEnd(' ', '\t', '，', ',', '：', ':', '、') + "…"
    } else {
        candidate.ifEmpty { AppLanguage.string(R.string.agent_ws_conversation_new) }
    }
}

@Composable internal fun AgentChat(
    vm: MusicViewModel,
    onNotifications: (() -> Unit)? = null,
    onSettings: (() -> Unit)? = null,
    unread: Int = 0,
    onPlayer: (() -> Unit)? = null,
    openDraft: (String) -> Unit,
) {
    val links = LocalUriHandler.current
    var showSummary by remember { mutableStateOf(false) }
    var conversations by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var conversation by remember { mutableStateOf<JsonObject?>(null) }
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var connection by remember { mutableStateOf<String?>(null) }
    var input by remember { mutableStateOf("") }; var history by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<JsonObject?>(null) }; var renaming by remember { mutableStateOf<JsonObject?>(null) }
    var title by remember { mutableStateOf("") }; var historyMenu by remember { mutableStateOf<String?>(null) }
    var conversationMenu by remember { mutableStateOf(false) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    suspend fun loadConversationsWithSummarizedTitles(): List<JsonObject> {
        return vm.agent.all("conversations").map { item ->
            if (item.text("title") == "\u65b0\u5bf9\u8bdd" || item.text("title") == AppLanguage.string(R.string.agent_ws_conversation_new)) {
                runCatching {
                    val detail = if (conversation?.text("id") == item.text("id")) conversation!! else vm.agent.request("conversations/${item.text("id")}")
                    val firstUser = detail.objects("messages").firstOrNull { it.text("role") == "user" }?.text("content").orEmpty()
                    val summarized = summarizeConversationTitle(firstUser)
                    if (summarized.isNotBlank() && summarized != "\u65b0\u5bf9\u8bdd" && summarized != AppLanguage.string(R.string.agent_ws_conversation_new)) {
                        val patched = vm.agent.request("conversations/${item.text("id")}", "PATCH", jsonBody("title" to summarized))
                        if (conversation?.text("id") == item.text("id")) conversation = patched
                        patched
                    } else item
                }.getOrDefault(item)
            } else item
        }
    }
    LaunchedEffect(Unit) {
        action.run {
            val loadedConnections = vm.agent.all("connections")
            connections = loadedConnections
            conversations = loadConversationsWithSummarizedTitles()
            if (connection == null) {
                connection = loadedConnections.firstOrNull { it.flag("enabled") }?.text("id")
            }
        }
        if (action.message == AppLanguage.string(R.string.completed) || action.message == "\u5df2\u5b8c\u6210") action.message = null
    }
    val running = conversation?.objects("runs")?.any { it.text("status") == "running" } == true
    val playback by vm.state.collectAsStateWithLifecycle()
    val handoffClearance = if (playback.handoff != null && !playback.playing) 72.dp else 0.dp
    LaunchedEffect(conversation?.text("id"), action.busy, running) {
        val id = conversation?.text("id") ?: return@LaunchedEffect
        if (!action.busy && !running) return@LaunchedEffect
        while (true) {
            delay(650)
            try {
                val latest = vm.agent.request("conversations/$id")
                if (conversation?.text("id") == id) conversation = latest
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* The send operation retains its diagnostic. */ }
        }
    }
    val pageChrome = onNotifications != null || onSettings != null
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(start = 12.dp, end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            if (pageChrome && playback.canGoBack) {
                IconButton(vm::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.agent_ws_back)) }
            }
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                AgentConnectionChoice(connections, connection, !action.busy, compact = true) { connection = it }
            }
            TextButton(
                { scope.launch { action.run { conversations = loadConversationsWithSummarizedTitles(); history = true; action.message = null } } },
                enabled = !action.busy,
                modifier = Modifier.defaultMinSize(minWidth = 1.dp, minHeight = 1.dp),
                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
            ) { Text(stringResource(R.string.agent_ws_history), style = MaterialTheme.typography.labelLarge) }
            TextButton(
                { conversation = null; input = "" },
                enabled = !action.busy,
                modifier = Modifier.defaultMinSize(minWidth = 1.dp, minHeight = 1.dp),
                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
            ) { Text(stringResource(R.string.agent_ws_new_chat), style = MaterialTheme.typography.labelLarge) }
            if (!pageChrome && conversation != null) {
                IconButton({ scope.launch { action.run { conversation = vm.agent.request("conversations/${conversation!!.text("id")}"); action.message = null } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, stringResource(R.string.agent_ws_refresh_conversation)) }
                IconButton({ deleting = conversation; action.message = null }, enabled = !action.busy) { Icon(Icons.Default.DeleteOutline, stringResource(R.string.agent_ws_delete_conversation)) }
            }
            if (pageChrome) {
                onPlayer?.let { open ->
                    IconButton(open, Modifier.testTag("assistant-paused-player")) {
                        Icon(Icons.Default.PlayArrow, stringResource(R.string.agent_ws_open_paused_player))
                    }
                }
                if (conversation != null) {
                    Box {
                        IconButton({ conversationMenu = true }, enabled = !action.busy) {
                            Icon(Icons.Default.MoreVert, stringResource(R.string.agent_ws_more))
                        }
                        DropdownMenu(conversationMenu, { conversationMenu = false }) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.agent_ws_refresh)) },
                                leadingIcon = { Icon(Icons.Default.Refresh, stringResource(R.string.agent_ws_refresh_conversation)) },
                                enabled = !action.busy,
                                onClick = {
                                    conversationMenu = false
                                    scope.launch { action.run { conversation = vm.agent.request("conversations/${conversation!!.text("id")}"); action.message = null } }
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.agent_ws_delete)) },
                                leadingIcon = { Icon(Icons.Default.DeleteOutline, stringResource(R.string.agent_ws_delete_conversation)) },
                                enabled = !action.busy,
                                onClick = { conversationMenu = false; deleting = conversation; action.message = null },
                            )
                        }
                    }
                }
                onNotifications?.let { open ->
                    IconButton(open, Modifier.testTag("open-notifications")) {
                        BadgedBox(badge = { if (unread > 0) Badge { Text(if (unread > 99) "99+" else unread.toString()) } }) {
                            Icon(Icons.Default.NotificationsNone, stringResource(R.string.agent_ws_notifications))
                        }
                    }
                }
                onSettings?.let { open -> IconButton(open) { Icon(Icons.Default.Settings, stringResource(R.string.agent_ws_settings)) } }
            }
        }
        val allMessages = conversation?.objects("messages") ?: emptyList()
        val lastAssistantId = allMessages.lastOrNull { it.text("role") == "assistant" }?.text("id")
    var activeGapData by remember { mutableStateOf<CatalogGapUiData?>(null) }
    var gapLoading by remember { mutableStateOf(false) }


    fun triggerGapCheck(artistName: String) {
        scope.launch {
            gapLoading = true
            try {
                val json = vm.repository.checkCatalogGaps(artistName)
                val artist = json.get("artist")?.asString ?: artistName
                val totalTarget = json.get("total_target")?.asInt ?: 10
                val matchedCount = json.get("matched_count")?.asInt ?: 0
                val missingCount = json.get("missing_count")?.asInt ?: 0
                val coveragePercent = json.get("coverage_percent")?.asInt ?: 0
                val summary = json.get("summary")?.asString ?: ""
                val matched = json.getAsJsonArray("matched")?.mapNotNull { el ->
                    if (!el.isJsonObject) null else {
                        val obj = el.asJsonObject
                        MatchedTrackUi(
                            title = obj.get("title")?.asString ?: "",
                            trackId = obj.get("track_id")?.asString ?: "",
                            album = obj.get("album")?.asString,
                            format = obj.get("format")?.asString ?: "",
                        )
                    }
                } ?: emptyList()
                val missing = json.getAsJsonArray("missing")?.mapNotNull { el ->
                    if (!el.isJsonObject) null else {
                        val obj = el.asJsonObject
                        MissingTrackUi(
                            title = obj.get("title")?.asString ?: "",
                            album = obj.get("album")?.asString ?: "",
                            year = obj.get("year")?.asString ?: "",
                            rank = obj.get("rank")?.asInt ?: 0,
                        )
                    }
                } ?: emptyList()
                activeGapData = CatalogGapUiData(artist, totalTarget, matchedCount, missingCount, coveragePercent, matched, missing, summary)
            } catch (_: Exception) {
            } finally {
                gapLoading = false
            }
        }
    }

        fun sendMessage(text: String) {
            val content = text.trim()
            if (content.isEmpty() || action.busy || running) return
            if (content.contains("查漏补缺") || content.contains("缺哪几首") || content.contains("代表作") || content.contains("全网榜单")) {
                val targetArtist = when {
                    content.contains("周杰伦") -> "周杰伦"
                    content.contains("陈奕迅") -> "陈奕迅"
                    content.contains("林俊杰") -> "林俊杰"
                    content.contains("王菲") -> "王菲"
                    content.contains("落日飞车") -> "落日飞车"
                    else -> "许嵩"
                }
                triggerGapCheck(targetArtist)
            }
            scope.launch { action.run {
                var current = conversation ?: vm.agent.request("conversations", "POST", jsonBody("title" to summarizeConversationTitle(content), "connection_id" to connection)).also { conversation = it }
                val id = current.text("id")
                try {
                    current = vm.agent.request("conversations/$id/messages", "POST", jsonBody("content" to content, "connection_id" to connection))
                    conversation = current
                    input = ""
                    action.message = null
                    vm.agent.refreshInbox()
                } catch (error: CancellationException) { throw error }
                catch (error: Exception) {
                    try { conversation = vm.agent.request("conversations/$id") }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* The original operation still supplies its diagnostic ID. */ }
                    throw error
                }
            } }
        }

        LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp).testTag("agent-messages"), verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(top = 2.dp, bottom = 4.dp + handoffClearance)) {
            conversation?.get("context_summary")?.takeIf { it.isJsonObject }?.asJsonObject?.let { summary -> item {
                TextButton({ showSummary = !showSummary }) { Text(stringResource(R.string.agent_ws_context_summary_collapsed)) }
                if (showSummary) { Text(summary.text("summary"), style = MaterialTheme.typography.bodySmall); TextButton({ scope.launch { action.run { val id = conversation!!.text("id"); vm.agent.request("conversations/$id/summary", "DELETE"); conversation = vm.agent.request("conversations/$id") } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_clear_summary)) } }
            } }
            if (conversation == null) item {
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f),
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)
                ) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.size(28.dp)) {
                                Box(contentAlignment = Alignment.Center) { Icon(Icons.Default.AutoAwesome, null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer) }
                            }
                            Text(stringResource(R.string.agent_ws_assistant_title), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        }
                        Text(stringResource(R.string.agent_ws_assistant_intro), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(stringResource(R.string.agent_ws_assistant_prompt_examples_heading), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium)
                        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            listOf(
                                stringResource(R.string.agent_ws_prompt_example_1),
                                stringResource(R.string.agent_ws_prompt_example_2),
                                stringResource(R.string.agent_ws_prompt_example_3),
                                stringResource(R.string.agent_ws_prompt_example_4),
                                stringResource(R.string.agent_ws_prompt_example_5),
                            ).forEach { prompt ->
                                Surface(
                                    shape = RoundedCornerShape(10.dp),
                                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.7f),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable { sendMessage(prompt) },
                                ) {
                                    Row(
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Text(
                                            text = stringResource(R.string.agent_ws_quote_prompt, prompt),
                                            style = MaterialTheme.typography.labelMedium,
                                            color = MaterialTheme.colorScheme.onSurface,
                                            modifier = Modifier.weight(1f),
                                        )
                                        Icon(
                                            Icons.Default.ArrowOutward,
                                            contentDescription = null,
                                            modifier = Modifier.size(14.dp),
                                            tint = MaterialTheme.colorScheme.primary,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (activeGapData != null) item {
                CatalogGapCard(
                    data = activeGapData!!,
                    onPlayTrack = { trackId ->
                        scope.launch {
                            try {
                                val track = vm.repository.track(trackId)
                                vm.play(listOf(track), 0)
                            } catch (_: Exception) {}
                        }
                    },
                )
            }
            items(allMessages, key = { it.text("id") }) { message ->
                val isAssistant = message.text("role") == "assistant"
                val isLatestAssistant = isAssistant && message.text("id") == lastAssistantId
                if (isAssistant) {
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (message.flag("partial")) Text(stringResource(R.string.agent_ws_generating_partial), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        SelectionContainer { AssistantMarkdown(message.text("content")) }
                        message.objects("sources").forEach { source ->
                            source.text("url").takeIf { it.startsWith("https://") }?.let { url ->
                                Surface(
                                    shape = RoundedCornerShape(8.dp),
                                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                                    modifier = Modifier.clickable { runCatching { links.openUri(url) }.onFailure { action.message = AppLanguage.string(R.string.agent_ws_cannot_open_source) } },
                                ) {
                                    Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                        Icon(Icons.Default.Public, null, modifier = Modifier.size(12.dp), tint = MaterialTheme.colorScheme.primary)
                                        Text(stringResource(R.string.agent_ws_source_label, source.text("title").ifBlank { url }), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                            }
                        }
                        if (isLatestAssistant && !message.flag("partial") && !running) {
                            val suggestions = remember(message.text("content")) { generateFollowUpSuggestions(message.text("content")) }
                            if (suggestions.isNotEmpty()) {
                                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    suggestions.forEach { (label, prompt) ->
                                        SuggestionChip(
                                            onClick = { sendMessage(prompt) },
                                            label = { Text(label, style = MaterialTheme.typography.labelSmall, maxLines = 1) },
                                            shape = RoundedCornerShape(12.dp),
                                            colors = SuggestionChipDefaults.suggestionChipColors(
                                                containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                                            ),
                                            border = null,
                                        )
                                    }
                                }
                            }
                        }
                    }
                } else {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
                        Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.widthIn(max = 300.dp)) {
                            SelectionContainer {
                                Text(message.text("content"), Modifier.padding(horizontal = 12.dp, vertical = 8.dp), style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
            conversation?.objects("runs")?.forEach { run ->
                val failed = run.text("error_code").isNotBlank() || run.text("status") in setOf("failed", "interrupted")
                val fallback = run.text("status") == "local_fallback"
                val drafts = run.getAsJsonArray("draft_ids")
                if (!failed && !fallback && (drafts == null || drafts.size() == 0)) return@forEach
                item(key = "run-${run.text("id")}") {
                    if (fallback) Text(stringResource(R.string.agent_ws_local_search_fallback), style = MaterialTheme.typography.bodySmall)
                    if (failed) Text(stringResource(R.string.agent_ws_run_failed_status, run.text("status"), run.text("error_code")), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    if (failed) AgentTrace(run)
                    drafts?.forEach { draft ->
                        Surface(
                            shape = RoundedCornerShape(10.dp),
                            color = MaterialTheme.colorScheme.primaryContainer,
                            modifier = Modifier.clickable { openDraft(draft.asString) },
                        ) {
                            Row(
                                Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Icon(Icons.AutoMirrored.Filled.PlaylistAdd, null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(16.dp))
                                Text(stringResource(R.string.agent_ws_draft_generated_banner), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onPrimaryContainer)
                            }
                        }
                    }
                }
            }
            item {
                if (!action.busy && !action.message.isNullOrBlank() && action.message != AppLanguage.string(R.string.completed) && action.message != "\u5df2\u5b8c\u6210") ActionStatus(action)
            }
        }
        conversation?.objects("runs")?.firstOrNull { it.text("status") == "running" }?.let { run ->
            Text(when (run.text("stage")) { "search" -> stringResource(R.string.agent_ws_stage_search); "tools" -> stringResource(R.string.agent_ws_stage_tools); "writing" -> stringResource(R.string.agent_ws_stage_writing); else -> stringResource(R.string.agent_ws_stage_analyzing) }, Modifier.padding(horizontal = 16.dp, vertical = 2.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxWidth()) {
            TextField(
                input,
                { input = it },
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).testTag("agent-chat-input"),
                placeholder = { Text(stringResource(R.string.agent_ws_chat_placeholder)) },
                shape = RoundedCornerShape(24.dp),
                maxLines = 4,
                enabled = !action.busy && !running,
                textStyle = MaterialTheme.typography.bodyMedium,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { sendMessage(input) }),
                trailingIcon = {
                    IconButton(
                        onClick = { sendMessage(input) },
                        enabled = !action.busy && !running && input.isNotBlank(),
                        modifier = Modifier.testTag("agent-chat-send"),
                    ) {
                        if (action.busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.agent_ws_chat_send))
                    }
                },
                colors = TextFieldDefaults.colors(
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                    disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                    unfocusedIndicatorColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    disabledIndicatorColor = Color.Transparent,
                ),
            )
        }
    }
    if (history) AlertDialog(modifier = Modifier.testTag("agent-history-dialog"), onDismissRequest = { if (!action.busy) history = false }, title = { Text(stringResource(R.string.agent_ws_history_dialog_title)) }, text = {
        LazyColumn(Modifier.heightIn(max = 400.dp).testTag("agent-history")) {
            item { ActionStatus(action) }
            if (conversations.isEmpty()) item { AgentEmpty(stringResource(R.string.agent_ws_empty_history)) }
            items(conversations, key = { it.text("id") }) { item ->
                ListItem(headlineContent = { Text(item.text("title"), maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.testTag("history-open-${item.text("id")}").clickable(enabled = !action.busy) { history = false; scope.launch { action.run { conversation = vm.agent.request("conversations/${item.text("id")}"); connection = conversation?.text("connection_id")?.takeIf { it.isNotBlank() } } } },
                    trailingContent = { Box {
                        IconButton({ historyMenu = item.text("id") }, enabled = !action.busy, modifier = Modifier.testTag("history-actions-${item.text("id")}")) { Icon(Icons.Default.MoreVert, stringResource(R.string.agent_ws_conversation_actions, item.text("title"))) }
                        DropdownMenu(historyMenu == item.text("id"), { historyMenu = null }) {
                            DropdownMenuItem(text = { Text(stringResource(R.string.agent_ws_rename)) }, leadingIcon = { Icon(Icons.Default.Edit, null) }, onClick = { renaming = item; title = item.text("title"); historyMenu = null; action.message = null })
                            DropdownMenuItem(text = { Text(stringResource(R.string.agent_ws_delete)) }, leadingIcon = { Icon(Icons.Default.DeleteOutline, null) }, onClick = { deleting = item; historyMenu = null; action.message = null })
                        }
                    } },
                )
            }
        }
    }, confirmButton = { TextButton({ history = false }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_close)) } })
    renaming?.let { item -> AlertDialog(onDismissRequest = { if (!action.busy) renaming = null }, title = { Text(stringResource(R.string.agent_ws_rename_dialog_title)) }, text = {
        Column { OutlinedTextField(title, { title = it.take(200) }, label = { Text(stringResource(R.string.agent_ws_conversation_name_label)) }, singleLine = true, enabled = !action.busy, modifier = Modifier.testTag("conversation-title")); ActionStatus(action) }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        val changed = vm.agent.request("conversations/${item.text("id")}", "PATCH", jsonBody("title" to title.trim()))
        conversations = conversations.map { if (it.text("id") == item.text("id")) changed else it }
        if (conversation?.text("id") == item.text("id")) conversation = changed
        renaming = null
    } } }, enabled = !action.busy && title.isNotBlank()) { Text(stringResource(R.string.agent_ws_save)) } }, dismissButton = { TextButton({ renaming = null }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_cancel)) } }) }
    deleting?.let { item -> AlertDialog(onDismissRequest = { if (!action.busy) deleting = null }, title = { Text(stringResource(R.string.agent_ws_delete_conversation_title)) }, text = {
        Column { Text(stringResource(R.string.agent_ws_delete_conversation_confirm, item.text("title"))); ActionStatus(action) }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        vm.agent.request("conversations/${item.text("id")}", "DELETE")
        if (conversation?.text("id") == item.text("id")) conversation = null
        conversations = conversations.filterNot { it.text("id") == item.text("id") }; deleting = null
    } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_delete)) } }, dismissButton = { TextButton({ deleting = null }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_cancel)) } }) }
}

/** Every AI entry point uses the same permission-filtered connection list. */
@Composable internal fun AgentConnectionChoice(connections: List<JsonObject>, selected: String?, enabled: Boolean = true, emptyLabel: String? = null, compact: Boolean = false, choose: (String?) -> Unit) {
    val resolvedEmptyLabel = emptyLabel ?: stringResource(R.string.agent_ws_empty_ai_model)
    var open by remember { mutableStateOf(false) }
    val enabledConnections = connections.filter { it.flag("enabled") }
    val chosen = enabledConnections.firstOrNull { it.text("id") == selected } ?: enabledConnections.firstOrNull()

    // Auto-select if selected is null but enabled connections exist
    LaunchedEffect(enabledConnections) {
        if (selected == null && enabledConnections.isNotEmpty()) {
            choose(enabledConnections.first().text("id"))
        }
    }

    Column {
        Box {
            if (enabledConnections.isEmpty()) {
                Text(
                    text = if (compact) resolvedEmptyLabel else stringResource(R.string.agent_ws_no_channel_configured),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.error,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = if (compact) 0.dp else 10.dp, vertical = if (compact) 0.dp else 6.dp),
                )
            } else if (enabledConnections.size == 1) {
                Surface(
                    shape = RoundedCornerShape(if (compact) 14.dp else 8.dp),
                    color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f),
                    modifier = if (compact) Modifier.fillMaxWidth().height(32.dp) else Modifier.padding(vertical = 4.dp),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = if (compact) 0.dp else 6.dp).then(if (compact) Modifier.fillMaxHeight() else Modifier),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primary, modifier = Modifier.size(6.dp)) {}
                        Text(
                            text = "${chosen?.text("name")} · ${chosen?.text("model")}",
                            style = if (compact) MaterialTheme.typography.labelMedium else MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Medium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = if (compact) Modifier.weight(1f) else Modifier,
                        )
                    }
                }
            } else {
                TextButton(
                    { open = true },
                    enabled = enabled,
                    modifier = Modifier.testTag("ai-connection-choice").then(if (compact) Modifier.fillMaxWidth().height(36.dp).defaultMinSize(minWidth = 1.dp, minHeight = 1.dp) else Modifier),
                    contentPadding = if (compact) PaddingValues(horizontal = 8.dp, vertical = 0.dp) else ButtonDefaults.TextButtonContentPadding,
                ) {
                    Text(
                        chosen?.let { "${it.text("name")} · ${it.text("model")}" } ?: resolvedEmptyLabel,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = if (compact) Modifier.weight(1f, fill = false) else Modifier,
                    )
                    Icon(Icons.Default.ArrowDropDown, null)
                }
                DropdownMenu(open, { open = false }) {
                    enabledConnections.forEach { item ->
                        DropdownMenuItem(
                            modifier = Modifier.testTag("ai-connection-${item.text("id")}"),
                            text = {
                                Column {
                                    Text("${item.text("name")} · ${item.text("model")}")
                                    Text(connectionBudget(item), style = MaterialTheme.typography.labelSmall)
                                }
                            },
                            onClick = {
                                choose(item.text("id"))
                                open = false
                            },
                        )
                    }
                }
            }
        }
        if (!compact && chosen != null && enabledConnections.size > 1) {
            Text(connectionBudget(chosen), Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall)
        }
    }
}

internal fun connectionBudget(connection: JsonObject): String {
    val scope = when {
        connection.flag("read_only") -> AppLanguage.string(R.string.agent_ws_budget_scope_readonly)
        connection.text("scope") == "instance" -> AppLanguage.string(R.string.agent_ws_budget_scope_instance)
        else -> AppLanguage.string(R.string.agent_ws_budget_scope_personal)
    }
    val used = connection.get("daily_calls_used")?.takeUnless { it.isJsonNull }?.asLong
    return AppLanguage.string(R.string.agent_ws_budget_daily, scope, connection.number("daily_call_budget")) + used?.let { AppLanguage.string(R.string.agent_ws_budget_used, it) }.orEmpty()
}

@Composable private fun AgentTasks(vm: MusicViewModel, selectedId: String?) {
    var tasks by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var schedules by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }; var create by remember { mutableStateOf(false) }; var scheduling by remember { mutableStateOf(false) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    suspend fun load() { tasks = vm.agent.all("tasks"); schedules = vm.agent.all("schedules"); selectedId?.let { selected = vm.agent.request("tasks/$it") } }
    LaunchedEffect(Unit) { action.run { load() }; if (action.message == AppLanguage.string(R.string.completed) || action.message == "\u5df2\u5b8c\u6210") action.message = null }
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(5000)
            if (tasks.any { it.text("status") in listOf("queued", "running", "cancel_requested", "retry_wait") }) {
                action.run { load() }; if (action.message == AppLanguage.string(R.string.completed) || action.message == "\u5df2\u5b8c\u6210") action.message = null
            }
        }
    }
    LazyColumn(Modifier.fillMaxSize().testTag("agent-tasks"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) { FilledTonalButton({ create = true }) { Icon(Icons.AutoMirrored.Filled.FactCheck, null); Text(stringResource(R.string.agent_ws_start_inspection)) }; Spacer(Modifier.weight(1f)); IconButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, stringResource(R.string.agent_ws_refresh_inspection)) } }
            Text(stringResource(R.string.agent_ws_inspection_hint), Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
        if (action.busy && tasks.isEmpty()) item { AgentSkeleton(Modifier.height(420.dp)) }
        items(tasks, key = { it.text("id") }) { task -> AgentCard {
            Text(stringResource(R.string.agent_ws_task_card_title, taskLabel(task.text("status")), inspectionStage(task.text("stage"), task.text("status"))), fontWeight = FontWeight.Medium)
            Text(localAgentTime(task.text("created_at")), style = MaterialTheme.typography.labelSmall); AgentCounts(task); AgentTrace(task)
            TextButton({ scope.launch { action.run { selected = vm.agent.request("tasks/${task.text("id")}") } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_details_and_recovery)) }
        } }
        if (tasks.isEmpty() && !action.busy && action.message == null) item { AgentEmpty(stringResource(R.string.agent_ws_empty_inspections)) }
        item { Row(verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_scheduled_inspection), Modifier.weight(1f), fontWeight = FontWeight.Medium); TextButton({ scheduling = true }) { Text(stringResource(R.string.agent_ws_new_schedule)) } } }
        items(schedules, key = { "schedule-${it.text("id")}" }) { schedule -> AgentScheduleCard(vm, schedule) { scope.launch { action.run { load() } } } }
    }
    if (create || scheduling) AgentInspectionForm(vm, scheduling, { create = false; scheduling = false }) { scope.launch { action.run { load() } } }
    selected?.let { task ->
        val status = task.text("status")
        AlertDialog(onDismissRequest = { selected = null }, title = { Text(stringResource(R.string.agent_ws_inspection_task_title, taskLabel(status))) }, text = {
            Column(Modifier.testTag("inspection-task-detail").heightIn(max = 460.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(stringResource(R.string.agent_ws_stage_label, inspectionStage(task.text("stage"), status))); AgentCounts(task)
                task.text("error_code").takeIf { it.isNotBlank() }?.let { Text(agentError(502, it, null), color = MaterialTheme.colorScheme.error) }
                task.objects("results").forEach { result ->
                    if (result.text("analysis").isNotBlank()) {
                        Text(if (result.flag("ai_skipped")) stringResource(R.string.agent_ws_rule_check_desc) else stringResource(R.string.agent_ws_ai_analysis_result), fontWeight = FontWeight.Medium)
                        Text(result.text("analysis"))
                    } else {
                        Text(result.text("title"), fontWeight = FontWeight.Medium)
                        result.objects("findings").forEach { finding -> Text(finding.text("summary"), style = MaterialTheme.typography.bodySmall) }
                        Text(result.getAsJsonArray("issues")?.joinToString(" · ") { issue -> mapOf("missing_album" to AppLanguage.string(R.string.agent_ws_issue_missing_album), "missing_cover" to AppLanguage.string(R.string.agent_ws_issue_missing_cover), "missing_lyrics" to AppLanguage.string(R.string.agent_ws_issue_missing_lyrics), "missing_track_number" to AppLanguage.string(R.string.agent_ws_issue_missing_track_number), "track_number_conflict" to AppLanguage.string(R.string.agent_ws_issue_track_number_conflict), "track_number_out_of_range" to AppLanguage.string(R.string.agent_ws_issue_track_number_out_of_range), "disc_number_out_of_range" to AppLanguage.string(R.string.agent_ws_issue_disc_number_out_of_range), "missing_disc_number" to AppLanguage.string(R.string.agent_ws_issue_missing_disc_number), "same_title_versions" to AppLanguage.string(R.string.agent_ws_issue_same_title_versions), "possible_duplicate_recording" to AppLanguage.string(R.string.agent_ws_issue_possible_duplicate_recording), "possible_multidisc_split" to AppLanguage.string(R.string.agent_ws_issue_possible_multidisc_split))[issue.asString] ?: issue.asString }.orEmpty(), style = MaterialTheme.typography.bodySmall)
                    }
                }
                AgentTrace(task); if (action.message != AppLanguage.string(R.string.completed) && action.message != "\u5df2\u5b8c\u6210") ActionStatus(action)
            }
        }, confirmButton = { Row {
            if (status in listOf("queued", "running", "retry_wait", "paused_authorization", "paused_budget")) TextButton({ scope.launch { action.run { selected = vm.agent.request("tasks/${task.text("id")}/cancel", "POST"); tasks = vm.agent.all("tasks") } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_request_cancel)) }
            if (status in listOf("paused_authorization", "paused_budget", "failed", "interrupted", "partial")) TextButton({ scope.launch { action.run { selected = vm.agent.request("tasks/${task.text("id")}/resume", "POST"); tasks = vm.agent.all("tasks") } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_resume_inspection)) }
            TextButton({ scope.launch { action.run { selected = vm.agent.request("tasks/${task.text("id")}") } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_refresh)) }
        } }, dismissButton = { TextButton({ selected = null }) { Text(stringResource(R.string.agent_ws_close)) } })
    }
}
@Composable private fun AgentCounts(task: JsonObject) {
    task.getAsJsonObject("counts")?.entrySet()?.takeIf { it.isNotEmpty() }?.let { counts ->
        Text(counts.joinToString(" · ") { (name, value) -> "${mapOf("processed" to AppLanguage.string(R.string.agent_ws_count_checked), "checked" to AppLanguage.string(R.string.agent_ws_count_checked), "total" to AppLanguage.string(R.string.agent_ws_count_total), "issues" to AppLanguage.string(R.string.agent_ws_count_issues), "drafts" to AppLanguage.string(R.string.agent_ws_count_drafts), "failed" to AppLanguage.string(R.string.agent_ws_count_failed), "skipped" to AppLanguage.string(R.string.agent_ws_count_skipped), "calls" to AppLanguage.string(R.string.agent_ws_count_calls))[name] ?: name} ${displayValue(value)}" }, style = MaterialTheme.typography.bodySmall)
    }
}
@Composable private fun AgentInspectionForm(vm: MusicViewModel, schedule: Boolean, dismiss: () -> Unit, submitted: () -> Unit) {
    val defaultInspectionName = stringResource(R.string.agent_ws_default_schedule_name)
    var name by remember { mutableStateOf(defaultInspectionName) }; var maxTracks by remember { mutableStateOf("500") }; var ai by remember { mutableStateOf(false) }
    var maxCalls by remember { mutableStateOf("4") }; var connection by remember { mutableStateOf<String?>(null) }; var hours by remember { mutableStateOf("24") }
    var timezone by remember { mutableStateOf(java.util.TimeZone.getDefault().id) }; var enabled by remember { mutableStateOf(false) }; var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { action.run { connections = vm.agent.all("connections") }; if (action.message == AppLanguage.string(R.string.completed) || action.message == "\u5df2\u5b8c\u6210") action.message = null }
    val available = connections.filter { it.flag("enabled") && (!schedule || it.flag("background_allowed")) }
    val selectedAvailable = available.any { it.text("id") == connection }
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text(if (schedule) stringResource(R.string.agent_ws_form_title_scheduled) else stringResource(R.string.agent_ws_form_title_start)) }, text = {
        Column(Modifier.heightIn(max = 500.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (schedule) OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.agent_ws_schedule_name_label)) }, singleLine = true)
            OutlinedTextField(maxTracks, { maxTracks = it.filter(Char::isDigit) }, label = { Text(stringResource(R.string.agent_ws_max_tracks_label)) }, singleLine = true)
            Row(Modifier.fillMaxWidth().clickable { ai = !ai }, verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_use_ai_analysis), Modifier.weight(1f)); Switch(ai, { ai = it }, modifier = Modifier.testTag("inspection-use-ai")) }
            if (ai) {
                AgentConnectionChoice(available, connection, !action.busy, emptyLabel = stringResource(R.string.agent_ws_select_ai_connection)) { connection = it }
                if (!selectedAvailable && !action.busy) Text(
                    if (available.isEmpty()) {
                        if (schedule) stringResource(R.string.agent_ws_no_schedule_connection)
                        else stringResource(R.string.agent_ws_no_inspection_connection)
                    } else stringResource(R.string.agent_ws_select_inspection_connection),
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedTextField(maxCalls, { maxCalls = it.filter(Char::isDigit) }, label = { Text(stringResource(R.string.agent_ws_max_calls_label)) }, singleLine = true)
                Text(if (schedule) stringResource(R.string.agent_ws_schedule_ai_budget_notice) else stringResource(R.string.agent_ws_manual_ai_budget_notice), style = MaterialTheme.typography.bodySmall)
            }
            if (schedule) {
                OutlinedTextField(hours, { hours = it.filter(Char::isDigit) }, label = { Text(stringResource(R.string.agent_ws_interval_hours_label)) }, singleLine = true)
                OutlinedTextField(timezone, { timezone = it }, label = { Text(stringResource(R.string.agent_ws_timezone_label)) }, singleLine = true)
                Row(Modifier.fillMaxWidth().clickable { enabled = !enabled }, verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_enable_schedule), Modifier.weight(1f)); Switch(enabled, { enabled = it }) }
            }
            Text(stringResource(R.string.agent_ws_policy_music_file_hint), style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        val parameters = jsonBody("max_tracks" to (maxTracks.toIntOrNull() ?: 0), "use_ai" to ai, "max_calls" to if (ai) maxCalls.toIntOrNull() ?: 0 else 0, "connection_id" to if (ai) connection else null)
        if (schedule) vm.agent.request("schedules", "POST", jsonBody("name" to name, "enabled" to enabled, "interval_hours" to (hours.toIntOrNull() ?: 0), "timezone" to timezone, "parameters" to parameters)) else vm.agent.request("tasks", "POST", parameters)
        submitted(); dismiss(); vm.agent.refreshInbox()
    } } }, enabled = !action.busy && (maxTracks.toIntOrNull() ?: 0) in 1..5000 && (!ai || (selectedAvailable && (maxCalls.toIntOrNull() ?: 0) in 1..100))) { Text(if (schedule) stringResource(R.string.agent_ws_save_schedule) else stringResource(R.string.agent_ws_start)) } }, dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_cancel)) } })
}
@Composable private fun AgentScheduleCard(vm: MusicViewModel, initial: JsonObject, refresh: () -> Unit) {
    var schedule by remember(initial) { mutableStateOf(initial) }; var deleting by remember { mutableStateOf(false) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AgentCard {
        Row(verticalAlignment = Alignment.CenterVertically) { Text(schedule.text("name"), Modifier.weight(1f), fontWeight = FontWeight.Medium)
            Switch(schedule.flag("enabled"), { enabled -> scope.launch { action.run { schedule = vm.agent.request("schedules/${schedule.text("id")}", "PATCH", jsonBody("version" to schedule.number("version"), "enabled" to enabled)); refresh() } } }, enabled = !action.busy) }
        Text(stringResource(R.string.agent_ws_every_n_hours, schedule.number("interval_hours"), schedule.text("timezone")), style = MaterialTheme.typography.bodySmall)
        if (schedule.flag("enabled")) Text(stringResource(R.string.agent_ws_next_run_at, localAgentTime(schedule.text("next_run_at"))), style = MaterialTheme.typography.bodySmall)
        TextButton({ deleting = true }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_delete_schedule)) }; ActionStatus(action)
    }
    if (deleting) AlertDialog(onDismissRequest = { deleting = false }, title = { Text(stringResource(R.string.agent_ws_delete_schedule_title)) }, text = { Text(stringResource(R.string.agent_ws_delete_schedule_confirm, schedule.text("name"))) }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("schedules/${schedule.text("id")}", "DELETE"); deleting = false; refresh() } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_delete)) } }, dismissButton = { TextButton({ deleting = false }) { Text(stringResource(R.string.agent_ws_cancel)) } })
}

@Composable internal fun AgentConnections(vm: MusicViewModel) {
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var editing by remember { mutableStateOf<JsonObject?>(null) }; var creating by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<JsonObject?>(null) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    suspend fun load() { connections = vm.agent.all("connections") }
    LaunchedEffect(Unit) { action.run { load() }; if (action.message == AppLanguage.string(R.string.completed) || action.message == "\u5df2\u5b8c\u6210") action.message = null }
    LazyColumn(Modifier.fillMaxSize().testTag("agent-connections"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { var expanded by remember { mutableStateOf(false) }; AgentCard {
            TextButton({ expanded = !expanded }) { Text(if (expanded) stringResource(R.string.agent_ws_collapse_curation) else stringResource(R.string.agent_ws_expand_curation)) }
            if (expanded) AgentApplicationPolicy(vm)
        } }
        item { Row(verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_your_connections), Modifier.weight(1f), fontWeight = FontWeight.Medium); TextButton({ creating = true }) { Text(stringResource(R.string.agent_ws_add_connection)) }; IconButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, stringResource(R.string.agent_ws_refresh_connections)) } }; ActionStatus(action) }
        item { Text(stringResource(R.string.agent_ws_connections_security_hint), style = MaterialTheme.typography.bodySmall) }
        if (action.busy && connections.isEmpty()) item { AgentSkeleton(Modifier.height(420.dp)) }
        items(connections, key = { it.text("id") }) { connection -> AgentCard {
            Text(connection.text("name"), fontWeight = FontWeight.Medium); Text("${connection.text("model")} · ${if (connection.text("scope") == "instance") stringResource(R.string.agent_ws_scope_instance) else stringResource(R.string.agent_ws_scope_personal)}")
            Text(connection.text("base_url"), style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.agent_ws_connection_status_budget, if (connection.flag("enabled")) stringResource(R.string.agent_ws_enabled) else stringResource(R.string.agent_ws_disabled), connection.number("daily_call_budget")), style = MaterialTheme.typography.bodySmall)
            if (connection.text("id") == "legacy") Text(stringResource(R.string.agent_ws_legacy_connection_hint), style = MaterialTheme.typography.bodySmall)
            connection.getAsJsonObject("capabilities")?.let { caps -> caps.entrySet().forEach { (name, value) -> Text(stringResource(R.string.agent_ws_field_key_value, fieldName(name), displayValue(value)), style = MaterialTheme.typography.labelSmall) } }
            Row {
                TextButton({ scope.launch { action.run {
                    val result = vm.agent.request("connections/${connection.text("id")}/test", "POST")
                    action.message = AppLanguage.string(R.string.agent_ws_test_result_prefix, result.entrySet().joinToString(" · ") { (name, value) -> "${fieldName(name)} ${displayValue(value)}" }); load()
                } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_test_capabilities)) }
                if (!connection.flag("read_only")) {
                    TextButton({ editing = connection }) { Text(stringResource(R.string.agent_ws_edit)) }
                    TextButton({ deleting = connection }) { Text(stringResource(R.string.agent_ws_delete)) }
                } else Text(stringResource(R.string.agent_ws_readonly), Modifier.padding(12.dp), style = MaterialTheme.typography.labelSmall)
            }
        } }
        if (connections.isEmpty() && !action.busy && action.message == null) item { AgentEmpty(stringResource(R.string.agent_ws_empty_connections)) }
    }
    if (creating || editing != null) AgentConnectionForm(vm, editing, { creating = false; editing = null }) { scope.launch { action.run { load() } } }
    deleting?.let { connection -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text(stringResource(R.string.agent_ws_delete_connection_title)) }, text = { Text(stringResource(R.string.agent_ws_delete_connection_confirm, connection.text("name"))) }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("connections/${connection.text("id")}", "DELETE"); deleting = null; load() } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_delete)) } }, dismissButton = { TextButton({ deleting = null }) { Text(stringResource(R.string.agent_ws_cancel)) } }) }
}

@Composable private fun AgentConnectionForm(vm: MusicViewModel, original: JsonObject?, dismiss: () -> Unit, saved: () -> Unit) {
    var protocol by remember { mutableStateOf(original?.text("protocol")?.ifBlank { "chat_completions" } ?: "chat_completions") }
    var provider by remember { mutableStateOf(original?.text("provider")?.ifBlank { "generic" } ?: "generic") }
    var effort by remember { mutableStateOf(if (original == null) "low" else original.text("reasoning_effort").ifBlank { "auto" }) }
    var outputLimit by remember { mutableStateOf((original?.number("max_output_tokens", 2048) ?: 8192).toString()) }
    var nativeSearch by remember { mutableStateOf(original?.flag("native_search") ?: false) }
    var streamOutput by remember { mutableStateOf(original?.get("stream_output")?.asBoolean ?: true) }
    val defaultConnName = stringResource(R.string.agent_ws_default_connection_name)
    var name by remember { mutableStateOf(original?.text("name") ?: defaultConnName) }; var base by remember { mutableStateOf(original?.text("base_url") ?: "") }
    var model by remember { mutableStateOf(original?.text("model") ?: "") }; var secret by remember { mutableStateOf("") }; var timeout by remember { mutableStateOf((original?.number("timeout") ?: 90).toString()) }
    var budget by remember { mutableStateOf((original?.number("daily_call_budget") ?: 100).toString()) }; var enabled by remember { mutableStateOf(original?.flag("enabled") ?: true) }
    var background by remember { mutableStateOf(original?.flag("background_allowed") ?: false) }; var instance by remember { mutableStateOf(original?.text("scope") == "instance") }; var shared by remember { mutableStateOf(original?.flag("shared") ?: false) }
    val account by vm.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }; val admin = account.account?.isOwner == true
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text(if (original == null) stringResource(R.string.agent_ws_add_connection_title) else stringResource(R.string.agent_ws_edit_connection_title)) }, text = {
        Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.agent_ws_name_label)) }, singleLine = true)
            ResearchChoice(stringResource(R.string.agent_ws_api_protocol), protocol, listOf("chat_completions" to "Chat Completions", "responses" to "Responses")) { protocol = it; nativeSearch = false }
            ResearchChoice(stringResource(R.string.agent_ws_provider), provider, listOf("generic" to stringResource(R.string.agent_ws_provider_generic), "openai" to "OpenAI", "deepseek" to "DeepSeek", "qwen" to stringResource(R.string.agent_ws_provider_qwen), "gemini" to stringResource(R.string.agent_ws_provider_gemini))) { provider = it; nativeSearch = false }
            OutlinedTextField(base, { base = it }, label = { Text(stringResource(R.string.agent_ws_base_url_label)) }, singleLine = true)
            OutlinedTextField(model, { model = it }, label = { Text(stringResource(R.string.agent_ws_model_label)) }, singleLine = true)
            OutlinedTextField(secret, { secret = it }, label = { Text(if (original?.flag("has_api_key") == true) stringResource(R.string.agent_ws_api_key_keep) else stringResource(R.string.agent_ws_api_key)) }, singleLine = true, visualTransformation = PasswordVisualTransformation())
            OutlinedTextField(timeout, { timeout = it.filter(Char::isDigit) }, label = { Text(stringResource(R.string.agent_ws_timeout_seconds_label)) }, singleLine = true)
            OutlinedTextField(budget, { budget = it.filter(Char::isDigit) }, label = { Text(stringResource(R.string.agent_ws_daily_budget_label)) }, singleLine = true)
            ResearchChoice(stringResource(R.string.agent_ws_reasoning_effort), effort, listOf("auto" to stringResource(R.string.agent_ws_reasoning_effort_auto), "none" to "none", "low" to "low", "medium" to "medium", "high" to "high", "max" to "max", "xhigh" to "xhigh")) { effort = it }
            OutlinedTextField(outputLimit, { outputLimit = it.filter(Char::isDigit) }, label = { Text(stringResource(R.string.agent_ws_max_output_tokens_label)) }, singleLine = true)
            if (protocol == "responses" && provider in listOf("openai", "deepseek", "qwen")) { Row(Modifier.fillMaxWidth().clickable { nativeSearch = !nativeSearch }, verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_native_web_search), Modifier.weight(1f)); Switch(nativeSearch, { nativeSearch = it }) }; Text(stringResource(R.string.agent_ws_native_search_billing_hint), style = MaterialTheme.typography.bodySmall) }
            Row(Modifier.fillMaxWidth().clickable { streamOutput = !streamOutput }, verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_stream_output), Modifier.weight(1f)); Switch(streamOutput, { streamOutput = it }) }
            Text(stringResource(R.string.agent_ws_stream_output_hint), style = MaterialTheme.typography.bodySmall)
            Row(Modifier.fillMaxWidth().clickable { enabled = !enabled }, verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_enable_connection), Modifier.weight(1f)); Switch(enabled, { enabled = it }) }
            Row(Modifier.fillMaxWidth().clickable { background = !background }, verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_allow_auto_inspection), Modifier.weight(1f)); Switch(background, { background = it }) }
            Text(stringResource(R.string.agent_ws_allow_auto_inspection_hint), style = MaterialTheme.typography.bodySmall)
            if (admin && original == null) Row(Modifier.fillMaxWidth().clickable { instance = !instance }, verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_instance_connection), Modifier.weight(1f)); Switch(instance, { instance = it }) }
            if (admin && instance) Row(Modifier.fillMaxWidth().clickable { shared = !shared }, verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_share_with_others), Modifier.weight(1f)); Switch(shared, { shared = it }) }
            Text(stringResource(R.string.agent_ws_connection_test_notice), style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        val body = jsonBody("name" to name, "base_url" to base.trim(), "model" to model.trim(), "timeout" to (timeout.toIntOrNull() ?: 0), "daily_call_budget" to (budget.toIntOrNull() ?: 0), "enabled" to enabled, "background_allowed" to background)
        body.addProperty("protocol", protocol); body.addProperty("provider", provider); body.addProperty("reasoning_effort", effort); body.addProperty("max_output_tokens", outputLimit.toIntOrNull() ?: 0); body.addProperty("native_search", nativeSearch); body.addProperty("stream_output", streamOutput)
        if (original == null) body.addProperty("scope", if (instance) "instance" else "personal") else body.addProperty("version", original.number("version"))
        if (admin && instance) body.addProperty("shared", shared)
        if (secret.isNotBlank()) body.addProperty("api_key", secret)
        vm.agent.request(if (original == null) "connections" else "connections/${original.text("id")}", if (original == null) "POST" else "PATCH", body)
        secret = ""; saved(); dismiss()
    } } }, enabled = !action.busy && name.isNotBlank() && base.isNotBlank() && model.isNotBlank()) { Text(stringResource(R.string.agent_ws_save)) } }, dismissButton = { TextButton({ secret = ""; dismiss() }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_cancel)) } })
}

@Composable internal fun AgentChannels(vm: MusicViewModel) {
    var targets by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var deliveries by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var preferences by remember { mutableStateOf<JsonObject?>(null) }; var edit by remember { mutableStateOf(false) }; var add by remember { mutableStateOf(false) }
    var verify by remember { mutableStateOf<JsonObject?>(null) }; var code by remember { mutableStateOf("") }; var deleting by remember { mutableStateOf<JsonObject?>(null) }
    var retry by remember { mutableStateOf<JsonObject?>(null) }; var retention by remember { mutableStateOf("30") }
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    suspend fun load() {
        targets = vm.agent.all("telegram-targets"); deliveries = vm.agent.all("deliveries"); preferences = vm.agent.request("notification-preferences")
        retention = vm.agent.request("assistant-preferences").number("retention_days", 30).toString()
    }
    LaunchedEffect(Unit) { action.run { load() }; if (action.message == AppLanguage.string(R.string.completed) || action.message == "\u5df2\u5b8c\u6210") action.message = null }
    LazyColumn(Modifier.fillMaxSize().testTag("agent-channels"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text(stringResource(R.string.agent_ws_in_app_notifications_always_on), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.agent_ws_in_app_notifications_hint), style = MaterialTheme.typography.bodySmall)
            Row { TextButton({ edit = true }, enabled = preferences != null) { Text(stringResource(R.string.agent_ws_telegram_sub_and_quiet)) }; IconButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, stringResource(R.string.agent_ws_refresh_channel_settings)) } }
            ActionStatus(action)
        }
        item { Row(verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_telegram_targets), Modifier.weight(1f), fontWeight = FontWeight.Medium); TextButton({ add = true }) { Text(stringResource(R.string.agent_ws_add)) } } }
        items(targets, key = { it.text("id") }) { target -> AgentCard {
            Text(target.text("name"), fontWeight = FontWeight.Medium)
            Text(if (!target.flag("verified")) stringResource(R.string.agent_ws_target_pending_verify) else if (target.flag("enabled")) stringResource(R.string.agent_ws_target_verified_enabled) else stringResource(R.string.agent_ws_target_verified_disabled), style = MaterialTheme.typography.bodySmall)
            Row {
                if (!target.flag("verified")) TextButton({ scope.launch { action.run { vm.agent.request("telegram-targets/${target.text("id")}/verify-send", "POST"); verify = target; code = ""; action.message = AppLanguage.string(R.string.agent_ws_verify_code_sent) } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_send_verify_code)) }
                else {
                    TextButton({ scope.launch { action.run { vm.agent.request("telegram-targets/${target.text("id")}/test", "POST"); action.message = AppLanguage.string(R.string.agent_ws_test_submitted); load() } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_send_test)) }
                    TextButton({ scope.launch { action.run { vm.agent.request("telegram-targets/${target.text("id")}", "PATCH", jsonBody("enabled" to !target.flag("enabled"), "version" to target.number("version"))); load() } } }, enabled = !action.busy) { Text(if (target.flag("enabled")) stringResource(R.string.agent_ws_disable) else stringResource(R.string.agent_ws_enable)) }
                }
                TextButton({ deleting = target }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_delete)) }
            }
        } }
        item { Text(stringResource(R.string.agent_ws_delivery_history), fontWeight = FontWeight.Medium) }
        if (deliveries.isEmpty()) item { Text(stringResource(R.string.agent_ws_no_deliveries), style = MaterialTheme.typography.bodySmall) }
        items(deliveries, key = { "delivery-${it.text("id")}" }) { delivery -> AgentCard {
            Text(mapOf("queued" to AppLanguage.string(R.string.agent_ws_delivery_status_queued), "sending" to AppLanguage.string(R.string.agent_ws_delivery_status_sending), "retry_wait" to AppLanguage.string(R.string.agent_ws_delivery_status_retry_wait), "sent" to AppLanguage.string(R.string.agent_ws_delivery_status_sent), "failed" to AppLanguage.string(R.string.agent_ws_delivery_status_failed), "unknown" to AppLanguage.string(R.string.agent_ws_delivery_status_unknown), "cancelled" to AppLanguage.string(R.string.agent_ws_delivery_status_cancelled))[delivery.text("status")] ?: delivery.text("status"), fontWeight = FontWeight.Medium)
            Text(stringResource(R.string.agent_ws_delivery_attempts, delivery.number("attempt")), style = MaterialTheme.typography.bodySmall)
            delivery.text("error_code").takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }; AgentTrace(delivery)
            if (delivery.text("status") in listOf("failed", "unknown", "retry_wait")) TextButton({ retry = delivery }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_retry_delivery)) }
        } }
        item { HorizontalDivider(); Text(stringResource(R.string.agent_ws_assistant_history), Modifier.padding(top = 12.dp), fontWeight = FontWeight.Medium)
            OutlinedTextField(retention, { retention = it.filter(Char::isDigit) }, label = { Text(stringResource(R.string.agent_ws_retention_days_label)) }, singleLine = true)
            Text(stringResource(R.string.agent_ws_retention_days_hint), style = MaterialTheme.typography.bodySmall)
            TextButton({ scope.launch { action.run { vm.agent.request("assistant-preferences", "PUT", jsonBody("retention_days" to (retention.toIntOrNull() ?: 0))) } } }, enabled = !action.busy && (retention.toIntOrNull() ?: 0) in 1..365) { Text(stringResource(R.string.agent_ws_save_retention)) }
        }
    }
    if (add) AgentTelegramForm(vm, { add = false }) { scope.launch { action.run { load() } } }
    if (edit && preferences != null) AgentNotificationPreferences(vm, preferences!!, { edit = false }) { scope.launch { action.run { load() } } }
    verify?.let { target -> AlertDialog(onDismissRequest = { verify = null }, title = { Text(stringResource(R.string.agent_ws_verify_target_title)) }, text = { Column {
        Text(stringResource(R.string.agent_ws_verify_target_desc, target.text("name")))
        OutlinedTextField(code, { code = it }, label = { Text(stringResource(R.string.agent_ws_verify_code_label)) }, singleLine = true); ActionStatus(action)
    } }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("telegram-targets/${target.text("id")}/verify", "POST", jsonBody("code" to code.trim())); code = ""; verify = null; load() } } }, enabled = !action.busy && code.isNotBlank()) { Text(stringResource(R.string.agent_ws_verify_and_enable)) } }, dismissButton = { TextButton({ verify = null; code = "" }) { Text(stringResource(R.string.agent_ws_cancel)) } }) }
    deleting?.let { target -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text(stringResource(R.string.agent_ws_delete_target_title)) }, text = { Text(stringResource(R.string.agent_ws_delete_target_confirm, target.text("name"))) }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("telegram-targets/${target.text("id")}", "DELETE"); deleting = null; load() } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_delete)) } }, dismissButton = { TextButton({ deleting = null }) { Text(stringResource(R.string.agent_ws_cancel)) } }) }
    retry?.let { delivery -> AlertDialog(onDismissRequest = { retry = null }, title = { Text(stringResource(R.string.agent_ws_resend_delivery_title)) }, text = { Text(if (delivery.text("status") == "unknown") stringResource(R.string.agent_ws_resend_delivery_unknown) else stringResource(R.string.agent_ws_resend_delivery_confirm)) }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("deliveries/${delivery.text("id")}/retry", "POST", jsonBody("acknowledge_unknown" to (delivery.text("status") == "unknown"))); retry = null; load() } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_confirm_retry)) } }, dismissButton = { TextButton({ retry = null }) { Text(stringResource(R.string.agent_ws_cancel)) } }) }
}

@Composable private fun AgentTelegramForm(vm: MusicViewModel, dismiss: () -> Unit, saved: () -> Unit) {
    val defaultTgName = stringResource(R.string.agent_ws_default_telegram_name)
    var name by remember { mutableStateOf(defaultTgName) }; var token by remember { mutableStateOf("") }; var chat by remember { mutableStateOf("") }; var topic by remember { mutableStateOf("") }; var direct by remember { mutableStateOf(false) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text(stringResource(R.string.agent_ws_add_telegram_title)) }, text = {
        Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.agent_ws_name_label)) }, singleLine = true)
            OutlinedTextField(token, { token = it }, label = { Text(stringResource(R.string.agent_ws_bot_token_label)) }, singleLine = true, visualTransformation = PasswordVisualTransformation())
            OutlinedTextField(chat, { chat = it }, label = { Text(stringResource(R.string.agent_ws_chat_id_label)) }, singleLine = true)
            OutlinedTextField(topic, { topic = it.filter(Char::isDigit) }, label = { Text(stringResource(R.string.agent_ws_topic_id_label)) }, singleLine = true)
            Row(Modifier.fillMaxWidth().clickable { direct = !direct }, verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_direct_telegram), Modifier.weight(1f)); Switch(direct, { direct = it }) }
            Text(if (direct) stringResource(R.string.agent_ws_direct_telegram_hint) else stringResource(R.string.agent_ws_inherit_proxy_hint), style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.agent_ws_telegram_verify_notice), style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        vm.agent.request("telegram-targets", "POST", jsonBody("name" to name, "bot_token" to token.trim(), "chat_id" to chat.trim(), "topic_id" to topic.toLongOrNull(), "proxy_mode" to if (direct) "direct" else "inherit", "enabled" to false)); token = ""; saved(); dismiss()
    } } }, enabled = !action.busy && name.isNotBlank() && token.isNotBlank() && chat.isNotBlank()) { Text(stringResource(R.string.agent_ws_save_target)) } }, dismissButton = { TextButton({ token = ""; dismiss() }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_cancel)) } })
}
@Composable private fun AgentNotificationPreferences(vm: MusicViewModel, initial: JsonObject, dismiss: () -> Unit, saved: () -> Unit) {
    var enabled by remember { mutableStateOf(initial.flag("telegram_enabled")) }; var severity by remember { mutableStateOf(initial.text("min_severity", "info")) }
    var start by remember { mutableStateOf(initial.text("quiet_start")) }; var end by remember { mutableStateOf(initial.text("quiet_end")) }; var timezone by remember { mutableStateOf(initial.text("timezone", java.util.TimeZone.getDefault().id)) }
    var events by remember { mutableStateOf(initial.getAsJsonArray("event_types")?.map { it.asString }?.toSet() ?: emptySet()) }
    val choices = listOf("draft.pending" to stringResource(R.string.agent_ws_event_draft_pending), "draft.applied" to stringResource(R.string.agent_ws_event_draft_applied), "task.completed" to stringResource(R.string.agent_ws_event_task_completed), "task.partial" to stringResource(R.string.agent_ws_event_task_partial), "task.failed" to stringResource(R.string.agent_ws_event_task_failed), "task.paused" to stringResource(R.string.agent_ws_event_task_paused))
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text(stringResource(R.string.agent_ws_telegram_sub_title)) }, text = {
        Column(Modifier.heightIn(max = 500.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth().clickable { enabled = !enabled }, verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.agent_ws_receive_telegram_notifications), Modifier.weight(1f)); Switch(enabled, { enabled = it }) }
            Text(stringResource(R.string.agent_ws_event_types_label), style = MaterialTheme.typography.labelLarge)
            choices.forEach { (id, title) -> Row(Modifier.fillMaxWidth().clickable { events = if (id in events) events - id else events + id }, verticalAlignment = Alignment.CenterVertically) { Checkbox(id in events, { checked -> events = if (checked) events + id else events - id }); Text(title) } }
            Row { listOf("info" to stringResource(R.string.agent_ws_severity_all), "warning" to stringResource(R.string.agent_ws_severity_warning), "error" to stringResource(R.string.agent_ws_severity_error)).forEach { (id, title) -> FilterChip(severity == id, { severity = id }, label = { Text(title) }, modifier = Modifier.padding(end = 4.dp)) } }
            OutlinedTextField(start, { start = it }, label = { Text(stringResource(R.string.agent_ws_quiet_start_label)) }, singleLine = true)
            OutlinedTextField(end, { end = it }, label = { Text(stringResource(R.string.agent_ws_quiet_end_label)) }, singleLine = true)
            OutlinedTextField(timezone, { timezone = it }, label = { Text(stringResource(R.string.agent_ws_timezone_label)) }, singleLine = true)
            Text(stringResource(R.string.agent_ws_quiet_hours_hint), style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        vm.agent.request("notification-preferences", "PUT", jsonBody("telegram_enabled" to enabled, "event_types" to jsonStrings(events.toList()), "min_severity" to severity,
            "quiet_start" to start.takeIf { it.isNotBlank() }, "quiet_end" to end.takeIf { it.isNotBlank() }, "timezone" to timezone)); saved(); dismiss()
    } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_save)) } }, dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text(stringResource(R.string.agent_ws_cancel)) } })
}
