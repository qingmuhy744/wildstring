package com.wildstring.app

import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import com.wildstring.app.ui.QueueList
import com.wildstring.app.ui.QueueRow
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class QueueReorderTest {
    @get:Rule val compose = createComposeRule()
    private val initial = (0..15).map { QueueRow("entry-$it", "same-track", "重复曲目", "测试艺人", it) }
    private val rows = mutableStateOf(initial)
    private val moves = mutableListOf<Pair<String, Int>>()
    private var plays = 0
    private var haptics = 0

    private fun show() {
        compose.setContent {
            MaterialTheme {
                QueueList(rows.value, "entry-0", Modifier.width(360.dp).height(360.dp),
                    onPlay = { plays++ }, onRemove = {}, onHaptic = { haptics++ },
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
            assertEquals(2, haptics)
            assertEquals(0, plays)
        }
        val again = point("queue-handle-entry-0")
        val top = point("queue-handle-entry-1")
        queue.performTouchInput { down(again); moveTo(top, delayMillis = 200) }
        queue.performTouchInput { cancel() }
        compose.runOnIdle { assertEquals(1, moves.size); assertEquals("entry-0", rows.value[2].entryId) }
        val actions = compose.onNodeWithTag("queue-handle-entry-0").fetchSemanticsNode().config[SemanticsActions.CustomActions]
        compose.runOnIdle { assertTrue(actions.first { it.label == "向前移动" }.action()) }
        compose.runOnIdle { assertEquals("entry-0", rows.value[1].entryId) }
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
}
