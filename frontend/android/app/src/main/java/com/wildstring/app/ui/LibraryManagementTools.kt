package com.wildstring.app.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import com.wildstring.app.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal fun obj(vararg values: Pair<String, Any?>): JsonObject = JsonObject().apply { values.forEach { (key, value) ->
    when(value) { null -> add(key, JsonNull.INSTANCE); is JsonElement -> add(key, value); is Boolean -> addProperty(key, value); is Number -> addProperty(key, value); else -> addProperty(key, value.toString()) }
} }
internal fun JsonObject.text(key: String): String = get(key)?.takeUnless { it.isJsonNull }?.let { if (it.isJsonPrimitive) it.asString else it.toString() }.orEmpty()
private fun fieldText(value: JsonElement?): String = when { value == null || value.isJsonNull -> ""; value.isJsonArray -> value.asJsonArray.joinToString("\n") { it.asString }; value.isJsonPrimitive -> value.asString; else -> value.toString() }
private fun JsonObject.arrayText(key: String, separator: String = " / "): String = getAsJsonArray(key)?.joinToString(separator) { it.asString }.orEmpty()
private val metadataFields: List<Pair<String, Int>> = listOf(
    "title" to R.string.lib_mgmt_field_title,
    "artists" to R.string.lib_mgmt_field_artists,
    "album" to R.string.lib_mgmt_field_album,
    "album_artists" to R.string.lib_mgmt_field_album_artists,
    "vocalists" to R.string.lib_mgmt_field_vocalists,
    "lyricists" to R.string.lib_mgmt_field_lyricists,
    "composers" to R.string.lib_mgmt_field_composers,
    "arrangers" to R.string.lib_mgmt_field_arrangers,
    "track_number" to R.string.lib_mgmt_field_track_number,
    "disc_number" to R.string.lib_mgmt_field_disc_number,
)
private val arrayFields = setOf("artists", "album_artists", "vocalists", "lyricists", "composers", "arrangers")
private val multiValueRegex = Regex("""[\r\n/／\\,，、;；|]+""")
private fun splitMultiValue(value: String): List<String> =
    value.split(multiValueRegex).map { it.trim() }.filter { it.isNotEmpty() }.distinct()

private fun parseField(key: String, value: String): JsonElement = when {
    key in arrayFields -> JsonArray().apply { splitMultiValue(value).forEach { add(it) } }
    key.endsWith("_number") -> if (value.isBlank()) JsonNull.INSTANCE else com.google.gson.JsonPrimitive((value.toIntOrNull() ?: throw IllegalArgumentException(AppLanguage.string(R.string.lib_mgmt_number_range_error))).also { require(it in 1..99999) { AppLanguage.string(R.string.lib_mgmt_number_range_error) } })
    value.isBlank() && key != "title" -> JsonNull.INSTANCE
    else -> com.google.gson.JsonPrimitive(value.trim())
}

