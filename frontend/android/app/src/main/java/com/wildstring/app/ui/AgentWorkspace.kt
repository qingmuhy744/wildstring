@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.FactCheck
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Same authenticated business API as Web and MCP; approval always previews a concrete version. */
@Composable internal fun AgentWorkspace(vm: MusicViewModel, initialTab: String = "chat") {
    val owner by vm.repository.session.profiles.collectAsStateWithLifecycle()
    key(owner) {
        var tab by remember { mutableStateOf(initialTab) }
        var selected by remember { mutableStateOf<String?>(null) }
        val tabs = listOf("chat" to "助手", "notifications" to "通知", "drafts" to "草案", "tasks" to "巡检", "connections" to "AI 连接", "research" to "联网与记忆", "channels" to "通知设置")
        Column(Modifier.fillMaxSize().testTag("agent-workspace")) {
            PrimaryScrollableTabRow(tabs.indexOfFirst { it.first == tab }.coerceAtLeast(0), edgePadding = 8.dp) {
                tabs.forEach { (id, title) -> Tab(tab == id, { tab = id; selected = null }, text = { Text(title) }, modifier = Modifier.testTag("agent-tab-$id")) }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (tab) {
                    "chat" -> AgentChat(vm) { draft -> selected = draft; tab = "drafts" }
                    "notifications" -> AgentNotifications(vm) { type, id -> selected = id; tab = type }
                    "drafts" -> AgentDrafts(vm, selected)
                    "tasks" -> AgentTasks(vm, selected)
                    "connections" -> AgentConnections(vm)
                    "research" -> AgentResearch(vm)
                    else -> AgentChannels(vm)
                }
            }
        }
    }
}

