package com.wildstring.app

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import com.wildstring.app.ui.QueueList
import com.wildstring.app.ui.QueueRow
import com.wildstring.app.ui.PodcastQueueRow
import com.wildstring.app.ui.PodcastQueueRows
import com.wildstring.app.ui.TactileKind
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class QueueReorderTest {
    @get:Rule val compose = createComposeRule()
    private val initial = (0..15).map { QueueRow("entry-$it", "same-track", "重复曲目", "测试艺人", it) }
    private val rows = mutableStateOf(initial)
    private val moves = mutableListOf<Pair<String, Int>>()
    private var plays = 0
    private val haptics = mutableListOf<TactileKind>()

    private fun show() {
        compose.setContent {
            MaterialTheme {
                QueueList(rows.value, "entry-0", Modifier.width(360.dp).height(360.dp),
                    onPlay = { plays++ }, onRemove = {}, onHaptic = { haptics += it },
                    onMove = { id, to ->
                        moves += id to to
                        rows.value = rows.value.toMutableList().apply { add(to, removeAt(indexOfFirst { it.entryId == id })) }
                    })
            }
        }
    }
    private fun point(tag: String): Offset {
        val viewport = compose.onNodeWithTag("playback-queue").fetchSemanticsNode().boundsInRoot
        val handle = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot
        return handle.center - viewport.topLeft
    }
    @Test fun handleMovesOneEntryOnDropAndCancelKeepsOrder() {
        show()
        val start = point("queue-handle-entry-0")
        val end = point("queue-handle-entry-2")
        val queue = compose.onNodeWithTag("playback-queue")
        queue.performTouchInput { down(start); moveTo(start + Offset(0f, 30f), delayMillis = 80); moveTo(end, delayMillis = 160) }
        compose.runOnIdle { assertTrue("Dragging must not repeatedly update the player", moves.isEmpty()) }
        queue.performTouchInput { up() }
        compose.runOnIdle {
            assertEquals(listOf("entry-1", "entry-2", "entry-0"), rows.value.take(3).map { it.entryId })
            assertEquals(listOf("entry-0" to 2), moves)
            assertEquals(listOf(TactileKind.DragStart, TactileKind.DragEnd), haptics)
            assertEquals(0, plays)
        }
        val again = point("queue-handle-entry-0")
        val top = point("queue-handle-entry-1")
        queue.performTouchInput { down(again); moveTo(top, delayMillis = 200) }
        queue.performTouchInput { cancel() }
        compose.runOnIdle { assertEquals(1, moves.size); assertEquals("entry-0", rows.value[2].entryId)
            assertEquals(listOf(TactileKind.DragStart, TactileKind.DragEnd, TactileKind.DragStart), haptics) }
        val actions = compose.onNodeWithTag("queue-handle-entry-0").fetchSemanticsNode().config[SemanticsActions.CustomActions]
        compose.runOnIdle { assertTrue(actions.first { it.label == uiString(R.string.queue_move_up) }.action()) }
        compose.runOnIdle { assertEquals("entry-0", rows.value[1].entryId) }
    }
    @Test fun swipeRemovalWaitsForReleaseAndUndoRestoresOriginalPosition() {
        val removed = mutableListOf<QueueRow>()
        val rows = mutableStateOf(initial.take(3))
        compose.setContent {
            MaterialTheme {
                QueueList(
                    rows.value,
                    "entry-0",
                    Modifier.width(360.dp).height(360.dp),
                    onPlay = {},
                    onRemove = {},
                    onHaptic = {},
                    onSwipeRemove = { row ->
                        val originalIndex = rows.value.indexOfFirst { it.entryId == row.entryId }
                        removed += row
                        rows.value = rows.value.toMutableList().apply { removeAt(originalIndex) }
                        ({ rows.value = rows.value.toMutableList().apply { add(originalIndex, row) } })
                    },
                    onMove = { _, _ -> },
                )
            }
        }
        val queue = compose.onNodeWithTag("playback-queue")
        val viewport = queue.fetchSemanticsNode().boundsInRoot
        val bounds = compose.onNodeWithTag("queue-row-entry-1").fetchSemanticsNode().boundsInRoot
        val start = bounds.center - viewport.topLeft
        queue.performTouchInput {
            down(start)
            moveTo(Offset(start.x - bounds.width * 1.1f, start.y), delayMillis = 400)
        }
        compose.runOnIdle { assertTrue("Holding a swipe must not remove the row", removed.isEmpty()) }
        queue.performTouchInput { moveTo(start, delayMillis = 400); up() }
        compose.waitForIdle()
        compose.runOnIdle { assertTrue("Returning before release must not remove the row", removed.isEmpty()) }
        queue.performTouchInput {
            down(start)
            moveTo(Offset(start.x - bounds.width * 1.1f, start.y), delayMillis = 400)
        }
        compose.runOnIdle { assertTrue("Holding a swipe must not remove the row", removed.isEmpty()) }
        queue.performTouchInput { up() }
        compose.waitUntil(5_000) { compose.runOnIdle { removed.size == 1 } }
        compose.onNodeWithText(uiString(R.string.queue_undo), substring = false).performClick()
        compose.waitUntil(5_000) { compose.runOnIdle { rows.value.map { it.entryId } == listOf("entry-0", "entry-1", "entry-2") } }
        val restored = compose.onNodeWithTag("queue-row-entry-1").fetchSemanticsNode().boundsInRoot
        val neighbor = compose.onNodeWithTag("queue-row-entry-2").fetchSemanticsNode().boundsInRoot
        assertEquals("Undo must reset the dismissed offset", neighbor.left, restored.left, 1f)
    }
    @Test fun undoBeforeQueueUpdateResetsSwipeAndAllowsAnotherRemoval() {
        var removals = 0
        var undos = 0
        compose.setContent {
            MaterialTheme {
                QueueList(
                    initial.take(3), "entry-0", Modifier.width(360.dp).height(360.dp),
                    onPlay = {}, onRemove = {}, onHaptic = {}, onMove = { _, _ -> },
                    // Model a MediaController timeline update that has not reached the UI yet.
                    onSwipeRemove = { removals++; { undos++ } },
                )
            }
        }
        val queue = compose.onNodeWithTag("playback-queue")
        fun holdAtRemovalEdge(expectedRemovals: Int) {
            val viewport = queue.fetchSemanticsNode().boundsInRoot
            val row = compose.onNodeWithTag("queue-row-entry-1").fetchSemanticsNode().boundsInRoot
            val start = row.center - viewport.topLeft
            queue.performTouchInput {
                down(start)
                moveTo(Offset(start.x - row.width * 1.1f, start.y), delayMillis = 400)
            }
            compose.runOnIdle { assertEquals("Holding the swipe must not remove a row", expectedRemovals, removals) }
        }
        holdAtRemovalEdge(0)
        queue.performTouchInput { up() }
        compose.waitUntil(5_000) { compose.runOnIdle { removals == 1 } }
        compose.onNodeWithText(uiString(R.string.queue_undo), substring = false).performClick()
        compose.waitUntil(5_000) { compose.runOnIdle { undos == 1 } }
        val restored = compose.onNodeWithTag("queue-row-entry-1").fetchSemanticsNode().boundsInRoot
        val neighbor = compose.onNodeWithTag("queue-row-entry-2").fetchSemanticsNode().boundsInRoot
        assertEquals("Undo must clear the swipe offset even before the queue refreshes", neighbor.left, restored.left, 1f)
        compose.runOnIdle { assertEquals("Undo must not dismiss the restored row again", 1, removals) }
        holdAtRemovalEdge(1)
        queue.performTouchInput { up() }
        compose.waitUntil(5_000) { compose.runOnIdle { removals == 2 } }
    }

    @Test fun podcastUndoBeforeQueueUpdateResetsSwipe() {
        val episodes = listOf(
            PodcastQueueRow("episode-1", "show", "单集一", "测试节目"),
            PodcastQueueRow("episode-2", "show", "单集二", "测试节目"),
        )
        var removals = 0
        var undos = 0
        compose.setContent {
            MaterialTheme {
                PodcastQueueRows(
                    rows = episodes, currentEpisodeId = "episode-1", playing = false, buffering = false,
                    onPlay = {}, onRemove = { removals++ }, onRestore = { _, _ -> undos++ }, onReorder = {},
                    modifier = Modifier.width(360.dp).height(260.dp),
                )
            }
        }
        val queue = compose.onNodeWithTag("podcast-queue-list")
        val viewport = queue.fetchSemanticsNode().boundsInRoot
        val row = compose.onNodeWithTag("podcast-queue-row-episode-2").fetchSemanticsNode().boundsInRoot
        val start = row.center - viewport.topLeft
        queue.performTouchInput {
            down(start)
            moveTo(Offset(start.x - row.width * 1.1f, start.y), delayMillis = 400)
        }
        compose.runOnIdle { assertEquals("Holding a podcast swipe must not remove a row", 0, removals) }
        queue.performTouchInput { up() }
        compose.waitUntil(5_000) { compose.runOnIdle { removals == 1 } }
        compose.onNodeWithText(uiString(R.string.queue_undo), substring = false).performClick()
        compose.waitUntil(5_000) { compose.runOnIdle { undos == 1 } }
        val restored = compose.onNodeWithTag("podcast-queue-row-episode-2").fetchSemanticsNode().boundsInRoot
        val neighbor = compose.onNodeWithTag("podcast-queue-row-episode-1").fetchSemanticsNode().boundsInRoot
        assertEquals("Podcast undo must clear the swipe offset", neighbor.left, restored.left, 1f)
        compose.runOnIdle { assertEquals("Podcast undo must not dismiss the row again", 1, removals) }
    }

    @Test fun edgeScrollReachesOffscreenRowsAndExternalChangeCancelsDrop() {
        show()
        val queue = compose.onNodeWithTag("playback-queue")
        val start = point("queue-handle-entry-0")
        val bounds = queue.fetchSemanticsNode().boundsInRoot
        queue.performTouchInput { down(start); moveTo(Offset(start.x, bounds.height - 4f), delayMillis = 400) }
        compose.waitUntil(8_000) {
            runCatching { compose.onNodeWithTag("queue-handle-entry-9").assertIsDisplayed() }.isSuccess
        }
        queue.performTouchInput { up() }
        compose.runOnIdle {
            assertEquals(1, moves.size)
            assertTrue("Holding the edge should move past the original viewport", moves.single().second >= 7)
            assertEquals(16, rows.value.map { it.entryId }.toSet().size)
            assertEquals(0, plays)
        }
        // Auto-scroll can continue between the visibility check and release. Bring the
        // next handle into view explicitly before testing an external queue change.
        compose.onNodeWithTag("queue-handle-entry-9").performScrollTo().assertIsDisplayed()
        val next = point("queue-handle-entry-9")
        queue.performTouchInput { down(next); moveBy(Offset(0f, -40f), delayMillis = 100) }
        compose.runOnIdle { rows.value = rows.value.dropLast(1) }
        queue.performTouchInput { up() }
        compose.runOnIdle { assertEquals("A changed queue must reject a stale drop", 1, moves.size) }
    }

    @Test fun podcastQueueCardsAlignWithDialogContent() {
        val initialRows = listOf(
            PodcastQueueRow("episode-1", "show", "单集一", "测试节目"),
            PodcastQueueRow("episode-2", "show", "单集二", "测试节目"),
        )
        val rows = mutableStateOf(initialRows)
        val reordered = mutableListOf<String>()
        compose.setContent {
            MaterialTheme {
                androidx.compose.foundation.layout.Column(Modifier.width(360.dp).padding(16.dp)) {
                    androidx.compose.foundation.layout.Box(Modifier.fillMaxWidth().height(48.dp).testTag("queue-dialog-tabs"))
                    PodcastQueueRows(
                        rows = rows.value,
                        currentEpisodeId = null,
                        playing = false,
                        buffering = false,
                        onPlay = {},
                        onRemove = {},
                        onRestore = { _, _ -> },
                        onReorder = { ordered ->
                            reordered += ordered.map { it.episodeId }
                            rows.value = ordered
                        },
                        modifier = Modifier.fillMaxWidth().height(200.dp),
                        horizontalContentPadding = 0.dp,
                    )
                }
            }
        }

        val tabs = compose.onNodeWithTag("queue-dialog-tabs").fetchSemanticsNode().boundsInRoot
        val firstRow = compose.onNodeWithTag("podcast-queue-row-episode-1").fetchSemanticsNode().boundsInRoot
        compose.runOnIdle {
            assertEquals(tabs.left, firstRow.left, 0.5f)
            assertEquals(tabs.right, firstRow.right, 0.5f)
        }

        val list = compose.onNodeWithTag("podcast-queue-list")
        val listBounds = list.fetchSemanticsNode().boundsInRoot
        val start = compose.onNodeWithTag("podcast-queue-handle-episode-1").fetchSemanticsNode().boundsInRoot.center - listBounds.topLeft
        val end = compose.onNodeWithTag("podcast-queue-handle-episode-2").fetchSemanticsNode().boundsInRoot.center - listBounds.topLeft
        list.performTouchInput {
            down(start)
            moveTo(start + Offset(0f, 24f), delayMillis = 100)
            moveTo(end, delayMillis = 200)
            up()
        }
        compose.runOnIdle {
            assertEquals(listOf("episode-2", "episode-1"), rows.value.map { it.episodeId })
            assertEquals(listOf("episode-2", "episode-1"), reordered)
        }
    }
}