@Composable
private fun OnlineMetadataMatcherCard(
    vm: MusicViewModel,
    track: Track,
    onApply: (Map<String, String>) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var expanded by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var searching by remember { mutableStateOf(false) }
    var suggestions by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var providerNames by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var message by remember { mutableStateOf<String?>(null) }

    suspend fun fetchSuggestions() {
        loading = true
        runCatching {
            val res = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "providers", "tracks", track.id))
            val list = res.getAsJsonArray("suggestions")?.mapNotNull { it.takeIf { elem -> elem.isJsonObject }?.asJsonObject }.orEmpty()
            suggestions = list
            val names = res.getAsJsonObject("provider_names")
            if (names != null) {
                providerNames = names.keySet().associateWith { names.text(it) }
            }
        }
        loading = false
    }

    LaunchedEffect(expanded, track.id) {
        if (expanded) {
            fetchSuggestions()
        }
    }

    fun triggerSearch() {
        scope.launch {
            searching = true
            message = AppLanguage.string(R.string.lib_mgmt_searching_metadata_suggestions)
            runCatching {
                vm.repository.api().objectPost(
                    vm.repository.url("api", "v1", "manage", "providers", "query"),
                    obj("track_ids" to JsonArray().apply { add(track.id) })
                )
                delay(1500)
                fetchSuggestions()
                message = if (suggestions.isEmpty()) AppLanguage.string(R.string.lib_mgmt_search_no_results) else AppLanguage.string(R.string.lib_mgmt_search_results_count, suggestions.size)
            }.onFailure {
                message = AppLanguage.string(R.string.lib_mgmt_search_failed, it.message ?: "")
            }
            searching = false
        }
    }

    OutlinedCard(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        colors = CardDefaults.outlinedCardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
        )
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(stringResource(R.string.lib_mgmt_online_matcher_title), style = MaterialTheme.typography.titleSmall)
                        if (suggestions.isNotEmpty()) {
                            Surface(
                                shape = RoundedCornerShape(4.dp),
                                color = MaterialTheme.colorScheme.primaryContainer,
                            ) {
                                Text(
                                    stringResource(R.string.lib_mgmt_candidates_count, suggestions.size),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                            }
                        }
                    }
                    Text(
                        if (expanded) stringResource(R.string.lib_mgmt_matcher_hint_expanded) else stringResource(R.string.lib_mgmt_matcher_hint_collapsed),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                TextButton(
                    onClick = {
                        if (!expanded) expanded = true
                        triggerSearch()
                    },
                    enabled = !searching && !loading
                ) {
                    Text(if (searching) stringResource(R.string.lib_mgmt_searching) else if (suggestions.isEmpty()) stringResource(R.string.lib_mgmt_online_match) else stringResource(R.string.lib_mgmt_requery))
                }
            }

            if (searching || loading) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }

            if (message != null) {
                Text(
                    message!!,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary
                )
            }

            if (expanded) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                if (suggestions.isEmpty() && !loading && !searching) {
                    Text(
                        stringResource(R.string.lib_mgmt_no_online_candidates),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 4.dp)
                    )
                } else {
                    suggestions.take(3).forEachIndexed { index, candidate ->
                        val fieldsObj = candidate.getAsJsonObject("fields") ?: JsonObject()
                        val matchObj = candidate.getAsJsonObject("match")
                        val score = matchObj?.get("score")?.takeIf { !it.isJsonNull }?.asDouble ?: 0.0
                        val scorePct = (score * 100).toInt()
                        val providerKey = candidate.text("provider")
                        val providerLabel = providerNames[providerKey] ?: providerKey

                        val candTitle = fieldsObj.text("title").ifBlank { track.title }
                        val candArtists = fieldsObj.getAsJsonArray("artists")?.mapNotNull { it.asString } ?: emptyList()
                        val candAlbum = fieldsObj.text("album")
                        val candYear = fieldsObj.text("release_date").take(4)

                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = MaterialTheme.colorScheme.surface,
                            tonalElevation = 1.dp,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                                    ) {
                                        Surface(
                                            shape = RoundedCornerShape(4.dp),
                                            color = if (scorePct >= 90) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.secondaryContainer
                                        ) {
                                            Text(
                                                stringResource(R.string.lib_mgmt_score_match, scorePct),
                                                style = MaterialTheme.typography.labelSmall,
                                                modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp)
                                            )
                                        }
                                        Text(providerLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    Button(
                                        onClick = {
                                            val updates = mutableMapOf<String, String>()
                                            if (fieldsObj.text("title").isNotBlank()) updates["title"] = fieldsObj.text("title")
                                            if (candArtists.isNotEmpty()) updates["artists"] = candArtists.joinToString("\n")
                                            if (fieldsObj.text("album").isNotBlank()) updates["album"] = fieldsObj.text("album")
                                            val candAlbumArtists = fieldsObj.getAsJsonArray("album_artists")?.mapNotNull { it.asString }.orEmpty()
                                            if (candAlbumArtists.isNotEmpty()) updates["album_artists"] = candAlbumArtists.joinToString("\n")
                                            val candTrackNo = fieldsObj.get("track_number")?.takeIf { !it.isJsonNull }?.toString()
                                            if (!candTrackNo.isNullOrBlank()) updates["track_number"] = candTrackNo
                                            val candDiscNo = fieldsObj.get("disc_number")?.takeIf { !it.isJsonNull }?.toString()
                                            if (!candDiscNo.isNullOrBlank()) updates["disc_number"] = candDiscNo
                                            val candVocalists = fieldsObj.getAsJsonArray("vocalists")?.mapNotNull { it.asString }.orEmpty()
                                            if (candVocalists.isNotEmpty()) updates["vocalists"] = candVocalists.joinToString("\n")
                                            val candLyricists = fieldsObj.getAsJsonArray("lyricists")?.mapNotNull { it.asString }.orEmpty()
                                            if (candLyricists.isNotEmpty()) updates["lyricists"] = candLyricists.joinToString("\n")
                                            val candComposers = fieldsObj.getAsJsonArray("composers")?.mapNotNull { it.asString }.orEmpty()
                                            if (candComposers.isNotEmpty()) updates["composers"] = candComposers.joinToString("\n")
                                            val candArrangers = fieldsObj.getAsJsonArray("arrangers")?.mapNotNull { it.asString }.orEmpty()
                                            if (candArrangers.isNotEmpty()) updates["arrangers"] = candArrangers.joinToString("\n")

                                            onApply(updates)
                                            message = AppLanguage.string(R.string.lib_mgmt_applied_candidate_message, index + 1)
                                        },
                                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                        modifier = Modifier.height(32.dp)
                                    ) {
                                        Text(stringResource(R.string.lib_mgmt_apply_to_form), style = MaterialTheme.typography.labelSmall)
                                    }
                                }

                                Text(
                                    candTitle,
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
                                    maxLines = 1
                                )
                                Text(
                                    listOfNotNull(
                                        candArtists.joinToString(" / ").takeIf { it.isNotBlank() },
                                        candAlbum.takeIf { it.isNotBlank() },
                                        candYear.takeIf { it.isNotBlank() }
                                    ).joinToString(" · "),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun MetadataPanel(vm: MusicViewModel, track: Track) {
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    var original by remember { mutableStateOf<JsonObject?>(null) }
    val fields = remember { mutableStateMapOf<String, String>() }; var restore by remember { mutableStateOf(setOf<String>()) }
    suspend fun load() {
        original = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "tracks", track.id, "metadata"))
        val effective = original!!.getAsJsonObject("effective")
        metadataFields.forEach { (key, _) -> fields[key] = fieldText(effective.get(key)) }; restore = emptySet()
    }
    LaunchedEffect(track.id) { action.run { load() }; if (action.message == "\u5df2\u5b8c\u6210") action.message = null }
    Column(Modifier.fillMaxSize()) {
      Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(track.title, style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.lib_mgmt_metadata_hint), style = MaterialTheme.typography.bodySmall)

        // 轻量在线元数据匹配卡片（方案 A）
        OnlineMetadataMatcherCard(
            vm = vm,
            track = track,
            onApply = { updates ->
                updates.forEach { (key, value) ->
                    fields[key] = value
                    restore = restore - key
                }
                action.message = AppLanguage.string(R.string.lib_mgmt_applied_online_suggestions_message)
            }
        )

        original?.text("path")?.takeIf { it.isNotBlank() }?.let { path ->
            Text(stringResource(R.string.lib_mgmt_file_path, path), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (original != null) metadataFields.forEach { (key, label) ->
            OutlinedTextField(fields[key].orEmpty(), { fields[key] = it.take(8000); restore = restore - key }, Modifier.fillMaxWidth(), label = { Text(stringResource(label)) }, enabled = !action.busy && key !in restore, minLines = if (key in arrayFields) 2 else 1)
            if (original!!.getAsJsonObject("overrides")?.has(key) == true) Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(key in restore, { restore = if (it) restore + key else restore - key }); Text(stringResource(R.string.lib_mgmt_restore_file_value), style = MaterialTheme.typography.bodySmall)
            }
        }
      }
      // Keep the primary action reachable while editing any field or while the IME is open.
      // The enclosing FeatureDialog applies imePadding, so this footer remains above the keyboard.
      Surface(tonalElevation = 2.dp) {
       Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
        ActionStatus(action)
        Button({ focus.clearFocus(); keyboard?.hide(); scope.launch { action.run {
            val record = original ?: return@run
            val overrides = record.getAsJsonObject("overrides").deepCopy()
            val effective = record.getAsJsonObject("effective")
            metadataFields.forEach { (key, _) ->
                if (key in restore) overrides.remove(key)
                else if (fields[key].orEmpty() != fieldText(effective.get(key))) overrides.add(key, parseField(key, fields[key].orEmpty()))
            }
            vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "tracks", track.id, "metadata"), obj("version" to record.get("version"), "overrides" to overrides))
            load(); vm.load(); action.message = AppLanguage.string(R.string.lib_mgmt_metadata_saved)
        } } }, enabled = original != null && !action.busy, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.lib_mgmt_save_changes)) }
       }
      }
    }
}

