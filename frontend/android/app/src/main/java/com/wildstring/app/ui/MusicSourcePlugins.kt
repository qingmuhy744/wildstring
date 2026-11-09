package com.wildstring.app.ui

import com.wildstring.app.R
import com.wildstring.app.AppLanguage
import androidx.compose.ui.res.stringResource
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream

@Composable internal fun SourcePluginsPanel(vm: MusicViewModel) {
    val context = LocalContext.current; val uriHandler = LocalUriHandler.current
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    var plugins by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var fields by remember { mutableStateOf<Map<String, Map<String, String>>>(emptyMap()) }
    var savedPlugins by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var savedFields by remember { mutableStateOf<Map<String, Map<String, String>>>(emptyMap()) }
    val tests = remember { mutableStateMapOf<String, FeatureAction>() }
    val busy = action.busy || tests.values.any { it.busy }
    var upgrade by remember { mutableStateOf<JsonObject?>(null) }; var exporting by remember { mutableStateOf<JsonObject?>(null) }
    suspend fun load() {
        plugins = vm.repository.feature("manage/source-plugins").objects()
        fields = plugins.associate { it.text("id") to (it.getAsJsonObject("config")?.entrySet()?.associate { e -> e.key to e.value.asString } ?: emptyMap()) }
        savedPlugins = plugins.associate { it.text("id") to it.toString() }
        savedFields = fields
    }
    val importer = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch { action.run {
            val owner = vm.repository.session.cacheScope()
            val bytes = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)!!.use { input ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val n = input.read(buffer); if (n < 0) break; require(output.size() + n <= 16 * 1024 * 1024) { AppLanguage.string(R.string.src_plugin_zip_size_exceeded) }; output.write(buffer, 0, n) }
                output.toByteArray()
            } }
            require(owner == vm.repository.session.cacheScope()) { AppLanguage.string(R.string.src_plugin_account_changed) }
            val url = vm.repository.url("api", "v1", "manage", "source-plugins", "import") + (upgrade?.let { "?expected_version=${it.number("version")}&expected_id=${it.text("id")}" } ?: "")
            val response = vm.repository.api().uploadPlugin(url, bytes.toRequestBody("application/zip".toMediaType()), RequestOwner(owner!!))
            if (!response.isSuccessful) throw AgentApiException(response.code(), "source_plugin_invalid_zip", diagnosticId(response.headers()["X-Wildstring-Trace-Id"]))
            require(owner == vm.repository.session.cacheScope()) { AppLanguage.string(R.string.src_plugin_account_changed) }
            load(); action.message = AppLanguage.string(R.string.src_plugin_imported_disabled_notice); upgrade = null
        } }
    }
    val exporter = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        val plugin = exporting
        if (uri != null && plugin != null) scope.launch { action.run {
            withContext(Dispatchers.IO) { vm.repository.api().downloadPlugin(vm.repository.url("api", "v1", "manage", "source-plugins", plugin.text("id"), "export"), RequestOwner(vm.repository.session.cacheScope()!!)).use { body ->
                context.contentResolver.openOutputStream(uri, "wt")!!.use { output -> body.byteStream().use { input ->
                    val buffer = ByteArray(8192); var total = 0
                    while (true) { val n = input.read(buffer); if (n < 0) break; total += n; require(total <= 16 * 1024 * 1024); output.write(buffer, 0, n) }
                } }
            } }; action.message = AppLanguage.string(R.string.src_plugin_exported_notice)
        } }
    }
    LaunchedEffect(Unit) { action.run { load() }; if (action.message == "\u5df2\u5b8c\u6210") action.message = null }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.src_plugin_title), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.src_plugin_description))
        ActionStatus(action)
        Button({ upgrade = null; importer.launch(arrayOf("application/zip", "application/octet-stream")) }, enabled = !busy) { Text(stringResource(R.string.src_plugin_import_zip)) }
        plugins.forEach { p -> key(p.text("id")) {
            val id = p.text("id")
            val test = remember { FeatureAction().also { tests[id] = it } }
            val dirty = savedPlugins[id] != p.toString() || savedFields[id] != fields[id]
            HorizontalDivider(); Text(p.text("name"), style = MaterialTheme.typography.titleMedium)
            Text(if (p.flag("request_pacing")) stringResource(R.string.src_plugin_request_pacing) else stringResource(R.string.src_plugin_call_pacing_hint), style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.src_plugin_version_info, p.text("license"), p.text("plugin_version"), p.number("version")), style = MaterialTheme.typography.bodySmall)
            TextButton({ uriHandler.openUri(p.text("upstream")) }) { Text(stringResource(R.string.src_plugin_view_upstream)) }
            if (!p.flag("available")) Text(stringResource(R.string.src_plugin_missing_dependencies))
            listOf("enabled" to R.string.src_plugin_enable_plugin, "metadata_enabled" to R.string.src_plugin_provide_metadata, "lyrics_enabled" to R.string.src_plugin_provide_lyrics).forEach { (key, labelRes) ->
                Row { Text(stringResource(labelRes), Modifier.weight(1f)); Switch(p.flag(key), { checked -> plugins = plugins.map { value -> if (value === p) value.deepCopy().apply { addProperty(key, checked) } else value } }, enabled = !busy) }
            }
            OutlinedTextField(p.number("priority").toString(), { text -> text.toIntOrNull()?.takeIf { it in 0..100 }?.let { number -> plugins = plugins.map { value -> if (value === p) value.deepCopy().apply { addProperty("priority", number) } else value } } }, label = { Text(stringResource(R.string.src_plugin_priority_label)) })
            p.objects("settings").forEach { field ->
                val key = field.text("key"); val id = p.text("id")
                OutlinedTextField(fields[id]?.get(key).orEmpty(), { fields = fields + (id to (fields[id].orEmpty() + (key to it))) }, label = { Text(field.text("label")) }, visualTransformation = if (field.text("type") == "secret") PasswordVisualTransformation() else VisualTransformation.None, singleLine = true)
            }
            TextButton({ scope.launch { action.run {
                val config = JsonObject().apply { fields[p.text("id")]?.forEach { (key, value) -> addProperty(key, value) } }
                vm.repository.feature("manage/source-plugins/${p.text("id")}", "PUT", jsonBody("version" to p.number("version"), "enabled" to p.flag("enabled"), "metadata_enabled" to p.flag("metadata_enabled"), "lyrics_enabled" to p.flag("lyrics_enabled"), "priority" to p.number("priority")).apply { add("config", config) })
                load(); action.message = AppLanguage.string(R.string.src_plugin_settings_saved)
            } } }, enabled = !busy) { Text(stringResource(R.string.src_plugin_save_named, p.text("name"))) }
            TextButton({ scope.launch { test.run {
                val result = vm.repository.feature("manage/source-plugins/$id/test", "POST")
                test.message = AppLanguage.string(R.string.src_plugin_test_response, result.number("count").toInt())
            } } }, enabled = !busy && !dirty && p.flag("enabled"), modifier = Modifier.testTag("plugin-test-$id")) { Text(stringResource(R.string.src_plugin_test_plugin)) }
            if (dirty) Text(stringResource(R.string.src_plugin_save_before_test_hint), style = MaterialTheme.typography.bodySmall)
            else Column(Modifier.testTag("plugin-test-result-$id")) { ActionStatus(test) }
            Row {
                TextButton({ exporting = p; exporter.launch("wildstring-${p.text("id")}.zip") }, enabled = !busy) { Text(stringResource(R.string.src_plugin_export_zip)) }
                TextButton({ upgrade = p; importer.launch(arrayOf("application/zip", "application/octet-stream")) }, enabled = !busy) { Text(stringResource(R.string.src_plugin_upgrade_zip)) }
            }
            TextButton({ scope.launch { action.run {
                val response = vm.repository.api().agentDelete(vm.repository.url("api", "v1", "manage", "source-plugins", p.text("id")) + "?version=${p.number("version")}", RequestOwner(vm.repository.session.cacheScope()!!))
                if (!response.isSuccessful) throw AgentApiException(response.code(), "source_plugin_disable_first", null)
                load(); action.message = AppLanguage.string(R.string.src_plugin_uninstalled_notice)
            } } }, enabled = !busy && !p.flag("enabled")) { Text(stringResource(R.string.src_plugin_uninstall_plugin)) }
        } }
        if (plugins.isEmpty()) Text(stringResource(R.string.src_plugin_empty_hint))
    }
}

