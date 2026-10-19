package com.wildstring.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.launch

@Composable internal fun AgentApplicationPolicy(vm: MusicViewModel) {
    var policy by remember { mutableStateOf<JsonObject?>(null) }
    var mode by remember { mutableStateOf("manual") }
    var kinds by remember { mutableStateOf(setOf<String>()) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    suspend fun load() {
        val value = vm.agent.request("application-policy"); policy = value
        mode = value.text("mode"); kinds = value.getAsJsonArray("kinds")?.map { it.asString }?.toSet() ?: emptySet()
    }
    LaunchedEffect(Unit) { action.run { load() }; action.message = null }
    val labels = mapOf("playlist" to "我的歌单", "metadata" to "单曲信息", "metadata_batch" to "专辑批量信息", "cover" to "封面", "lyrics" to "歌词", "intake" to "导入整理")
    Column(Modifier.fillMaxWidth().testTag("application-policy"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("整理方式", style = MaterialTheme.typography.titleLarge)
        Text("按账号保存，助手、巡检和 MCP 共用。MCP 还需授予应用草案权限。", style = MaterialTheme.typography.bodySmall)
        if (policy != null) {
            listOf("manual" to "审核后应用", "automatic" to "自动整理").forEach { (key, label) ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(mode == key, { mode = key }, enabled = !action.busy, modifier = Modifier.testTag("application-mode-$key"))
                    Text(label)
                }
            }
            Text(if (mode == "manual") "查看草案后，点击接受即可直接应用。" else "新草案中勾选的类型会直接应用，并保留修改记录。", style = MaterialTheme.typography.bodySmall)
            policy?.getAsJsonArray("allowed_kinds")?.forEach { value ->
                val kind = value.asString
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(kind in kinds, { checked -> kinds = if (checked) kinds + kind else kinds - kind }, enabled = !action.busy && mode == "automatic", modifier = Modifier.testTag("application-kind-$kind"))
                    Text(labels[kind] ?: kind)
                }
            }
            Text("已有待确认草案保持原状。资料保存在应用内，导入源不变。", style = MaterialTheme.typography.bodySmall)
            Button({ scope.launch { action.run {
                val saved = vm.agent.request("application-policy", "PUT", jsonBody("mode" to mode, "kinds" to jsonStrings(kinds.toList()), "version" to policy!!.number("version")))
                policy = saved
            } } }, enabled = !action.busy && (mode == "manual" || kinds.isNotEmpty())) { Text("保存整理方式") }
            TextButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Text("重新读取整理方式") }
        } else TextButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Text("重新读取整理方式") }
        ActionStatus(action)
    }
}