@Composable
internal fun LyricsEditorPanel(vm: MusicViewModel, track: Track) {
    val state by vm.state.collectAsStateWithLifecycle(); val position by vm.position.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    var tabIndex by remember { mutableIntStateOf(0) }
    var record by remember { mutableStateOf<JsonObject?>(null) }; var text by remember { mutableStateOf("") }
    var timing by remember { mutableStateOf(false) }; var lines by remember { mutableStateOf<List<String>>(emptyList()) }
    var times by remember { mutableStateOf<List<Long?>>(emptyList()) }; var cursor by remember { mutableIntStateOf(0) }
    suspend fun load() {
        record = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "tracks", track.id, "lyrics"))
        text = record!!.text("text")
    }
    LaunchedEffect(track.id) { action.run { load() } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(track.title, style = MaterialTheme.typography.titleMedium)
        ActionStatus(action)

        PrimaryTabRow(selectedTabIndex = tabIndex) {
            Tab(selected = tabIndex == 0, onClick = { tabIndex = 0; action.message = null }, text = { Text(stringResource(R.string.lib_mgmt_lyrics_tab_manual)) })
            Tab(selected = tabIndex == 1, onClick = { tabIndex = 1; action.message = null }, text = { Text(stringResource(R.string.lib_mgmt_lyrics_tab_online)) })
        }

        if (tabIndex == 0) {
            if (!timing) {
                OutlinedTextField(text, { text = it.take(500_000) }, Modifier.fillMaxWidth().heightIn(min = 240.dp), label = { Text(stringResource(R.string.lib_mgmt_paste_lyrics_label)) }, enabled = record != null && !action.busy)
                TextButton({
                    lines = text.lines().map { it.replace(Regex("\\[[^]]*]"), "").trim() }
                    times = lines.map { null }; cursor = 0; timing = true
                }, enabled = text.isNotBlank() && record != null) { Text(stringResource(R.string.lib_mgmt_start_timing)) }
            } else {
                Text(stringResource(R.string.lib_mgmt_timing_hint), style = MaterialTheme.typography.bodySmall)
                if (state.current?.id != track.id) Button({ vm.play(listOf(track)) }) { Text(stringResource(R.string.lib_mgmt_play_to_time)) }
                else Row(verticalAlignment = Alignment.CenterVertically) { TextButton(vm::toggle) { Text(if (state.playing) stringResource(R.string.lib_mgmt_pause) else stringResource(R.string.lib_mgmt_play)) }; Text(formatTime(position)); TextButton({ vm.seek(0) }) { Text(stringResource(R.string.lib_mgmt_seek_start)) } }
                lines.forEachIndexed { index, line -> Row(Modifier.fillMaxWidth().clickable { cursor = index }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(cursor == index, { cursor = index }); Text((times.getOrNull(index)?.let(::formatTime) ?: stringResource(R.string.lib_mgmt_unmarked)) + "  " + line.ifBlank { stringResource(R.string.lib_mgmt_interlude) }, Modifier.weight(1f), color = if (cursor == index) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                } }
                Button({
                    if (cursor < lines.size) {
                        val previous = times.take(cursor).filterNotNull().lastOrNull() ?: 0
                        val next = times.drop(cursor + 1).filterNotNull().firstOrNull() ?: Long.MAX_VALUE
                        if (position in previous..next) { times = times.toMutableList().apply { this[cursor] = position }; cursor = (cursor + 1).coerceAtMost(lines.size) }
                        else action.message = AppLanguage.string(R.string.lib_mgmt_timing_order_error)
                    }
                }, enabled = state.current?.id == track.id && state.playing && !state.buffering && cursor < lines.size) { Text(stringResource(R.string.lib_mgmt_mark_next_line, cursor + 1, lines.size)) }
                Row {
                    TextButton({ val target = (cursor - 1).coerceAtLeast(0); times = times.toMutableList().apply { this[target] = null }; cursor = target }, enabled = times.any { it != null }) { Text(stringResource(R.string.lib_mgmt_undo_previous_line)) }
                    TextButton({ timing = false }) { Text(stringResource(R.string.lib_mgmt_cancel_timing)) }
                }
                Button({ text = lines.mapIndexed { i, line -> val ms = times[i]!!; "[%02d:%02d.%03d]%s".format(ms / 60_000, ms / 1000 % 60, ms % 1000, line) }.joinToString("\n"); timing = false }, enabled = times.isNotEmpty() && times.all { it != null }) { Text(stringResource(R.string.lib_mgmt_generate_synced_lyrics)) }
            }
            if (!timing) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton({ scope.launch { action.run { val preview = vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "tracks", track.id, "lyrics", "preview"), obj("text" to text)); action.message = AppLanguage.string(R.string.lib_mgmt_preview_passed, preview.getAsJsonArray("lines")?.size() ?: 0) } } }, enabled = record != null && !action.busy) { Text(stringResource(R.string.lib_mgmt_verify_preview)) }
                    Button({ scope.launch { action.run {
                        val r = record!!; vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "tracks", track.id, "lyrics"), obj("version" to r.get("version"), "file_version" to r.get("file_version"), "text" to text))
                        load(); vm.refreshLyrics(); action.message = AppLanguage.string(R.string.lib_mgmt_lyrics_saved)
                    } } }, enabled = record != null && !action.busy) { Text(stringResource(R.string.lib_mgmt_save_lyrics)) }
                }
                TextButton({ scope.launch { action.run { val r = record!!; vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "tracks", track.id, "lyrics"), obj("version" to r.get("version"), "file_version" to r.get("file_version"), "text" to null)); load(); vm.refreshLyrics(); action.message = AppLanguage.string(R.string.lib_mgmt_restored_file_lyrics) } } }, enabled = record != null && !action.busy) { Text(stringResource(R.string.lib_mgmt_restore_file_lyrics)) }
            }
        } else {
            val eff = record?.getAsJsonObject("effective")
            val hasCandidate = record?.has("selected_candidate") == true && !record?.get("selected_candidate")?.isJsonNull!!
            val hasOverride = record?.has("override") == true && !record?.get("override")?.isJsonNull!!
            val kind = eff?.text("kind") ?: "none"
            val hasWords = eff?.objects("lines")?.any { it.objects("words").isNotEmpty() } == true
            val hasTrans = eff?.objects("lines")?.any { it.text("translation").isNotBlank() } == true

            val statusText = if (hasCandidate) {
                val kindText = if (hasWords) stringResource(R.string.lib_mgmt_lyric_kind_word_timed) else if (kind == "synced") stringResource(R.string.lib_mgmt_lyric_kind_synced) else stringResource(R.string.lib_mgmt_lyric_kind_plain)
                val bilingualText = if (hasTrans) stringResource(R.string.lib_mgmt_lyric_kind_bilingual_suffix) else ""
                stringResource(R.string.lib_mgmt_lyric_status_candidate, kindText + bilingualText)
            } else if (hasOverride) {
                stringResource(R.string.lib_mgmt_lyric_status_override)
            } else if (kind == "synced") {
                stringResource(R.string.lib_mgmt_lyric_status_file_synced)
            } else if (kind == "plain") {
                stringResource(R.string.lib_mgmt_lyric_status_file_plain)
            } else {
                stringResource(R.string.lib_mgmt_lyric_status_none)
            }

            Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(statusText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (hasCandidate || hasOverride) {
                        TextButton({ scope.launch { action.run {
                            val r = record!!
                            vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "tracks", track.id, "lyrics"), obj("version" to r.get("version"), "file_version" to r.get("file_version"), "text" to null))
                            load(); vm.refreshLyrics(); action.message = AppLanguage.string(R.string.lib_mgmt_restored_original_file_lyrics)
                        } } }, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_restore_file_lyrics)) }
                    }
                }
            }

            OnlineLyricsPanel(vm, track) { scope.launch { load() } }
        }
    }
}

