package com.wildstring.app.ui

import com.wildstring.app.R
import com.wildstring.app.AppLanguage
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val lyricLevels = listOf(
    R.string.lyric_scan_level_none,
    R.string.lyric_scan_level_static,
    R.string.lyric_scan_level_synced,
    R.string.lyric_scan_level_bilingual_synced,
    R.string.lyric_scan_level_word,
    R.string.lyric_scan_level_bilingual_word,
)
internal fun lyricLevelLabel(quality: JsonObject?): String? {
    if (quality == null) return null
    val level = quality.get("level")?.takeIf { !it.isJsonNull }?.asInt
    if (level != null && level in lyricLevels.indices) return AppLanguage.string(lyricLevels[level])
    return quality.text("label").takeIf { it.isNotBlank() }
}
private val lyricStateResIds = mapOf(
    "running" to R.string.lyric_scan_state_running,
    "queued" to R.string.lyric_scan_state_queued,
    "paused" to R.string.lyric_scan_state_paused,
    "completed" to R.string.lyric_scan_state_completed,
    "cancelled" to R.string.lyric_scan_state_cancelled,
    "ready" to R.string.lyric_scan_state_ready,
    "review" to R.string.lyric_scan_state_review,
    "no_match" to R.string.lyric_scan_state_no_match,
    "failed" to R.string.lyric_scan_state_failed,
    "locked" to R.string.lyric_scan_state_locked,
    "skipped_goal" to R.string.lyric_scan_state_skipped_goal,
    "skipped_scanned" to R.string.lyric_scan_state_skipped_scanned,
    "stale" to R.string.lyric_scan_state_stale,
    "applied" to R.string.lyric_scan_state_applied,
    "restored" to R.string.lyric_scan_state_restored,
)
private fun lyricStateLabel(status: String): String =
    lyricStateResIds[status]?.let { AppLanguage.string(it) } ?: status

