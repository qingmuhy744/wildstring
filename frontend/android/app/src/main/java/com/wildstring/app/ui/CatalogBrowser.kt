@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wildstring.app.data.*
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** One absolute slot per server result. Placeholders cannot start playback or open an item. */
@Composable internal fun CatalogBrowser(
    vm: MusicViewModel, state: MusicState, header: @Composable () -> Unit,
    play: (Track) -> Unit, actions: (Track) -> Unit,
    playlistActions: (Playlist) -> Unit = {},
    albumActions: (Album) -> Unit = {},
) {
    val list = rememberLazyListState()
    val grid = rememberLazyGridState()
    val scope = rememberCoroutineScope()
    val playlistFeedback = LocalTactileFeedback.current
    val tracksById = remember(state.tracks) { state.tracks.associateBy { it.id } }
    val playlistsById = remember(state.playlists) { state.playlists.associateBy { it.id } }
    val groups = state.browseIndex?.groups.orEmpty()
    // The keyboard leaves too little height for 28 readable letter targets.
    val indexed = groups.isNotEmpty() && WindowInsets.ime.getBottom(LocalDensity.current) == 0
    val albumGrid = state.kind == "albums"
    var jumpJob by remember { mutableStateOf<Job?>(null) }
    val firstPosition by remember(albumGrid) { derivedStateOf {
        ((if (albumGrid) grid.firstVisibleItemIndex else list.firstVisibleItemIndex) - 1).coerceAtLeast(0)
    } }
    val activeKey = groups.lastOrNull { it.count > 0 && it.offset != null && it.offset <= firstPosition }?.key
    // Page ownership lives in the ViewModel; changing visible positions never changes the route.
    LaunchedEffect(state.contentKey, albumGrid, state.total, state.loading, state.window.pages.keys, state.rangeErrors.keys) {
        snapshotFlow {
            val visible = if (albumGrid) grid.layoutInfo.visibleItemsInfo.map { it.index } else list.layoutInfo.visibleItemsInfo.map { it.index }
            visible.map { it - 1 }.filter { it in 0 until state.total }
        }.distinctUntilChanged().collect { visible ->
            if (visible.isNotEmpty()) {
                val first = (visible.min() - 5).coerceAtLeast(0)
                val last = (visible.max() + 10).coerceAtMost(state.total - 1)
                for (index in first..last step CATALOG_PAGE_SIZE) vm.ensureRange(index)
                vm.ensureRange(last)
            }
        }
    }
    Box(Modifier.fillMaxSize()) {
        val gutter = if (indexed) 30.dp else 0.dp
        if (albumGrid) LazyVerticalGrid(GridCells.Adaptive(140.dp), state = grid,
            modifier = Modifier.fillMaxSize().padding(end = gutter).testTag("album-grid"),
            horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp)) {
            item(key = "catalog-header", span = { GridItemSpan(maxLineSpan) }) { header() }
            items(state.total, key = { "album-position-$it" }) { index ->
                val album = state.window.albumAt(index)
                if (album == null) CatalogPlaceholder(vm, state, index, grid = true)
                else Column(Modifier.testTag("catalog-item-$index").combinedClickable(
                    onClick = { vm.openAlbum(album) },
                    hapticFeedbackEnabled = false,
                    onLongClickLabel = "专辑操作",
                    onLongClick = { playlistFeedback(TactileKind.DragStart); albumActions(album) },
                )) {
                    Cover(vm, album.coverTrackId, album.title, Modifier.fillMaxWidth().aspectRatio(1f))
                    Text(album.title, Modifier.padding(top = 8.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(album.artists.joinToString(" / "), color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        } else LazyColumn(state = list, modifier = Modifier.fillMaxSize().padding(end = gutter).testTag("catalog-list"),
            contentPadding = PaddingValues(bottom = 12.dp)) {
            item(key = "catalog-header") { header() }
            items(state.total, key = { "catalog-position-$it" }) { index ->
                when (state.kind) {
                    "artists" -> state.window.artistAt(index)?.let { artist ->
                        ListItem(headlineContent = { Text(artist.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            supportingContent = { Text("${artist.trackCount} 首") },
                            leadingContent = { Cover(vm, artist.coverTrackId, artist.name, Modifier.size(44.dp)) },
                            modifier = Modifier.testTag("catalog-item-$index").clickable { vm.openArtist(artist) })
                    } ?: CatalogPlaceholder(vm, state, index)
                    "playlists" -> state.window.playlistAt(index)?.let { cached ->
                        val playlist = playlistsById[cached.id] ?: cached
                        ListItem(headlineContent = { Text(playlist.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            supportingContent = { Text("${playlist.trackCount} 首${if (playlist.kind == "smart") " · 规则歌单" else ""}") },
                            leadingContent = { Cover(vm, playlist.coverTrackId, playlist.name, Modifier.size(44.dp)) },
                            modifier = Modifier.testTag("catalog-item-$index").combinedClickable(
                                onClick = { vm.openPlaylist(playlist) },
                                hapticFeedbackEnabled = false,
                                onLongClickLabel = "歌单操作",
                                onLongClick = { playlistFeedback(TactileKind.DragStart); playlistActions(playlist) }))
                    } ?: CatalogPlaceholder(vm, state, index)
                    else -> state.window.trackAt(index)?.let { track ->
                        val display = tracksById[track.id] ?: track
                        Column {
                            if (state.discs.size > 1 && state.sort in listOf("title", "track_number")) {
                                state.discs.firstOrNull { it.offset == index }?.let { disc ->
                                    DiscHeading(disc)
                                }
                            }
                            TrackRow(vm, display, state, index, { play(display) }, { actions(display) })
                        }
                    } ?: CatalogPlaceholder(vm, state, index)
                }
            }
        }
        if (indexed) AlphabetRail(groups, activeKey, Modifier.align(Alignment.CenterEnd).fillMaxHeight().width(30.dp)) { offset ->
            vm.ensureRange(offset, retry = true)
            jumpJob?.cancel()
            jumpJob = scope.launch {
                if (albumGrid) grid.scrollToItem(offset + 1) else list.scrollToItem(offset + 1)
            }
        }
        if (!state.loading && state.total == 0 && state.error == null) Text(
            if (state.query.isNotBlank()) "没有找到匹配的音乐" else if (state.kind == "playlists") "还没有歌单" else "这里还没有音乐，请先在网页端导入曲库。",
            Modifier.align(Alignment.Center).padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.loading && !state.hasContent) CatalogSkeleton(state.kind)
    }
}

@Composable private fun CatalogPlaceholder(vm: MusicViewModel, state: MusicState, index: Int, grid: Boolean = false) {
    val error = state.rangeErrors[index / CATALOG_PAGE_SIZE * CATALOG_PAGE_SIZE]
    Column(Modifier.fillMaxWidth().then(if (grid) Modifier.aspectRatio(.8f) else Modifier.heightIn(min = if (state.kind in listOf("artists", "playlists")) 72.dp else LocalSongListSize.current.rowDp.dp))
        .testTag("catalog-placeholder-$index").then(if (error != null) Modifier.clickable { vm.ensureRange(index, retry = true) } else Modifier)
        .padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.Center) {
        if (error != null) {
            Text("加载失败，点击重试", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            Text(error, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
        } else {
            Box(Modifier.fillMaxWidth(.6f).height(12.dp).background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(4.dp)))
            Spacer(Modifier.height(9.dp))
            Box(Modifier.fillMaxWidth(.35f).height(9.dp).background(MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(4.dp)))
        }
    }
}

/** Crossing a populated letter jumps immediately; empty/repeated letters never buzz. */
@Composable internal fun AlphabetRail(groups: List<BrowseGroup>, activeKey: String?, modifier: Modifier, jump: (Int) -> Unit) {
    var height by remember { mutableIntStateOf(1) }
    var preview by remember { mutableStateOf<String?>(null) }
    var previewY by remember { mutableFloatStateOf(0f) }
    var lastKey by remember { mutableStateOf<String?>(null) }
    val currentJump by rememberUpdatedState(jump)
    val feedback = LocalTactileFeedback.current
    val density = LocalDensity.current
    val bubbleSize = with(density) { 72.dp.toPx() }
    val padding = with(density) { 6.dp.toPx() }
    fun select(y: Float) {
        val group = groups[(y / height * groups.size).toInt().coerceIn(groups.indices)]
        preview = group.key; previewY = y.coerceIn(0f, height.toFloat())
        if (group.count > 0 && group.offset != null && group.key != lastKey) {
            lastKey = group.key
            feedback(TactileKind.Tap)
            currentJump(group.offset)
        }
    }
    Box(modifier) {
        Column(Modifier.fillMaxSize().padding(vertical = 6.dp).onSizeChanged { height = it.height.coerceAtLeast(1) }
            .testTag("alphabet-rail").pointerInput(groups) {
                detectDragGestures(onDragStart = { lastKey = null; select(it.y) }, onDragEnd = {
                    lastKey = null; preview = null
                }, onDragCancel = { lastKey = null; preview = null }) { change, _ -> change.consume(); select(change.position.y) }
            }, verticalArrangement = Arrangement.SpaceEvenly, horizontalAlignment = Alignment.CenterHorizontally) {
            groups.forEach { group ->
                val enabled = group.count > 0 && group.offset != null
                Text(group.key, style = MaterialTheme.typography.labelSmall, fontSize = if (group.key == "0–9") 9.sp else 11.sp,
                    fontWeight = if (group.key == activeKey) FontWeight.Bold else FontWeight.Normal,
                    color = if (group.key == activeKey) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (enabled) 1f else .28f),
                    modifier = Modifier.fillMaxWidth().weight(1f)
                        .background(if (group.key == activeKey) MaterialTheme.colorScheme.primaryContainer else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(8.dp))
                        .wrapContentSize(Alignment.Center).testTag("alphabet-${group.key}")
                        .semantics { contentDescription = "跳至 ${group.key}"; selected = group.key == activeKey }
                        .clickable(enabled = enabled) { feedback(TactileKind.Tap); group.offset?.let(currentJump) })
            }
        }
        preview?.let { letter -> Surface(Modifier.align(Alignment.TopEnd).offset {
            IntOffset(with(density) { (-44).dp.roundToPx() }, (previewY + padding - bubbleSize / 2).coerceIn(0f, (height + 2 * padding - bubbleSize).coerceAtLeast(0f)).roundToInt())
        }.size(72.dp).testTag("alphabet-preview"),
            shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.primaryContainer, shadowElevation = 6.dp) {
            Box(contentAlignment = Alignment.Center) { Text(letter, style = MaterialTheme.typography.headlineLarge) }
        } }
    }
}

/** A restrained divider, leaving song positions and paging indices unchanged. */
@Composable private fun DiscHeading(disc: DiscSummary) {
    Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 20.dp, top = 14.dp, bottom = 4.dp).heightIn(min = 24.dp)
        .testTag("disc-heading-${disc.number}").semantics { contentDescription = "Disc ${disc.number}，${disc.trackCount} 首" },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("DISC ${disc.number.toString().padStart(2, '0')}", color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelSmall, fontSize = 11.sp, letterSpacing = 1.sp, fontWeight = FontWeight.SemiBold)
        Text("${disc.trackCount} 首", color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .7f), fontSize = 10.sp)
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f))
    }
}