@Composable
internal fun SuggestionsPanel(vm: MusicViewModel, track: Track) { MetadataReviewPanel(vm, track) }
internal fun statusName(value: String): String = when(value) {
    "queued" -> AppLanguage.string(R.string.lib_mgmt_status_queued)
    "running" -> AppLanguage.string(R.string.lib_mgmt_status_running)
    "completed" -> AppLanguage.string(R.string.lib_mgmt_status_completed)
    "completed_with_errors" -> AppLanguage.string(R.string.lib_mgmt_status_completed_with_errors)
    "failed" -> AppLanguage.string(R.string.lib_mgmt_status_failed)
    "interrupted" -> AppLanguage.string(R.string.lib_mgmt_status_interrupted)
    "review" -> AppLanguage.string(R.string.lib_mgmt_status_review)
    "conflict" -> AppLanguage.string(R.string.lib_mgmt_status_conflict)
    "ready" -> AppLanguage.string(R.string.lib_mgmt_status_ready)
    "waiting" -> AppLanguage.string(R.string.lib_mgmt_status_waiting)
    "no_match" -> AppLanguage.string(R.string.lib_mgmt_status_no_match)
    else -> value
}

@Composable
internal fun ManagementPanel(vm: MusicViewModel, initialBatchId: String? = null, initialAlbumId: String? = null) {
    var reviewOpen by remember { mutableStateOf(initialBatchId != null || initialAlbumId != null) }
    if (reviewOpen) { Column(Modifier.fillMaxSize()) { TextButton({ reviewOpen = false }) { Text(stringResource(R.string.lib_mgmt_back_to_management)) }; MetadataReviewPanel(vm, initialBatchId = initialBatchId, initialAlbumId = initialAlbumId) }; return }
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    var overview by remember { mutableStateOf<JsonObject?>(null) }; var jobs by remember { mutableStateOf<JsonObject?>(null) }
    var intake by remember { mutableStateOf<JsonObject?>(null) }; var automatic by remember { mutableStateOf<JsonObject?>(null) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }; var confirmJob by remember { mutableStateOf<String?>(null) }
    var pendingOffset by remember { mutableIntStateOf(0) }
    var jobOffset by remember { mutableIntStateOf(0) }
    var editImport by remember { mutableStateOf(false) }
    var folders by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var folderDetail by remember { mutableStateOf<JsonObject?>(null) }
    var folderPicker by remember { mutableStateOf(false) }
    var folderConfirm by remember { mutableStateOf(false) }
    var folderAlbum by remember { mutableStateOf("") }
    var folderArtists by remember { mutableStateOf("") }
    val folderAction = remember { FeatureAction() }
    suspend fun load() {
        overview = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "overview"))
        jobs = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "jobs") + "?limit=20&offset=$jobOffset")
        intake = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "intake", "items") + "?limit=20&offset=$pendingOffset")
        automatic = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "intake", "settings"))
    }
    suspend fun loadFolders() {
        folders = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "metadata", "folders") + "?limit=200")
            .getAsJsonArray("items")?.map { it.asJsonObject }.orEmpty()
    }
    suspend fun openFolder(folder: String) {
        val detail = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "metadata", "folders") + "?folder=${java.net.URLEncoder.encode(folder, "UTF-8")}")
        folderDetail = detail
        folderAlbum = detail.getAsJsonArray("album_variants")?.firstOrNull()?.asString.orEmpty()
        folderArtists = detail.getAsJsonArray("album_artist_variants")?.joinToString(" / ") { it.asString }.orEmpty()
    }
    LaunchedEffect(pendingOffset, jobOffset) { action.run { load() }; while (true) { delay(4000); if (!action.busy && selected == null) runCatching { load() } } }
    LaunchedEffect(Unit) { folderAction.run { loadFolders() }; folderAction.message = null }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.lib_mgmt_library_overview), style = MaterialTheme.typography.titleLarge)
        Button({ reviewOpen = true }) { Text(stringResource(R.string.lib_mgmt_batch_review_metadata)) }
        overview?.let { info ->
            val counts = info.getAsJsonObject("counts")
            Text(stringResource(R.string.lib_mgmt_overview_counts, counts?.text("tracks").orEmpty(), info.text("albums"), info.text("artists")))
            Text(stringResource(R.string.lib_mgmt_overview_audio_size, counts?.get("size_bytes")?.asLong?.div(1024 * 1024) ?: 0))
        }
        Text(stringResource(R.string.lib_mgmt_folder_organize_title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.lib_mgmt_folder_organize_hint), style = MaterialTheme.typography.bodySmall)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (folders.isEmpty()) stringResource(R.string.lib_mgmt_folders_loading) else stringResource(R.string.lib_mgmt_folders_discovered, folders.size), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            TextButton({ folderPicker = true }, enabled = !folderAction.busy && folders.isNotEmpty()) { Text(stringResource(R.string.lib_mgmt_select_folder)) }
        }
        ActionStatus(folderAction)
        folderDetail?.let { detail ->
            val tracks = detail.getAsJsonArray("tracks")?.map { it.asJsonObject }.orEmpty()
            Text(detail.text("folder"), style = MaterialTheme.typography.titleSmall)
            Text(stringResource(R.string.lib_mgmt_folder_tracks_summary, tracks.size, detail.arrayText("album_variants").ifBlank { stringResource(R.string.lib_mgmt_unnamed_album) }), style = MaterialTheme.typography.bodySmall)
            if (detail.get("warning")?.asBoolean == true) Text(stringResource(R.string.lib_mgmt_folder_warning), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(folderAlbum, { folderAlbum = it.take(1000) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.lib_mgmt_unify_album)) }, enabled = !folderAction.busy)
            OutlinedTextField(folderArtists, { folderArtists = it.take(1000) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.lib_mgmt_unify_album_artists)) }, enabled = !folderAction.busy)
            Text(
                if (tracks.size > 8) stringResource(R.string.lib_mgmt_tracks_summary_with_more, tracks.take(8).joinToString("、") { it.text("title") }, tracks.size)
                else stringResource(R.string.lib_mgmt_tracks_summary, tracks.take(8).joinToString("、") { it.text("title") }),
                style = MaterialTheme.typography.bodySmall
            )
            Button({ folderConfirm = true }, enabled = !folderAction.busy && (folderAlbum.isNotBlank() || folderArtists.isNotBlank())) { Text(stringResource(R.string.lib_mgmt_apply_to_folder)) }
        }
        Row { Button({ confirmJob = "import" }, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_import_music)) }; Spacer(Modifier.width(12.dp)); OutlinedButton({ confirmJob = "scan" }, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_scan_library)) } }
        TextButton({ scope.launch { action.run { val result = vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "providers", "refresh"), obj("scope" to "library", "mode" to "missing", "force" to false)); action.message = AppLanguage.string(R.string.lib_mgmt_refresh_queued_message, result.text("queued")) } } }, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_refresh_missing_metadata)) }
        automatic?.let { options -> Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(options.get("enabled")?.asBoolean == true, { enabled -> scope.launch { action.run { automatic = vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "intake", "settings"), obj("version" to options.get("version"), "enabled" to enabled, "interval_seconds" to options.get("interval_seconds"), "stable_seconds" to options.get("stable_seconds"))); action.message = AppLanguage.string(R.string.lib_mgmt_auto_discover_saved) } } }, enabled = !action.busy)
            Text(stringResource(R.string.lib_mgmt_auto_discover_sources), Modifier.padding(start = 12.dp))
        } }
        if (automatic?.has("download_policy") == true) TextButton({ editImport = true }) { Text(stringResource(R.string.lib_mgmt_download_import_settings)) }
        ActionStatus(action)
        Text(stringResource(R.string.lib_mgmt_pending_intake), style = MaterialTheme.typography.titleLarge)
        intake?.getAsJsonArray("items")?.forEach { node -> val item = node.asJsonObject
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) {
                Text(item.text("source_path")); Text(statusName(item.text("state")), style = MaterialTheme.typography.bodySmall)
                Text(item.getAsJsonArray("issues")?.joinToString("、") { if (it.asString == "download_incomplete") AppLanguage.string(R.string.lib_mgmt_issue_download_incomplete) else it.asString }.orEmpty(), style = MaterialTheme.typography.bodySmall)
                Row {
                    if (item.get("can_approve")?.asBoolean == true) TextButton({ selected = item }) { Text(stringResource(R.string.lib_mgmt_fill_and_approve)) }
                    if (item.text("state") == "failed") TextButton({ scope.launch { action.run { vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "intake", "items", item.text("id"), "retry"), obj("version" to item.get("version"))); load() } } }, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_retry)) }
                    TextButton({ scope.launch { action.run { vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "intake", "items", item.text("id"), "ignore"), obj("version" to item.get("version"))); load() } } }, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_ignore)) }
                }
            } }
        }
        Row {
            TextButton({ pendingOffset = (pendingOffset - 20).coerceAtLeast(0) }, enabled = pendingOffset > 0 && !action.busy) { Text(stringResource(R.string.lib_mgmt_prev_page)) }
            TextButton({ pendingOffset += 20 }, enabled = pendingOffset + 20 < (intake?.get("total")?.asInt ?: 0) && !action.busy) { Text(stringResource(R.string.lib_mgmt_next_page)) }
        }
        Text(stringResource(R.string.lib_mgmt_background_jobs), style = MaterialTheme.typography.titleLarge)
        jobs?.getAsJsonArray("items")?.forEach { node -> val item = node.asJsonObject
            Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                Text((if (item.text("kind") == "import") stringResource(R.string.lib_mgmt_job_kind_import) else stringResource(R.string.lib_mgmt_job_kind_scan)) + " · " + statusName(item.text("status")))
                item.get("result")?.takeIf { it.isJsonObject }?.asJsonObject?.get("counts")?.takeIf { it.isJsonObject }?.asJsonObject?.let { counts ->
                    Text(counts.entrySet().joinToString(" · ") { (key, value) -> (when(key) {
                        "discovered" -> AppLanguage.string(R.string.lib_mgmt_count_discovered)
                        "imported" -> AppLanguage.string(R.string.lib_mgmt_count_imported)
                        "scanned" -> AppLanguage.string(R.string.lib_mgmt_count_scanned)
                        "added" -> AppLanguage.string(R.string.lib_mgmt_count_added)
                        "updated" -> AppLanguage.string(R.string.lib_mgmt_count_updated)
                        "unchanged" -> AppLanguage.string(R.string.lib_mgmt_count_unchanged)
                        "errors" -> AppLanguage.string(R.string.lib_mgmt_count_errors)
                        "missing" -> AppLanguage.string(R.string.lib_mgmt_count_missing)
                        "unreadable" -> AppLanguage.string(R.string.lib_mgmt_count_unreadable)
                        "skipped" -> AppLanguage.string(R.string.lib_mgmt_count_skipped)
                        else -> key
                    }) + " " + value.asString }, style = MaterialTheme.typography.bodySmall)
                }
                if (item.text("error").isNotBlank()) Text(item.text("error"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
        Row {
            TextButton({ jobOffset = (jobOffset - 20).coerceAtLeast(0) }, enabled = jobOffset > 0 && !action.busy) { Text(stringResource(R.string.lib_mgmt_newer_jobs)) }
            TextButton({ jobOffset += 20 }, enabled = jobOffset + 20 < (jobs?.get("total")?.asInt ?: 0) && !action.busy) { Text(stringResource(R.string.lib_mgmt_older_jobs)) }
        }
    }
    confirmJob?.let { kind -> AlertDialog(onDismissRequest = { confirmJob = null }, title = { Text(if (kind == "import") stringResource(R.string.lib_mgmt_confirm_import_title) else stringResource(R.string.lib_mgmt_confirm_scan_title)) }, text = { Text(if (kind == "import") stringResource(R.string.lib_mgmt_confirm_import_message) else stringResource(R.string.lib_mgmt_confirm_scan_message)) }, confirmButton = { TextButton({ scope.launch { action.run { vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "jobs"), obj("kind" to kind, "full" to false)); confirmJob = null; load(); action.message = AppLanguage.string(R.string.lib_mgmt_job_submitted_message) } } }, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_start)) } }, dismissButton = { TextButton({ confirmJob = null }) { Text(stringResource(R.string.lib_mgmt_cancel)) } }) }
    if (editImport) automatic?.let { options -> ImportSettingsDialog(vm, options, { editImport = false }) { result -> automatic = result; editImport = false } }
    selected?.let { item -> IntakeApprovalDialog(vm, item, { selected = null }) { scope.launch { action.run { load() } } } }
    if (folderPicker) AlertDialog(
        onDismissRequest = { folderPicker = false },
        title = { Text(stringResource(R.string.lib_mgmt_select_folder_title)) },
        text = {
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(folders, key = { it.text("folder") }) { item ->
                    TextButton({ folderPicker = false; scope.launch { folderAction.run { openFolder(item.text("folder")) } } }, enabled = !folderAction.busy, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.Start) {
                            Text(item.text("folder"))
                            Text(stringResource(R.string.lib_mgmt_folder_tracks_summary, item.text("track_count").toIntOrNull() ?: 0, item.asJsonObject.arrayText("album_variants").ifBlank { stringResource(R.string.lib_mgmt_unnamed_album) }), style = MaterialTheme.typography.bodySmall)
                            if (item.get("warning")?.asBoolean == true) Text(stringResource(R.string.lib_mgmt_folder_multi_album_warning), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton({ folderPicker = false }) { Text(stringResource(R.string.lib_mgmt_close)) } },
    )
    if (folderConfirm) {
        val detail = folderDetail
        AlertDialog(
            onDismissRequest = { if (!folderAction.busy) folderConfirm = false },
            title = { Text(stringResource(R.string.lib_mgmt_confirm_folder_title)) },
            text = {
                val albumText = folderAlbum.takeIf { it.isNotBlank() }?.let { stringResource(R.string.lib_mgmt_album_field_name) }
                val artistsText = folderArtists.takeIf { it.isNotBlank() }?.let { stringResource(R.string.lib_mgmt_album_artists_field_name) }
                val joined = listOfNotNull(albumText, artistsText).joinToString(stringResource(R.string.lib_mgmt_and_separator))
                Text(stringResource(R.string.lib_mgmt_confirm_folder_message, detail?.getAsJsonArray("tracks")?.size() ?: 0, joined))
            },
            confirmButton = { TextButton({
                scope.launch { folderAction.run {
                    val current = detail ?: return@run
                    val overrides = JsonObject()
                    folderAlbum.trim().takeIf { it.isNotBlank() }?.let { overrides.addProperty("album", it) }
                    folderArtists.split(Regex("[/,，、]")).map { it.trim() }.filter { it.isNotBlank() }.takeIf { it.isNotEmpty() }?.let { values -> overrides.add("album_artists", JsonArray().apply { values.forEach(::add) }) }
                    val tracks = current.getAsJsonArray("tracks") ?: JsonArray()
                    vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "metadata", "folders"), obj("folder" to current.text("folder"), "tracks" to JsonArray().apply { tracks.forEach { track -> add(obj("track_id" to track.asJsonObject.text("track_id"), "version" to track.asJsonObject.get("metadata_version"))) } }, "overrides" to overrides))
                    openFolder(current.text("folder")); loadFolders(); vm.load(); folderConfirm = false; folderAction.message = AppLanguage.string(R.string.lib_mgmt_folder_updated_message, tracks.size())
                } }
            }, enabled = !folderAction.busy) { Text(stringResource(R.string.lib_mgmt_confirm_modify)) } },
            dismissButton = { TextButton({ folderConfirm = false }, enabled = !folderAction.busy) { Text(stringResource(R.string.lib_mgmt_cancel)) } },
        )
    }
}

