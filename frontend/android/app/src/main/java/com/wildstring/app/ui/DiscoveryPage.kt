package com.wildstring.app.ui

import androidx.compose.foundation.clickable
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

/** The reference layout, backed by actual albums and listening history rather than invented picks. */
@Composable internal fun DiscoveryPage(vm: MusicViewModel, state: MusicState, play: (Int) -> Unit, recent: () -> Unit, header: @Composable () -> Unit = {}) {
    Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.TopCenter) {
        LazyColumn(Modifier.widthIn(max = 1040.dp).fillMaxSize().testTag("discovery-page"), contentPadding = PaddingValues(bottom = 16.dp)) {
            item(key = "discovery-header") { header() }
            item {
                SectionHeading("专辑", "查看全部", vm::browseAlbums)
            }
            item {
                if (state.albums.isNotEmpty()) LazyRow(Modifier.testTag("discovery-albums"),
                    contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    items(state.albums, key = { it.id }) { album ->
                        Column(Modifier.width(140.dp).clickable { vm.openAlbum(album) }) {
                            Cover(vm, album.coverTrackId, album.title, Modifier.fillMaxWidth().aspectRatio(1f))
                            Text(album.title, Modifier.padding(top = 10.dp), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(album.artists.joinToString(" / "), Modifier.padding(top = 3.dp), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                } else if (!state.loading && state.error == null) Text(if (state.offline) "本机暂无专辑缓存，联网后刷新。" else "还没有专辑，请先在网页端导入音乐。", Modifier.padding(horizontal = 20.dp, vertical = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item { Spacer(Modifier.height(24.dp)); SectionHeading("最近听过", "查看更多", recent) }
            if (state.tracks.isEmpty() && !state.loading && state.error == null) item {
                Text(if (state.offline) "当前离线，本机暂无最近收听记录。" else "听过的歌曲会出现在这里。", Modifier.padding(horizontal = 20.dp, vertical = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(state.tracks.take(6), key = { it.id }) { track ->
                val playTrack = tactile { play(state.tracks.indexOf(track)) }
                ListItem(headlineContent = { Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(listOfNotNull(track.artist, track.album).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingContent = { Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.size(54.dp)) },
                    trailingContent = { IconButton(playTrack) { Icon(Icons.Default.PlayCircleOutline, "播放${track.title}") } },
                    modifier = Modifier.fillMaxWidth().clickable(onClick = playTrack).padding(horizontal = 4.dp, vertical = 4.dp))
            }
        }
    }
}

@Composable private fun SectionHeading(title: String, action: String, click: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        TextButton(click) { Text(action) }
    }
}
