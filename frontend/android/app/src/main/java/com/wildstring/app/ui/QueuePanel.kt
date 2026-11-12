@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.wildstring.app.ui

import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.gestures.verticalDrag
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlin.math.abs
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Surface
import androidx.compose.ui.text.font.FontWeight
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun QueuePanel(
    vm: MusicViewModel,
    state: MusicState,
    modifier: Modifier,
    headerModifier: Modifier = Modifier,
    onClose: (() -> Unit)? = null,
    showClear: Boolean = true,
    bottomInset: androidx.compose.ui.unit.Dp = 0.dp,
) {
    if (state.current?.isPodcast == true) {
        PodcastQueuePanel(vm, state, modifier, headerModifier, onClose, bottomInset)
        return
    }
    val feedback = LocalTactileFeedback.current
    QueueList(state.queue, state.entryId, modifier,
        onPlay = { feedback(TactileKind.Tap); vm.playQueue(it.index) },
        onRemove = {},
        onSwipeRemove = { row ->
            val removed = vm.removeQueueEntry(row.entryId) ?: return@QueueList null
            ({ vm.restoreQueueEntry(removed.first, removed.second) })
        },
        onMove = vm::moveQueue, onHaptic = feedback, playing = state.playing, buffering = state.buffering,
        onClear = if (showClear && state.queue.isNotEmpty()) ({ feedback(TactileKind.Tap); vm.clearQueue() }) else null,
        headerModifier = headerModifier,
        bottomInset = bottomInset,
        onClose = onClose)
}

@Composable
internal fun PodcastQueuePanel(
    vm: MusicViewModel,
    state: MusicState,
    modifier: Modifier = Modifier,
    headerModifier: Modifier = Modifier,
    onClose: (() -> Unit)? = null,
    bottomInset: androidx.compose.ui.unit.Dp = 0.dp,
) {
    val cloud by vm.podcastCloud.collectAsState()
    val feedback = LocalTactileFeedback.current
    LaunchedEffect(Unit) {
        vm.refreshPodcastCloud()
        vm.refreshPodcastAutoPreview()
    }
    Column(modifier.fillMaxWidth().testTag("podcast-player-queue")) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).then(headerModifier),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.q_panel_queue_title, cloud.queueRows.size),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            if (onClose != null) {
                IconButton(onClick = onClose) {
                    Icon(Icons.Default.Close, contentDescription = stringResource(R.string.q_panel_close))
                }
            }
        }
        if (cloud.queueFull) PodcastQueueFullNote(Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        PodcastQueueRows(
            rows = cloud.queueRows,
            currentEpisodeId = state.current?.podcastEpisodeId,
            playing = state.playing,
            buffering = state.buffering,
            onPlay = { vm.playPodcastPendingQueue(it.episodeId) },
            onRemove = { vm.removePodcastQueueEpisode(it.episodeId) },
            onRestore = vm::restorePodcastQueueRow,
            onReorder = vm::reorderPodcastPending,
            modifier = Modifier.fillMaxWidth().weight(1f, fill = false),
            bottomInset = bottomInset,
            empty = {
                Text(
                    text = stringResource(R.string.podcast_player_queue_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 12.dp),
                )
            },
            footer = {
                if (cloud.autoPreview.isNotEmpty()) {
                    Text(
                        text = stringResource(R.string.q_panel_auto_continue),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                    )
                    cloud.autoPreview.forEach { item ->
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = MaterialTheme.colorScheme.surfaceContainerHighest.copy(alpha = 0.5f),
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        ) {
                            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(item.title, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    if (item.showTitle.isNotBlank()) Text(item.showTitle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                                }
                                Spacer(Modifier.width(8.dp))
                                FilledTonalButton(
                                    onClick = { feedback(TactileKind.Tap); vm.addPodcastEpisodeToQueue(item.episode, item.summary, next = false) },
                                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                    shape = RoundedCornerShape(8.dp),
                                    modifier = Modifier.height(32.dp),
                                ) { Text(stringResource(R.string.q_panel_add_to_queue), style = MaterialTheme.typography.labelSmall) }
                            }
                        }
                    }
                    Text(
                        text = stringResource(R.string.q_panel_not_written_to_queue),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.outline,
                        modifier = Modifier.padding(top = 4.dp, bottom = 8.dp),
                    )
                }
            },
        )
    }
}

