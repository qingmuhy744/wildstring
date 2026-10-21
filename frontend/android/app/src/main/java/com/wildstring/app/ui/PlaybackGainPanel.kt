package com.wildstring.app.ui

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
    LaunchedEffect(track.id) { action.run { load() }; if (action.message == "已完成") action.message = null }
    val scanning = record?.getAsJsonObject("analysis")?.text("status") in listOf("queued", "running")
    LaunchedEffect(scanning, track.id) { while (record?.getAsJsonObject("analysis")?.text("status") in listOf("queued", "running")) { delay(2000); load(false); vm.settings.gainChanged() } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(track.title, style = MaterialTheme.typography.titleLarge)
        Text("自动响度均衡、专辑整体增减与单曲微调分别控制，按账号保存；专辑与单曲手动值叠加，不改写音频。")
        ResearchChoice("自动响度均衡", mode, listOf("off" to "关闭", "track" to "单曲 ReplayGain", "album" to "专辑 ReplayGain"), enabled = record != null && !action.busy) { selected ->
            if (selected != mode) scope.launch { action.run {
                val settings = record!!.getAsJsonObject("settings").deepCopy().apply { addProperty("mode", selected) }
                val saved = vm.repository.feature("playback/gain-settings", "PUT", settings)
                mode = saved.text("mode")
                record = record!!.deepCopy().apply { add("settings", saved) }
                vm.settings.gainChanged(); action.message = "自动响度模式已保存。"
                load(false)
            } }
        }
        Text("模式选择后自动保存；前级和防削波修改后，请点击下方保存按钮。", style = MaterialTheme.typography.bodySmall)
        ActionStatus(action)
        Text("缺少专辑 ReplayGain 时使用单曲值。已有标签优先，无标签可由管理员分析本曲。", style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(preamp, { preamp = it }, label = { Text("均衡前级 dB（-12 至 12）") }, singleLine = true, enabled = record != null && !action.busy)
        Row { Text("根据峰值防止削波", Modifier.weight(1f)); Switch(prevent, { prevent = it }, enabled = record != null && !action.busy) }
        Text("未知峰值时只衰减，分析峰值后可自动利用余量放大。", style = MaterialTheme.typography.bodySmall)
        TextButton({ scope.launch { action.run {
            val settings = record!!.getAsJsonObject("settings")
            vm.repository.feature("playback/gain-settings", "PUT", jsonBody("version" to settings.number("version"), "mode" to mode, "preamp_db" to preamp.toDouble(), "prevent_clipping" to prevent))
            load(); vm.settings.gainChanged(); action.message = "均衡设置已保存。"
        } } }, enabled = record != null && !action.busy && preamp.toDoubleOrNull()?.let { it in -12.0..12.0 } == true) { Text("保存均衡设置") }
        listOf("album", "track").forEach { target ->
            val value = if (target == "album") albumGain else trackGain
            val label = if (target == "album") "整张专辑增减 dB" else "本曲额外微调 dB"
            val available = record != null && (target == "track" || record!!.text("album_id").isNotEmpty())
            OutlinedTextField(value, { if (target == "album") albumGain = it else trackGain = it }, label = { Text(label) }, enabled = available && !action.busy, singleLine = true)
            Row {
                TextButton({ scope.launch { action.run {
                    vm.repository.feature("tracks/${track.id}/playback-gain", "PUT", jsonBody("scope" to target, "version" to record!!.getAsJsonObject(target).number("version"), "gain_db" to value.toDouble()))
                    load(false); vm.settings.gainChanged(); action.message = "手动调整已保存。"
                } } }, enabled = available && !action.busy && value.toDoubleOrNull()?.let { it in -12.0..12.0 } == true) { Text(if (target == "album") "保存专辑调整" else "保存单曲调整") }
                TextButton({ scope.launch { action.run {
                    vm.repository.feature("tracks/${track.id}/playback-gain", "PUT", jsonBody("scope" to target, "version" to record!!.getAsJsonObject(target).number("version"), "gain_db" to 0))
                    load(false); vm.settings.gainChanged(); action.message = "此项已归零。"
                } } }, enabled = available && !action.busy) { Text("归零") }
            }
        }
        record?.let { data ->
            Text("请求 ${data.get("requested_db").asFloat} dB · 实际 ${data.get("applied_db").asFloat} dB${if (data.flag("limited")) "（受峰值保护限制）" else ""}")
            if (account.account?.isOwner == true) TextButton({ scope.launch { action.run {
                vm.repository.feature("manage/tracks/${track.id}/analyze-loudness", "POST"); load(false); action.message = "已加入后台分析，文件不会修改。"
            } } }, enabled = !action.busy && !scanning) { Text(if (scanning) "后台正在分析…" else "分析本曲响度与峰值") }
            data.getAsJsonObject("analysis").text("error").takeIf { it.isNotBlank() }?.let { Text("分析未完成：$it") }
        }
    }
}
