package com.wildstring.app.ui

import com.wildstring.app.R
import com.wildstring.app.AppLanguage
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.style.TextOverflow
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.wildstring.app.data.*
import kotlinx.coroutines.launch
import java.util.UUID

private data class ReviewChoice(val source: String, val fields: Set<String>)
private fun candidate(track: JsonObject, choice: ReviewChoice?) = track.objects("suggestions").firstOrNull { it.text("id") == choice?.source }
private fun stale(source: JsonObject?) = source?.get("stale")?.asBoolean ?: false
private fun defaultReviewChoice(track: JsonObject): ReviewChoice {
    val source = track.objects("suggestions").firstOrNull { !stale(it) }
    val current = track.getAsJsonObject("current") ?: JsonObject(); val overrides = track.getAsJsonObject("overrides") ?: JsonObject()
    val fields = source?.getAsJsonObject("fields")?.entrySet()?.filter { (k, v) -> current.get(k) != v && !overrides.has(k) }?.map { it.key }?.toSet() ?: emptySet()
    return ReviewChoice(source?.text("id").orEmpty(), fields)
}
private fun reviewCandidateLabel(source: JsonObject, track: JsonObject, names: JsonObject): String {
    val fields = source.getAsJsonObject("fields") ?: JsonObject()
    val score = source.getAsJsonObject("match")?.get("score")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asDouble
    return listOfNotNull(names.text(source.text("provider")).ifEmpty { source.text("provider") },
        fields.text("title").takeIf { it.isNotBlank() && it != track.text("title") },
        fields.text("album").ifBlank { AppLanguage.string(R.string.meta_rev_no_album) }, fields.text("release_date").takeIf { it.isNotBlank() },
        score?.takeIf { it.isFinite() }?.let { AppLanguage.string(R.string.meta_rev_match_score, kotlin.math.round(if (it <= 1) it * 100 else it).toInt()) },
        source.text("stale_reason").takeIf { it.isNotBlank() } ?: AppLanguage.string(R.string.meta_rev_stale_default_reason).takeIf { stale(source) }).joinToString(" · ")
}
private val reviewLabelResIds = mapOf(
    "title" to R.string.meta_rev_label_title,
    "artists" to R.string.meta_rev_label_artists,
    "album" to R.string.meta_rev_label_album,
    "album_artists" to R.string.meta_rev_label_album_artists,
    "track_number" to R.string.meta_rev_label_track_number,
    "disc_number" to R.string.meta_rev_label_disc_number,
    "track_total" to R.string.meta_rev_label_track_total,
    "disc_total" to R.string.meta_rev_label_disc_total,
    "release_date" to R.string.meta_rev_label_release_date,
    "original_date" to R.string.meta_rev_label_original_date,
    "composers" to R.string.meta_rev_label_composers,
    "lyricists" to R.string.meta_rev_label_lyricists,
    "arrangers" to R.string.meta_rev_label_arrangers,
    "vocalists" to R.string.meta_rev_label_vocalists,
    "genres" to R.string.meta_rev_label_genres,
    "external_ids" to R.string.meta_rev_label_external_ids,
    "description" to R.string.meta_rev_label_description,
)
private fun reviewLabel(key: String): String =
    reviewLabelResIds[key]?.let { AppLanguage.string(it) } ?: key

