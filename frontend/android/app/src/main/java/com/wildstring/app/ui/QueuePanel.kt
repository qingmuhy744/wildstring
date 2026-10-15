package com.wildstring.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
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
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlin.math.abs
import kotlinx.coroutines.delay

@Composable
internal fun QueuePanel(vm: MusicViewModel, state: MusicState, modifier: Modifier) {
    val tick = tactile(vm) {}
    QueueList(state.queue, state.entryId, modifier,
        onPlay = { vm.playQueue(it.index) },
        onRemove = { tick(); vm.removeQueue(it.index) },
        onMove = vm::moveQueue, onHaptic = tick)
}

/** Only the handle starts a reorder; the rest of the row keeps ordinary tap/scroll behavior. */
@Composable
internal fun QueueList(
    rows: List<QueueRow>, currentEntry: String?, modifier: Modifier = Modifier,
    onPlay: (QueueRow) -> Unit, onRemove: (QueueRow) -> Unit,
    onMove: (String, Int) -> Unit, onHaptic: () -> Unit,
) {
    val list = rememberLazyListState()
    val drag = remember(list) { QueueDragState(list) }
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
    Column(modifier) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("播放队列 · ${rows.size}", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            Text("拖动排序", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
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
                        haptic()
                        drag.move(change.position.y)
                        awaitPointerEvent(PointerEventPass.Final)
                        var dropped = false
                        try {
                            dropped = verticalDrag(change.id) { event -> drag.move(event.position.y); event.consume() }
                        } finally {
                            val destination = drag.order?.indexOfFirst { it.entryId == id } ?: -1
                            if (dropped && currentRows.map { it.entryId } == startIds && destination >= 0 && destination != startIds.indexOf(id)) {
                                move(id, destination)
                                haptic()
                            }
                            drag.cancel()
                        }
                    }
                },
            state = list, userScrollEnabled = drag.entryId == null,
        ) {
            itemsIndexed(drag.order ?: rows, key = { _, row -> row.entryId }) { index, row ->
                val active = drag.entryId == row.entryId
                DisposableEffect(row.entryId) { onDispose { handles.remove(row.entryId) } }
                Row(
                    Modifier.animateItem(placementSpec = if (active) null else androidx.compose.animation.core.spring())
                        .fillMaxWidth().heightIn(min = 64.dp).zIndex(if (active) 1f else 0f)
                        .graphicsLayer {
                            translationY = if (active) drag.top - (list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == row.entryId }?.offset ?: 0) else 0f
                            shadowElevation = if (active) elevation else 0f
                            shape = RoundedCornerShape(12.dp)
                        }
                        .clip(RoundedCornerShape(12.dp))
                        .background(if (active) MaterialTheme.colorScheme.surfaceContainerHigh else androidx.compose.ui.graphics.Color.Transparent)
                        .testTag("queue-row-${row.entryId}"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f).clickable(enabled = drag.entryId == null) { onPlay(row) }.padding(vertical = 12.dp, horizontal = 16.dp)) {
                        Text(row.title, color = if (row.entryId == currentEntry) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(row.artist, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Box(Modifier.size(48.dp).testTag("queue-handle-${row.entryId}")
                        .onGloballyPositioned { handle -> coordinates?.takeIf { it.isAttached && handle.isAttached }?.let { handles[row.entryId] = it.localBoundingBoxOf(handle, clipBounds = false) } }
                        .semantics {
                            contentDescription = "拖动排序：${row.title}"
                            stateDescription = "第 ${index + 1} 首，共 ${rows.size} 首"
                            customActions = buildList {
                                if (index > 0) add(CustomAccessibilityAction("向前移动") { haptic(); move(row.entryId, index - 1); true })
                                if (index < rows.lastIndex) add(CustomAccessibilityAction("向后移动") { haptic(); move(row.entryId, index + 1); true })
                            }
                        }, contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.Menu, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton({ onRemove(row) }, enabled = drag.entryId == null) { Icon(Icons.Default.Close, "移除${row.title}") }
                }
            }
        }
    }
}

private class QueueDragState(private val list: LazyListState) {
    var entryId by mutableStateOf<String?>(null)
        private set
    var order by mutableStateOf<List<QueueRow>?>(null)
        private set
    var top by mutableFloatStateOf(0f)
        private set
    var pointerY by mutableFloatStateOf(0f)
        private set
    var originalIds: List<String> = emptyList()
        private set
    private var grabOffset = 0f
    private var height = 0

    fun start(id: String, rows: List<QueueRow>, y: Float): Boolean {
        val item = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == id } ?: return false
        originalIds = rows.map { it.entryId }
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
        val from = rows.indexOfFirst { it.entryId == entryId }
        if (from < 0) return
        val center = top + height / 2f
        val candidates = list.layoutInfo.visibleItemsInfo.filter { it.key != entryId &&
            ((it.index > from && center >= it.offset + it.size / 2f) || (it.index < from && center <= it.offset + it.size / 2f)) }
        val target = candidates.minByOrNull { abs(center - (it.offset + it.size / 2f)) } ?: return
        val first = list.firstVisibleItemIndex
        val offset = list.firstVisibleItemScrollOffset
        order = rows.toMutableList().apply { add(target.index, removeAt(from)) }
        // Stable keys normally anchor the first item; moving that item must not scroll the viewport.
        list.requestScrollToItem(first, offset)
    }
    fun cancel() { entryId = null; order = null }
}
