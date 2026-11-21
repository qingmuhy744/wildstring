package com.wildstring.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
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
                            color = MaterialTheme.colorScheme.surfaceContainerHigh,
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
      HorizontalDivider()
      Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh) {
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
                else Row(verticalAlignment = Alignment.CenterVertically) { TextButton(vm::toggle) { Text(if (state.playing) stringResource(R.string.lib_mgmt_pause) else stringResource(R.string.lib_mgmt_play)) }; Text(formatTime(position), style = TextStyle(fontFeatureSettings = "tnum")); TextButton({ vm.seek(0) }) { Text(stringResource(R.string.lib_mgmt_seek_start)) } }
                lines.forEachIndexed { index, line -> Row(Modifier.fillMaxWidth().clickable { cursor = index }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(cursor == index, { cursor = index }); Text((times.getOrNull(index)?.let(::formatTime) ?: stringResource(R.string.lib_mgmt_unmarked)) + "  " + line.ifBlank { stringResource(R.string.lib_mgmt_interlude) }, Modifier.weight(1f), color = if (cursor == index) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, style = TextStyle(fontFeatureSettings = "tnum"))
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
        HorizontalDivider()
        Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh) {
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