@Composable
internal fun PodcastQueueRows(
    rows: List<PodcastQueueRow>,
    currentEpisodeId: String?,
    playing: Boolean,
    buffering: Boolean,
    onPlay: (PodcastQueueRow) -> Unit,
    onRemove: (PodcastQueueRow) -> Unit,
    onRestore: (PodcastQueueRow, Int) -> Unit,
    onReorder: (List<PodcastQueueRow>) -> Unit,
    modifier: Modifier = Modifier,
    horizontalContentPadding: androidx.compose.ui.unit.Dp = 16.dp,
    bottomInset: androidx.compose.ui.unit.Dp = 0.dp,
    empty: @Composable () -> Unit = {},
    footer: @Composable () -> Unit = {},
) {
    val feedback = LocalTactileFeedback.current
    val list = rememberLazyListState()
    val drag = remember(list) { QueueDragState(list) { row: PodcastQueueRow -> row.episodeId } }
    val handles = remember { mutableMapOf<String, Rect>() }
    var coordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    val currentRows by rememberUpdatedState(rows)
    val reorder by rememberUpdatedState(onReorder)
    val ordered = drag.order ?: rows
    val density = LocalDensity.current
    val elevation = with(density) { 6.dp.toPx() }
    val edge = with(density) { 64.dp.toPx() }
    val speed = with(density) { 900.dp.toPx() }
    val ids = remember(rows) { rows.map { it.episodeId } }
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val removedLabel = stringResource(R.string.queue_removed)
    val undoLabel = stringResource(R.string.queue_undo)
    val resources = androidx.compose.ui.platform.LocalResources.current
    val restoreNow = rememberUpdatedState(onRestore)
    val removeNow = rememberUpdatedState(onRemove)
    fun offerUndo(row: PodcastQueueRow, index: Int) {
        scope.launch {
            val result = snackbar.showSnackbar(removedLabel, undoLabel, duration = SnackbarDuration.Short)
            if (result == SnackbarResult.ActionPerformed) restoreNow.value(row, index)
        }
    }
    LaunchedEffect(ids) { if (drag.entryId != null && drag.originalIds != ids) drag.cancel() }
    DisposableEffect(Unit) { onDispose { drag.cancel() } }
    LaunchedEffect(drag.entryId) {
        if (drag.entryId == null) return@LaunchedEffect
        var previous = System.nanoTime()
        while (drag.entryId != null) {
            delay(16)
            val frame = System.nanoTime()
            val elapsed = ((frame - previous) / 1_000_000_000f).coerceAtMost(.05f)
            previous = frame
            val layout = list.layoutInfo
            val zone = edge.coerceAtMost((layout.viewportEndOffset - layout.viewportStartOffset) / 3f)
            val direction = when {
                drag.pointerY < layout.viewportStartOffset + zone -> -((layout.viewportStartOffset + zone - drag.pointerY) / zone).coerceIn(0f, 1f)
                drag.pointerY > layout.viewportEndOffset - zone -> ((drag.pointerY - layout.viewportEndOffset + zone) / zone).coerceIn(0f, 1f)
                else -> 0f
            }
            if (direction != 0f) { list.scrollBy(direction * speed * elapsed); drag.reorder() }
        }
    }
    Box(modifier) {
        LazyColumn(
            modifier = Modifier.fillMaxSize()
                .onGloballyPositioned { coordinates = it }
                .testTag("podcast-queue-list")
                .pointerInput(drag) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                        val id = handles.entries.firstOrNull { it.value.contains(down.position) }?.key
                            ?: return@awaitEachGesture
                        if (currentRows.size < 2) return@awaitEachGesture
                        val startIds = currentRows.map { it.episodeId }
                        var change = down
                        while (abs(change.position.y - down.position.y) <= viewConfiguration.touchSlop) {
                            change = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id }
                                ?: return@awaitEachGesture
                            if (change.isConsumed || !change.pressed) return@awaitEachGesture
                        }
                        change.consume()
                        if (!drag.start(id, currentRows, down.position.y)) return@awaitEachGesture
                        feedback(TactileKind.DragStart)
                        drag.move(change.position.y)
                        awaitPointerEvent(PointerEventPass.Final)
                        var dropped = false
                        try {
                            dropped = verticalDrag(change.id) { event -> drag.move(event.position.y); event.consume() }
                        } finally {
                            if (dropped && drag.originalIds == startIds) drag.order?.let { orderedRows ->
                                if (orderedRows.map { it.episodeId } != startIds) {
                                    reorder(orderedRows)
                                    feedback(TactileKind.DragEnd)
                                }
                            }
                            drag.cancel()
                        }
                    }
                },
            state = list,
            userScrollEnabled = drag.entryId == null,
            contentPadding = PaddingValues(start = horizontalContentPadding, end = horizontalContentPadding, top = 4.dp, bottom = 4.dp + bottomInset),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (rows.isEmpty()) item { empty() }
            itemsIndexed(ordered, key = { _, row -> row.episodeId }) { index, row ->
                val active = drag.entryId == row.episodeId
                val current = row.episodeId == currentEpisodeId
                val canSwipe = !current && !active
                DisposableEffect(row.episodeId) { onDispose { handles.remove(row.episodeId) } }
                val canSwipeNow by rememberUpdatedState(canSwipe)
                val rowNow by rememberUpdatedState(row)
                val indexNow by rememberUpdatedState(index)
                val dismissState = rememberSwipeToDismissBoxState(confirmValueChange = { value ->
                    if (value != SwipeToDismissBoxValue.EndToStart || !canSwipeNow) false
                    else {
                        removeNow.value(rowNow)
                        offerUndo(rowNow, indexNow)
                        true
                    }
                })
                SwipeToDismissBox(
                    state = dismissState,
                    modifier = Modifier.animateItem(placementSpec = if (active) null else androidx.compose.animation.core.spring())
                        .fillMaxWidth().zIndex(if (active) 1f else 0f)
                        .graphicsLayer {
                            translationY = if (active) drag.top - (list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == row.episodeId }?.offset ?: 0) else 0f
                            shadowElevation = if (active) elevation else 0f
                            shape = RoundedCornerShape(12.dp)
                            clip = false
                        },
                    enableDismissFromStartToEnd = false,
                    enableDismissFromEndToStart = canSwipe,
                    gesturesEnabled = canSwipe,
                    backgroundContent = {
                        Box(Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(horizontal = 20.dp), contentAlignment = Alignment.CenterEnd) {
                            Text(stringResource(R.string.queue_remove), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    },
                ) {
                    QueueChromeRow(
                        index = index,
                        title = row.title,
                        subtitle = row.showTitle,
                        current = current,
                        highlighted = active,
                        playing = playing,
                        buffering = buffering,
                        playEnabled = drag.entryId == null,
                        onPlay = { onPlay(row) },
                        rowTag = "podcast-queue-row-${row.episodeId}",
                        handleTag = "podcast-queue-handle-${row.episodeId}",
                        onHandlePositioned = { handle -> coordinates?.takeIf { it.isAttached && handle.isAttached }?.let { handles[row.episodeId] = it.localBoundingBoxOf(handle, clipBounds = false) } },
                        dragLabel = resources.getString(R.string.queue_drag_named, row.title),
                        positionLabel = resources.getString(R.string.queue_position, index + 1, rows.size),
                        onMoveUp = if (index > 0) ({ feedback(TactileKind.Tap); reorder(ordered.toMutableList().apply { add(index - 1, removeAt(index)) }) }) else null,
                        onMoveDown = if (index < ordered.lastIndex) ({ feedback(TactileKind.Tap); reorder(ordered.toMutableList().apply { add(index + 1, removeAt(index)) }) }) else null,
                        onRemove = if (!current) ({ removeNow.value(row); offerUndo(row, index) }) else null,
                        showRemoveButton = false,
                        onRemoveButton = {},
                        titleMaxLines = 2,
                    )
                }
            }
            item { footer() }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(8.dp))
    }
}