@Composable
internal fun AlbumMetadataPanel(vm: MusicViewModel, albumId: String, dismiss: () -> Unit) {
    val action = remember { FeatureAction() }
    var detail by remember { mutableStateOf<JsonObject?>(null) }
    var album by remember { mutableStateOf("") }
    var artists by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    suspend fun load() {
        detail = vm.repository.api().objectGet(vm.repository.url("api", "v1", "manage", "metadata", "albums") + "?album_id=${java.net.URLEncoder.encode(albumId, "UTF-8")}")
        album = detail!!.arrayText("album_variants").substringBefore(" / ")
        artists = detail!!.arrayText("album_artist_variants")
    }
    LaunchedEffect(albumId) { action.run { load() }; if (action.message == "\u5df2\u5b8c\u6210") action.message = null }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.lib_mgmt_album_unify_title), style = MaterialTheme.typography.titleLarge)
            detail?.let { current ->
                val tracks = current.getAsJsonArray("tracks") ?: JsonArray()
                Text(stringResource(R.string.lib_mgmt_folder_tracks_summary, tracks.size(), current.arrayText("album_variants").ifBlank { stringResource(R.string.lib_mgmt_unnamed_album) }), style = MaterialTheme.typography.bodySmall)
                if (current.get("warning")?.asBoolean == true) Text(stringResource(R.string.lib_mgmt_album_warning), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(album, { album = it.take(1000) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.lib_mgmt_album_label)) }, enabled = !action.busy)
                OutlinedTextField(artists, { artists = it.take(1000) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.lib_mgmt_album_artists_label)) }, enabled = !action.busy)
                Text(stringResource(R.string.lib_mgmt_album_scope_hint), style = MaterialTheme.typography.bodySmall)
                Text(
                    if (tracks.size() > 10) stringResource(R.string.lib_mgmt_tracks_summary_with_more, tracks.take(10).joinToString("、") { it.asJsonObject.text("title") }, tracks.size())
                    else stringResource(R.string.lib_mgmt_tracks_summary, tracks.joinToString("、") { it.asJsonObject.text("title") }),
                    style = MaterialTheme.typography.bodySmall
                )
            }
            ActionStatus(action)
        }
        Surface(tonalElevation = 2.dp) {
            Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(dismiss, enabled = !action.busy, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.lib_mgmt_close)) }
                Button({ scope.launch { action.run {
                    val current = detail ?: return@run
                    val overrides = JsonObject()
                    album.trim().takeIf { it.isNotBlank() }?.let { overrides.addProperty("album", it) }
                    artists.split(Regex("[/,，、]")).map { it.trim() }.filter { it.isNotBlank() }.takeIf { it.isNotEmpty() }?.let { values -> overrides.add("album_artists", JsonArray().apply { values.forEach(::add) }) }
                    val tracks = current.getAsJsonArray("tracks") ?: JsonArray()
                    vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "metadata", "albums"), obj(
                        "album_id" to albumId,
                        "tracks" to JsonArray().apply { tracks.forEach { track -> add(obj("track_id" to track.asJsonObject.text("track_id"), "version" to track.asJsonObject.get("metadata_version"))) } },
                        "overrides" to overrides,
                    ))
                    load(); vm.load(); action.message = AppLanguage.string(R.string.lib_mgmt_folder_updated_message, tracks.size())
                } } }, enabled = detail != null && !action.busy && (album.isNotBlank() || artists.isNotBlank()), modifier = Modifier.weight(1f)) { Text(if (action.busy) stringResource(R.string.lib_mgmt_saving) else stringResource(R.string.lib_mgmt_save_album)) }
            }
        }
    }
}