@Composable internal fun MetadataReviewPanel(vm: MusicViewModel, initialTrack: Track? = null, initialBatchId: String? = null, initialAlbumId: String? = null) {
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope(); val uri = LocalUriHandler.current
    var albums by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var albumTotal by remember { mutableIntStateOf(0) }
    var page by remember { mutableStateOf<JsonObject?>(null) }; var active by remember { mutableStateOf("") }
    var choices by remember { mutableStateOf<Map<String, ReviewChoice>>(emptyMap()) }
    var showAlbums by remember { mutableStateOf(false) }; var showSongs by remember { mutableStateOf(false) }; var showSources by remember { mutableStateOf(false) }
    var filter by remember { mutableStateOf("") }; var tab by remember { mutableStateOf("fields") }; var onlyChanges by remember { mutableStateOf(true) }; var original by remember { mutableStateOf(false) }
    var cover by remember { mutableStateOf<JsonObject?>(null) }; var coverAll by remember { mutableStateOf(false) }; var coverReady by remember { mutableStateOf(false) }
    var rejectionNotice by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableStateOf(false) }; var conflicts by remember { mutableStateOf(setOf<String>()) }
    var operationSignature by remember { mutableStateOf("") }; var operationKey by remember { mutableStateOf(UUID.randomUUID().toString()) }
    val tracks = page?.objects() ?: emptyList(); val current = tracks.firstOrNull { it.text("id") == active }; val selected = tracks.filter { choices[it.text("id")]?.fields?.isNotEmpty() == true }
    val source = current?.let { candidate(it, choices[it.text("id")]) }; val names = page?.getAsJsonObject("provider_names") ?: JsonObject()
    suspend fun loadAlbums(append: Boolean = false): List<JsonObject> {
        val value = vm.agent.request("metadata-review/albums", query = mapOf("limit" to "100", "offset" to if (append) albums.size.toString() else "0"))
        albums = if (append) albums + value.objects() else value.objects(); albumTotal = value.number("total").toInt(); return value.objects()
    }
    suspend fun load(query: Map<String, String>, next: String? = null) {
        val value = vm.agent.request("metadata-review", query = mapOf("limit" to "500") + query)
        page = value; val rows = value.objects(); choices = rows.associate { it.text("id") to defaultReviewChoice(it) }
        active = rows.firstOrNull { it.text("id") == next }?.text("id") ?: rows.firstOrNull { defaultReviewChoice(it).fields.isNotEmpty() }?.text("id") ?: rows.firstOrNull()?.text("id").orEmpty()
        cover = null; coverReady = false; conflicts = emptySet(); rejectionNotice = null
    }
    fun currentQuery(value: JsonObject, offset: Long = value.number("offset")): Map<String, String> =
        if (value.text("batch_id").isNotBlank()) mapOf("batch_id" to value.text("batch_id"), "offset" to offset.toString())
        else mapOf("album_id" to value.text("album_id"), "offset" to offset.toString())
    fun choose(id: String, fields: Set<String>) { choices = choices + (id to (choices[id] ?: ReviewChoice("", emptySet())).copy(fields = fields)) }
    fun next() { val i = tracks.indexOfFirst { it.text("id") == active }; active = tracks.getOrNull((i + 1) % tracks.size.coerceAtLeast(1))?.text("id").orEmpty(); tab = "fields"; cover = null; coverReady = false; rejectionNotice = null; action.message = null }
    suspend fun rejectCurrent() {
        val track = current ?: return; val chosen = source ?: return
        rejectionNotice = null
        val previous = choices; val versions = tracks.associate { it.text("id") to it.number("metadata_version") }; val identity = active
        vm.agent.request("metadata-review/reject", "POST", jsonBody("track_id" to identity,
            "suggestion_id" to chosen.text("id"), "metadata_version" to track.number("metadata_version"), "candidate_digest" to chosen.text("candidate_digest")))
        page?.let { load(currentQuery(it), identity) }
        choices = choices.mapValues { (id, choice) ->
            val row = page?.objects()?.firstOrNull { it.text("id") == id }; val old = previous[id]
            if (id == identity) choice.copy(fields = emptySet())
            else if (old != null && row != null && versions[id] == row.number("metadata_version") && candidate(row, old) != null) old else choice
        }
        loadAlbums(); rejectionNotice = AppLanguage.string(R.string.meta_rev_rejected_current_notice); action.message = rejectionNotice
    }
    suspend fun rejectAlbum() {
        val albumId = page?.text("album_id")?.takeIf { it.isNotBlank() } ?: current?.text("album_id") ?: return
        rejectionNotice = null
        vm.agent.request("metadata-review/reject", "POST", jsonBody("album_id" to albumId))
        val updatedAlbums = loadAlbums()
        rejectionNotice = AppLanguage.string(R.string.meta_rev_rejected_album_notice)
        action.message = rejectionNotice
        val nextAlbum = updatedAlbums.firstOrNull { it.text("id") != albumId }
        if (nextAlbum != null) {
            load(mapOf("album_id" to nextAlbum.text("id")))
        } else {
            page = null
        }
    }
    suspend fun rejectTrack(trackId: String) {
        rejectionNotice = null
        vm.agent.request("metadata-review/reject", "POST", jsonBody("track_id" to trackId))
        page?.let { load(currentQuery(it)) }
        loadAlbums()
        rejectionNotice = AppLanguage.string(R.string.meta_rev_rejected_track_notice)
        action.message = rejectionNotice
    }
    suspend fun purgeStale() {
        action.run {
            val res = vm.agent.request("metadata-review/stale/purge", "POST")
            val count = res.number("purged_count")
            val remaining = res.number("remaining_pending")
            val msg = if (count > 0) AppLanguage.string(R.string.meta_rev_purged_stale_count, count.toInt(), remaining.toInt()) else AppLanguage.string(R.string.meta_rev_no_stale_candidates)
            action.message = msg
            val updated = loadAlbums()
            if (updated.isNotEmpty() && page != null) {
                load(currentQuery(page!!), active)
            } else if (updated.isEmpty()) {
                page = null
            }
        }
    }
    suspend fun accept(single: Boolean, advanceAlbum: Boolean = false) {
        rejectionNotice = null
        val chosen = if (single) selected.filter { it.text("id") == active } else selected
        val items = JsonArray().apply { chosen.forEach { row -> val choice = choices[row.text("id")]!!; val c = candidate(row, choice)!!
            add(jsonBody("track_id" to row.text("id"), "suggestion_id" to c.text("id"), "metadata_version" to row.number("metadata_version"), "candidate_digest" to c.text("candidate_digest"), "fields" to jsonStrings(choice.fields.toList())))
        } }
        val snapshot = cover; val signature = items.toString() + snapshot?.text("id"); if (signature != operationSignature) { operationSignature = signature; operationKey = UUID.randomUUID().toString() }
        if (items.size() > 0) {
            val body = jsonBody("items" to items, "idempotency_key" to operationKey); snapshot?.let { body.addProperty("cover_draft_id", it.text("id")) }
            val result = vm.agent.request("metadata-review/accept", "POST", body)
            if (result.text("status") != "applied") { conflicts = result.objects("conflicts").map { it.text("track_id") }.toSet(); action.message = AppLanguage.string(R.string.meta_rev_conflicts_message); return }
        } else if (snapshot != null) vm.agent.request("drafts/${snapshot.text("id")}/accept", "POST", jsonBody("version" to snapshot.number("version"), "preview_digest" to snapshot.text("preview_digest"), "idempotency_key" to operationKey))
        else return
        val currentAlbumId = page?.text("album_id")
        val updatedAlbums = loadAlbums(); vm.load()
        val coverSuffix = if (snapshot != null) AppLanguage.string(R.string.meta_rev_with_fixed_cover) else ""
        action.message = AppLanguage.string(R.string.meta_rev_accepted_message, chosen.size, coverSuffix)
        if (advanceAlbum) {
            val nextAlbum = updatedAlbums.firstOrNull { it.text("id") != currentAlbumId }
            if (nextAlbum != null) {
                load(mapOf("album_id" to nextAlbum.text("id")))
            } else {
                page = null
            }
        } else {
            val nextId = if (single) tracks.getOrNull((tracks.indexOfFirst { it.text("id") == active } + 1) % tracks.size.coerceAtLeast(1))?.text("id") else null
            page?.let { load(currentQuery(it), nextId) }
        }
    }
    LaunchedEffect(initialTrack?.id, initialBatchId, initialAlbumId) { action.run { val list = loadAlbums(); load(when { initialTrack != null -> mapOf("track_id" to initialTrack.id); initialBatchId != null -> mapOf("batch_id" to initialBatchId); initialAlbumId != null -> mapOf("album_id" to initialAlbumId); else -> mapOf("album_id" to list.firstOrNull()?.text("id").orEmpty()) }, initialTrack?.id) }; if (action.message == "\u5df2\u5b8c\u6210") action.message = null }
    Column(Modifier.fillMaxSize().testTag("metadata-review")) {
        if (action.busy && page == null) {
            ActionStatus(action)
            ReviewSkeleton(Modifier.weight(1f))
        } else LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("review-scroll"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text(stringResource(R.string.meta_rev_title), style = MaterialTheme.typography.titleLarge); Text(stringResource(R.string.meta_rev_hint), style = MaterialTheme.typography.bodySmall)
                Row {
                    TextButton({ showAlbums = true }, enabled = !action.busy) { Text(stringResource(R.string.meta_rev_select_album)) }
                    TextButton({ scope.launch { action.run { page?.let { load(currentQuery(it), active) } } } }, enabled = !action.busy) { Text(stringResource(R.string.meta_rev_reload)) }
                    TextButton({ scope.launch { purgeStale() } }, enabled = !action.busy) { Text(stringResource(R.string.meta_rev_purge_stale)) }
                }
                Text(current?.text("album") ?: stringResource(R.string.meta_rev_no_pending_albums), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.meta_rev_summary_tracks, page?.number("total")?.toInt() ?: 0, tracks.size), style = MaterialTheme.typography.bodySmall); ActionStatus(action)
                Row { TextButton({ choices = tracks.associate { it.text("id") to defaultReviewChoice(it) } }, enabled = !action.busy) { Text(stringResource(R.string.meta_rev_check_changes)) }; TextButton({ choices = choices.mapValues { it.value.copy(fields = emptySet()) } }, enabled = !action.busy) { Text(stringResource(R.string.meta_rev_clear_selection)) } }
                TextButton({ showSongs = !showSongs }, enabled = !action.busy) { Text(if (showSongs) stringResource(R.string.meta_rev_collapse_song_list) else stringResource(R.string.meta_rev_select_songs_count, selected.size)) }
            }
            if (showSongs) items(tracks, key = { it.text("id") }) { row -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(choices[row.text("id")]?.fields?.isNotEmpty() == true, { checked -> choose(row.text("id"), if (checked) defaultReviewChoice(row).fields else emptySet()) }, enabled = !action.busy, modifier = Modifier.testTag("review-track-${row.text("id")}"))
                Column(Modifier.weight(1f).clickable(enabled = !action.busy) { active = row.text("id"); showSongs = false; cover = null; coverReady = false; rejectionNotice = null; action.message = null }) { Text(row.text("title")); Text(if (row.text("id") in conflicts) stringResource(R.string.meta_rev_conflict_warning) else stringResource(R.string.meta_rev_fields_selected_count, choices[row.text("id")]?.fields?.size ?: 0), style = MaterialTheme.typography.bodySmall) }
            } }
            if (page != null && page!!.number("total") > 500) item { Row { TextButton({ scope.launch { action.run { load(currentQuery(page!!, (page!!.number("offset") - 500).coerceAtLeast(0))) } } }, enabled = !action.busy && page!!.number("offset") > 0) { Text(stringResource(R.string.meta_rev_prev_page)) }; TextButton({ scope.launch { action.run { load(currentQuery(page!!, page!!.number("offset") + 500)) } } }, enabled = !action.busy && page!!.number("offset") + 500 < page!!.number("total")) { Text(stringResource(R.string.meta_rev_next_page)) } } }
            if (current != null) {
                item { Text(current.text("title"), style = MaterialTheme.typography.titleLarge); Text(current.getAsJsonArray("artists")?.joinToString(" / ") { it.asString }.orEmpty())
                    Row {
                        TextButton({ showSources = true }, enabled = !action.busy, modifier = Modifier.weight(1f).testTag("review-source")) { Text(source?.let { reviewCandidateLabel(it, current, names) } ?: stringResource(R.string.meta_rev_select_source), maxLines = 3, overflow = TextOverflow.Ellipsis) }
                        TextButton({ refresh = true }, enabled = !action.busy) { Text(stringResource(R.string.meta_rev_query_new_metadata)) }
                        TextButton({ scope.launch { action.run { rejectTrack(current.text("id")) } } }, enabled = !action.busy) { Text(stringResource(R.string.meta_rev_reject_track)) }
                    }
                    if (source != null && source.number("duplicate_count") > 1) Text(stringResource(R.string.meta_rev_duplicate_merged_hint, source.number("duplicate_count").toInt()), style = MaterialTheme.typography.bodySmall)
                    Row { listOf("fields" to R.string.meta_rev_tab_fields, "cover" to R.string.meta_rev_tab_cover, "lyrics" to R.string.meta_rev_tab_lyrics).forEach { (id, labelRes) -> FilterChip(tab == id, { tab = id }, { Text(stringResource(labelRes)) }, modifier = Modifier.padding(end = 6.dp)) } }
                }
                if (tab == "fields") {
                    item { Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(onlyChanges, { onlyChanges = it }); Text(stringResource(R.string.meta_rev_only_changes)) }
                        if (source != null) {
                            val staleSuffix = source.text("stale_reason").takeIf { it.isNotBlank() }?.let { " · $it" } ?: if (stale(source)) stringResource(R.string.meta_rev_stale_changed_suffix) else ""
                            Text(stringResource(R.string.meta_rev_version_prefix, source.number("metadata_version").toString(), staleSuffix), style = MaterialTheme.typography.bodySmall)
                            if (source.text("source_url").isNotBlank()) TextButton({ uri.openUri(source.text("source_url")) }) { Text(stringResource(R.string.meta_rev_view_source_evidence)) }
                        }
                        else Text(stringResource(R.string.meta_rev_no_valid_candidates))
                    }
                    val fields = source?.getAsJsonObject("fields")?.entrySet()?.filter { !onlyChanges || current.getAsJsonObject("current")?.get(it.key) != it.value } ?: emptyList()
                    items(fields, key = { it.key }) { entry -> val field = entry.key; val chosen = choices[active]?.fields.orEmpty()
                        Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerLow) { Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(field in chosen, { checked -> choose(active, if (checked) chosen + field else chosen - field) }, enabled = !action.busy && !stale(source), modifier = Modifier.testTag("review-field-$field")); Text(reviewLabel(field), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall); if (current.getAsJsonObject("overrides")?.has(field) == true) Text(stringResource(R.string.meta_rev_manual_override_badge), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall) }
                            Text(stringResource(R.string.meta_rev_current_value_label), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(displayValue(current.getAsJsonObject("current")?.get(field)))
                            HorizontalDivider(); Text(stringResource(R.string.meta_rev_suggested_value_label), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary); Text(displayValue(entry.value))
                            TextButton({ val on = field !in chosen; choices = choices.mapValues { (id, choice) -> val row = tracks.first { it.text("id") == id }; val c = candidate(row, choice); if (c?.getAsJsonObject("fields")?.has(field) == true && !stale(c)) choice.copy(fields = if (on) choice.fields + field else choice.fields - field) else choice } }, enabled = !action.busy) { Text(if (field in chosen) stringResource(R.string.meta_rev_uncheck_same_field) else stringResource(R.string.meta_rev_check_same_field)) }
                        } }
                    }
                    item { TextButton({ original = !original }) { Text(stringResource(R.string.meta_rev_original_and_match)) }; if (original) { current.getAsJsonObject("original")?.entrySet()?.forEach { (k, v) -> Text("${reviewLabel(k)}：${displayValue(v)}", style = MaterialTheme.typography.bodySmall) }; Text(source?.get("match")?.toString().orEmpty(), style = MaterialTheme.typography.bodySmall) } }
                }
                if (tab == "cover") item {
                    Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(coverAll, { coverAll = it; cover = null; coverReady = false }, enabled = !action.busy); Text(stringResource(R.string.meta_rev_cover_all_checkbox, if (coverAll) tracks.size else 1)) }
                    Button({ scope.launch { action.run {
                        val targets = JsonArray().apply { (if (coverAll) tracks else listOf(current)).forEach { add(jsonBody("track_id" to it.text("id"), "metadata_version" to it.number("metadata_version"))) } }
                        coverReady = false; cover = vm.agent.request("metadata-review/cover", "POST", jsonBody("kind" to "cover", "title" to AppLanguage.string(R.string.meta_rev_cover_draft_title, current.text("album")), "payload" to jsonBody("suggestion_id" to source!!.text("id"), "metadata_version" to current.number("metadata_version"), "targets" to targets)))
                    } } }, enabled = !action.busy && source?.text("cover_url")?.isNotBlank() == true && !stale(source)) { Text(stringResource(R.string.meta_rev_fix_and_preview_cover)) }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(Modifier.weight(1f)) { Text(stringResource(R.string.meta_rev_current_cover)); if (current.flag("has_cover")) AsyncImage(ImageRequest.Builder(LocalContext.current).data(vm.repository.url("api", "v1", "tracks", active, "cover") + "?size=320&v=${current.number("metadata_version")}").build(), stringResource(R.string.meta_rev_current_cover), imageLoader = vm.imageLoader, modifier = Modifier.fillMaxWidth().aspectRatio(1f)) else Text(stringResource(R.string.meta_rev_no_cover)) }
                        Column(Modifier.weight(1f)) { Text(stringResource(R.string.meta_rev_target_cover)); cover?.let { snapshot -> AsyncImage(ImageRequest.Builder(LocalContext.current).data(vm.repository.url("api", "v1", "agent", "drafts", snapshot.text("id"), "cover-preview")).memoryCacheKey("${vm.repository.session.cacheScope()}:${snapshot.text("id")}").build(), stringResource(R.string.meta_rev_fixed_cover_snapshot), imageLoader = vm.imageLoader, modifier = Modifier.fillMaxWidth().aspectRatio(1f), onSuccess = { coverReady = true }, onError = { coverReady = false; action.message = AppLanguage.string(R.string.meta_rev_cover_load_error) }) } }
                    }
                }
                if (tab == "lyrics") item { key(active) { OnlineLyricsPanel(vm, Track(id = current.text("id"), title = current.text("title"), artists = current.getAsJsonArray("artists")?.map { it.asString } ?: emptyList(), album = current.text("album"), durationMs = 0, albumId = current.text("album_id"))) {} } }
            }
        }
        Surface(color = MaterialTheme.colorScheme.surfaceContainer) { Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val fixedCoverNotice = if (cover != null) stringResource(R.string.meta_rev_with_fixed_cover_suffix) else ""
            Text(stringResource(R.string.meta_rev_footer_selection, selected.size, selected.sumOf { choices[it.text("id")]?.fields?.size ?: 0 }, fixedCoverNotice), style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton({ choose(active, emptySet()); next() }, enabled = !action.busy && current != null) { Text(stringResource(R.string.meta_rev_skip_this)) }
                Button({ scope.launch { action.run { accept(false) } } }, enabled = !action.busy && (selected.isNotEmpty() || cover != null) && (cover == null || coverReady), modifier = Modifier.testTag("review-accept-selected")) { Text(stringResource(R.string.meta_rev_accept_selected)) }
                Button({ scope.launch { action.run { accept(false, advanceAlbum = true) } } }, enabled = !action.busy && (selected.isNotEmpty() || cover != null) && (cover == null || coverReady), modifier = Modifier.testTag("review-accept-next-album")) { Text(stringResource(R.string.meta_rev_accept_next_album)) }
            }
            rejectionNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("review-rejection-notice")) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton({ scope.launch { action.run { rejectAlbum() } } }, enabled = !action.busy && (page?.text("album_id")?.isNotBlank() == true || current?.text("album_id")?.isNotBlank() == true), modifier = Modifier.weight(1f).testTag("review-reject-album")) { Text(stringResource(R.string.meta_rev_reject_album)) }
                TextButton({ scope.launch { action.run { rejectCurrent() } } }, enabled = !action.busy && source != null, modifier = Modifier.weight(1f).testTag("review-reject-current")) { Text(stringResource(R.string.meta_rev_reject_current)) }
            }
        } }
    }
    if (showAlbums) AlertDialog(onDismissRequest = { showAlbums = false }, title = { Text(stringResource(R.string.meta_rev_pending_albums_dialog_title)) }, text = { Column { OutlinedTextField(filter, { filter = it }, label = { Text(stringResource(R.string.meta_rev_filter_albums_label)) }); LazyColumn(Modifier.heightIn(max = 360.dp)) { items(albums.filter { (it.text("title") + it.text("artists")).contains(filter, true) }, key = { it.text("id") }) { album -> TextButton({ scope.launch { action.run { load(mapOf("album_id" to album.text("id"))); showAlbums = false } } }, enabled = !action.busy) { Text(stringResource(R.string.meta_rev_album_item, album.text("title"), album.number("count").toInt())) } }; if (albums.size < albumTotal) item { TextButton({ scope.launch { action.run { loadAlbums(true) } } }) { Text(stringResource(R.string.meta_rev_more_albums)) } } } } }, confirmButton = { TextButton({ showAlbums = false }) { Text(stringResource(R.string.meta_rev_close)) } })
    if (showSources && current != null) AlertDialog(onDismissRequest = { showSources = false }, title = { Text(stringResource(R.string.meta_rev_sources_dialog_title)) }, text = { Column(Modifier.verticalScroll(rememberScrollState())) { current.objects("suggestions").forEach { c -> TextButton({ choices = choices + (active to ReviewChoice(c.text("id"), if (stale(c)) emptySet() else c.getAsJsonObject("fields").entrySet().filter { (k, v) -> current.getAsJsonObject("current")?.get(k) != v && current.getAsJsonObject("overrides")?.has(k) != true }.map { it.key }.toSet())); cover = null; coverReady = false; showSources = false; rejectionNotice = null; action.message = null }) { Text(reviewCandidateLabel(c, current, names)) } } } }, confirmButton = { TextButton({ showSources = false }) { Text(stringResource(R.string.meta_rev_close)) } })
    if (refresh && current != null) MetadataRefreshPrompt(vm, "album", current.text("album_id")) { refresh = false; action.message = AppLanguage.string(R.string.meta_rev_query_queued_notice) }
}
