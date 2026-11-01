package com.wildstring.app.ui

import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
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
    val resources = androidx.compose.ui.platform.LocalResources.current
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
            Text(stringResource(R.string.research_chat_search), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.research_search_hint), style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
        if (action.busy && settings == null) item { AgentSkeleton(Modifier.height(420.dp)) }
        item {
            ResearchChoice(stringResource(R.string.research_service), provider, listOf("deepseek" to stringResource(R.string.research_deepseek), "tavily" to "Tavily")) { provider = it; secret = "" }
            OutlinedTextField(secret, { secret = it }, label = { Text(if (settings?.flag("has_api_key") == true) stringResource(R.string.research_key_keep) else stringResource(R.string.research_key)) }, visualTransformation = PasswordVisualTransformation(), singleLine = true)
            OutlinedTextField(budget, { budget = it.filter(Char::isDigit) }, label = { Text(stringResource(R.string.research_daily_limit)) }, singleLine = true)
            Row(verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.research_enable), Modifier.weight(1f)); Switch(enabled, { enabled = it }, enabled = !action.busy) }
            Row(verticalAlignment = Alignment.CenterVertically) { Text(stringResource(R.string.research_clear_key), Modifier.weight(1f)); Switch(clearKey, { clearKey = it }, enabled = !action.busy) }
            Text(stringResource(R.string.research_requests_today, settings?.number("requests_today") ?: 0), style = MaterialTheme.typography.bodySmall)
            TextButton({ scope.launch { action.run {
                val body = jsonBody("provider" to provider, "enabled" to enabled, "daily_budget" to (budget.toIntOrNull() ?: -1), "version" to (settings?.number("version") ?: 0), "clear_api_key" to clearKey)
                if (secret.isNotBlank()) body.addProperty("api_key", secret)
                vm.agent.request("search-settings", "PUT", body); load(); runCatching { focus.clearFocus(force = true); keyboard?.hide() }; secret = ""; clearKey = false
            } } }, enabled = !action.busy && settings != null) { Text(stringResource(R.string.research_save)) }
            TextButton({ scope.launch { action.run { val result = vm.agent.request("search-settings/test", "POST"); load(); action.message = resources.getString(R.string.research_test_result, result.objects("sources").size) } } }, enabled = !action.busy && settings?.flag("enabled") == true) { Text(stringResource(R.string.research_test)) }
        }
        item {
            HorizontalDivider(); Text(stringResource(R.string.research_context_memory), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.research_memory_hint), style = MaterialTheme.typography.bodySmall)
            listOf("context_summary" to stringResource(R.string.research_summary_auto), "long_term_memory" to stringResource(R.string.research_memory_use)).forEach { (field, label) ->
                Row(verticalAlignment = Alignment.CenterVertically) { Text(label, Modifier.weight(1f)); Switch(preferences?.flag(field) ?: true, { checked -> scope.launch { action.run {
                    val value = preferences ?: return@run
                    preferences = vm.agent.request("assistant-preferences", "PUT", jsonBody("retention_days" to value.number("retention_days", 30), "context_summary" to if (field == "context_summary") checked else value.flag("context_summary"), "long_term_memory" to if (field == "long_term_memory") checked else value.flag("long_term_memory")))
                } } }, enabled = !action.busy && preferences != null) }
            }
            OutlinedTextField(content, { content = it.take(1000) }, label = { Text(if (editing == null) stringResource(R.string.research_memory_input) else stringResource(R.string.research_memory_edit)) }, modifier = Modifier.fillMaxWidth().testTag("agent-memory-input"), minLines = 2)
            Row {
                TextButton({ scope.launch { action.run {
                    val current = editing
                    val body = jsonBody("content" to content)
                    if (current != null) body.addProperty("version", current.number("version"))
                    vm.agent.request(if (current == null) "memories" else "memories/${current.text("id")}", if (current == null) "POST" else "PATCH", body)
                    memories = vm.agent.all("memories"); runCatching { focus.clearFocus(force = true); keyboard?.hide() }; content = ""; editing = null
                } } }, enabled = !action.busy && content.isNotBlank(), modifier = Modifier.testTag("agent-memory-save")) { Text(if (editing == null) stringResource(R.string.research_memory_save) else stringResource(R.string.research_memory_update)) }
                if (editing != null) TextButton({ editing = null; content = "" }) { Text(stringResource(R.string.cancel_edit)) }
            }
        }
        items(memories, key = { it.text("id") }) { memory ->
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow) {
                Column(Modifier.fillMaxWidth().padding(12.dp)) {
                    Text(memory.text("content")); Row {
                        TextButton({ editing = memory; content = memory.text("content") }, enabled = !action.busy) { Text(stringResource(R.string.research_memory_edit_action)) }
                        TextButton({ deleting = memory }, enabled = !action.busy) { Text(stringResource(R.string.research_memory_delete)) }
                    }
                }
            }
        }
    }
    deleting?.let { memory -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text(stringResource(R.string.research_memory_delete_title)) }, text = { Text(memory.text("content")) }, confirmButton = { TextButton({ scope.launch { action.run { vm.agent.request("memories/${memory.text("id")}", "DELETE"); if (editing?.text("id") == memory.text("id")) { editing = null; content = "" }; deleting = null; memories = vm.agent.all("memories") } } }, enabled = !action.busy, modifier = Modifier.testTag("agent-memory-delete-confirm")) { Text(stringResource(R.string.delete)) } }, dismissButton = { TextButton({ deleting = null }) { Text(stringResource(R.string.cancel)) } }) }
}