@Composable
private fun IntakeApprovalDialog(vm: MusicViewModel, item: JsonObject, dismiss: () -> Unit, saved: () -> Unit) {
    val fields = remember(item.text("id")) { mutableStateMapOf<String, String>().apply {
        val effective = item.getAsJsonObject("metadata") ?: JsonObject()
        metadataFields.take(4).forEach { (key, _) -> put(key, fieldText(item.getAsJsonObject("overrides")?.get(key) ?: effective.get(key))) }
    } }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text(stringResource(R.string.lib_mgmt_intake_approval_title)) }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            metadataFields.take(4).forEach { (key, titleRes) -> OutlinedTextField(fields[key].orEmpty(), { fields[key] = it.take(8000) }, label = { Text(stringResource(titleRes)) }, enabled = !action.busy) }
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        val overrides = item.getAsJsonObject("overrides")?.deepCopy() ?: JsonObject()
        fields.forEach { (key, value) -> overrides.add(key, parseField(key, value)) }
        vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "intake", "items", item.text("id"), "approve"), obj("version" to item.get("version"), "overrides" to overrides))
        dismiss(); saved()
    } } }, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_confirm_and_import)) } }, dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_cancel)) } })
}

@Composable
internal fun MetadataRefreshPrompt(vm: MusicViewModel, scopeName: String, id: String?, dismiss: () -> Unit) {
    var missing by remember { mutableStateOf(true) }; var force by remember { mutableStateOf(false) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text(stringResource(R.string.lib_mgmt_refresh_prompt_title)) }, text = {
        Column {
            Row(Modifier.fillMaxWidth().clickable { missing = !missing }, verticalAlignment = Alignment.CenterVertically) { Checkbox(missing, { missing = it }); Text(stringResource(R.string.lib_mgmt_refresh_missing_only)) }
            Row(Modifier.fillMaxWidth().clickable { force = !force }, verticalAlignment = Alignment.CenterVertically) { Checkbox(force, { force = it }); Text(stringResource(R.string.lib_mgmt_refresh_force_requery)) }
            Text(stringResource(R.string.lib_mgmt_refresh_prompt_hint), style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        val result = vm.repository.api().objectPost(vm.repository.url("api", "v1", "manage", "providers", "refresh"), obj("scope" to scopeName, "id" to id, "mode" to if (missing) "missing" else "all", "force" to force))
        val queued = result.number("queued").toInt(); val active = result.number("already_active").toInt(); val upgraded = result.number("upgraded").toInt(); val intents = result.number("refresh_intents").toInt()
        action.message = if (queued == 0 && active == result.number("total").toInt() && upgraded + intents == 0) {
            AppLanguage.string(R.string.lib_mgmt_refresh_already_active, result.number("total").toInt())
        } else {
            AppLanguage.string(R.string.lib_mgmt_refresh_queued_summary, queued, active) + if (upgraded + intents > 0) AppLanguage.string(R.string.lib_mgmt_refresh_intents_suffix, upgraded + intents) else ""
        }; vm.notify(action.message!!); dismiss()
    } } }, enabled = !action.busy) { Text(if (action.busy) stringResource(R.string.lib_mgmt_submitting) else stringResource(R.string.lib_mgmt_start_refresh)) } }, dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_cancel)) } })
}

