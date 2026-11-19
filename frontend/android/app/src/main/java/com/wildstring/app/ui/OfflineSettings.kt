package com.wildstring.app.ui

import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

@Composable internal fun downloadQualityLabel(bitrate: Int) = if (bitrate == 0) stringResource(R.string.quality_original) else "AAC $bitrate kbps"

@Composable internal fun OfflineSettings(vm: MusicViewModel) {
    val downloads = vm.repository.downloads
    var quality by remember { mutableIntStateOf(downloads.bitrate) }
    var wifi by remember { mutableStateOf(downloads.wifiOnly) }
    var menu by remember { mutableStateOf(false) }
    var choosing by remember { mutableStateOf(false) }
    var playlists by remember { mutableStateOf<List<Playlist>?>(null) }
    var selected by remember { mutableStateOf<Set<String>?>(null) }
    val selectionLock = remember { Mutex() }
    LaunchedEffect(downloads) { selected = withContext(Dispatchers.IO) { downloads.followedPlaylists() } }
    val status by vm.offlineSyncStatus.collectAsStateWithLifecycle()
    val action = remember { FeatureAction() }; val scope = rememberCoroutineScope()
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.download_quality), Modifier.weight(1f))
        Box {
            TextButton({ menu = true }) { Text(downloadQualityLabel(quality)) }
            DropdownMenu(menu, { menu = false }) {
                PlaybackRequest.bitrates.forEach { rate -> DropdownMenuItem(text = { Text(downloadQualityLabel(rate)) },
                    onClick = { downloads.bitrate = rate; quality = rate; menu = false }) }
            }
        }
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.download_wifi_only), Modifier.weight(1f))
        Switch(wifi, { wifi = it; downloads.wifiOnly = it; scope.launch { action.run { vm.syncOfflinePlaylists() } } })
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.playlist_auto_count, selected.orEmpty().size), Modifier.weight(1f))
        TextButton({ choosing = true; scope.launch { action.run { playlists = vm.allPlaylists() } } }, enabled = selected != null) { Text(stringResource(R.string.playlist_choose)) }
    }
    Text(stringResource(R.string.offline_auto_hint), style = MaterialTheme.typography.bodySmall)
    if (status.isNotBlank()) Text(status, style = MaterialTheme.typography.bodySmall)
    ActionStatus(action)
    if (!selected.isNullOrEmpty()) TextButton({ scope.launch { action.run { vm.syncOfflinePlaylists() } } }, enabled = !action.busy) { Text(stringResource(R.string.playlist_check_now)) }
    if (choosing) AlertDialog(onDismissRequest = { choosing = false }, title = { Text(stringResource(R.string.playlist_auto_download)) }, text = {
        Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            if (playlists == null) Text(if (action.busy) stringResource(R.string.playlist_loading) else stringResource(R.string.playlist_loading_failed))
            playlists?.forEach { playlist ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(playlist.id in selected.orEmpty(), { enabled ->
                        val owner = vm.repository.session.cacheScope() ?: return@Checkbox
                        scope.launch {
                            selectionLock.withLock {
                                val updated = withContext(Dispatchers.IO) {
                                    downloads.followPlaylist(playlist.id, enabled, owner)
                                    downloads.followedPlaylists()
                                }
                                if (owner == vm.repository.session.cacheScope()) selected = updated
                            }
                        }
                    })
                    Column(Modifier.weight(1f)) { Text(playlist.name); Text(stringResource(R.string.track_count, playlist.trackCount), style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
    }, confirmButton = { TextButton({ choosing = false; scope.launch { action.run { vm.syncOfflinePlaylists() } } }) { Text(stringResource(R.string.done)) } })
}
