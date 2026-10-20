package com.wildstring.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.launch

@Composable internal fun ResearchChoice(label: String, value: String, choices: List<Pair<String, String>>, enabled: Boolean = true, changed: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton({ expanded = true }, enabled = enabled) { Text("$label：${choices.firstOrNull { it.first == value }?.second ?: value}") }
        DropdownMenu(expanded, { expanded = false }) { choices.forEach { (id, title) -> DropdownMenuItem(text = { Text(title) }, onClick = { changed(id); expanded = false }) } }
    }
}

@Composable internal fun AgentResearch(vm: MusicViewModel) {
    val focus = LocalFocusManager.current; val keyboard = LocalSoftwareKeyboardController.current
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    var settings by remember { mutableStateOf<JsonObject?>(null) }; var preferences by remember { mutableStateOf<JsonObject?>(null) }
    var memories by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var provider by remember { mutableStateOf("deepseek") }; var enabled by remember { mutableStateOf(false) }
    var secret by remember { mutableStateOf("") }; var budget by remember { mutableStateOf("100") }; var clearKey by remember { mutableStateOf(false) }
    var content by remember { mutableStateOf("") }; var editing by remember { mutableStateOf<JsonObject?>(null) }; var deleting by remember { mutableStateOf<JsonObject?>(null) }
    suspend fun load() {
        settings = vm.agent.request("search-settings"); preferences = vm.agent.request("assistant-preferences"); memories = vm.agent.all("memories")
        provider = settings!!.text("provider"); enabled = settings!!.flag("enabled"); budget = settings!!.number("daily_budget", 100).toString()
    }
    LaunchedEffect(Unit) { action.run { load() }; if (action.message == "已完成") action.message = null }
    LazyColumn(Modifier.fillMaxSize().testTag("agent-research"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("聊天联网搜索", style = MaterialTheme.typography.titleLarge)
            Text("实时核对库外最新发行与历史资料。搜索服务需要独立密钥，按服务商规则计费；不上传音频或整份曲库。", style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
        if (action.busy && settings == null) item { AgentSkeleton(Modifier.height(420.dp)) }
        item {
            ResearchChoice("搜索服务", provider, listOf("deepseek" to "DeepSeek 官方", "tavily" to "Tavily")) { provider = it; secret = "" }
            OutlinedTextField(secret, { secret = it }, label = { Text(if (settings?.flag("has_api_key") == true) "搜索 API Key（留空保留）" else "搜索 API Key") }, visualTransformation = PasswordVisualTransformation(), singleLine = true)
            OutlinedTextField(budget, { budget = it.filter(Char::isDigit) }, label = { Text("每日搜索与读取请求上限") }, singleLine = true)
            Row(verticalAlignment = Alignment.CenterVertically) { Text("启用聊天联网", Modifier.weight(1f)); Switch(enabled, { enabled = it }, enabled = !action.busy) }
            Row(verticalAlignment = Alignment.CenterVertically) { Text("清除搜索密钥", Modifier.weight(1f)); Switch(clearKey, { clearKey = it }, enabled = !action.busy) }
            Text("今日已请求 ${settings?.number("requests_today") ?: 0} 次。每轮最多 4 次；失败请求预留额度，同一结果缓存 15 分钟。", style = MaterialTheme.typography.bodySmall)
            TextButton({ scope.launch { action.run {
                val body = jsonBody("provider" to provider, "enabled" to enabled, "daily_budget" to (budget.toIntOrNull() ?: -1), "version" to (settings?.number("version") ?: 0), "clear_api_key" to clearKey)
                if (secret.isNotBlank()) body.addProperty("api_key", secret)
                vm.agent.request("search-settings", "PUT", body); load(); runCatching { focus.clearFocus(force = true); keyboard?.hide() }; secret = ""; clearKey = false
            } } }, enabled = !action.busy && settings != null) { Text("保存搜索设置") }
            TextButton({ scope.launch { action.run { val result = vm.agent.request("search-settings/test", "POST"); load(); action.message = "搜索服务已响应，取得 ${result.objects("sources").size} 个可用来源。" } } }, enabled = !action.busy && settings?.flag("enabled") == true) { Text("测试搜索（计入额度）") }
        }
        item {
            HorizontalDivider(); Text("上下文与长期记忆", style = MaterialTheme.typography.titleLarge)
            Text("长对话摘要可能有遗漏，可在聊天中查看或清除；摘要占用本轮一次模型调用。记忆只保存你明确提交的偏好，最多 50 条，删除对话不会删除记忆。", style = MaterialTheme.typography.bodySmall)
            listOf("context_summary" to "长对话自动摘要", "long_term_memory" to "在聊天中使用已保存记忆").forEach { (field, label) ->
                Row(verticalAlignment = Alignment.CenterVertically) { Text(label, Modifier.weight(1f)); Switch(preferences?.flag(field) ?: true, { checked -> scope.launch { action.run {
                    val value = preferences ?: return@run
                    preferences = vm.agent.request("assistant-preferences", "PUT", jsonBody("retention_days" to value.number("retention_days", 30), "context_summary" to if (field == "context_summary") checked else value.flag("context_summary"), "long_term_memory" to if (field == "long_term_memory") checked else value.flag("long_term_memory")))
                } } }, enabled = !action.busy && preferences != null) }
            }
            OutlinedTextField(content, { content = it.take(1000) }, label = { Text(if (editing == null) "明确保存的音乐偏好" else "编辑长期记忆") }, modifier = Modifier.fillMaxWidth().testTag("agent-memory-input"), minLines = 2)
            Row {
                TextButton({ scope.launch { action.run {
                    val current = editing
                    val body = jsonBody("content" to content)
                    if (current != null) body.addProperty("version", current.number("version"))
                    vm.agent.request(if (current == null) "memories" else "memories/${current.text("id")}", if (current == null) "POST" else "PATCH", body)
                    memories = vm.agent.all("memories"); runCatching { focus.clearFocus(force = true); keyboard?.hide() }; content = ""; editing = null
                } } }, enabled = !action.busy && content.isNotBlank(), modifier = Modifier.testTag("agent-memory-save")) { Text(if (editing == null) "保存长期记忆" else "更新记忆") }
                if (editing != null) TextButton({ editing = null; content = "" }) { Text("取消编辑") }
            }
        }
        items(memories, key = { it.text("id") }) { memory ->
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow) {
                Column(Modifier.fillMaxWidth().padding(12.dp)) {
                    Text(memory.text("content")); Row {
                        TextButton({ editing = memory; content = memory.text("content") }, enabled = !action.busy) { Text("编辑记忆") }
                        TextButton({ deleting = memory }, enabled = !action.busy) { Text("删除记忆") }
                    }
                }
            }
        }
    }
    deleting?.let { memory -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除长期记忆？") }, text = { Text(memory.text("content")) }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("memories/${memory.text("id")}", "DELETE"); if (editing?.text("id") == memory.text("id")) { editing = null; content = "" }; deleting = null; memories = vm.agent.all("memories") } } }, enabled = !action.busy, modifier = Modifier.testTag("agent-memory-delete-confirm")) { Text("删除") } }, dismissButton = { TextButton({ deleting = null }) { Text("取消") } }) }
}