@Composable private fun AgentError(message: String?) { message?.let { SelectionContainer { Text(it, Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) } } }
@Composable private fun AgentTrace(value: JsonObject) { value.text("trace_id").takeIf { it.isNotBlank() }?.let { SelectionContainer { Text("诊断编号：$it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
@Composable private fun AgentEmpty(text: String) { Text(text, Modifier.padding(vertical = 24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
@Composable private fun AgentCard(content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}
private fun taskLabel(status: String): String = mapOf("queued" to "等待开始", "running" to "正在巡检", "retry_wait" to "等待重试", "paused_authorization" to "授权暂停", "paused_budget" to "预算暂停", "cancel_requested" to "正在取消", "cancelled" to "已取消", "succeeded" to "已完成", "partial" to "部分完成", "failed" to "失败", "interrupted" to "已中断")[status] ?: status
private fun draftLabel(status: String): String = mapOf("pending" to "待确认", "approved" to "已批准，尚未应用", "applied" to "已应用", "rejected" to "已拒绝")[status] ?: status
private fun localAgentTime(value: String): String = runCatching { Instant.parse(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")) }.getOrDefault(value)

@Composable private fun AgentNotifications(vm: MusicViewModel, open: (String, String) -> Unit) {
    val state by vm.agent.inbox.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    val owner = vm.repository.session.cacheScope()
    val valid = state.owner == owner
    LaunchedEffect(owner) { vm.agent.refreshInbox() }
    LazyColumn(Modifier.fillMaxSize().testTag("agent-notifications"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${if (valid) state.unread else 0} 条未读", Modifier.weight(1f), fontWeight = FontWeight.Medium)
                IconButton({ scope.launch { vm.agent.refreshInbox(force = true) } }, enabled = !state.loading) { Icon(Icons.Default.Refresh, "刷新通知") }
                TextButton({ scope.launch { action.run { vm.agent.readSnapshot() } } }, enabled = !action.busy && valid && state.items.isNotEmpty()) { Text("全部已读") }
            }
            Text("查看列表不会标记已读。其他设备的已读状态会自动同步。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            AgentError(state.error); ActionStatus(action)
        }
        if (valid) items(state.items, key = { it.text("id") }) { notice ->
            AgentCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (notice.text("read_at").isBlank()) Icon(Icons.Default.Circle, "未读", Modifier.padding(end = 8.dp).size(8.dp), tint = MaterialTheme.colorScheme.primary)
                    Text(notice.text("title"), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    if (notice.text("severity") != "info") Icon(Icons.Default.Info, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error)
                }
                Text(notice.text("summary")); Text(localAgentTime(notice.text("created_at")), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                AgentTrace(notice)
                Row {
                    notice.text("draft_id").takeIf { it.isNotBlank() }?.let { TextButton({ open("drafts", it) }) { Text("查看草案") } }
                    notice.text("task_id").takeIf { it.isNotBlank() }?.let { TextButton({ open("tasks", it) }) { Text("查看巡检") } }
                    if (notice.text("read_at").isBlank()) TextButton({ scope.launch { action.run { vm.agent.readNotification(notice.text("id")) } } }, enabled = !action.busy,
                        modifier = Modifier.testTag("notice-read-${notice.text("id")}")) { Text("标为已读") }
                }
            }
        }
        if (valid && state.items.isEmpty() && !state.loading && state.error == null) item { AgentEmpty("还没有通知。后台结果会在你下次打开时出现在这里。") }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

@Composable private fun AgentDrafts(vm: MusicViewModel, selectedId: String?) {
    var drafts by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    suspend fun load() { drafts = vm.agent.all("drafts"); selectedId?.let { id -> selected = drafts.firstOrNull { it.text("id") == id } ?: vm.agent.request("drafts/$id") } }
    LaunchedEffect(Unit) { action.run { load() }; if (action.message == "已完成") action.message = null }
    LazyColumn(Modifier.fillMaxSize().testTag("agent-drafts"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Row(verticalAlignment = Alignment.CenterVertically) { Text("确认后才会修改", Modifier.weight(1f), fontWeight = FontWeight.Medium); IconButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, "刷新草案") } }; ActionStatus(action) }
        if (!action.busy && drafts.isEmpty() && action.message == null) item { AgentEmpty("暂时没有草案。可让助手或 MCP 先整理候选。") }
        items(drafts, key = { it.text("id") }) { draft ->
            AgentCard { Text(draft.text("title"), fontWeight = FontWeight.SemiBold); Text(draftLabel(draft.text("status")), color = MaterialTheme.colorScheme.primary); AgentTrace(draft)
                TextButton({ selected = draft }, Modifier.testTag("draft-open-${draft.text("id")}")) { Text("查看差异与依据") } }
        }
    }
    selected?.let { current -> AgentDraftDetail(vm, current, { selected = null }) { updated -> selected = updated; drafts = drafts.map { if (it.text("id") == updated.text("id")) updated else it } } }
}

internal fun fieldName(key: String) = mapOf("title" to "歌名", "artists" to "艺人", "album" to "专辑", "album_artists" to "专辑艺人", "track_number" to "曲号", "disc_number" to "碟号", "genre" to "流派", "date" to "日期", "lyricists" to "作词", "composers" to "作曲", "arrangers" to "编曲", "name" to "歌单名", "track_ids" to "歌曲")[key] ?: key
internal fun displayValue(value: com.google.gson.JsonElement?): String = when { value == null || value.isJsonNull -> "未设置"; value.isJsonPrimitive -> value.asString; value.isJsonArray -> value.asJsonArray.joinToString(" / ") { displayValue(it) }; else -> value.toString() }
@Composable private fun AgentDraftDetail(vm: MusicViewModel, initial: JsonObject, dismiss: () -> Unit, updated: (JsonObject) -> Unit) {
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
            if (draft.text("kind") == "metadata") Text("歌曲：${tracks[payload.text("track_id")] ?: payload.text("track_id")}")
            if (draft.text("kind") == "intake") Text("导入来源：${before.text("source_path")}。应用后安排复制到托管曲库，保留导入源。")
            if (draft.text("kind") == "lyrics") {
                Text("歌曲：${before.text("title")} · ${before.text("provider")}")
                Text("${before.getAsJsonObject("current_quality")?.text("label")} → ${before.getAsJsonObject("candidate_quality")?.text("label")}")
                Text("同步偏移：${payload.number("offset_ms")} ms")
                Text("匹配依据：${before.text("match")}", style = MaterialTheme.typography.bodySmall)
                Text("当前歌词预览", fontWeight = FontWeight.Medium)
                before.objects("current_lines").forEach { Text(it.text("text"), style = MaterialTheme.typography.bodySmall) }
                Text("候选歌词预览", fontWeight = FontWeight.Medium)
                before.objects("candidate_lines").forEach { Text(listOf(it.text("text"), it.text("translation")).filter { v -> v.isNotBlank() }.joinToString(" / "), style = MaterialTheme.typography.bodySmall) }
            }
            if (draft.text("kind") in listOf("cover", "metadata_batch")) CurationDraftPreview(vm, draft) { coverReady = it }
            changes.entrySet().filter { draft.text("kind") !in listOf("lyrics", "cover", "metadata_batch") && it.key !in listOf("track_id", "metadata_version", "playlist_id", "playlist_version", "file_version", "candidate_id") }.forEach { (field, value) ->
                Text(fieldName(field), fontWeight = FontWeight.Medium)
                if (field == "track_ids") {
                    value.asJsonArray.forEachIndexed { index, id -> Text("${index + 1}. ${tracks[id.asString] ?: id.asString}", style = MaterialTheme.typography.bodySmall) }
                } else Text("${displayValue(before.get(field))} → ${displayValue(value)}", style = MaterialTheme.typography.bodyMedium)
            }
            draft.objects("evidence").forEach { evidence -> Text("${evidence.text("source")} · ${evidence.text("summary")}", style = MaterialTheme.typography.bodySmall); evidence.text("url").takeIf { it.isNotBlank() }?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.labelSmall) } } }
            Text("版本 ${draft.number("version")} · 导入仅复制；资料与歌词更新保存在应用内，不写回音乐文件。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            AgentTrace(draft); ActionStatus(action)
        }
    }, confirmButton = {
        if (draft.text("status") in listOf("pending", "approved")) TextButton({ confirm = if (draft.text("status") == "pending") "approve" else "apply" }, enabled = !action.busy && (draft.text("kind") != "cover" || coverReady), modifier = Modifier.testTag("draft-confirm")) { Text(if (draft.text("status") == "pending") "批准此版本" else "应用已批准草案") }
    }, dismissButton = { Row { if (draft.text("status") in listOf("pending", "approved")) TextButton({ confirm = "reject" }, enabled = !action.busy) { Text("拒绝") }; TextButton(dismiss, enabled = !action.busy) { Text("关闭") } } })
    confirm?.let { operation ->
        AlertDialog(onDismissRequest = { if (!action.busy) confirm = null }, title = { Text(when (operation) { "approve" -> "批准当前差异？"; "apply" -> "应用这个版本？"; else -> "拒绝这份草案？" }) },
            text = { Text("${draft.text("title")} · 版本 ${draft.number("version")}" + if (operation == "approve") "。批准后仍需点击应用。" else "。服务器会再次校验版本与权限。") },
            confirmButton = { TextButton({ scope.launch { action.run {
                val body = jsonBody("version" to draft.number("version"))
                if (operation == "approve" && draft.text("preview_digest").isNotBlank()) body.addProperty("preview_digest", draft.text("preview_digest"))
                if (operation == "apply") body.addProperty("idempotency_key", "android-${draft.text("id")}-${draft.number("version")}")
                draft = vm.agent.request("drafts/${draft.text("id")}/$operation", "POST", body); updated(draft); confirm = null; vm.agent.refreshInbox()
            } } }, enabled = !action.busy, modifier = Modifier.testTag("draft-confirm-$operation")) { Text("确认") } }, dismissButton = { TextButton({ confirm = null }, enabled = !action.busy) { Text("取消") } })
    }
}

@Composable private fun AgentChat(vm: MusicViewModel, openDraft: (String) -> Unit) {
    val links = LocalUriHandler.current
    var showSummary by remember { mutableStateOf(false) }
    var conversations by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var conversation by remember { mutableStateOf<JsonObject?>(null) }
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var connection by remember { mutableStateOf<String?>(null) }
    var input by remember { mutableStateOf("") }; var history by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<JsonObject?>(null) }; var renaming by remember { mutableStateOf<JsonObject?>(null) }
    var title by remember { mutableStateOf("") }; var historyMenu by remember { mutableStateOf<String?>(null) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { action.run { connections = vm.agent.all("connections"); conversations = vm.agent.all("conversations") }; if (action.message == "已完成") action.message = null }
    val running = conversation?.objects("runs")?.any { it.text("status") == "running" } == true
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
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton({ scope.launch { action.run { conversations = vm.agent.all("conversations"); history = true; action.message = null } } }, enabled = !action.busy) { Icon(Icons.Default.History, null); Text("历史") }
            TextButton({ conversation = null; input = "" }, enabled = !action.busy) { Icon(Icons.Default.Add, null); Text("新对话") }
            Spacer(Modifier.weight(1f))
            if (conversation != null) {
                IconButton({ scope.launch { action.run { conversation = vm.agent.request("conversations/${conversation!!.text("id")}"); action.message = null } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, "刷新当前对话") }
                IconButton({ deleting = conversation; action.message = null }, enabled = !action.busy) { Icon(Icons.Default.DeleteOutline, "删除当前对话") }
            }
        }
        AgentConnectionChoice(connections, connection, !action.busy) { connection = it }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("agent-messages"), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 12.dp)) {
            conversation?.get("context_summary")?.takeIf { it.isJsonObject }?.asJsonObject?.let { summary -> item {
                TextButton({ showSummary = !showSummary }) { Text("已压缩较早对话 · 查看上下文摘要") }
                if (showSummary) { Text(summary.text("summary"), style = MaterialTheme.typography.bodySmall); TextButton({ scope.launch { action.run { val id = conversation!!.text("id"); vm.agent.request("conversations/$id/summary", "DELETE"); conversation = vm.agent.request("conversations/$id") } } }, enabled = !action.busy) { Text("清除摘要") } }
            } }
            if (conversation == null) item { AgentEmpty("试试“把我很久没听的收藏整理成歌单”。助手会先生成草案，等你确认。未配置 AI 时仍可本地找歌。") }
            items(conversation?.objects("messages") ?: emptyList(), key = { it.text("id") }) { message ->
                AgentCard { Text(if (message.text("role") == "user") "你" else "野弦", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary); if (message.flag("partial")) Text("正在生成 · 内容尚未完成", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant); SelectionContainer { if (message.text("role") == "assistant") AssistantMarkdown(message.text("content")) else Text(message.text("content")) }; message.objects("sources").forEach { source ->
                    source.text("url").takeIf { it.startsWith("https://") }?.let { url -> TextButton({ runCatching { links.openUri(url) }.onFailure { action.message = "无法打开来源。" } }) { Text("来源：${source.text("title")}") } }
                } }
            }
            conversation?.objects("runs")?.forEach { run -> item(key = "run-${run.text("id")}") {
                if (run.text("status") == "running") Text(when (run.text("stage")) { "search" -> "正在检索联网来源…"; "tools" -> "正在查询曲库与处理工具结果…"; "writing" -> "正在生成回答…"; else -> "正在分析已有资料…" }, style = MaterialTheme.typography.bodySmall)
                val fallback = run.text("status") == "local_fallback"
                if (fallback) Text("本地关键词检索 · 未调用模型", style = MaterialTheme.typography.bodySmall)
                if (run.text("error_code").isNotBlank()) Text("状态：${run.text("status")} · ${run.text("error_code")}", style = MaterialTheme.typography.bodySmall)
                run.getAsJsonArray("draft_ids")?.forEach { draft -> TextButton({ openDraft(draft.asString) }) { Text("查看生成的草案") } }
                AgentTrace(run)
            } }
            item { ActionStatus(action) }
        }
        conversation?.objects("runs")?.firstOrNull { it.text("status") == "running" }?.let { run ->
            Text(when (run.text("stage")) { "search" -> "正在检索联网来源…"; "tools" -> "正在查询曲库与处理工具结果…"; "writing" -> "正在生成回答…"; else -> "正在分析已有资料…" }, Modifier.padding(vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(input, { input = it }, Modifier.weight(1f).testTag("agent-chat-input"), placeholder = { Text("聊聊你的音乐") }, maxLines = 4, enabled = !action.busy && !running)
            IconButton({
                val content = input.trim(); if (content.isNotEmpty()) scope.launch { action.run {
                    var current = conversation ?: vm.agent.request("conversations", "POST", jsonBody("connection_id" to connection)).also { conversation = it }
                    val id = current.text("id")
                    try { current = vm.agent.request("conversations/$id/messages", "POST", jsonBody("content" to content, "connection_id" to connection, "max_calls" to 4)); conversation = current; input = ""; action.message = null; vm.agent.refreshInbox() }
                    catch (error: CancellationException) { throw error }
                    catch (error: Exception) {
                        try { conversation = vm.agent.request("conversations/$id") }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { /* The original operation still supplies its diagnostic ID. */ }
                        throw error
                    }
                } }
            }, enabled = !action.busy && !running && input.isNotBlank(), modifier = Modifier.testTag("agent-chat-send")) { if (action.busy) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) else Icon(Icons.AutoMirrored.Filled.Send, "发送") }
        }
    }
    if (history) AlertDialog(modifier = Modifier.testTag("agent-history-dialog"), onDismissRequest = { if (!action.busy) history = false }, title = { Text("历史对话") }, text = {
        LazyColumn(Modifier.heightIn(max = 400.dp).testTag("agent-history")) {
            item { ActionStatus(action) }
            if (conversations.isEmpty()) item { AgentEmpty("暂无历史。") }
            items(conversations, key = { it.text("id") }) { item ->
                ListItem(headlineContent = { Text(item.text("title"), maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.testTag("history-open-${item.text("id")}").clickable(enabled = !action.busy) { history = false; scope.launch { action.run { conversation = vm.agent.request("conversations/${item.text("id")}"); connection = conversation?.text("connection_id")?.takeIf { it.isNotBlank() } } } },
                    trailingContent = { Box {
                        IconButton({ historyMenu = item.text("id") }, enabled = !action.busy, modifier = Modifier.testTag("history-actions-${item.text("id")}")) { Icon(Icons.Default.MoreVert, "对话操作：${item.text("title")}") }
                        DropdownMenu(historyMenu == item.text("id"), { historyMenu = null }) {
                            DropdownMenuItem(text = { Text("改名") }, leadingIcon = { Icon(Icons.Default.Edit, null) }, onClick = { renaming = item; title = item.text("title"); historyMenu = null; action.message = null })
                            DropdownMenuItem(text = { Text("删除") }, leadingIcon = { Icon(Icons.Default.DeleteOutline, null) }, onClick = { deleting = item; historyMenu = null; action.message = null })
                        }
                    } },
                )
            }
        }
    }, confirmButton = { TextButton({ history = false }, enabled = !action.busy) { Text("关闭") } })
    renaming?.let { item -> AlertDialog(onDismissRequest = { if (!action.busy) renaming = null }, title = { Text("对话改名") }, text = {
        Column { OutlinedTextField(title, { title = it.take(200) }, label = { Text("对话名称") }, singleLine = true, enabled = !action.busy, modifier = Modifier.testTag("conversation-title")); ActionStatus(action) }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        val changed = vm.agent.request("conversations/${item.text("id")}", "PATCH", jsonBody("title" to title.trim()))
        conversations = conversations.map { if (it.text("id") == item.text("id")) changed else it }
        if (conversation?.text("id") == item.text("id")) conversation = changed
        renaming = null
    } } }, enabled = !action.busy && title.isNotBlank()) { Text("保存") } }, dismissButton = { TextButton({ renaming = null }, enabled = !action.busy) { Text("取消") } }) }
    deleting?.let { item -> AlertDialog(onDismissRequest = { if (!action.busy) deleting = null }, title = { Text("删除对话？") }, text = {
        Column { Text("删除「${item.text("title")}」的对话历史，已有草案单独保留。"); ActionStatus(action) }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        vm.agent.request("conversations/${item.text("id")}", "DELETE")
        if (conversation?.text("id") == item.text("id")) conversation = null
        conversations = conversations.filterNot { it.text("id") == item.text("id") }; deleting = null
    } } }, enabled = !action.busy) { Text("删除") } }, dismissButton = { TextButton({ deleting = null }, enabled = !action.busy) { Text("取消") } }) }
}

