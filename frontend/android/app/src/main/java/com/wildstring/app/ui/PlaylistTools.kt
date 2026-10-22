package com.wildstring.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.wildstring.app.data.*
import kotlinx.coroutines.launch

@Composable
internal fun PlaylistEditor(vm: MusicViewModel, existing: Playlist?, dismiss: () -> Unit) {
    var serverRecord by remember(existing?.id) { mutableStateOf(existing) }
    var name by remember { mutableStateOf(existing?.name.orEmpty()) }
    var smart by remember { mutableStateOf(existing?.kind == "smart") }
    var definition by remember { mutableStateOf(existing?.definition?.toString() ?: "{\"all\":[{\"is\":{\"loved\":true}}],\"sort\":\"lastPlayed\",\"order\":\"asc\",\"limit\":100}") }
    var artist by remember { mutableStateOf("") }
    var onlyLoved by remember { mutableStateOf(true) }
    var days by remember { mutableStateOf("30") }
    var advanced by remember { mutableStateOf(existing?.kind == "smart") }
    val scope = rememberCoroutineScope(); val action = remember { FeatureAction() }
    LaunchedEffect(existing?.id) {
        if (existing != null) action.run {
            val full = vm.repository.api().playlist(vm.repository.url("api", "v1", "playlists", existing.id))
            serverRecord = full; name = full.name; definition = full.definition?.toString() ?: definition
        }
    }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        OutlinedTextField(name, { name = it.take(100) }, Modifier.fillMaxWidth(), label = { Text("歌单名称") }, singleLine = true, enabled = !action.busy)
        if (existing == null) Row(Modifier.fillMaxWidth().clickable { smart = !smart }, verticalAlignment = Alignment.CenterVertically) { Switch(smart, { smart = it }); Text("规则歌单", Modifier.padding(start = 12.dp)) }
        if (smart) {
            Text("根据当前曲库自动选歌；修改规则不打断已有播放。", style = MaterialTheme.typography.bodySmall)
            Row(Modifier.fillMaxWidth().clickable { advanced = !advanced }, verticalAlignment = Alignment.CenterVertically) { Switch(advanced, { advanced = it }); Text("高级规则 JSON", Modifier.padding(start = 12.dp)) }
            if (advanced) OutlinedTextField(definition, { definition = it.take(32000) }, Modifier.fillMaxWidth().heightIn(min = 220.dp), label = { Text("规则（all / any、排序与数量）") })
            else {
                Row(Modifier.fillMaxWidth().clickable { onlyLoved = !onlyLoved }, verticalAlignment = Alignment.CenterVertically) { Checkbox(onlyLoved, { onlyLoved = it }); Text("只选我喜欢的音乐") }
                OutlinedTextField(artist, { artist = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("艺人包含（可留空）") })
                OutlinedTextField(days, { days = it.filter(Char::isDigit).take(4) }, Modifier.fillMaxWidth(), label = { Text("多少天没有听过（留空不限）") })
                Text("按最近播放从旧到新，最多 100 首。", style = MaterialTheme.typography.bodySmall)
            }
        }
        ActionStatus(action)
        Button({ scope.launch { action.run {
            val rule = if (!smart) null else if (advanced) JsonParser.parseString(definition).asJsonObject else JsonObject().apply {
                val all = com.google.gson.JsonArray()
                if (onlyLoved) all.add(JsonObject().apply { add("is", JsonObject().apply { addProperty("loved", true) }) })
                if (artist.isNotBlank()) all.add(JsonObject().apply { add("contains", JsonObject().apply { addProperty("artist", artist.trim()) }) })
                days.toIntOrNull()?.takeIf { it > 0 }?.let { number -> all.add(JsonObject().apply { add("notInTheLast", JsonObject().apply { addProperty("lastPlayed", number) }) }) }
                require(all.size() > 0) { "请至少设置一个条件。" }
                add("all", all); addProperty("sort", "lastPlayed"); addProperty("order", "asc"); addProperty("limit", 100)
            }
            vm.savePlaylist(name.trim(), rule, serverRecord); dismiss()
        } } }, enabled = !action.busy && name.isNotBlank()) { Text(if (action.busy) "正在保存…" else "保存歌单") }
    }
}

