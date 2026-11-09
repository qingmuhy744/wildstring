package com.wildstring.app.ui

import androidx.compose.ui.res.stringResource
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable internal fun PlaybackGainPanel(vm: MusicViewModel, track: Track) {
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    var record by remember { mutableStateOf<JsonObject?>(null) }
    var mode by remember { mutableStateOf("off") }; var preamp by remember { mutableStateOf("0") }; var prevent by remember { mutableStateOf(true) }
    var trackGain by remember { mutableStateOf("0") }; var albumGain by remember { mutableStateOf("0") }
    val account by vm.state.collectAsState()
    suspend fun load(refreshSettings: Boolean = true) {
        record = vm.repository.playbackGain(track.id)
        val settings = record!!.getAsJsonObject("settings")
        if (refreshSettings) { mode = settings.text("mode"); preamp = settings.get("preamp_db").asString; prevent = settings.flag("prevent_clipping") }
        trackGain = record!!.getAsJsonObject("track").get("gain_db").asString; albumGain = record!!.getAsJsonObject("album").get("gain_db").asString
    }
    LaunchedEffect(track.id) { action.run { load() }; if (action.message == DONE_STATUS) action.message = null }
    val scanning = record?.getAsJsonObject("analysis")?.text("status") in listOf("queued", "running")
    LaunchedEffect(scanning, track.id) { while (record?.getAsJsonObject("analysis")?.text("status") in listOf("queued", "running")) { delay(2000); load(false); vm.settings.gainChanged() } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(track.title, style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.gain_panel_description))
        ResearchChoice(stringResource(R.string.gain_panel_mode_title), mode, listOf("off" to stringResource(R.string.gain_panel_mode_off), "track" to stringResource(R.string.gain_panel_mode_track), "album" to stringResource(R.string.gain_panel_mode_album)), enabled = record != null && !action.busy) { selected ->
            if (selected != mode) scope.launch { action.run {
                val settings = record!!.getAsJsonObject("settings").deepCopy().apply { addProperty("mode", selected) }
                val saved = vm.repository.feature("playback/gain-settings", "PUT", settings)
                mode = saved.text("mode")
                record = record!!.deepCopy().apply { add("settings", saved) }
                vm.settings.gainChanged(); action.message = AppLanguage.string(R.string.gain_panel_mode_saved)
                load(false)
            } }
        }
        Text(stringResource(R.string.gain_panel_auto_save_hint), style = MaterialTheme.typography.bodySmall)
        ActionStatus(action)
        Text(stringResource(R.string.gain_panel_fallback_hint), style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(preamp, { preamp = it }, label = { Text(stringResource(R.string.gain_panel_preamp_label)) }, singleLine = true, enabled = record != null && !action.busy)
        Row { Text(stringResource(R.string.gain_panel_prevent_clipping), Modifier.weight(1f)); Switch(prevent, { prevent = it }, enabled = record != null && !action.busy) }
        Text(stringResource(R.string.gain_panel_prevent_clipping_hint), style = MaterialTheme.typography.bodySmall)
        TextButton({ scope.launch { action.run {
            val settings = record!!.getAsJsonObject("settings")
            vm.repository.feature("playback/gain-settings", "PUT", jsonBody("version" to settings.number("version"), "mode" to mode, "preamp_db" to preamp.toDouble(), "prevent_clipping" to prevent))
            load(); vm.settings.gainChanged(); action.message = AppLanguage.string(R.string.gain_panel_settings_saved)
        } } }, enabled = record != null && !action.busy && preamp.toDoubleOrNull()?.let { it in -12.0..12.0 } == true) { Text(stringResource(R.string.gain_panel_save_settings)) }
        listOf("album", "track").forEach { target ->
            val value = if (target == "album") albumGain else trackGain
            val label = if (target == "album") stringResource(R.string.gain_panel_album_gain_label) else stringResource(R.string.gain_panel_track_gain_label)
            val available = record != null && (target == "track" || record!!.text("album_id").isNotEmpty())
            OutlinedTextField(value, { if (target == "album") albumGain = it else trackGain = it }, label = { Text(label) }, enabled = available && !action.busy, singleLine = true)
            Row {
                TextButton({ scope.launch { action.run {
                    vm.repository.feature("tracks/${track.id}/playback-gain", "PUT", jsonBody("scope" to target, "version" to record!!.getAsJsonObject(target).number("version"), "gain_db" to value.toDouble()))
                    load(false); vm.settings.gainChanged(); action.message = AppLanguage.string(R.string.gain_panel_manual_saved)
                } } }, enabled = available && !action.busy && value.toDoubleOrNull()?.let { it in -12.0..12.0 } == true) { Text(if (target == "album") stringResource(R.string.gain_panel_save_album_gain) else stringResource(R.string.gain_panel_save_track_gain)) }
                TextButton({ scope.launch { action.run {
                    vm.repository.feature("tracks/${track.id}/playback-gain", "PUT", jsonBody("scope" to target, "version" to record!!.getAsJsonObject(target).number("version"), "gain_db" to 0))
                    load(false); vm.settings.gainChanged(); action.message = AppLanguage.string(R.string.gain_panel_reset_done)
                } } }, enabled = available && !action.busy) { Text(stringResource(R.string.gain_panel_reset)) }
            }
        }
        record?.let { data ->
            Text(stringResource(R.string.gain_panel_status_summary, data.get("requested_db").asFloat.toString(), data.get("applied_db").asFloat.toString()) + if (data.flag("limited")) stringResource(R.string.gain_panel_peak_limited_suffix) else "")
            if (account.account?.isOwner == true) TextButton({ scope.launch { action.run {
                vm.repository.feature("manage/tracks/${track.id}/analyze-loudness", "POST"); load(false); action.message = AppLanguage.string(R.string.gain_panel_analysis_enqueued)
            } } }, enabled = !action.busy && !scanning) { Text(if (scanning) stringResource(R.string.gain_panel_analyzing) else stringResource(R.string.gain_panel_analyze_loudness)) }
            data.getAsJsonObject("analysis").text("error").takeIf { it.isNotBlank() }?.let { Text(stringResource(R.string.gain_panel_analysis_incomplete, it)) }
        }
    }
}