/** Every AI entry point uses the same permission-filtered connection list; null is explicitly local. */
@Composable internal fun AgentConnectionChoice(connections: List<JsonObject>, selected: String?, enabled: Boolean = true, emptyLabel: String = "本地找歌（不使用模型）", choose: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val chosen = connections.firstOrNull { it.text("id") == selected }
    Column {
        Box {
            TextButton({ open = true }, enabled = enabled, modifier = Modifier.testTag("ai-connection-choice")) {
                Text(if (selected == null) emptyLabel else chosen?.text("name") ?: "已选连接不可用")
                Icon(Icons.Default.ArrowDropDown, null)
            }
            DropdownMenu(open, { open = false }) {
                DropdownMenuItem(text = { Text(emptyLabel) }, onClick = { choose(null); open = false })
                connections.filter { it.flag("enabled") }.forEach { item ->
                    DropdownMenuItem(text = { Column {
                        Text("${item.text("name")} · ${item.text("model")}")
                        Text(connectionBudget(item), style = MaterialTheme.typography.labelSmall)
                    } }, onClick = { choose(item.text("id")); open = false })
                }
            }
        }
        if (selected != null) Text(chosen?.let(::connectionBudget) ?: "连接已删除或无权使用，请重新选择。", Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall)
    }
}

internal fun connectionBudget(connection: JsonObject): String {
    val scope = when { connection.flag("read_only") -> "实例兼容"; connection.text("scope") == "instance" -> "实例共享"; else -> "个人连接" }
    val used = connection.get("daily_calls_used")?.takeUnless { it.isJsonNull }?.asLong
    return "$scope · 每日预算 ${connection.number("daily_call_budget")} 次" + used?.let { " · 已用 $it 次" }.orEmpty()
}