@Composable
internal fun PlaylistOrder(vm: MusicViewModel, playlist: Playlist, dismiss: () -> Unit) {
    var record by remember { mutableStateOf(playlist) }
    var tracks by remember { mutableStateOf<List<Track>>(emptyList()) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    val feedback = LocalTactileFeedback.current
    LaunchedEffect(playlist.id) { action.run { tracks = vm.playlistTracks(playlist) } }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        ActionStatus(action)
        if (action.busy && tracks.isEmpty()) CatalogSkeleton("tracks", Modifier.weight(1f))
        else QueueList(tracks.mapIndexed { index, t -> QueueRow(t.id, t.id, t.title, t.artist, index) }, null, Modifier.weight(1f),
                onPlay = {}, onRemove = { row ->
                    if (!action.busy) tracks.firstOrNull { it.id == row.trackId }?.let { track -> scope.launch { action.run {
                        vm.removePlaylistTrack(track, record)
                        record = vm.repository.api().playlist(vm.repository.url("api", "v1", "playlists", playlist.id))
                        tracks = tracks.filter { it.id != row.trackId }
                    } } }
                }, onMove = { id, destination ->
                    val from = tracks.indexOfFirst { it.id == id }
                    if (!action.busy && from >= 0 && destination in tracks.indices) tracks = tracks.toMutableList().apply { add(destination, removeAt(from)) }
                }, onHaptic = feedback, allowRemove = !action.busy, title = "拖动排序，或移除曲目")
        Button({ scope.launch { action.run { vm.reorderPlaylist(record, tracks.map { it.id }); dismiss() } } }, enabled = !action.busy && tracks.isNotEmpty(), modifier = Modifier.fillMaxWidth()) { Text("保存顺序") }
    }
}

@Composable
internal fun MultiSelectPanel(vm: MusicViewModel, dismiss: () -> Unit) {
    val original = remember { vm.state.value }
    var tracks by remember { mutableStateOf<List<Track>>(emptyList()) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var choices by remember { mutableStateOf<List<Playlist>?>(null) }
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { action.run {
        tracks = vm.repository.collectionTracks(CatalogQuery(original.tab, original.kind, original.title, original.query, collection = original.collection,
            collectionId = original.collectionId, playlist = original.activePlaylist, role = original.role, sort = original.sort, albumFilter = original.albumFilter))
    } }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ActionStatus(action)
        Row { TextButton({ selected = tracks.map { it.id }.toSet() }) { Text("全选") }; TextButton({ selected = emptySet() }) { Text("清空") }; Text("已选 ${selected.size} 首", Modifier.padding(12.dp)) }
        if (action.busy && tracks.isEmpty()) CatalogSkeleton("tracks", Modifier.weight(1f))
        else LazyColumn(Modifier.weight(1f)) { items(tracks, key = { it.id }) { track ->
            Row(Modifier.fillMaxWidth().clickable { selected = if (track.id in selected) selected - track.id else selected + track.id }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(track.id in selected, null); Column(Modifier.padding(12.dp)) { Text(track.title); Text(track.artist, style = MaterialTheme.typography.bodySmall) }
            }
        } }
        Button({ scope.launch { action.run { choices = vm.playlistsForAdd() } } }, enabled = !action.busy && selected.isNotEmpty(), modifier = Modifier.fillMaxWidth()) { Text("加入歌单") }
    }
    choices?.let { playlists -> AlertDialog(onDismissRequest = { choices = null }, title = { Text("选择歌单") }, text = {
        Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            if (playlists.isEmpty()) Text("请先创建普通歌单。")
            playlists.forEach { item ->
                ListItem(
                    headlineContent = { Text(item.name) },
                    supportingContent = { Text("${item.trackCount} 首") },
                    colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
                    modifier = Modifier.fillMaxWidth().clickable(enabled = !action.busy) {
                        scope.launch { action.run { vm.addTracksToPlaylist(tracks.filter { it.id in selected }, item); choices = null; dismiss() } }
                    },
                )
            }
        }
    }, confirmButton = { TextButton({ choices = null }) { Text("关闭") } }) }
}