/** Only the handle starts a reorder; the rest of the row keeps ordinary tap/scroll behavior. */
@Composable
internal fun QueueList(
    rows: List<QueueRow>, currentEntry: String?, modifier: Modifier = Modifier,
    onPlay: (QueueRow) -> Unit, onRemove: (QueueRow) -> Unit,
    onMove: (String, Int) -> Unit, onHaptic: (TactileKind) -> Unit, allowRemove: Boolean = true,
    onSwipeRemove: ((QueueRow) -> (() -> Unit)?)? = null,
    title: String = stringResource(R.string.queue_title_count, rows.size),
    playing: Boolean = false, buffering: Boolean = false, onClear: (() -> Unit)? = null,
    headerModifier: Modifier = Modifier,
    onClose: (() -> Unit)? = null,
    bottomInset: androidx.compose.ui.unit.Dp = 0.dp,
) {
    val resources = androidx.compose.ui.platform.LocalResources.current
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val drag = remember(list) { QueueDragState(list) { row: QueueRow -> row.entryId } }
    val ids = remember(rows) { rows.map { it.entryId } }
    val currentRows by rememberUpdatedState(rows)
    val move by rememberUpdatedState(onMove)
    val haptic by rememberUpdatedState(onHaptic)
    val handles = remember { mutableMapOf<String, Rect>() }
    var coordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    val density = LocalDensity.current
    val edge = with(density) { 64.dp.toPx() }
    val speed = with(density) { 900.dp.toPx() }
    val elevation = with(density) { 6.dp.toPx() }
    val snackbar = remember { SnackbarHostState() }
    val removedLabel = stringResource(R.string.queue_removed)
    val undoLabel = stringResource(R.string.queue_undo)
    val swipeRemove by rememberUpdatedState(onSwipeRemove)
    fun offerUndo(restore: () -> Unit) {
        scope.launch {
            val result = snackbar.showSnackbar(removedLabel, undoLabel, duration = SnackbarDuration.Short)
            if (result == SnackbarResult.ActionPerformed) restore()
        }
    }

    LaunchedEffect(Unit) {
        val currentIdx = rows.indexOfFirst { it.entryId == currentEntry }
        if (currentIdx > 2) list.scrollToItem((currentIdx - 1).coerceAtLeast(0))
    }
    val currentOffscreen by remember(currentEntry, rows) {
        derivedStateOf {
            val idx = rows.indexOfFirst { it.entryId == currentEntry }
            idx >= 0 && list.layoutInfo.visibleItemsInfo.isNotEmpty() && list.layoutInfo.visibleItemsInfo.none { it.index == idx }
        }
    }

    // An external add/remove/replace cancels the gesture, rather than applying a stale index.
    LaunchedEffect(ids) { if (drag.entryId != null && drag.originalIds != ids) drag.cancel() }
    DisposableEffect(Unit) { onDispose { drag.cancel() } }
    LaunchedEffect(drag.entryId) {
        if (drag.entryId == null) return@LaunchedEffect
        var previous = System.nanoTime()
        while (drag.entryId != null) {
            delay(16)
            val frame = System.nanoTime()
            val elapsed = ((frame - previous) / 1_000_000_000f).coerceAtMost(.05f)
            previous = frame
            val layout = list.layoutInfo
            val zone = edge.coerceAtMost((layout.viewportEndOffset - layout.viewportStartOffset) / 3f)
            val direction = when {
                drag.pointerY < layout.viewportStartOffset + zone -> -((layout.viewportStartOffset + zone - drag.pointerY) / zone).coerceIn(0f, 1f)
                drag.pointerY > layout.viewportEndOffset - zone -> ((drag.pointerY - layout.viewportEndOffset + zone) / zone).coerceIn(0f, 1f)
                else -> 0f
            }
            if (direction != 0f) { list.scrollBy(direction * speed * elapsed); drag.reorder() }
        }
    }
    Box(modifier) {
    Column(Modifier.fillMaxSize()) {
        Row(headerModifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.queue_drag_hint), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
            }
            if (currentOffscreen) {
                TextButton({
                    val idx = rows.indexOfFirst { it.entryId == currentEntry }
                    if (idx >= 0) scope.launch { list.animateScrollToItem((idx - 1).coerceAtLeast(0)) }
                }, contentPadding = PaddingValues(horizontal = 8.dp)) { Text(stringResource(R.string.queue_locate_current), fontSize = 12.sp) }
            }
            if (onClear != null && rows.isNotEmpty()) {
                TextButton(onClear, contentPadding = PaddingValues(horizontal = 8.dp), modifier = Modifier.testTag("queue-clear")) {
                    Text(stringResource(R.string.clear), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (onClose != null) {
                IconButton(onClose) { Icon(Icons.Default.Close, stringResource(R.string.queue_close)) }
            }
        }
        LazyColumn(
            Modifier.weight(1f, fill = false).testTag("playback-queue")
                .onGloballyPositioned { coordinates = it }
                // Keeping the detector on the viewport avoids moving the gesture's coordinate system.
                .pointerInput(drag) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                        val id = handles.entries.firstOrNull { it.value.contains(down.position) }?.key
                            ?: return@awaitEachGesture
                        if (currentRows.size < 2) return@awaitEachGesture
                        val startIds = currentRows.map { it.entryId }
                        var change = down
                        // Claim a handle drag before the list or bottom sheet starts scrolling.
                        while (abs(change.position.y - down.position.y) <= viewConfiguration.touchSlop) {
                            change = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id }
                                ?: return@awaitEachGesture
                            if (change.isConsumed || !change.pressed) return@awaitEachGesture
                        }
                        change.consume()
                        if (!drag.start(id, currentRows, down.position.y)) return@awaitEachGesture
                        haptic(TactileKind.DragStart)
                        drag.move(change.position.y)
                        awaitPointerEvent(PointerEventPass.Final)
                        var dropped = false
                        try {
                            dropped = verticalDrag(change.id) { event -> drag.move(event.position.y); event.consume() }
                        } finally {
                            val destination = drag.destinationOf(id)
                            if (dropped && currentRows.map { it.entryId } == startIds && destination >= 0 && destination != startIds.indexOf(id)) {
                                move(id, destination)
                                haptic(TactileKind.DragEnd)
                            }
                            drag.cancel()
                        }
                    }
                },
            state = list, userScrollEnabled = drag.entryId == null,
            // Inset cards with a gap, like the podcast queue, so the list ends as a soft block above the gesture bar.
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 4.dp + bottomInset),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            itemsIndexed(drag.order ?: rows, key = { _, row -> row.entryId }) { index, row ->
                val active = drag.entryId == row.entryId
                val current = row.entryId == currentEntry
                val canSwipe = onSwipeRemove != null && allowRemove && !current && !active
                DisposableEffect(row.entryId) { onDispose { handles.remove(row.entryId) } }
                val rowModifier = Modifier.animateItem(placementSpec = if (active) null else androidx.compose.animation.core.spring())
                    .fillMaxWidth().zIndex(if (active) 1f else 0f)
                    .graphicsLayer {
                        translationY = if (active) drag.top - (list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == row.entryId }?.offset ?: 0) else 0f
                        shadowElevation = if (active) elevation else 0f
                        shape = RoundedCornerShape(12.dp)
                        clip = false
                    }
                val body = @Composable {
                    QueueChromeRow(
                        index = index,
                        title = row.title,
                        subtitle = row.artist,
                        current = current,
                        highlighted = active,
                        playing = playing,
                        buffering = buffering,
                        playEnabled = drag.entryId == null,
                        onPlay = { onPlay(row) },
                        rowTag = "queue-row-${row.entryId}",
                        handleTag = "queue-handle-${row.entryId}",
                        onHandlePositioned = { handle -> coordinates?.takeIf { it.isAttached && handle.isAttached }?.let { handles[row.entryId] = it.localBoundingBoxOf(handle, clipBounds = false) } },
                        dragLabel = resources.getString(R.string.queue_drag_named, row.title),
                        positionLabel = resources.getString(R.string.queue_position, index + 1, rows.size),
                        onMoveUp = if (index > 0) ({ haptic(TactileKind.Tap); move(row.entryId, index - 1) }) else null,
                        onMoveDown = if (index < rows.lastIndex) ({ haptic(TactileKind.Tap); move(row.entryId, index + 1) }) else null,
                        onRemove = if (allowRemove && !current) ({
                            haptic(TactileKind.Tap)
                            val restore = swipeRemove?.invoke(row)
                            if (swipeRemove != null) {
                                if (restore != null) offerUndo(restore)
                            } else onRemove(row)
                        }) else null,
                        showRemoveButton = allowRemove && onSwipeRemove == null,
                        onRemoveButton = { onRemove(row) },
                    )
                }
                if (onSwipeRemove != null && allowRemove) {
                    val canSwipeNow by rememberUpdatedState(canSwipe)
                    val rowNow by rememberUpdatedState(row)
                    val dismissState = rememberSwipeToDismissBoxState(confirmValueChange = { value ->
                        if (value != SwipeToDismissBoxValue.EndToStart || !canSwipeNow) false
                        else swipeRemove?.invoke(rowNow)?.also(::offerUndo) != null
                    })
                    SwipeToDismissBox(
                        state = dismissState,
                        modifier = rowModifier,
                        enableDismissFromStartToEnd = false,
                        enableDismissFromEndToStart = canSwipe,
                        gesturesEnabled = canSwipe,
                        backgroundContent = {
                            Box(
                                Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp))
                                    .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                                    .padding(horizontal = 20.dp),
                                contentAlignment = Alignment.CenterEnd,
                            ) {
                                Text(stringResource(R.string.queue_remove), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        },
                    ) { body() }
                } else {
                    Box(rowModifier) { body() }
                }
            }
        }
    }
    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(8.dp))
    }
}

