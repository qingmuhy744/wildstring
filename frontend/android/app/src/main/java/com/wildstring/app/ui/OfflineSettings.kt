package com.wildstring.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.wildstring.app.data.PlaybackRequest
import com.wildstring.app.data.Playlist
import kotlinx.coroutines.launch

internal fun downloadQualityLabel(bitrate: Int) = if (bitrate == 0) "原音" else "AAC $bitrate kbps"

@Composable internal fun OfflineSettings(vm: MusicViewModel) {
    val downloads = vm.repository.downloads
    var quality by remember { mutableIntStateOf(downloads.bitrate) }
    var wifi by remember { mutableStateOf(downloads.wifiOnly) }
    var menu by remember { mutableStateOf(false) }
    var choosing by remember { mutableStateOf(false) }
    var playlists by remember { mutableStateOf<List<Playlist>?>(null) }
    var selected by remember { mutableStateOf(downloads.followedPlaylists()) }
    val status by vm.offlineSyncStatus.collectAsStateWithLifecycle()
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("默认下载音质", Modifier.weight(1f))
        Box {
            TextButton({ menu = true }) { Text(downloadQualityLabel(quality)) }
            DropdownMenu(menu, { menu = false }) {
                PlaybackRequest.bitrates.forEach { rate -> DropdownMenuItem(text = { Text(downloadQualityLabel(rate)) },
                    onClick = { downloads.bitrate = rate; quality = rate; menu = false }) }
            }
        }
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("仅 Wi-Fi 下载", Modifier.weight(1f))
        Switch(wifi, { wifi = it; downloads.wifiOnly = it; scope.launch { action.run { vm.syncOfflinePlaylists() } } })
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("自动下载歌单 · ${selected.size} 个", Modifier.weight(1f))
        TextButton({ choosing = true; scope.launch { action.run { playlists = vm.allPlaylists() } } }) { Text("选择歌单") }
    }
    Text("打开或返回应用时检查歌单，新歌曲自动保存，已下载文件保留。音质仅影响新下载；已有有损音频保持原音。", style = MaterialTheme.typography.bodySmall)
    if (status.isNotBlank()) Text(status, style = MaterialTheme.typography.bodySmall)
    ActionStatus(action)
    if (selected.isNotEmpty()) TextButton({ scope.launch { action.run { vm.syncOfflinePlaylists() } } }, enabled = !action.busy) { Text("立即检查歌单") }
    if (choosing) AlertDialog(onDismissRequest = { choosing = false }, title = { Text("自动下载歌单") }, text = {
        Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            if (playlists == null) Text(if (action.busy) "正在读取歌单…" else "无法读取歌单，请关闭后重试。")
            playlists?.forEach { playlist ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(playlist.id in selected, { enabled ->
                        downloads.followPlaylist(playlist.id, enabled)
                        selected = downloads.followedPlaylists()
                    })
                    Column(Modifier.weight(1f)) { Text(playlist.name); Text("${playlist.trackCount} 首", style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
    }, confirmButton = { TextButton({ choosing = false; scope.launch { action.run { vm.syncOfflinePlaylists() } } }) { Text("完成") } })
}