@Composable private fun AgentTasks(vm: MusicViewModel, selectedId: String?) {
    var tasks by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var schedules by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }; var create by remember { mutableStateOf(false) }; var scheduling by remember { mutableStateOf(false) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    suspend fun load() { tasks = vm.agent.all("tasks"); schedules = vm.agent.all("schedules"); selectedId?.let { selected = vm.agent.request("tasks/$it") } }
    LaunchedEffect(Unit) { action.run { load() }; if (action.message == "已完成") action.message = null }
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(5000)
            if (tasks.any { it.text("status") in listOf("queued", "running", "cancel_requested", "retry_wait") }) {
                action.run { load() }; if (action.message == "已完成") action.message = null
            }
        }
    }
    LazyColumn(Modifier.fillMaxSize().testTag("agent-tasks"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) { FilledTonalButton({ create = true }) { Icon(Icons.AutoMirrored.Filled.FactCheck, null); Text("开始巡检") }; Spacer(Modifier.weight(1f)); IconButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, "刷新巡检") } }
            Text("默认只检查本地资料，不调用 AI，也不会自动应用修改。", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
        items(tasks, key = { it.text("id") }) { task -> AgentCard {
            Text("${taskLabel(task.text("status"))} · ${inspectionStage(task.text("stage"), task.text("status"))}", fontWeight = FontWeight.Medium)
            Text(localAgentTime(task.text("created_at")), style = MaterialTheme.typography.labelSmall); AgentCounts(task); AgentTrace(task)
            TextButton({ scope.launch { action.run { selected = vm.agent.request("tasks/${task.text("id")}") } } }, enabled = !action.busy) { Text("详情与恢复") }
        } }
        if (tasks.isEmpty() && !action.busy && action.message == null) item { AgentEmpty("还没有巡检任务。") }
        item { Row(verticalAlignment = Alignment.CenterVertically) { Text("定时巡检", Modifier.weight(1f), fontWeight = FontWeight.Medium); TextButton({ scheduling = true }) { Text("新建计划") } } }
        items(schedules, key = { "schedule-${it.text("id")}" }) { schedule -> AgentScheduleCard(vm, schedule) { scope.launch { action.run { load() } } } }
    }
    if (create || scheduling) AgentInspectionForm(vm, scheduling, { create = false; scheduling = false }) { scope.launch { action.run { load() } } }
    selected?.let { task ->
        val status = task.text("status")
        AlertDialog(onDismissRequest = { selected = null }, title = { Text("巡检 · ${taskLabel(status)}") }, text = {
            Column(Modifier.testTag("inspection-task-detail").heightIn(max = 460.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("阶段：${inspectionStage(task.text("stage"), status)}"); AgentCounts(task)
                task.text("error_code").takeIf { it.isNotBlank() }?.let { Text(agentError(502, it, null), color = MaterialTheme.colorScheme.error) }
                task.objects("results").forEach { result ->
                    if (result.text("analysis").isNotBlank()) {
                        Text(if (result.flag("ai_skipped")) "规则检查说明" else "AI 分析结果", fontWeight = FontWeight.Medium)
                        Text(result.text("analysis"))
                    } else {
                        Text(result.text("title"), fontWeight = FontWeight.Medium)
                        result.objects("findings").forEach { finding -> Text(finding.text("summary"), style = MaterialTheme.typography.bodySmall) }
                        Text(result.getAsJsonArray("issues")?.joinToString(" · ") { issue -> mapOf("missing_album" to "缺少专辑", "missing_cover" to "缺少封面", "missing_lyrics" to "未读到歌词（纯音乐可能正常）", "missing_track_number" to "曲序待核对", "track_number_conflict" to "同碟曲序重复", "track_number_out_of_range" to "曲序超过总曲数", "disc_number_out_of_range" to "碟号超过总碟数", "missing_disc_number" to "多碟专辑缺少碟号", "same_title_versions" to "同名歌曲版本待核对", "possible_duplicate_recording" to "同名且时长接近，需核对音频", "possible_multidisc_split" to "多碟专辑可能被拆分")[issue.asString] ?: issue.asString }.orEmpty(), style = MaterialTheme.typography.bodySmall)
                    }
                }
                AgentTrace(task); if (action.message != "已完成") ActionStatus(action)
            }
        }, confirmButton = { Row {
            if (status in listOf("queued", "running", "retry_wait", "paused_authorization", "paused_budget")) TextButton({ scope.launch { action.run { selected = vm.agent.request("tasks/${task.text("id")}/cancel", "POST"); tasks = vm.agent.all("tasks") } } }, enabled = !action.busy) { Text("请求取消") }
            if (status in listOf("paused_authorization", "paused_budget", "failed", "interrupted", "partial")) TextButton({ scope.launch { action.run { selected = vm.agent.request("tasks/${task.text("id")}/resume", "POST"); tasks = vm.agent.all("tasks") } } }, enabled = !action.busy) { Text("恢复巡检") }
            TextButton({ scope.launch { action.run { selected = vm.agent.request("tasks/${task.text("id")}") } } }, enabled = !action.busy) { Text("刷新") }
        } }, dismissButton = { TextButton({ selected = null }) { Text("关闭") } })
    }
}
@Composable private fun AgentCounts(task: JsonObject) {
    task.getAsJsonObject("counts")?.entrySet()?.takeIf { it.isNotEmpty() }?.let { counts ->
        Text(counts.joinToString(" · ") { (name, value) -> "${mapOf("processed" to "已检查", "checked" to "已检查", "total" to "总数", "issues" to "本地问题", "drafts" to "草案", "failed" to "曲目失败", "skipped" to "跳过", "calls" to "模型调用")[name] ?: name} ${displayValue(value)}" }, style = MaterialTheme.typography.bodySmall)
    }
}
@Composable private fun AgentInspectionForm(vm: MusicViewModel, schedule: Boolean, dismiss: () -> Unit, submitted: () -> Unit) {
    var name by remember { mutableStateOf("每日曲库巡检") }; var maxTracks by remember { mutableStateOf("500") }; var ai by remember { mutableStateOf(false) }
    var maxCalls by remember { mutableStateOf("4") }; var connection by remember { mutableStateOf<String?>(null) }; var hours by remember { mutableStateOf("24") }
    var timezone by remember { mutableStateOf(java.util.TimeZone.getDefault().id) }; var enabled by remember { mutableStateOf(false) }; var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { action.run { connections = vm.agent.all("connections") }; if (action.message == "已完成") action.message = null }
    val available = connections.filter { it.flag("enabled") && (!schedule || it.flag("background_allowed")) }
    val selectedAvailable = available.any { it.text("id") == connection }
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text(if (schedule) "定时巡检" else "开始曲库巡检") }, text = {
        Column(Modifier.heightIn(max = 500.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (schedule) OutlinedTextField(name, { name = it }, label = { Text("计划名称") }, singleLine = true)
            OutlinedTextField(maxTracks, { maxTracks = it.filter(Char::isDigit) }, label = { Text("最多检查歌曲数") }, singleLine = true)
            Row(verticalAlignment = Alignment.CenterVertically) { Text("使用 AI 分析", Modifier.weight(1f)); Switch(ai, { ai = it }, modifier = Modifier.testTag("inspection-use-ai")) }
            if (ai) {
                AgentConnectionChoice(available, connection, !action.busy, emptyLabel = "请选择 AI 连接") { connection = it }
                if (!selectedAvailable && !action.busy) Text(
                    if (available.isEmpty()) {
                        if (schedule) "没有可用于定时巡检的连接。请在「AI 连接」添加或编辑连接，开启「允许自动巡检使用」。"
                        else "没有可用的 AI 连接。请先在「AI 连接」添加并启用连接。"
                    } else "请选择用于本次巡检的 AI 连接。",
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedTextField(maxCalls, { maxCalls = it.filter(Char::isDigit) }, label = { Text("最多模型调用次数") }, singleLine = true)
                Text(if (schedule) "定时巡检仅使用已授权自动使用的连接，受每日预算约束。结果先生成草案。" else "点击开始仅授权本次 AI 巡检，可能产生模型费用，受调用上限与每日预算约束。结果先生成草案。", style = MaterialTheme.typography.bodySmall)
            }
            if (schedule) {
                OutlinedTextField(hours, { hours = it.filter(Char::isDigit) }, label = { Text("间隔小时（1–720）") }, singleLine = true)
                OutlinedTextField(timezone, { timezone = it }, label = { Text("时区") }, singleLine = true)
                Row(verticalAlignment = Alignment.CenterVertically) { Text("启用计划", Modifier.weight(1f)); Switch(enabled, { enabled = it }) }
            }
            Text("检查和草案不会改动音乐文件；应用仍需你批准。", style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        val parameters = jsonBody("max_tracks" to (maxTracks.toIntOrNull() ?: 0), "use_ai" to ai, "max_calls" to if (ai) maxCalls.toIntOrNull() ?: 0 else 0, "connection_id" to if (ai) connection else null)
        if (schedule) vm.agent.request("schedules", "POST", jsonBody("name" to name, "enabled" to enabled, "interval_hours" to (hours.toIntOrNull() ?: 0), "timezone" to timezone, "parameters" to parameters)) else vm.agent.request("tasks", "POST", parameters)
        submitted(); dismiss(); vm.agent.refreshInbox()
    } } }, enabled = !action.busy && (maxTracks.toIntOrNull() ?: 0) in 1..5000 && (!ai || (selectedAvailable && (maxCalls.toIntOrNull() ?: 0) in 1..100))) { Text(if (schedule) "保存计划" else "开始") } }, dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text("取消") } })
}
@Composable private fun AgentScheduleCard(vm: MusicViewModel, initial: JsonObject, refresh: () -> Unit) {
    var schedule by remember(initial) { mutableStateOf(initial) }; var deleting by remember { mutableStateOf(false) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AgentCard {
        Row(verticalAlignment = Alignment.CenterVertically) { Text(schedule.text("name"), Modifier.weight(1f), fontWeight = FontWeight.Medium)
            Switch(schedule.flag("enabled"), { enabled -> scope.launch { action.run { schedule = vm.agent.request("schedules/${schedule.text("id")}", "PATCH", jsonBody("version" to schedule.number("version"), "enabled" to enabled)); refresh() } } }, enabled = !action.busy) }
        Text("每 ${schedule.number("interval_hours")} 小时 · ${schedule.text("timezone")}", style = MaterialTheme.typography.bodySmall)
        if (schedule.flag("enabled")) Text("下次：${localAgentTime(schedule.text("next_run_at"))}", style = MaterialTheme.typography.bodySmall)
        TextButton({ deleting = true }, enabled = !action.busy) { Text("删除计划") }; ActionStatus(action)
    }
    if (deleting) AlertDialog(onDismissRequest = { deleting = false }, title = { Text("删除巡检计划？") }, text = { Text("${schedule.text("name")}。已有结果和草案保留。") }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("schedules/${schedule.text("id")}", "DELETE"); deleting = false; refresh() } } }, enabled = !action.busy) { Text("删除") } }, dismissButton = { TextButton({ deleting = false }) { Text("取消") } })
}

