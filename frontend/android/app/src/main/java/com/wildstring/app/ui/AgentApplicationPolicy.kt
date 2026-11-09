package com.wildstring.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.google.gson.JsonObject
import com.wildstring.app.R
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
    val labels = mapOf(
        "playlist" to stringResource(R.string.agent_pol_kind_playlist),
        "metadata" to stringResource(R.string.agent_pol_kind_metadata),
        "metadata_batch" to stringResource(R.string.agent_pol_kind_metadata_batch),
        "cover" to stringResource(R.string.agent_pol_kind_cover),
        "lyrics" to stringResource(R.string.agent_pol_kind_lyrics),
        "intake" to stringResource(R.string.agent_pol_kind_intake)
    )
    Column(Modifier.fillMaxWidth().testTag("application-policy"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.agent_pol_title), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.agent_pol_description), style = MaterialTheme.typography.bodySmall)
        if (policy != null) {
            listOf("manual" to stringResource(R.string.agent_pol_mode_manual), "automatic" to stringResource(R.string.agent_pol_mode_automatic)).forEach { (key, label) ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(mode == key, { mode = key }, enabled = !action.busy, modifier = Modifier.testTag("application-mode-$key"))
                    Text(label)
                }
            }
            Text(if (mode == "manual") stringResource(R.string.agent_pol_manual_hint) else stringResource(R.string.agent_pol_automatic_hint), style = MaterialTheme.typography.bodySmall)
            policy?.getAsJsonArray("allowed_kinds")?.forEach { value ->
                val kind = value.asString
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(kind in kinds, { checked -> kinds = if (checked) kinds + kind else kinds - kind }, enabled = !action.busy && mode == "automatic", modifier = Modifier.testTag("application-kind-$kind"))
                    Text(labels[kind] ?: kind)
                }
            }
            Text(stringResource(R.string.agent_pol_draft_retention_hint), style = MaterialTheme.typography.bodySmall)
            Button({ scope.launch { action.run {
                val saved = vm.agent.request("application-policy", "PUT", jsonBody("mode" to mode, "kinds" to jsonStrings(kinds.toList()), "version" to policy!!.number("version")))
                policy = saved
            } } }, enabled = !action.busy && (mode == "manual" || kinds.isNotEmpty())) { Text(stringResource(R.string.agent_pol_save)) }
            TextButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_pol_reload)) }
        } else TextButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Text(stringResource(R.string.agent_pol_reload)) }
        ActionStatus(action)
    }
}