private data class CandidateQualitySummary(
    val label: String,
    val wordTimed: Boolean,
    val bilingual: Boolean,
    val romanized: Boolean,
    val synced: Boolean,
    val wordCoveragePct: Int,
    val translationCoveragePct: Int,
)

private fun candidateQualitySummary(candidate: JsonObject): CandidateQualitySummary {
    val lyrics = candidate.getAsJsonObject("normalized")
    val lines = lyrics?.objects("lines").orEmpty().filter { it.text("text").isNotBlank() }
    val count = lines.size.coerceAtLeast(1)
    val romanized = lines.any { it.text("romanization").isNotBlank() }
    val quality = candidate.get("quality")?.takeIf { it.isJsonObject }?.asJsonObject
    if (quality != null) {
        val wordCov = ((quality.get("word_coverage")?.takeIf { !it.isJsonNull }?.asDouble ?: 0.0) * 100).toInt()
        val transCov = ((quality.get("translation_coverage")?.takeIf { !it.isJsonNull }?.asDouble ?: 0.0) * 100).toInt()
        val level = quality.number("level").toInt()
        return CandidateQualitySummary(
            label = quality.text("label").ifBlank { AppLanguage.string(R.string.src_plugin_quality_unknown) },
            wordTimed = quality.flag("word_timed"),
            bilingual = quality.flag("bilingual"),
            romanized = romanized,
            synced = level >= 2,
            wordCoveragePct = wordCov,
            translationCoveragePct = transCov,
        )
    }
    val timedRatio = lines.count { it.get("time_ms")?.isJsonNull == false } / count.toDouble()
    val wordRatio = lines.count { it.objects("words").isNotEmpty() } / count.toDouble()
    val transRatio = lines.count { it.text("translation").isNotBlank() } / count.toDouble()
    val synced = lyrics?.text("kind") == "synced" && timedRatio >= 0.8
    val wordTimed = synced && wordRatio >= 0.8
    val bilingual = synced && transRatio >= 0.8
    val label = when {
        wordTimed && bilingual -> AppLanguage.string(R.string.src_plugin_quality_bilingual_word)
        wordTimed -> AppLanguage.string(R.string.src_plugin_quality_word)
        synced && bilingual -> AppLanguage.string(R.string.src_plugin_quality_bilingual_synced)
        synced -> AppLanguage.string(R.string.src_plugin_quality_synced)
        lines.isNotEmpty() -> AppLanguage.string(R.string.src_plugin_quality_static)
        else -> AppLanguage.string(R.string.src_plugin_quality_none)
    }
    return CandidateQualitySummary(
        label = label,
        wordTimed = wordTimed,
        bilingual = bilingual,
        romanized = romanized,
        synced = synced,
        wordCoveragePct = (wordRatio * 100).toInt(),
        translationCoveragePct = (transRatio * 100).toInt(),
    )
}