@Composable private fun AgentConnections(vm: MusicViewModel) {
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var editing by remember { mutableStateOf<JsonObject?>(null) }; var creating by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<JsonObject?>(null) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    suspend fun load() { connections = vm.agent.all("connections") }
    LaunchedEffect(Unit) { action.run { load() }; if (action.message == "已完成") action.message = null }
    LazyColumn(Modifier.fillMaxSize().testTag("agent-connections"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Row(verticalAlignment = Alignment.CenterVertically) { Text("你的模型连接", Modifier.weight(1f), fontWeight = FontWeight.Medium); TextButton({ creating = true }) { Text("添加连接") }; IconButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, "刷新连接") } }; ActionStatus(action) }
        item { Text("个人连接仅本人使用；共享实例连接由管理员授权。密钥只保存在服务端。", style = MaterialTheme.typography.bodySmall) }
        items(connections, key = { it.text("id") }) { connection -> AgentCard {
            Text(connection.text("name"), fontWeight = FontWeight.Medium); Text("${connection.text("model")} · ${if (connection.text("scope") == "instance") "实例连接" else "个人连接"}")
            Text(connection.text("base_url"), style = MaterialTheme.typography.bodySmall)
            Text("${if (connection.flag("enabled")) "已启用" else "未启用"} · 每日最多 ${connection.number("daily_call_budget")} 次", style = MaterialTheme.typography.bodySmall)
            if (connection.text("id") == "legacy") Text("沿用服务端已有 AI 配置，可用于手动巡检。定时巡检请添加并授权新连接。", style = MaterialTheme.typography.bodySmall)
            connection.getAsJsonObject("capabilities")?.let { caps -> caps.entrySet().forEach { (name, value) -> Text("${fieldName(name)}：${displayValue(value)}", style = MaterialTheme.typography.labelSmall) } }
            Row {
                TextButton({ scope.launch { action.run {
                    val result = vm.agent.request("connections/${connection.text("id")}/test", "POST")
                    action.message = "检测结果：${result.entrySet().joinToString(" · ") { (name, value) -> "${fieldName(name)} ${displayValue(value)}" }}"; load()
                } } }, enabled = !action.busy) { Text("检测能力") }
                if (!connection.flag("read_only")) {
                    TextButton({ editing = connection }) { Text("编辑") }
                    TextButton({ deleting = connection }) { Text("删除") }
                } else Text("只读", Modifier.padding(12.dp), style = MaterialTheme.typography.labelSmall)
            }
        } }
        if (connections.isEmpty() && !action.busy && action.message == null) item { AgentEmpty("尚未配置 AI，基础播放和本地找歌仍可使用。") }
    }
    if (creating || editing != null) AgentConnectionForm(vm, editing, { creating = false; editing = null }) { scope.launch { action.run { load() } } }
    deleting?.let { connection -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除 AI 连接？") }, text = { Text("${connection.text("name")}。相关后台任务会重新检查授权，不会切换到其他付费连接。") }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("connections/${connection.text("id")}", "DELETE"); deleting = null; load() } } }, enabled = !action.busy) { Text("删除") } }, dismissButton = { TextButton({ deleting = null }) { Text("取消") } }) }
}