@Composable
private fun QueueChromeRow(
    index: Int,
    title: String,
    subtitle: String,
    current: Boolean,
    highlighted: Boolean,
    playing: Boolean,
    buffering: Boolean,
    playEnabled: Boolean,
    onPlay: () -> Unit,
    rowTag: String,
    handleTag: String,
    onHandlePositioned: (LayoutCoordinates) -> Unit,
    dragLabel: String,
    positionLabel: String,
    onMoveUp: (() -> Unit)?,
    onMoveDown: (() -> Unit)?,
    onRemove: (() -> Unit)?,
    showRemoveButton: Boolean,
    onRemoveButton: () -> Unit,
    titleMaxLines: Int = 1,
) {
    val moveUpLabel = stringResource(R.string.queue_move_up)
    val moveDownLabel = stringResource(R.string.queue_move_down)
    val removeLabel = stringResource(R.string.queue_remove)
    // The swipe layer always draws 「移除」. A transparent or 8% tint lets that word show at rest
    // and sit under the drag handle, including on the playing row. The sheet behind a song queue
    // is surfaceContainerLow and the podcast dialog is surface, so the card uses the next step up.
    val card = MaterialTheme.colorScheme.surfaceContainer
    val rowFill = when {
        highlighted -> MaterialTheme.colorScheme.surfaceContainerHigh
        current -> MaterialTheme.colorScheme.primary.copy(alpha = .08f).compositeOver(card)
        else -> card
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(rowFill)
            .semantics { selected = current }
            .testTag(rowTag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.padding(start = 12.dp).width(28.dp), contentAlignment = Alignment.Center) {
            if (current) PlaybackIndicator(playing, buffering)
            else Text((index + 1).toString(), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
        }
        Column(Modifier.weight(1f).clickable(enabled = playEnabled, interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onPlay).padding(vertical = 12.dp, horizontal = 8.dp)) {
            Text(title, color = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, maxLines = titleMaxLines, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotBlank()) Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.size(48.dp).testTag(handleTag)
            .onGloballyPositioned(onHandlePositioned)
            .semantics {
                contentDescription = dragLabel
                stateDescription = positionLabel
                customActions = buildList {
                    if (onMoveUp != null) add(CustomAccessibilityAction(moveUpLabel) { onMoveUp(); true })
                    if (onMoveDown != null) add(CustomAccessibilityAction(moveDownLabel) { onMoveDown(); true })
                    if (onRemove != null) add(CustomAccessibilityAction(removeLabel) { onRemove(); true })
                }
            }, contentAlignment = Alignment.Center) {
            Icon(Icons.Default.Menu, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (showRemoveButton) IconButton(onRemoveButton, enabled = playEnabled) { Icon(Icons.Default.Close, stringResource(R.string.remove_named, title)) }
    }
}

@Composable
internal fun PodcastQueueFullNote(modifier: Modifier = Modifier) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = modifier.fillMaxWidth().testTag("podcast-queue-full"),
    ) {
        Text(
            stringResource(R.string.podcast_queue_full),
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * Handle-drag state shared by the music and podcast queues. It reorders rows locally by their stable id;
 * the caller persists the new order once, after the drop.
 */
private class QueueDragState<T>(private val list: LazyListState, private val key: (T) -> String) {
    var entryId by mutableStateOf<String?>(null)
        private set
    var order by mutableStateOf<List<T>?>(null)
        private set
    var top by mutableFloatStateOf(0f)
        private set
    var pointerY by mutableFloatStateOf(0f)
        private set
    var originalIds: List<String> = emptyList()
        private set
    private var grabOffset = 0f
    private var height = 0

    /** Index of [id] in the dragged order, or -1 when it would not move. */
    fun destinationOf(id: String): Int = order?.indexOfFirst { key(it) == id } ?: -1

    fun start(id: String, rows: List<T>, y: Float): Boolean {
        val item = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == id } ?: return false
        originalIds = rows.map(key)
        order = rows; top = item.offset.toFloat(); pointerY = y
        grabOffset = y - item.offset; height = item.size; entryId = id
        return true
    }
    fun move(y: Float) {
        if (entryId == null) return
        pointerY = y
        val layout = list.layoutInfo
        top = (y - grabOffset).coerceIn(layout.viewportStartOffset.toFloat(), (layout.viewportEndOffset - height).toFloat().coerceAtLeast(layout.viewportStartOffset.toFloat()))
        reorder()
    }
    fun reorder() {
        val rows = order ?: return
        // Resolve positions by row key: a list may interleave items that are not part of [order].
        val positions = rows.withIndex().associate { (index, row) -> key(row) to index }
        val from = positions[entryId] ?: return
        val center = top + height / 2f
        val target = list.layoutInfo.visibleItemsInfo.mapNotNull { info ->
            val index = positions[info.key] ?: return@mapNotNull null
            val middle = info.offset + info.size / 2f
            when {
                index > from && center >= middle -> index to info
                index < from && center <= middle -> index to info
                else -> null
            }
        }.minByOrNull { abs(center - (it.second.offset + it.second.size / 2f)) } ?: return
        val first = list.firstVisibleItemIndex
        val offset = list.firstVisibleItemScrollOffset
        order = rows.toMutableList().apply { add(target.first, removeAt(from)) }
        // Stable keys normally anchor the first item; moving that item must not scroll the viewport.
        list.requestScrollToItem(first, offset)
    }
    fun cancel() { entryId = null; order = null }
}