@Composable private fun LyricBadgePill(text: String, highlighted: Boolean = false) {
    Surface(
        shape = androidx.compose.foundation.shape.RoundedCornerShape(999.dp),
        color = if (highlighted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = if (highlighted) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
        )
    }
}

@Composable internal fun OnlineLyricsPanel(vm: MusicViewModel, track: Track, applied: () -> Unit) {
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope(); val uriHandler = LocalUriHandler.current
    var result by remember { mutableStateOf<JsonObject?>(null) }; var selected by remember { mutableStateOf<JsonObject?>(null) }; var offset by remember { mutableStateOf("0") }
    var filterMode by remember { mutableStateOf("all") }
    var showWordSplits by remember { mutableStateOf(true) }
    suspend fun load() { result = vm.repository.feature("manage/tracks/${track.id}/online-lyrics") }
    LaunchedEffect(track.id) { action.run { load() }; if (action.message == "\u5df2\u5b8c\u6210") action.message = null }
    val running = result?.objects("jobs")?.any { it.text("status") in listOf("queued", "running") } == true
    LaunchedEffect(running, track.id) { while (result?.objects("jobs")?.any { it.text("status") in listOf("queued", "running") } == true) { delay(2000); load() } }
    val allCandidates = result?.objects().orEmpty()
    val filteredCandidates = remember(allCandidates, filterMode) {
        allCandidates.filter { candidate ->
            val q = candidateQualitySummary(candidate)
            when (filterMode) {
                "word" -> q.wordTimed
                "bilingual" -> q.bilingual
                else -> true
            }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        HorizontalDivider(); Text(stringResource(R.string.src_plugin_lyrics_candidates_title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.src_plugin_lyrics_candidates_hint), style = MaterialTheme.typography.bodySmall)
        ActionStatus(action)
        TextButton({ scope.launch { action.run { vm.repository.feature("manage/tracks/${track.id}/online-lyrics", "POST"); load() } } }, enabled = !action.busy && !running) { Text(if (running) stringResource(R.string.src_plugin_searching_lyrics) else stringResource(R.string.src_plugin_find_online_lyrics)) }
        if (running) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        if (allCandidates.size > 1) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(filterMode == "all", { filterMode = "all" }, label = { Text(stringResource(R.string.src_plugin_filter_all, allCandidates.size), maxLines = 1, softWrap = false) })
                FilterChip(filterMode == "word", { filterMode = "word" }, label = { Text(stringResource(R.string.src_plugin_filter_word, allCandidates.count { candidateQualitySummary(it).wordTimed }), maxLines = 1, softWrap = false) })
                FilterChip(filterMode == "bilingual", { filterMode = "bilingual" }, label = { Text(stringResource(R.string.src_plugin_filter_bilingual, allCandidates.count { candidateQualitySummary(it).bilingual }), maxLines = 1, softWrap = false) })
            }
        }
        filteredCandidates.forEach { candidate ->
            val match = candidate.getAsJsonObject("match"); val lyrics = candidate.getAsJsonObject("normalized")
            val q = candidateQualitySummary(candidate)
            val artists = match.getAsJsonArray("artists")?.mapNotNull { it?.asString }?.joinToString(" / ").orEmpty()
            val scorePct = ((match.get("score")?.takeIf { !it.isJsonNull }?.asDouble ?: 0.0) * 100).toInt()
            val diffMs = match.get("duration_difference_ms")?.takeIf { !it.isJsonNull }?.asLong
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        LyricBadgePill(
                            text = if (q.wordTimed) stringResource(R.string.src_plugin_badge_word_pct, q.wordCoveragePct) else if (q.synced) stringResource(R.string.src_plugin_quality_synced) else stringResource(R.string.src_plugin_quality_static),
                            highlighted = q.wordTimed,
                        )
                        if (q.bilingual) LyricBadgePill(stringResource(R.string.src_plugin_badge_bilingual_pct, q.translationCoveragePct))
                        if (q.romanized) LyricBadgePill(stringResource(R.string.src_plugin_badge_romanized))
                        LyricBadgePill(lyrics.text("format").uppercase())
                    }
                    Text("${candidate.text("plugin_id")} · ${match.text("title")}", style = MaterialTheme.typography.titleSmall)
                    Text(
                        buildList {
                            if (artists.isNotBlank()) add(artists)
                            add(q.label)
                            add(stringResource(R.string.src_plugin_line_count, candidate.number("line_count").toInt()))
                            add(stringResource(R.string.src_plugin_match_score, scorePct))
                            if (diffMs != null) add(stringResource(R.string.src_plugin_duration_diff, String.format(java.util.Locale.US, "%.1f", diffMs / 1000.0)))
                        }.joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (match.flag("version_mismatch")) Text(stringResource(R.string.src_plugin_version_mismatch_warning), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton({ uriHandler.openUri(candidate.text("source_url")) }) { Text(stringResource(R.string.src_plugin_view_lyric_source)) }
                        TextButton({ selected = candidate; offset = "0" }, enabled = !action.busy) { Text(stringResource(R.string.src_plugin_preview_and_select_lyrics)) }
                    }
                }
            }
        }
        result?.objects("jobs")?.firstOrNull()?.getAsJsonArray("warnings")?.forEach { Text(it.asString, style = MaterialTheme.typography.bodySmall) }
    }
    selected?.let { candidate ->
        val q = candidateQualitySummary(candidate)
        val lines = candidate.getAsJsonObject("normalized").objects("lines").take(100)
        val hasWords = lines.any { it.objects("words").isNotEmpty() }
        val state by vm.state.collectAsStateWithLifecycle()
        val position by vm.position.collectAsStateWithLifecycle()
        val isCurrentTrack = state.current?.id == track.id
        AlertDialog(onDismissRequest = { if (!action.busy) selected = null }, title = { Text(stringResource(R.string.src_plugin_confirm_use_lyric_title)) }, text = {
            Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    LyricBadgePill(q.label, highlighted = q.wordTimed)
                    if (q.wordTimed) LyricBadgePill(stringResource(R.string.src_plugin_word_coverage, q.wordCoveragePct))
                    if (q.bilingual) LyricBadgePill(stringResource(R.string.src_plugin_trans_coverage, q.translationCoveragePct))
                }
                Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (!isCurrentTrack) {
                                TextButton({ vm.play(listOf(track)) }) { Text(stringResource(R.string.src_plugin_play_to_audition)) }
                            } else {
                                TextButton(vm::toggle) { Text(if (state.playing) stringResource(R.string.src_plugin_audition_pause) else stringResource(R.string.src_plugin_audition_play)) }
                                Text(formatTime(position) + " / " + formatTime(track.durationMs), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        if (isCurrentTrack && track.durationMs > 0) {
                            Slider(
                                value = position.toFloat().coerceIn(0f, track.durationMs.toFloat()),
                                onValueChange = { vm.seek(it.toLong()) },
                                valueRange = 0f..track.durationMs.toFloat(),
                                modifier = Modifier.fillMaxWidth().height(24.dp)
                            )
                        }
                    }
                }
                if (hasWords) {
                    FilterChip(
                        selected = showWordSplits,
                        onClick = { showWordSplits = !showWordSplits },
                        label = { Text(stringResource(R.string.src_plugin_show_word_splits)) },
                    )
                }
                Text(lines.joinToString("\n\n") { line ->
                    val timePrefix = line.get("time_ms")?.takeIf { !it.isJsonNull }?.asLong?.let { ms ->
                        String.format(java.util.Locale.US, "[%02d:%05.2f] ", ms / 60000, (ms % 60000) / 1000.0)
                    }.orEmpty()
                    val words = line.objects("words")
                    val mainText = if (hasWords && showWordSplits && words.isNotEmpty()) {
                        words.joinToString(" ") { w ->
                            val start = w.get("start_ms")?.takeIf { !it.isJsonNull }?.asLong
                            if (start != null) "${w.text("text")}⟨${String.format(java.util.Locale.US, "%.2fs", start / 1000.0)}⟩" else w.text("text")
                        }
                    } else {
                        line.text("text")
                    }
                    listOf(timePrefix + mainText, line.text("translation"), line.text("romanization")).filter { it.isNotBlank() }.joinToString("\n")
                })
                OutlinedTextField(offset, { offset = it }, label = { Text(stringResource(R.string.src_plugin_offset_label)) })
                ActionStatus(action)
            }
        }, confirmButton = { TextButton({ scope.launch { action.run {
            vm.repository.feature("manage/lyric-candidates/${candidate.text("id")}/apply", "POST", jsonBody("version" to candidate.number("lyrics_version"), "file_version" to candidate.text("file_version"), "offset_ms" to (offset.toIntOrNull() ?: 0)))
            selected = null; load(); applied(); vm.refreshLyrics(); action.message = AppLanguage.string(R.string.src_plugin_lyric_saved_notice)
        } } }, enabled = !action.busy && offset.toIntOrNull() in -60000..60000) { Text(stringResource(R.string.src_plugin_confirm_use_lyric)) } }, dismissButton = { TextButton({ selected = null }, enabled = !action.busy) { Text(stringResource(R.string.src_plugin_cancel)) } })
    }
}
