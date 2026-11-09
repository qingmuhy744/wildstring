package com.wildstring.app.ui

import com.wildstring.app.AppLanguage
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.wildstring.app.R
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
        if (action.message == DONE_STATUS) action.message = null
        loading = false
    }
    AlertDialog(
        onDismissRequest = { if (!action.busy) dismiss() },
        title = { Text(stringResource(R.string.rec_dlg_title_add_to_playlist)) },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.rec_dlg_selected_count_order, tracks.size))
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (created == null) {
                    Row(Modifier.fillMaxWidth().clickable(enabled = !action.busy) { target = null }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(target == null, { target = null }, enabled = !action.busy); Text(stringResource(R.string.rec_dlg_new_playlist))
                    }
                    playlists.forEach { playlist ->
                        Row(Modifier.fillMaxWidth().clickable(enabled = !action.busy) { target = playlist }, verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(target?.id == playlist.id, { target = playlist }, enabled = !action.busy)
                            Text(playlist.name, Modifier.weight(1f))
                        }
                    }
                }
                if (target == null) OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.rec_dlg_playlist_name)) }, enabled = !action.busy && created == null, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (created != null && action.message != null) Text(stringResource(R.string.rec_dlg_playlist_created_hint), style = MaterialTheme.typography.bodySmall)
                ActionStatus(action)
            }
        },
        confirmButton = { TextButton({
            scope.launch { action.run {
                val selected = created ?: target ?: vm.repository.api().createPlaylist(PlaylistRequest(name.trim(), "manual")).also { created = it }
                val fresh = vm.repository.api().playlist(vm.repository.url("api", "v1", "playlists", selected.id))
                vm.addTracksToPlaylist(tracks, fresh)
                saved(AppLanguage.string(R.string.rec_dlg_added_to_named_playlist, fresh.name))
            } }
        }, enabled = !loading && !action.busy && (target != null || name.isNotBlank())) { Text(if (action.busy) stringResource(R.string.rec_dlg_adding) else stringResource(R.string.rec_dlg_confirm_add)) } },
        dismissButton = { TextButton(dismiss, enabled = !action.busy) { Text(stringResource(R.string.rec_dlg_cancel)) } },
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
            Text(stringResource(R.string.rec_dlg_lyrics_preview, track.artist), color = MaterialTheme.colorScheme.onSurfaceVariant)
            when {
                error != null -> Text(error.orEmpty())
                lyrics == null -> CircularProgressIndicator()
                lyrics!!.lines.isEmpty() -> Text(stringResource(R.string.rec_dlg_no_lyrics))
                else -> lyrics!!.lines.forEach { Text(it.text) }
            }
        }
    }, confirmButton = { TextButton(dismiss) { Text(stringResource(R.string.lyrics_preview_close)) } })
}