@Composable private fun AgentConnectionForm(vm: MusicViewModel, original: JsonObject?, dismiss: () -> Unit, saved: () -> Unit) {
    var protocol by remember { mutableStateOf(original?.text("protocol")?.ifBlank { "chat_completions" } ?: "chat_completions") }
    var provider by remember { mutableStateOf(original?.text("provider")?.ifBlank { "generic" } ?: "generic") }
    var effort by remember { mutableStateOf(if (original == null) "low" else original.text("reasoning_effort").ifBlank { "auto" }) }
    var outputLimit by remember { mutableStateOf((original?.number("max_output_tokens", 2048) ?: 8192).toString()) }
    var nativeSearch by remember { mutableStateOf(original?.flag("native_search") ?: false) }
    var streamOutput by remember { mutableStateOf(original?.get("stream_output")?.asBoolean ?: true) }
    var name by remember { mutableStateOf(original?.text("name") ?: "我的 AI") }; var base by remember { mutableStateOf(original?.text("base_url") ?: "") }
    var model by remember { mutableStateOf(original?.text("model") ?: "") }; var secret by remember { mutableStateOf("") }; var timeout by remember { mutableStateOf((original?.number("timeout") ?: 90).toString()) }
    var budget by remember { mutableStateOf((original?.number("daily_call_budget") ?: 100).toString()) }; var enabled by remember { mutableStateOf(original?.flag("enabled") ?: true) }
    var background by remember { mutableStateOf(original?.flag("background_allowed") ?: false) }; var instance by remember { mutableStateOf(original?.text("scope") == "instance") }; var shared by remember { mutableStateOf(original?.flag("shared") ?: false) }
    val account by vm.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }; val admin = account.account?.role == "admin"
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text(if (original == null) "添加 AI 连接" else "编辑 AI 连接") }, text = {
        Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text("名称") }, singleLine = true)
            ResearchChoice("API 协议", protocol, listOf("chat_completions" to "Chat Completions", "responses" to "Responses")) { protocol = it; nativeSearch = false }
            ResearchChoice("供应商", provider, listOf("generic" to "通用兼容接口", "openai" to "OpenAI", "deepseek" to "DeepSeek", "qwen" to "千问 / 百炼", "gemini" to "Gemini 兼容接口")) { provider = it; nativeSearch = false }
            OutlinedTextField(base, { base = it }, label = { Text("模型 API 服务地址") }, singleLine = true)
            OutlinedTextField(model, { model = it }, label = { Text("模型") }, singleLine = true)
            OutlinedTextField(secret, { secret = it }, label = { Text(if (original?.flag("has_api_key") == true) "API Key（留空保留）" else "API Key") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
            OutlinedTextField(timeout, { timeout = it.filter(Char::isDigit) }, label = { Text("请求超时秒数") }, singleLine = true)
            OutlinedTextField(budget, { budget = it.filter(Char::isDigit) }, label = { Text("每日调用预算") }, singleLine = true)
            ResearchChoice("推理强度", effort, listOf("auto" to "沿用模型默认", "none" to "none", "low" to "low", "medium" to "medium", "high" to "high", "max" to "max", "xhigh" to "xhigh")) { effort = it }
            OutlinedTextField(outputLimit, { outputLimit = it.filter(Char::isDigit) }, label = { Text("单次输出 Token 上限") }, singleLine = true)
            if (protocol == "responses" && provider in listOf("openai", "deepseek", "qwen")) { Row(verticalAlignment = Alignment.CenterVertically) { Text("模型原生联网搜索", Modifier.weight(1f)); Switch(nativeSearch, { nativeSearch = it }) }; Text("按供应商规则计费，单次模型请求可能多次搜索，不受独立搜索请求额度限制。", style = MaterialTheme.typography.bodySmall) }
            Row(verticalAlignment = Alignment.CenterVertically) { Text("逐步显示回答", Modifier.weight(1f)); Switch(streamOutput, { streamOutput = it }) }
            Text("兼容接口不支持流式响应时可关闭。", style = MaterialTheme.typography.bodySmall)
            Row(verticalAlignment = Alignment.CenterVertically) { Text("启用连接", Modifier.weight(1f)); Switch(enabled, { enabled = it }) }
            Row(verticalAlignment = Alignment.CenterVertically) { Text("允许自动巡检使用", Modifier.weight(1f)); Switch(background, { background = it }) }
            Text("用于定时巡检等自动任务；手动开始无需开启。", style = MaterialTheme.typography.bodySmall)
            if (admin && original == null) Row(verticalAlignment = Alignment.CenterVertically) { Text("实例连接", Modifier.weight(1f)); Switch(instance, { instance = it }) }
            if (admin && instance) Row(verticalAlignment = Alignment.CenterVertically) { Text("共享给其他用户", Modifier.weight(1f)); Switch(shared, { shared = it }) }
            Text("个人端点受管理员的域名策略约束，保存后可单独检测能力。检测会进行少量实际模型请求。", style = MaterialTheme.typography.bodySmall)
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
    } } }, enabled = !action.busy && name.isNotBlank() && base.isNotBlank() && model.isNotBlank()) { Text("保存") } }, dismissButton = { TextButton({ secret = ""; dismiss() }, enabled = !action.busy) { Text("取消") } })
}

