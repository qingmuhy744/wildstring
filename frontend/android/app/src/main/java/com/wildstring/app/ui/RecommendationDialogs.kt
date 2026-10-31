package com.wildstring.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun RecommendationPlaylistDialog(vm: MusicViewModel, tracks: List<Track>, dismiss: () -> Unit, saved: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val action = remember { FeatureAction() }
    var playlists by remember { mutableStateOf<List<Playlist>>(emptyList()) }
    var target by remember { mutableStateOf<Playlist?>(null) }
    var created by remember { mutableStateOf<Playlist?>(null) }
    var name by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        action.run { playlists = vm.playlistsForAdd() }
        if (action.message == "已完成") action.message = null
        loading = false
    }
    AlertDialog(
        onDismissRequest = { if (!action.busy) dismiss() },
        title = { Text("加入歌单") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("已选 ${tracks.size} 首 · 按推荐中的顺序保存")
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (created == null) {
                    Row(Modifier.fillMaxWidth().clickable(enabled = !action.busy) { target = null }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(target == null, { target = null }, enabled = !action.busy); Text("新建歌单")
                    }
                    playlists.forEach { playlist ->
                        Row(Modifier.fillMaxWidth().clickable(enabled = !action.busy) { target = playlist }, verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(target?.id == playlist.id, { target = playlist }, enabled = !action.busy)
                            Text(playlist.name, Modifier.weight(1f))
                        }
                    }
                }
                if (target == null) OutlinedTextField(name, { name = it }, label = { Text("歌单名称") }, enabled = !action.busy && created == null, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (created != null && action.message != null) Text("歌单已创建，再次确认会继续向该歌单加入曲目。", style = MaterialTheme.typography.bodySmall)
                ActionStatus(action)
            }
        },
        confirmButton = { TextButton({
            scope.launch { action.run {
                val selected = created ?: target ?: vm.repository.api().createPlaylist(PlaylistRequest(name.trim(), "manual")).also { created = it }
                val fresh = vm.repository.api().playlist(vm.repository.url("api", "v1", "playlists", selected.id))
                vm.addTracksToPlaylist(tracks, fresh)
                saved("已加入「${fresh.name}」")
            } }
        }, enabled = !loading && !action.busy && (target != null || name.isNotBlank())) { Text(if (action.busy) "正在加入…" else "确认加入") } },
        dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text("取消") } },
    )
}

@Composable
internal fun RecommendationLyricsDialog(vm: MusicViewModel, track: Track, dismiss: () -> Unit) {
    var lyrics by remember(track.id) { mutableStateOf<Lyrics?>(null) }
    var error by remember(track.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(track.id) {
        try { lyrics = vm.repository.lyrics(track.id) }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = friendlyError(failure) }
    }
    AlertDialog(onDismissRequest = dismiss, title = { Text(track.title) }, text = {
        Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()).testTag("recommendation-lyrics"), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("${track.artist} · 歌词预览", color = MaterialTheme.colorScheme.onSurfaceVariant)
            when {
                error != null -> Text(error.orEmpty())
                lyrics == null -> CircularProgressIndicator()
                lyrics!!.lines.isEmpty() -> Text("这首歌还没有歌词。")
                else -> lyrics!!.lines.forEach { Text(it.text) }
            }
        }
    }, confirmButton = { TextButton(dismiss) { Text("关闭歌词预览") } })
}