@Composable internal fun LyricScansPanel(vm: MusicViewModel, albumId: String? = null, initialBatchId: String? = null) {
    val focus = LocalFocusManager.current; val keyboard = LocalSoftwareKeyboardController.current
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    val list = rememberLazyListState()
    var goal by remember { mutableIntStateOf(5) }; var mode by remember { mutableStateOf("upgrade") }
    var preference by remember { mutableStateOf("timing") }; var profile by remember { mutableStateOf("low") }
    var interval by remember { mutableStateOf("10") }; var force by remember { mutableStateOf(false) }
    var defaults by remember { mutableStateOf<JsonObject?>(null) }; var editDefaults by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<Long?>(null) }; var batch by remember { mutableStateOf<JsonObject?>(null) }
    var history by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var historyOpen by remember { mutableStateOf(false) }
    var offset by remember { mutableIntStateOf(0) }; var selected by remember { mutableStateOf<Set<String>>(emptySet()) }
    var confirm by remember { mutableStateOf<String?>(null) }; var previewTrack by remember { mutableStateOf<Track?>(null) }
    val endpoint = "manage/lyric-scans"
    fun options() = jsonBody("scope" to if (albumId == null) "library" else "album", "scope_id" to albumId,
        "mode" to mode, "goal" to if (mode == "missing") 1 else goal, "preference" to preference,
        "rate_profile" to profile, "interval_seconds" to (interval.toIntOrNull() ?: 10), "force" to force)
    suspend fun load(id: String? = batch?.text("id"), page: Int = offset) {
        history = vm.repository.feature(endpoint).objects().filter { albumId == null || it.getAsJsonObject("options").text("scope_id") == albumId }
        if (id != null) batch = vm.repository.feature("$endpoint/$id", query = mapOf("offset" to page.toString(), "limit" to "50"))
    }
    fun control(command: String) { scope.launch { action.run {
        batch?.let { vm.repository.feature("$endpoint/${it.text("id")}/control", "POST", jsonBody("action" to command)) }
        confirm = null; load()
    } } }
    LaunchedEffect(albumId, initialBatchId) { action.run { load(initialBatchId); defaults = vm.repository.feature("manage/lyric-scan-settings"); profile = defaults!!.text("default_profile") }; if (action.message == "\u5df2\u5b8c\u6210") action.message = null }
    LaunchedEffect(batch?.text("id")) { if (batch != null) list.animateScrollToItem(1) }
    LaunchedEffect(goal, mode, preference, profile, interval, force) { preview = null }
    LaunchedEffect(batch?.text("id"), batch?.text("status"), offset) {
        while (batch?.text("status") == "running") { delay(2000); action.run { load() }; if (action.message == "\u5df2\u5b8c\u6210") action.message = null }
    }
    LazyColumn(Modifier.fillMaxSize().testTag("lyric-scans-panel"), state = list, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(if (albumId == null) stringResource(R.string.lyric_scan_library_title) else stringResource(R.string.lyric_scan_album_title), style = MaterialTheme.typography.titleLarge)
                Text(stringResource(R.string.lyric_scan_description), style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(mode == "upgrade", { mode = "upgrade" }, { Text(stringResource(R.string.lyric_scan_mode_upgrade)) }, enabled = !action.busy)
                    FilterChip(mode == "missing", { mode = "missing" }, { Text(stringResource(R.string.lyric_scan_mode_missing)) }, enabled = !action.busy)
                }
                if (mode == "upgrade") {
                    Text(stringResource(R.string.lyric_scan_goal_level))
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        lyricLevels.drop(1).forEachIndexed { i, resId -> FilterChip(goal == i + 1, { goal = i + 1 }, { Text(stringResource(resId)) }, enabled = !action.busy) }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(preference == "timing", { preference = "timing" }, { Text(stringResource(R.string.lyric_scan_pref_timing)) }, enabled = !action.busy)
                    FilterChip(preference == "bilingual", { preference = "bilingual" }, { Text(stringResource(R.string.lyric_scan_pref_bilingual)) }, enabled = !action.busy)
                }
                Text(stringResource(R.string.lyric_scan_rate_heading))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("low" to R.string.lyric_scan_rate_low, "medium" to R.string.lyric_scan_rate_medium, "high" to R.string.lyric_scan_rate_high, "custom" to R.string.lyric_scan_rate_custom).forEach { (key, labelRes) ->
                        val suffix = if (key == "custom") "" else stringResource(R.string.lyric_scan_rate_seconds_suffix, defaults?.number(key + "_seconds")?.toInt() ?: 0)
                        FilterChip(profile == key, { profile = key }, { Text(stringResource(labelRes) + suffix) }, enabled = !action.busy, modifier = Modifier.testTag("lyric-rate-$key"))
                    }
                }
                if (profile == "custom") OutlinedTextField(interval, { interval = it }, label = { Text(stringResource(R.string.lyric_scan_custom_interval_label)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { focus.clearFocus(); keyboard?.hide() }), enabled = !action.busy)
                Text(stringResource(R.string.lyric_scan_rate_hint), style = MaterialTheme.typography.bodySmall)
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(force, { force = it }, enabled = !action.busy); Text(stringResource(R.string.lyric_scan_force_rescan)) }
                ActionStatus(action)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton({ scope.launch { action.run { preview = vm.repository.feature("$endpoint/preview", "POST", options()).number("total") } } }, enabled = !action.busy && interval.toIntOrNull() in 1..120) { Text(stringResource(R.string.lyric_scan_check_scope)) }
                    TextButton({ scope.launch { action.run { load() } } }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_refresh_tasks)) }
                }
                preview?.let { total ->
                    Text(stringResource(R.string.lyric_scan_scope_total, total.toInt()))
                    Button({ scope.launch { action.run { batch = vm.repository.feature(endpoint, "POST", options()); offset = 0; selected = emptySet(); load() } } }, enabled = !action.busy && total > 0) { Text(stringResource(R.string.lyric_scan_start_scan)) }
                }
                TextButton({ editDefaults = !editDefaults }) { Text(stringResource(R.string.lyric_scan_edit_defaults)) }
                if (editDefaults) defaults?.let { settings ->
                    val rateSettingsList = listOf("low" to R.string.lyric_scan_rate_low, "medium" to R.string.lyric_scan_rate_medium, "high" to R.string.lyric_scan_rate_high)
                    rateSettingsList.forEach { (key, labelRes) ->
                        val field = key + "_seconds"
                        OutlinedTextField(settings.number(field).toString(), { text -> text.toIntOrNull()?.let { value -> defaults = settings.deepCopy().apply { addProperty(field, value) } } }, label = { Text(stringResource(R.string.lyric_scan_interval_seconds_label, stringResource(labelRes))) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), enabled = !action.busy)
                    }
                    Text(stringResource(R.string.lyric_scan_default_profile_heading))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        rateSettingsList.forEach { (key, labelRes) -> FilterChip(settings.text("default_profile") == key, { defaults = settings.deepCopy().apply { addProperty("default_profile", key) } }, { Text(stringResource(labelRes)) }, enabled = !action.busy) }
                    }
                    val valid = settings.number("low_seconds") >= settings.number("medium_seconds") && settings.number("medium_seconds") >= settings.number("high_seconds") && listOf("low_seconds", "medium_seconds", "high_seconds").all { settings.number(it) in 1..120 }
                    Button({ scope.launch { action.run { defaults = vm.repository.feature("manage/lyric-scan-settings", "PUT", settings); action.message = AppLanguage.string(R.string.lyric_scan_defaults_saved) } } }, enabled = !action.busy && valid) { Text(stringResource(R.string.lyric_scan_save_defaults)) }
                }
                HorizontalDivider()
                TextButton({ historyOpen = !historyOpen }) { Text(stringResource(R.string.lyric_scan_recent_tasks, history.size)) }
                if (historyOpen) history.forEach { entry -> TextButton({ scope.launch { action.run { offset = 0; selected = emptySet(); load(entry.text("id"), 0) } } }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_history_entry, entry.number("total").toInt(), lyricStateLabel(entry.text("status")), java.text.DateFormat.getDateTimeInstance().format(java.util.Date(entry.number("created_at") * 1000)))) } }
            }
        }
        batch?.let { current ->
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.lyric_scan_batch_summary, lyricStateLabel(current.text("status")), current.number("total").toInt()), style = MaterialTheme.typography.titleMedium)
                    current.getAsJsonObject("options")?.number("interval_seconds")?.takeIf { it > 0 }?.let { Text(stringResource(R.string.lyric_scan_task_interval, it.toInt()), style = MaterialTheme.typography.bodySmall) }
                    Text(current.getAsJsonObject("counts").entrySet().joinToString(" · ") { "${lyricStateLabel(it.key)} ${it.value.asInt}" })
                    current.objects("cooldowns").forEach { Text(stringResource(R.string.lyric_scan_cooldown_reason, it.text("plugin_id"), it.text("reason")), style = MaterialTheme.typography.bodySmall) }
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (current.text("status") == "running") OutlinedButton({ control("pause") }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_pause)) }
                        if (current.text("status") == "paused") OutlinedButton({ control("resume") }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_resume)) }
                        if (current.text("status") in listOf("running", "paused")) TextButton({ confirm = "cancel" }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_cancel_task)) }
                        else TextButton({ control("retry_failed") }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_retry_failed)) }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton({ selected = current.objects().filter { it.text("status") == "ready" }.map { it.text("id") }.toSet() }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_select_page_ready)) }
                        Button({ confirm = "apply" }, enabled = !action.busy && selected.isNotEmpty()) { Text(stringResource(R.string.lyric_scan_confirm_selected, selected.size)) }
                    }
                }
            }
            items(current.objects(), key = { it.text("id") }) { item ->
                ElevatedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(item.text("id") in selected, { checked -> selected = if (checked) selected + item.text("id") else selected - item.text("id") }, enabled = !action.busy && item.text("status") == "ready")
                        Text(item.text("title"), Modifier.weight(1f)); Text(lyricStateLabel(item.text("status")), style = MaterialTheme.typography.labelMedium)
                    }
                    val baseline = item.get("baseline")?.takeIf { it.isJsonObject }?.asJsonObject
                    val candidate = item.get("quality")?.takeIf { it.isJsonObject }?.asJsonObject
                    val baselineLabel = lyricLevelLabel(baseline) ?: stringResource(R.string.lyric_scan_not_checked)
                    val candidateLabel = lyricLevelLabel(candidate)
                    Text(baselineLabel + (candidateLabel?.let { " → $it" } ?: ""))
                    if (item.text("error").isNotBlank()) Text(stringResource(R.string.lyric_scan_source_error, item.text("error")), style = MaterialTheme.typography.bodySmall)
                    TextButton({ scope.launch { action.run { previewTrack = vm.repository.track(item.text("track_id")) } } }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_preview_candidates)) }
                    TextButton({ scope.launch { action.run { val path = "manage/tracks/${item.text("track_id")}/lyric-lock"; val lock = vm.repository.feature(path); vm.repository.feature(path, "PUT", lock.deepCopy().apply { addProperty("locked", !lock.flag("locked")) }); action.message = if (lock.flag("locked")) AppLanguage.string(R.string.lyric_scan_unlocked_message) else AppLanguage.string(R.string.lyric_scan_locked_message) } } }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_lock_unlock)) }
                    if (item.text("status") == "applied") TextButton({ scope.launch { action.run { vm.repository.feature("manage/lyric-scan-items/${item.text("id")}/restore", "POST"); vm.refreshLyrics(); load() } } }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_restore_previous)) }
                } }
            }
            item { Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton({ scope.launch { action.run { offset = (offset - 50).coerceAtLeast(0); selected = emptySet(); load() } } }, enabled = !action.busy && offset > 0) { Text(stringResource(R.string.lyric_scan_prev_page)) }
                Text("${(offset+1).coerceAtMost(current.number("total").toInt())}–${(offset+50).coerceAtMost(current.number("total").toInt())} / ${current.number("total")}")
                TextButton({ scope.launch { action.run { offset += 50; selected = emptySet(); load() } } }, enabled = !action.busy && offset + 50 < current.number("total")) { Text(stringResource(R.string.lyric_scan_next_page)) }
            } }
        }
    }
    confirm?.let { command -> AlertDialog(onDismissRequest = { if (!action.busy) confirm = null }, title = { Text(if (command == "apply") stringResource(R.string.lyric_scan_confirm_apply_title) else stringResource(R.string.lyric_scan_confirm_cancel_title)) }, text = { Column { Text(if (command == "apply") stringResource(R.string.lyric_scan_confirm_apply_message, selected.size) else stringResource(R.string.lyric_scan_confirm_cancel_message)) ; ActionStatus(action) } }, confirmButton = { TextButton({ if (command == "cancel") control("cancel") else scope.launch { action.run {
        val result = vm.repository.feature("$endpoint/${batch!!.text("id")}/apply", "POST", jsonBody("item_ids" to jsonStrings(selected.toList())))
        selected = emptySet(); confirm = null; vm.refreshLyrics(); load()
        val appliedCount = result.objects().count { it.text("status") == "applied" }
        val conflictCount = result.objects().count { it.text("status") == "conflict" }
        action.message = AppLanguage.string(R.string.lyric_scan_applied_result_message, appliedCount, conflictCount)
    } } }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_confirm)) } }, dismissButton = { TextButton({ confirm = null }, enabled = !action.busy) { Text(stringResource(R.string.lyric_scan_back)) } }) }
    previewTrack?.let { track -> Dialog(onDismissRequest = { previewTrack = null }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) { Column(Modifier.fillMaxSize().padding(16.dp)) { TextButton({ previewTrack = null }) { Text(stringResource(R.string.lyric_scan_close_preview)) }; androidx.compose.foundation.lazy.LazyColumn { item { OnlineLyricsPanel(vm, track) { scope.launch { load() } } } } } }
    } }
}
