package com.wildstring.app.ui

import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayCircleOutline
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wildstring.app.data.Album

/** New library arrivals and personal listening history have independent ordering and queues. */
@Composable internal fun DiscoveryPage(vm: MusicViewModel, state: MusicState, play: (List<com.wildstring.app.data.Track>, Int) -> Unit, recent: () -> Unit, header: @Composable () -> Unit = {}, albumActions: (Album) -> Unit = {}) {
    val feedback = LocalTactileFeedback.current
    Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.TopCenter) {
        LazyColumn(Modifier.widthIn(max = 1040.dp).fillMaxSize().testTag("discovery-page"), contentPadding = PaddingValues(bottom = 16.dp)) {
            item(key = "discovery-header") { header() }
            item {
                SectionHeading(stringResource(R.string.recently_added_albums), stringResource(R.string.view_all)) { vm.recentlyAdded("albums") }
            }
            item {
                if (state.albums.isNotEmpty()) LazyRow(Modifier.testTag("discovery-albums"),
                    contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    items(state.albums, key = { it.id }) { album ->
                        Column(Modifier.width(140.dp).combinedClickable(
                            onClick = { vm.openAlbum(album) },
                            hapticFeedbackEnabled = false,
                            onLongClickLabel = stringResource(R.string.album_actions),
                            onLongClick = { feedback(TactileKind.DragStart); albumActions(album) },
                        )) {
                            Cover(vm, album.coverTrackId, album.title, Modifier.fillMaxWidth().aspectRatio(1f))
                            Text(album.title, Modifier.padding(top = 10.dp), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(album.artists.joinToString(" / "), Modifier.padding(top = 3.dp), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                } else if (!state.loading && state.error == null) Text(if (state.offline) stringResource(R.string.discovery_albums_offline) else stringResource(R.string.discovery_albums_empty), Modifier.padding(horizontal = 20.dp, vertical = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item { Spacer(Modifier.height(24.dp)); SectionHeading(stringResource(R.string.recently_added_tracks), stringResource(R.string.view_all)) { vm.recentlyAdded("tracks") } }
            if (state.addedTracks.isEmpty() && !state.loading && state.error == null) item {
                Text(if (state.offline) stringResource(R.string.discovery_added_offline) else stringResource(R.string.discovery_added_empty), Modifier.padding(horizontal = 20.dp, vertical = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(state.addedTracks, key = { "added-${it.id}" }) { track ->
                val playTrack = tactile { play(state.addedTracks, state.addedTracks.indexOf(track)) }
                ListItem(headlineContent = { Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(listOfNotNull(track.artist, track.album).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingContent = { Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.size(54.dp)) },
                    trailingContent = { IconButton(playTrack) { Icon(Icons.Default.PlayCircleOutline, stringResource(R.string.play_named, track.title)) } },
                    modifier = Modifier.fillMaxWidth().testTag("discovery-added-${track.id}").clickable(onClick = playTrack).padding(horizontal = 4.dp, vertical = 4.dp))
            }
            item { Spacer(Modifier.height(24.dp)); SectionHeading(stringResource(R.string.recently_played), stringResource(R.string.view_more), recent) }
            if (state.tracks.isEmpty() && !state.loading && state.error == null) item {
                Text(if (state.offline) stringResource(R.string.discovery_recent_offline) else stringResource(R.string.discovery_recent_empty), Modifier.padding(horizontal = 20.dp, vertical = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(state.tracks.take(6), key = { "recent-${it.id}" }) { track ->
                val playTrack = tactile { play(state.tracks, state.tracks.indexOf(track)) }
                ListItem(headlineContent = { Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(listOfNotNull(track.artist, track.album).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingContent = { Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.size(54.dp)) },
                    trailingContent = { IconButton(playTrack) { Icon(Icons.Default.PlayCircleOutline, stringResource(R.string.play_named, track.title)) } },
                    modifier = Modifier.fillMaxWidth().clickable(onClick = playTrack).padding(horizontal = 4.dp, vertical = 4.dp))
            }
        }
        if (state.loading && state.albums.isEmpty() && state.tracks.isEmpty()) DiscoverySkeleton()
    }
}

@Composable private fun SectionHeading(title: String, action: String, click: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        TextButton(click) { Text(action) }
    }
}
