package com.wildstring.app.ui

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
        fields.text("album").ifBlank { "未提供专辑" }, fields.text("release_date").takeIf { it.isNotBlank() },
        score?.takeIf { it.isFinite() }?.let { "匹配度 ${kotlin.math.round(if (it <= 1) it * 100 else it).toInt()}%" },
        source.text("stale_reason").takeIf { it.isNotBlank() } ?: "查询依据已变化".takeIf { stale(source) }).joinToString(" · ")
}
private val reviewLabels = mapOf("title" to "歌名", "artists" to "歌曲艺人", "album" to "专辑", "album_artists" to "专辑艺人", "track_number" to "曲序", "disc_number" to "碟号", "track_total" to "总曲数", "disc_total" to "总碟数", "release_date" to "发行日期", "original_date" to "首次发行日期", "composers" to "作曲", "lyricists" to "作词", "arrangers" to "编曲", "vocalists" to "演唱", "genres" to "风格", "external_ids" to "外部标识", "description" to "简介")

@Composable internal fun MetadataReviewPanel(vm: MusicViewModel, initialTrack: Track? = null, initialBatchId: String? = null) {
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
        loadAlbums(); rejectionNotice = "已拒绝当前候选，现有资料保持不变。"; action.message = rejectionNotice
    }
    suspend fun accept(single: Boolean) {
        rejectionNotice = null
        val chosen = if (single) selected.filter { it.text("id") == active } else selected
        val items = JsonArray().apply { chosen.forEach { row -> val choice = choices[row.text("id")]!!; val c = candidate(row, choice)!!
            add(jsonBody("track_id" to row.text("id"), "suggestion_id" to c.text("id"), "metadata_version" to row.number("metadata_version"), "candidate_digest" to c.text("candidate_digest"), "fields" to jsonStrings(choice.fields.toList())))
        } }
        val snapshot = cover; val signature = items.toString() + snapshot?.text("id"); if (signature != operationSignature) { operationSignature = signature; operationKey = UUID.randomUUID().toString() }
        if (items.size() > 0) {
            val body = jsonBody("items" to items, "idempotency_key" to operationKey); snapshot?.let { body.addProperty("cover_draft_id", it.text("id")) }
            val result = vm.agent.request("metadata-review/accept", "POST", body)
            if (result.text("status") != "applied") { conflicts = result.objects("conflicts").map { it.text("track_id") }.toSet(); action.message = "此批次未应用：歌曲或候选已变化，请重新读取后核对。"; return }
        } else if (snapshot != null) vm.agent.request("drafts/${snapshot.text("id")}/accept", "POST", jsonBody("version" to snapshot.number("version"), "preview_digest" to snapshot.text("preview_digest"), "idempotency_key" to operationKey))
        else return
        val nextId = if (single) tracks.getOrNull((tracks.indexOfFirst { it.text("id") == active } + 1) % tracks.size.coerceAtLeast(1))?.text("id") else null
        page?.let { load(currentQuery(it), nextId) }; loadAlbums(); vm.load(); action.message = "已应用 ${chosen.size} 首的所选资料${if (snapshot != null) "及固定封面" else ""}。"
    }
    LaunchedEffect(initialTrack?.id, initialBatchId) { action.run { val list = loadAlbums(); load(when { initialTrack != null -> mapOf("track_id" to initialTrack.id); initialBatchId != null -> mapOf("batch_id" to initialBatchId); else -> mapOf("album_id" to list.firstOrNull()?.text("id").orEmpty()) }, initialTrack?.id) }; if (action.message == "已完成") action.message = null }
    Column(Modifier.fillMaxSize().testTag("metadata-review")) {
        if (action.busy && page == null) {
            ActionStatus(action)
            ReviewSkeleton(Modifier.weight(1f))
        } else LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("review-scroll"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text("批量核对资料", style = MaterialTheme.typography.titleLarge); Text("先对比，再接受。人工值默认保留，勾选后会替换该字段。", style = MaterialTheme.typography.bodySmall)
                Row { TextButton({ showAlbums = true }, enabled = !action.busy) { Text("选择专辑") }; TextButton({ scope.launch { action.run { page?.let { load(currentQuery(it), active) } } } }, enabled = !action.busy) { Text("重新读取") } }
                Text(current?.text("album") ?: "暂无待核对专辑", style = MaterialTheme.typography.titleMedium)
                Text("${page?.number("total") ?: 0} 首 · 本页 ${tracks.size} 首", style = MaterialTheme.typography.bodySmall); ActionStatus(action)
                Row { TextButton({ choices = tracks.associate { it.text("id") to defaultReviewChoice(it) } }, enabled = !action.busy) { Text("勾选变化（保留人工值）") }; TextButton({ choices = choices.mapValues { it.value.copy(fields = emptySet()) } }, enabled = !action.busy) { Text("清空") } }
                TextButton({ showSongs = !showSongs }, enabled = !action.busy) { Text(if (showSongs) "收起歌曲列表" else "选择歌曲（已选 ${selected.size} 首）") }
            }
            if (showSongs) items(tracks, key = { it.text("id") }) { row -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(choices[row.text("id")]?.fields?.isNotEmpty() == true, { checked -> choose(row.text("id"), if (checked) defaultReviewChoice(row).fields else emptySet()) }, enabled = !action.busy, modifier = Modifier.testTag("review-track-${row.text("id")}"))
                Column(Modifier.weight(1f).clickable(enabled = !action.busy) { active = row.text("id"); showSongs = false; cover = null; coverReady = false; rejectionNotice = null; action.message = null }) { Text(row.text("title")); Text(if (row.text("id") in conflicts) "版本或候选冲突" else "${choices[row.text("id")]?.fields?.size ?: 0} 个字段已选", style = MaterialTheme.typography.bodySmall) }
            } }
            if (page != null && page!!.number("total") > 500) item { Row { TextButton({ scope.launch { action.run { load(currentQuery(page!!, (page!!.number("offset") - 500).coerceAtLeast(0))) } } }, enabled = !action.busy && page!!.number("offset") > 0) { Text("上一页") }; TextButton({ scope.launch { action.run { load(currentQuery(page!!, page!!.number("offset") + 500)) } } }, enabled = !action.busy && page!!.number("offset") + 500 < page!!.number("total")) { Text("下一页") } } }
            if (current != null) {
                item { Text(current.text("title"), style = MaterialTheme.typography.titleLarge); Text(current.getAsJsonArray("artists")?.joinToString(" / ") { it.asString }.orEmpty())
                    Row { TextButton({ showSources = true }, enabled = !action.busy, modifier = Modifier.weight(1f).testTag("review-source")) { Text(source?.let { reviewCandidateLabel(it, current, names) } ?: "选择候选来源", maxLines = 3, overflow = TextOverflow.Ellipsis) }; TextButton({ refresh = true }, enabled = !action.busy) { Text("查询新资料") } }
                    if (source != null && source.number("duplicate_count") > 1) Text("已合并 ${source.number("duplicate_count")} 条相同候选记录，不同版本分别保留。", style = MaterialTheme.typography.bodySmall)
                    Row { listOf("fields" to "文字资料", "cover" to "封面对比", "lyrics" to "歌词预览").forEach { (id, label) -> FilterChip(tab == id, { tab = id }, { Text(label) }, modifier = Modifier.padding(end = 6.dp)) } }
                }
                if (tab == "fields") {
                    item { Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(onlyChanges, { onlyChanges = it }); Text("只看变化字段") }
                        if (source != null) { Text("信息版本 ${source.number("metadata_version")}${source.text("stale_reason").takeIf { it.isNotBlank() }?.let { " · $it" } ?: if (stale(source)) " · 查询依据已变化" else ""}", style = MaterialTheme.typography.bodySmall); if (source.text("source_url").isNotBlank()) TextButton({ uri.openUri(source.text("source_url")) }) { Text("查看来源依据") } }
                        else Text("没有有效候选，可以查询资料或跳过。")
                    }
                    val fields = source?.getAsJsonObject("fields")?.entrySet()?.filter { !onlyChanges || current.getAsJsonObject("current")?.get(it.key) != it.value } ?: emptyList()
                    items(fields, key = { it.key }) { entry -> val field = entry.key; val chosen = choices[active]?.fields.orEmpty()
                        Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerLow) { Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(field in chosen, { checked -> choose(active, if (checked) chosen + field else chosen - field) }, enabled = !action.busy && !stale(source), modifier = Modifier.testTag("review-field-$field")); Text(reviewLabels[field] ?: field, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall); if (current.getAsJsonObject("overrides")?.has(field) == true) Text("人工值", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall) }
                            Text("当前值", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(displayValue(current.getAsJsonObject("current")?.get(field)))
                            HorizontalDivider(); Text("建议值", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary); Text(displayValue(entry.value))
                            TextButton({ val on = field !in chosen; choices = choices.mapValues { (id, choice) -> val row = tracks.first { it.text("id") == id }; val c = candidate(row, choice); if (c?.getAsJsonObject("fields")?.has(field) == true && !stale(c)) choice.copy(fields = if (on) choice.fields + field else choice.fields - field) else choice } }, enabled = !action.busy) { Text("本页同字段${if (field in chosen) "取消" else "勾选"}") }
                        } }
                    }
                    item { TextButton({ original = !original }) { Text("文件原始值与匹配依据") }; if (original) { current.getAsJsonObject("original")?.entrySet()?.forEach { (k, v) -> Text("${reviewLabels[k] ?: k}：${displayValue(v)}", style = MaterialTheme.typography.bodySmall) }; Text(source?.get("match")?.toString().orEmpty(), style = MaterialTheme.typography.bodySmall) } }
                }
                if (tab == "cover") item {
                    Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(coverAll, { coverAll = it; cover = null; coverReady = false }, enabled = !action.busy); Text("用于本页同专辑歌曲（${if (coverAll) tracks.size else 1} 首）") }
                    Button({ scope.launch { action.run {
                        val targets = JsonArray().apply { (if (coverAll) tracks else listOf(current)).forEach { add(jsonBody("track_id" to it.text("id"), "metadata_version" to it.number("metadata_version"))) } }
                        coverReady = false; cover = vm.agent.request("metadata-review/cover", "POST", jsonBody("kind" to "cover", "title" to "封面核对 · ${current.text("album")}", "payload" to jsonBody("suggestion_id" to source!!.text("id"), "metadata_version" to current.number("metadata_version"), "targets" to targets)))
                    } } }, enabled = !action.busy && source?.text("cover_url")?.isNotBlank() == true && !stale(source)) { Text("固定并预览此封面") }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(Modifier.weight(1f)) { Text("当前封面"); if (current.flag("has_cover")) AsyncImage(ImageRequest.Builder(LocalContext.current).data(vm.repository.url("api", "v1", "tracks", active, "cover") + "?size=320&v=${current.number("metadata_version")}").build(), "当前封面", imageLoader = vm.imageLoader, modifier = Modifier.fillMaxWidth().aspectRatio(1f)) else Text("暂无封面") }
                        Column(Modifier.weight(1f)) { Text("将采用的封面"); cover?.let { snapshot -> AsyncImage(ImageRequest.Builder(LocalContext.current).data(vm.repository.url("api", "v1", "agent", "drafts", snapshot.text("id"), "cover-preview")).memoryCacheKey("${vm.repository.session.cacheScope()}:${snapshot.text("id")}").build(), "固定封面快照", imageLoader = vm.imageLoader, modifier = Modifier.fillMaxWidth().aspectRatio(1f), onSuccess = { coverReady = true }, onError = { coverReady = false; action.message = "封面无法显示，本次不能应用。" }) } }
                    }
                }
                if (tab == "lyrics") item { key(active) { OnlineLyricsPanel(vm, Track(id = current.text("id"), title = current.text("title"), artists = current.getAsJsonArray("artists")?.map { it.asString } ?: emptyList(), album = current.text("album"), durationMs = 0, albumId = current.text("album_id"))) {} } }
            }
        }
        Surface(shadowElevation = 4.dp, color = MaterialTheme.colorScheme.surfaceContainer) { Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("已选 ${selected.size} 首 · ${selected.sumOf { choices[it.text("id")]?.fields?.size ?: 0 }} 个字段${if (cover != null) " · 含固定封面" else ""}", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedButton({ choose(active, emptySet()); next() }, enabled = !action.busy && current != null) { Text("本次跳过") }; Button({ scope.launch { action.run { accept(false) } } }, enabled = !action.busy && (selected.isNotEmpty() || cover != null) && (cover == null || coverReady), modifier = Modifier.testTag("review-accept-selected")) { Text("接受选中项") } }
            rejectionNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("review-rejection-notice")) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton({ scope.launch { action.run { rejectCurrent() } } }, enabled = !action.busy && source != null, modifier = Modifier.weight(1f).testTag("review-reject-current")) { Text("拒绝当前建议") }
                TextButton({ scope.launch { action.run { accept(true) } } }, enabled = !action.busy && (choices[active]?.fields?.isNotEmpty() == true || cover != null) && (cover == null || (coverReady && !coverAll)), modifier = Modifier.weight(1f)) { Text("接受本曲并下一首") }
            }
        } }
    }
    if (showAlbums) AlertDialog(onDismissRequest = { showAlbums = false }, title = { Text("待核对专辑") }, text = { Column { OutlinedTextField(filter, { filter = it }, label = { Text("筛选专辑") }); LazyColumn(Modifier.heightIn(max = 360.dp)) { items(albums.filter { (it.text("title") + it.text("artists")).contains(filter, true) }, key = { it.text("id") }) { album -> TextButton({ scope.launch { action.run { load(mapOf("album_id" to album.text("id"))); showAlbums = false } } }, enabled = !action.busy) { Text("${album.text("title")} · ${album.number("count")} 首") } }; if (albums.size < albumTotal) item { TextButton({ scope.launch { action.run { loadAlbums(true) } } }) { Text("更多专辑") } } } } }, confirmButton = { TextButton({ showAlbums = false }) { Text("关闭") } })
    if (showSources && current != null) AlertDialog(onDismissRequest = { showSources = false }, title = { Text("候选来源") }, text = { Column(Modifier.verticalScroll(rememberScrollState())) { current.objects("suggestions").forEach { c -> TextButton({ choices = choices + (active to ReviewChoice(c.text("id"), if (stale(c)) emptySet() else c.getAsJsonObject("fields").entrySet().filter { (k, v) -> current.getAsJsonObject("current")?.get(k) != v && current.getAsJsonObject("overrides")?.has(k) != true }.map { it.key }.toSet())); cover = null; coverReady = false; showSources = false; rejectionNotice = null; action.message = null }) { Text(reviewCandidateLabel(c, current, names)) } } } }, confirmButton = { TextButton({ showSources = false }) { Text("关闭") } })
    if (refresh && current != null) MetadataRefreshPrompt(vm, "album", current.text("album_id")) { refresh = false; action.message = "查询已排队，完成后重新读取。" }
}