@Composable private fun AgentChannels(vm: MusicViewModel) {
    var targets by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var deliveries by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var preferences by remember { mutableStateOf<JsonObject?>(null) }; var edit by remember { mutableStateOf(false) }; var add by remember { mutableStateOf(false) }
    var verify by remember { mutableStateOf<JsonObject?>(null) }; var code by remember { mutableStateOf("") }; var deleting by remember { mutableStateOf<JsonObject?>(null) }
    var retry by remember { mutableStateOf<JsonObject?>(null) }; var retention by remember { mutableStateOf("30") }
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    suspend fun load() {
        targets = vm.agent.all("telegram-targets"); deliveries = vm.agent.all("deliveries"); preferences = vm.agent.request("notification-preferences")
        retention = vm.agent.request("assistant-preferences").number("retention_days", 30).toString()
    }
    LaunchedEffect(Unit) { action.run { load() }; if (action.message == "已完成") action.message = null }
    LazyColumn(Modifier.fillMaxSize().testTag("agent-channels"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("站内通知始终可用", style = MaterialTheme.typography.titleMedium)
            Text("无需开启系统推送权限。登录、回到前台或恢复联网后自动读取结果。", style = MaterialTheme.typography.bodySmall)
            Row { TextButton({ edit = true }, enabled = preferences != null) { Text("Telegram 订阅与静默时间") }; IconButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Icon(Icons.Default.Refresh, "刷新通知设置") } }
            ActionStatus(action)
        }
        item { Row(verticalAlignment = Alignment.CenterVertically) { Text("Telegram 目标", Modifier.weight(1f), fontWeight = FontWeight.Medium); TextButton({ add = true }) { Text("添加") } } }
        items(targets, key = { it.text("id") }) { target -> AgentCard {
            Text(target.text("name"), fontWeight = FontWeight.Medium)
            Text(if (!target.flag("verified")) "待验证，尚不接收结果" else if (target.flag("enabled")) "已验证 · 已启用" else "已验证 · 已停用", style = MaterialTheme.typography.bodySmall)
            Row {
                if (!target.flag("verified")) TextButton({ scope.launch { action.run { vm.agent.request("telegram-targets/${target.text("id")}/verify-send", "POST"); verify = target; code = ""; action.message = "验证码已发送，请在 Telegram 中查看后回填。" } } }, enabled = !action.busy) { Text("发送验证码") }
                else {
                    TextButton({ scope.launch { action.run { vm.agent.request("telegram-targets/${target.text("id")}/test", "POST"); action.message = "测试已提交，请核对投递记录及 Telegram。"; load() } } }, enabled = !action.busy) { Text("发送测试") }
                    TextButton({ scope.launch { action.run { vm.agent.request("telegram-targets/${target.text("id")}", "PATCH", jsonBody("enabled" to !target.flag("enabled"), "version" to target.number("version"))); load() } } }, enabled = !action.busy) { Text(if (target.flag("enabled")) "停用" else "启用") }
                }
                TextButton({ deleting = target }, enabled = !action.busy) { Text("删除") }
            }
        } }
        item { Text("投递记录", fontWeight = FontWeight.Medium) }
        if (deliveries.isEmpty()) item { Text("暂无外部投递。未配置 Telegram 不影响站内通知。", style = MaterialTheme.typography.bodySmall) }
        items(deliveries, key = { "delivery-${it.text("id")}" }) { delivery -> AgentCard {
            Text(mapOf("queued" to "排队中", "sending" to "正在发送", "retry_wait" to "等待重试", "sent" to "Telegram 已接收", "failed" to "发送失败", "unknown" to "结果未知，需人工核对", "cancelled" to "已取消")[delivery.text("status")] ?: delivery.text("status"), fontWeight = FontWeight.Medium)
            Text("尝试 ${delivery.number("attempt")} 次", style = MaterialTheme.typography.bodySmall)
            delivery.text("error_code").takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }; AgentTrace(delivery)
            if (delivery.text("status") in listOf("failed", "unknown", "retry_wait")) TextButton({ retry = delivery }, enabled = !action.busy) { Text("重试投递") }
        } }
        item { HorizontalDivider(); Text("助手历史", Modifier.padding(top = 12.dp), fontWeight = FontWeight.Medium)
            OutlinedTextField(retention, { retention = it.filter(Char::isDigit) }, label = { Text("助手对话保留天数（1–365）") }, singleLine = true)
            Text("按对话最后更新时间清理聊天记录，已有草案、歌单和音乐保留。", style = MaterialTheme.typography.bodySmall)
            TextButton({ scope.launch { action.run { vm.agent.request("assistant-preferences", "PUT", jsonBody("retention_days" to (retention.toIntOrNull() ?: 0))) } } }, enabled = !action.busy && (retention.toIntOrNull() ?: 0) in 1..365) { Text("保存保留设置") }
        }
    }
    if (add) AgentTelegramForm(vm, { add = false }) { scope.launch { action.run { load() } } }
    if (edit && preferences != null) AgentNotificationPreferences(vm, preferences!!, { edit = false }) { scope.launch { action.run { load() } } }
    verify?.let { target -> AlertDialog(onDismissRequest = { verify = null }, title = { Text("验证 Telegram 目标") }, text = { Column {
        Text("${target.text("name")}：输入刚收到的短效验证码。")
        OutlinedTextField(code, { code = it }, label = { Text("验证码") }, singleLine = true); ActionStatus(action)
    } }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("telegram-targets/${target.text("id")}/verify", "POST", jsonBody("code" to code.trim())); code = ""; verify = null; load() } } }, enabled = !action.busy && code.isNotBlank()) { Text("验证并启用") } }, dismissButton = { TextButton({ verify = null; code = "" }) { Text("取消") } }) }
    deleting?.let { target -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除通知目标？") }, text = { Text("${target.text("name")}。未发送的消息将停止投递，站内结果保留。") }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("telegram-targets/${target.text("id")}", "DELETE"); deleting = null; load() } } }, enabled = !action.busy) { Text("删除") } }, dismissButton = { TextButton({ deleting = null }) { Text("取消") } }) }
    retry?.let { delivery -> AlertDialog(onDismissRequest = { retry = null }, title = { Text("重新发送通知？") }, text = { Text(if (delivery.text("status") == "unknown") "此前请求可能已经送达。请先核对 Telegram，重试可能产生重复消息。" else "重试会再次向已验证且启用的目标发送。") }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("deliveries/${delivery.text("id")}/retry", "POST", jsonBody("acknowledge_unknown" to (delivery.text("status") == "unknown"))); retry = null; load() } } }, enabled = !action.busy) { Text("确认重试") } }, dismissButton = { TextButton({ retry = null }) { Text("取消") } }) }
}

