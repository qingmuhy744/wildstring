@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import com.wildstring.app.R
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.changedToDownIgnoreConsumed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.wildstring.app.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** The rail and the grid share these so the two columns can never overlap. */
internal val ALPHABET_RAIL_WIDTH = 44.dp
internal val ALPHABET_RAIL_GAP = 8.dp

/** End padding the grid must reserve when the rail is shown; 0 when it is hidden. */
internal fun alphabetGutter(indexed: Boolean): androidx.compose.ui.unit.Dp =
    if (indexed) ALPHABET_RAIL_WIDTH + ALPHABET_RAIL_GAP else 0.dp

/** One absolute slot per server result. Placeholders cannot start playback or open an item. */
@Composable internal fun CatalogBrowser(
    vm: MusicViewModel, state: MusicState, header: @Composable () -> Unit,
    play: (Track) -> Unit, actions: (Track) -> Unit,
    playlistActions: (Playlist) -> Unit = {},
    albumActions: (Album) -> Unit = {},
) {
    val grid = rememberLazyGridState()
    val scope = rememberCoroutineScope()
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    val playlistFeedback = LocalTactileFeedback.current
    val tracksById = remember(state.tracks) { state.tracks.associateBy { it.id } }
    val playlistsById = remember(state.playlists) { state.playlists.associateBy { it.id } }
    val groups = state.browseIndex?.groups.orEmpty()
    // The keyboard leaves too little height for 28 readable letter targets.
    val indexed = groups.isNotEmpty() && WindowInsets.ime.getBottom(LocalDensity.current) == 0
    val albumGrid = state.kind == "albums"
    var jumpJob by remember { mutableStateOf<Job?>(null) }
    val firstPosition by remember(albumGrid) { derivedStateOf {
        (grid.firstVisibleItemIndex - 1).coerceAtLeast(0)
    } }
    val activeKey = groups.lastOrNull { it.count > 0 && it.offset != null && it.offset <= firstPosition }?.key
    // Page ownership lives in the ViewModel; changing visible positions never changes the route.
    LaunchedEffect(state.contentKey, albumGrid, state.total, state.loading, state.window.pages.keys, state.rangeErrors.keys) {
        snapshotFlow {
            val visible = grid.layoutInfo.visibleItemsInfo.map { it.index }
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
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        val pad = LocalAndroidLayoutMode.current == AndroidLayoutMode.Pad
        val trackColumns = pad && maxWidth >= 760.dp
        val cardGrid = pad && state.kind in listOf("artists", "playlists")
        val gutter = alphabetGutter(indexed)
        // One grid and one absolute item index in every mode retain the viewport on resize.
        LazyVerticalGrid(
            columns = when { albumGrid -> GridCells.Adaptive(140.dp); cardGrid -> GridCells.Adaptive(260.dp); else -> GridCells.Fixed(1) },
            state = grid,
            // Same 1180dp reading width as the Web shell, so ultra-wide windows do not stretch rows apart.
            modifier = Modifier.widthIn(max = 1180.dp).fillMaxSize().padding(end = gutter).testTag(if (albumGrid) "album-grid" else "catalog-list"),
            horizontalArrangement = Arrangement.spacedBy(if (albumGrid || cardGrid) 16.dp else 0.dp),
            verticalArrangement = Arrangement.spacedBy(if (albumGrid) 16.dp else if (cardGrid) 8.dp else 0.dp),
            contentPadding = if (albumGrid || cardGrid) PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp) else PaddingValues(bottom = 12.dp),
        ) {
            item(key = "catalog-header", span = { GridItemSpan(maxLineSpan) }) {
                Column {
                    header()
                    if (trackColumns && !albumGrid && !cardGrid) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Spacer(Modifier.width(if (state.collection == "albums" || state.albumFilter != null) 30.dp else LocalSongListSize.current.coverDp.dp))
                            Text(stringResource(R.string.sort_track_name), Modifier.weight(2.4f).padding(start = 14.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(stringResource(R.string.artists), Modifier.weight(1.4f).padding(start = 24.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(stringResource(R.string.agent_ws_field_album), Modifier.weight(1.7f).padding(start = 24.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(stringResource(R.string.sort_duration), Modifier.width(52.dp), textAlign = androidx.compose.ui.text.style.TextAlign.End, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(48.dp))
                        }
                    }
                }
            }
            items(state.total, key = { "catalog-position-$it" }) { index ->
                if (albumGrid) {
                    val album = state.window.albumAt(index)
                    if (album == null) CatalogPlaceholder(vm, state, index, grid = true)
                    else Column(Modifier.testTag("catalog-item-$index").combinedClickable(
                        onClick = { vm.openAlbum(album) },
                        hapticFeedbackEnabled = false,
                        onLongClickLabel = stringResource(R.string.album_actions),
                        onLongClick = { playlistFeedback(TactileKind.DragStart); albumActions(album) },
                    )) {
                        Cover(vm, album.coverTrackId, album.title, Modifier.fillMaxWidth().aspectRatio(1f))
                        Text(album.title, Modifier.padding(top = 8.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(album.artists.joinToString(" / "), color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                } else {
                    when (state.kind) {
                        "artists" -> state.window.artistAt(index)?.let { artist ->
                            ListItem(headlineContent = { Text(artist.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                supportingContent = { Text(stringResource(R.string.track_count, artist.trackCount)) },
                                leadingContent = { Cover(vm, artist.coverTrackId, artist.name, Modifier.size(44.dp)) },
                                modifier = Modifier.testTag("catalog-item-$index").clickable { vm.openArtist(artist) })
                        } ?: CatalogPlaceholder(vm, state, index)
                        "playlists" -> state.window.playlistAt(index)?.let { cached ->
                            val playlist = playlistsById[cached.id] ?: cached
                            ListItem(headlineContent = { Text(playlist.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                supportingContent = { Text(stringResource(R.string.track_count, playlist.trackCount) + if (playlist.kind == "smart") stringResource(R.string.smart_playlist_suffix) else "") },
                                leadingContent = { Cover(vm, playlist.coverTrackId, playlist.name, Modifier.size(44.dp)) },
                                modifier = Modifier.testTag("catalog-item-$index").combinedClickable(
                                    onClick = { vm.openPlaylist(playlist) },
                                    hapticFeedbackEnabled = false,
                                    onLongClickLabel = stringResource(R.string.playlist_actions),
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
                                TrackRow(vm, display, state, index, { play(display) }, { actions(display) }, columns = trackColumns)
                            }
                        } ?: CatalogPlaceholder(vm, state, index)
                    }
                }
            }
        }
        if (indexed) {
            val motion = preferences.interfaceAnimations && playbackMotionAllowed()
            AlphabetRail(groups, activeKey, Modifier.align(Alignment.CenterEnd).fillMaxHeight().width(ALPHABET_RAIL_WIDTH),
                jump = { offset ->
                    vm.ensureRange(offset, retry = true)
                    jumpJob?.cancel()
                    jumpJob = scope.launch {
                        grid.scrollToItem(offset + 1)
                    }
                },
                scrolling = grid.isScrollInProgress, scrollTick = grid.firstVisibleItemIndex, motionAllowed = motion)
        }
        if (!state.loading && state.total == 0 && state.error == null) Text(
            if (state.query.isNotBlank()) stringResource(R.string.catalog_no_matches) else if (state.kind == "playlists") stringResource(R.string.catalog_no_playlists) else stringResource(R.string.catalog_empty),
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
            Text(stringResource(R.string.load_failed_retry), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            Text(error, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
        } else {
            Box(Modifier.fillMaxWidth(.6f).height(12.dp).background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(4.dp)))
            Spacer(Modifier.height(9.dp))
            Box(Modifier.fillMaxWidth(.35f).height(9.dp).background(MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(4.dp)))
        }
    }
}

/** The rail rests quieter than the list and returns to full strength for a moment after use. */
internal val ALPHABET_RAIL_IDLE_ALPHA = .35f
internal const val ALPHABET_RAIL_IDLE_DELAY_MS = 1_200L
internal const val ALPHABET_RAIL_FADE_MS = 180
private const val ALPHABET_RAIL_DISABLED_ALPHA = .6f
private val AlphabetRailLetterHeight = 14.dp

/** Crossing a populated letter jumps immediately; empty/repeated letters never buzz. */
@Composable internal fun AlphabetRail(
    groups: List<BrowseGroup>, activeKey: String?, modifier: Modifier, jump: (Int) -> Unit,
    scrolling: Boolean = false, scrollTick: Int = 0, motionAllowed: Boolean = playbackMotionAllowed(),
) {
    val resources = androidx.compose.ui.platform.LocalResources.current
    var height by remember { mutableIntStateOf(1) }
    var preview by remember { mutableStateOf<String?>(null) }
    var previewY by remember { mutableFloatStateOf(0f) }
    var lastKey by remember { mutableStateOf<String?>(null) }
    // A new value restarts the idle timer; every gesture and an active-letter change refreshes it.
    var lastTouch by remember { mutableIntStateOf(0) }
    var idle by remember { mutableStateOf(false) }
    val currentJump by rememberUpdatedState(jump)
    val feedback = LocalTactileFeedback.current
    val density = LocalDensity.current
    val bubbleSize = with(density) { 72.dp.toPx() }
    val padding = with(density) { 6.dp.toPx() }
    val interactions = remember { MutableInteractionSource() }
    val hovered by interactions.collectIsHoveredAsState()
    fun touched() { lastTouch = lastTouch + 1 }
    LaunchedEffect(lastTouch, hovered, scrolling, motionAllowed) {
        if (!motionAllowed) { idle = false; return@LaunchedEffect }
        idle = false
        if (!hovered && !scrolling) { delay(ALPHABET_RAIL_IDLE_DELAY_MS); idle = true }
    }
    // The user's own scrolling, a new active letter and any touch on the rail all show it again.
    LaunchedEffect(scrolling, scrollTick, activeKey) { if (scrolling || activeKey != null) touched() }
    val alpha by animateFloatAsState(if (idle) ALPHABET_RAIL_IDLE_ALPHA else 1f,
        tween(if (motionAllowed) ALPHABET_RAIL_FADE_MS else 0), label = "alphabet-fade")
    fun select(y: Float) {
        if (groups.isEmpty()) return
        val group = groups[(y / height * groups.size).toInt().coerceIn(groups.indices)]
        preview = group.key; previewY = y.coerceIn(0f, height.toFloat())
        if (group.count > 0 && group.offset != null && group.key != lastKey) {
            lastKey = group.key
            feedback(TactileKind.Tap)
            currentJump(group.offset)
        }
    }
    Box(modifier.hoverable(interactions)) {
        Column(Modifier.fillMaxSize().padding(vertical = 6.dp, horizontal = 6.dp)
            .onSizeChanged { height = it.height.coerceAtLeast(1) }.graphicsLayer { this.alpha = alpha }
            .testTag("alphabet-rail").semantics {
                stateDescription = resources.getString(if (idle) R.string.alphabet_rail_idle else R.string.alphabet_rail_active)
            }.pointerInput(Unit) {
                // Pressing anywhere on the rail restores it before a drag or click is recognised.
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent()
                        if (event.changes.any { it.changedToDownIgnoreConsumed() }) touched()
                    }
                }
            }.pointerInput(groups) {
                detectDragGestures(onDragStart = { lastKey = null; touched(); select(it.y) }, onDragEnd = {
                    lastKey = null; preview = null; touched()
                }, onDragCancel = { lastKey = null; preview = null; touched() }) { change, _ -> change.consume(); select(change.position.y) }
            }, horizontalAlignment = Alignment.CenterHorizontally) {
            groups.forEach { group ->
                val enabled = group.count > 0 && group.offset != null
                val active = group.key == activeKey
                // The hit area is the letter's whole share of the column (a touch target, never smaller than
                // before); only the 14dp visual inside it is fixed, so the tick and glyph never move.
                Box(Modifier.fillMaxWidth().weight(1f).testTag("alphabet-${group.key}")
                    .semantics { contentDescription = resources.getString(R.string.jump_to, group.key); selected = active }
                    .clickable(enabled = enabled) { touched(); feedback(TactileKind.Tap); group.offset?.let(currentJump) },
                    contentAlignment = Alignment.Center) {
                    Box(Modifier.height(AlphabetRailLetterHeight).fillMaxWidth().testTag("alphabet-visual-${group.key}"),
                        contentAlignment = Alignment.Center) {
                        Box(Modifier.align(Alignment.CenterStart).offset(x = 3.dp).width(2.dp).height(11.dp)
                            .clip(RoundedCornerShape(1.dp)).background(if (active) MaterialTheme.colorScheme.tertiary else Color.Transparent))
                        Text(group.key, fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 14.sp,
                            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (active) MaterialTheme.colorScheme.tertiary
                                else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (enabled) 1f else ALPHABET_RAIL_DISABLED_ALPHA))
                    }
                }
            }
        }
        preview?.let { letter -> Surface(Modifier.align(Alignment.TopEnd).offset {
            IntOffset(with(density) { (-ALPHABET_RAIL_WIDTH.value - 2).dp.roundToPx() }, (previewY + padding - bubbleSize / 2).coerceIn(0f, (height + 2 * padding - bubbleSize).coerceAtLeast(0f)).roundToInt())
        }.size(72.dp).testTag("alphabet-preview"),
            shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.primaryContainer) {
            Box(contentAlignment = Alignment.Center) { Text(letter, style = MaterialTheme.typography.headlineLarge) }
        } }
    }
}

/** A restrained divider, leaving song positions and paging indices unchanged. */
@Composable private fun DiscHeading(disc: DiscSummary) {
    val resources = androidx.compose.ui.platform.LocalResources.current
    Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 20.dp, top = 14.dp, bottom = 4.dp).heightIn(min = 24.dp)
        .testTag("disc-heading-${disc.number}").semantics { contentDescription = resources.getString(R.string.disc_summary, disc.number, disc.trackCount) },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("DISC ${disc.number.toString().padStart(2, '0')}", color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelSmall, fontSize = 11.sp, letterSpacing = 1.sp, fontWeight = FontWeight.SemiBold)
        Text(stringResource(R.string.track_count, disc.trackCount), color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .7f), fontSize = 11.sp)
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f))
    }
}