@Composable
private fun ImportSettingsDialog(vm: MusicViewModel, initial: JsonObject, dismiss: () -> Unit, saved: (JsonObject) -> Unit) {
    var interval by remember { mutableStateOf(initial.text("interval_seconds")) }
    var stable by remember { mutableStateOf(initial.text("stable_seconds")) }
    val policy = initial.getAsJsonObject("download_policy")
    var waitAlbum by remember { mutableStateOf(policy.get("wait_for_album").asBoolean) }
    var suffixes by remember { mutableStateOf(policy.getAsJsonArray("partial_suffixes").joinToString(", ") { it.asString }) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!action.busy) dismiss() }, title = { Text(stringResource(R.string.lib_mgmt_import_settings_title)) }, text = {
        Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(interval, { interval = it }, label = { Text(stringResource(R.string.lib_mgmt_interval_label)) })
            OutlinedTextField(stable, { stable = it }, label = { Text(stringResource(R.string.lib_mgmt_stable_label)) })
            Row(Modifier.fillMaxWidth().clickable { waitAlbum = !waitAlbum }, verticalAlignment = Alignment.CenterVertically) { Checkbox(waitAlbum, { waitAlbum = it }); Text(stringResource(R.string.lib_mgmt_wait_for_album)) }
            OutlinedTextField(suffixes, { suffixes = it }, label = { Text(stringResource(R.string.lib_mgmt_partial_suffixes_label)) })
            Text(stringResource(R.string.lib_mgmt_import_settings_hint), style = MaterialTheme.typography.bodySmall)
            ActionStatus(action)
        }
    }, confirmButton = { TextButton({ scope.launch { action.run {
        val check = interval.toIntOrNull(); val duration = stable.toIntOrNull()
        require(check != null && check in 15..86400 && duration != null && duration in 5..86400) { AppLanguage.string(R.string.lib_mgmt_time_range_error) }
        val endings = JsonArray().apply { suffixes.split(Regex("[,\\s]+" )).filter { it.isNotBlank() }.forEach { add(it) } }
        val body = initial.deepCopy().apply { addProperty("interval_seconds", check); addProperty("stable_seconds", duration); add("download_policy", obj("wait_for_album" to waitAlbum, "partial_suffixes" to endings)) }
        saved(vm.repository.api().objectPut(vm.repository.url("api", "v1", "manage", "intake", "settings"), body))
    } } }, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_save_settings)) } }, dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text(stringResource(R.string.lib_mgmt_cancel)) } })
}