@Composable private fun AgentTelegramForm(vm: MusicViewModel, dismiss: () -> Unit, saved: () -> Unit) {
    var name by remember { mutableStateOf("我的 Telegram") }; var token by remember { mutableStateOf("") }; var chat by remember { mutableStateOf("") }; var topic by remember { mutableStateOf("") }; var direct by remember { mutableStateOf(false) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text("添加 Telegram 目标") }, text = {
        Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text("名称") }, singleLine = true)
            OutlinedTextField(token, { token = it }, label = { Text("Bot Token") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
            OutlinedTextField(chat, { chat = it }, label = { Text("Chat ID") }, singleLine = true)
            OutlinedTextField(topic, { topic = it.filter(Char::isDigit) }, label = { Text("Topic ID（可选）") }, singleLine = true)
            Row(verticalAlignment = Alignment.CenterVertically) { Text("直接连接 Telegram", Modifier.weight(1f)); Switch(direct, { direct = it }) }
            Text(if (direct) "直接连接，不经过服务端代理。" else "沿用服务端网络与代理设置。", style = MaterialTheme.typography.bodySmall)
            Text("保存后需显式发送验证码并回填；验证前不会发送私人结果。", style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        vm.agent.request("telegram-targets", "POST", jsonBody("name" to name, "bot_token" to token.trim(), "chat_id" to chat.trim(), "topic_id" to topic.toLongOrNull(), "proxy_mode" to if (direct) "direct" else "inherit", "enabled" to false)); token = ""; saved(); dismiss()
    } } }, enabled = !action.busy && name.isNotBlank() && token.isNotBlank() && chat.isNotBlank()) { Text("保存目标") } }, dismissButton = { TextButton({ token = ""; dismiss() }, enabled = !action.busy) { Text("取消") } })
}
@Composable private fun AgentNotificationPreferences(vm: MusicViewModel, initial: JsonObject, dismiss: () -> Unit, saved: () -> Unit) {
    var enabled by remember { mutableStateOf(initial.flag("telegram_enabled")) }; var severity by remember { mutableStateOf(initial.text("min_severity", "info")) }
    var start by remember { mutableStateOf(initial.text("quiet_start")) }; var end by remember { mutableStateOf(initial.text("quiet_end")) }; var timezone by remember { mutableStateOf(initial.text("timezone", java.util.TimeZone.getDefault().id)) }
    var events by remember { mutableStateOf(initial.getAsJsonArray("event_types")?.map { it.asString }?.toSet() ?: emptySet()) }
    val choices = listOf("draft.pending" to "草案待确认", "draft.applied" to "草案已应用", "task.completed" to "巡检完成", "task.partial" to "部分完成", "task.failed" to "失败", "task.paused" to "需要处理")
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text("Telegram 订阅") }, text = {
        Column(Modifier.heightIn(max = 500.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) { Text("接收 Telegram 通知", Modifier.weight(1f)); Switch(enabled, { enabled = it }) }
            Text("事件类型（未选择时接收全部）", style = MaterialTheme.typography.labelLarge)
            choices.forEach { (id, title) -> Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(id in events, { checked -> events = if (checked) events + id else events - id }); Text(title) } }
            Row { listOf("info" to "全部", "warning" to "提醒与错误", "error" to "仅错误").forEach { (id, title) -> FilterChip(severity == id, { severity = id }, label = { Text(title) }, modifier = Modifier.padding(end = 4.dp)) } }
            OutlinedTextField(start, { start = it }, label = { Text("静默开始 HH:mm（可选）") }, singleLine = true)
            OutlinedTextField(end, { end = it }, label = { Text("静默结束 HH:mm（可选）") }, singleLine = true)
            OutlinedTextField(timezone, { timezone = it }, label = { Text("时区") }, singleLine = true)
            Text("静默时间只影响外部投递，站内通知照常保存。", style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        vm.agent.request("notification-preferences", "PUT", jsonBody("telegram_enabled" to enabled, "event_types" to jsonStrings(events.toList()), "min_severity" to severity,
            "quiet_start" to start.takeIf { it.isNotBlank() }, "quiet_end" to end.takeIf { it.isNotBlank() }, "timezone" to timezone)); saved(); dismiss()
    } } }, enabled = !action.busy) { Text("保存") } }, dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text("取消") } })
}
