package com.wildstring.app

import android.graphics.Bitmap
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.ui.BookReaderChrome
import com.wildstring.app.ui.BookReaderPanel
import com.wildstring.app.ui.BookReaderToolbar
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class BookReaderPanelMotionTest {
    @get:Rule val compose = createComposeRule()

    private data class Frame(val time: Int, val stage: Rect, val button: Rect, val panel: Rect?, val changedPixels: Int)

    @Test fun overlaysMoveWithoutReflowAndReducedMotionSnaps() {
        val visible = mutableStateOf(false)
        val tools = mutableStateOf(false)
        val animate = mutableStateOf(true)
        val injectedOffset = mutableStateOf(0)
        val inject = InstrumentationRegistry.getArguments().getString("injectBookPanelJump") == "true"
        compose.setContent {
            MaterialTheme {
                Box(Modifier.fillMaxSize()) {
                    Column(Modifier.fillMaxSize().testTag("stage")) {
                        TextButton(onClick = { visible.value = true }, modifier = Modifier.testTag("open")) { Text("Open") }
                        TextButton(onClick = { tools.value = !tools.value }, modifier = Modifier.testTag("toggle-tools")) {
                            Text("Tools")
                        }
                        Text("A chapter stays on the same line while its contents are open.")
                    }
                    Box(Modifier.matchParentSize().padding(top = 160.dp)) {
                        BookReaderToolbar(tools.value, animate.value, close = { tools.value = false }) {
                            TextButton(onClick = {}) { Text("Bookmarks") }
                        }
                    }
                    Box(Modifier.matchParentSize().offset { IntOffset(injectedOffset.value, 0) }) {
                        BookReaderPanel(visible.value, wide = true, animate = animate.value,
                            title = "Contents", close = { visible.value = false }) {
                            Text("Chapter 1")
                        }
                    }
                }
            }
        }

        fun bounds(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().firstOrNull()?.boundsInRoot
        fun frames(count: Int, capture: Boolean = false, overlayTag: String = "book-reader-panel"): List<Frame> = buildList {
            var previous: Bitmap? = null
            repeat(count) { index ->
                if (inject && capture && index in 5..6) {
                    compose.runOnUiThread { injectedOffset.value = if (index == 5) -120 else 0 }
                }
                compose.mainClock.advanceTimeByFrame()
                val panel = bounds(overlayTag)
                val bitmap = if (panel != null && capture) compose.onNodeWithTag(overlayTag)
                    .captureToImage().asAndroidBitmap().copy(Bitmap.Config.ARGB_8888, false) else null
                val before = previous
                val changed = if (before == null || bitmap == null || before.width != bitmap.width || before.height != bitmap.height) -1
                    else if (before.sameAs(bitmap)) 0 else 1
                add(Frame((index + 1) * 16, checkNotNull(bounds("stage")), checkNotNull(bounds("open")), panel, changed))
                before?.recycle()
                previous = bitmap
            }
            previous?.recycle()
        }

        try {
            val stage = bounds("stage")
            val button = bounds("open")
            compose.mainClock.autoAdvance = false
            compose.onNodeWithTag("open").performClick()
            val opened = frames(25, capture = true)
            val floating = opened.filter { it.panel != null }
            val left = floating.map { it.panel!!.left }
            assertTrue("The panel must travel across multiple frames", left.size > 10 && abs(left.last() - left.first()) >= MotionAssertions.MIN_TRAVEL_PX)
            val problems = MotionAssertions.continuousCurve("drawer left on entry", left) +
                MotionAssertions.landsAndStays("drawer", floating.map { it.time }, left,
                    floating.map { it.changedPixels }, settleMs = 300)
            assertTrue(problems.joinToString("\n"), problems.isEmpty())
            assertTrue(opened.all { it.stage == stage && it.button == button })

            compose.onNodeWithText(uiString(R.string.books_close)).performClick()
            val closed = frames(25)
            val closing = closed.mapNotNull { it.panel?.left }
            assertTrue("The panel must visibly travel on exit", closing.size > 5 && abs(closing.last() - closing.first()) >= MotionAssertions.MIN_TRAVEL_PX)
            val exit = MotionAssertions.continuousCurve("drawer left on exit", closing)
            assertTrue(exit.joinToString("\n"), exit.isEmpty())
            assertTrue(closed.filter { it.time >= 300 }.all { it.panel == null })
            assertTrue(closed.all { it.stage == stage && it.button == button })

            compose.runOnUiThread { animate.value = false }
            compose.mainClock.advanceTimeByFrame()
            compose.onNodeWithTag("open").performClick()
            val reduced = frames(10)
            val landed = checkNotNull(reduced.first().panel)
            assertEquals(floating.last().panel, landed)
            assertTrue(reduced.all { it.panel == landed && it.stage == stage && it.button == button })
            compose.onNodeWithText(uiString(R.string.books_close)).performClick()
            assertTrue(frames(1).single().panel == null)

            val toolTag = "book-reader-tools"
            val toolButton = compose.onNodeWithTag("toggle-tools")
            compose.runOnUiThread { animate.value = true }
            compose.mainClock.advanceTimeByFrame()
            toolButton.performClick()
            val toolEntrance = frames(25, capture = true, overlayTag = toolTag)
            val visibleTools = toolEntrance.filter { it.panel != null }
            val tops = visibleTools.map { it.panel!!.top }
            assertTrue(tops.size > 10 && abs(tops.last() - tops.first()) >= MotionAssertions.MIN_TRAVEL_PX)
            val toolProblems = MotionAssertions.continuousCurve("toolbar top on entry", tops) +
                MotionAssertions.landsAndStays("toolbar", visibleTools.map { it.time }, tops,
                    visibleTools.map { it.changedPixels }, settleMs = 300)
            assertTrue(toolProblems.joinToString("\n"), toolProblems.isEmpty())
            assertTrue(toolEntrance.all { it.stage == stage && it.button == button })

            toolButton.performClick()
            val toolExit = frames(25, overlayTag = toolTag)
            val exitTops = toolExit.mapNotNull { it.panel?.top }
            assertTrue(exitTops.size > 5 && abs(exitTops.last() - exitTops.first()) >= MotionAssertions.MIN_TRAVEL_PX)
            assertTrue(MotionAssertions.continuousCurve("toolbar top on exit", exitTops).isEmpty())
            assertTrue(toolExit.filter { it.time >= 300 }.all { it.panel == null && it.stage == stage && it.button == button })

            // Tapping blank space outside the toolbar must also dismiss it cleanly without reflow.
            toolButton.performClick()
            frames(25, overlayTag = toolTag)
            compose.onNodeWithTag("book-reader-tools-backdrop").performTouchInput {
                click(Offset(centerX, bottom - 24f))
            }
            val backdropExit = frames(25, overlayTag = toolTag)
            val backdropTops = backdropExit.mapNotNull { it.panel?.top }
            assertTrue(backdropTops.size > 5 && abs(backdropTops.last() - backdropTops.first()) >= MotionAssertions.MIN_TRAVEL_PX)
            assertTrue(MotionAssertions.continuousCurve("toolbar backdrop dismiss", backdropTops).isEmpty())
            assertTrue(backdropExit.filter { it.time >= 300 }.all { it.panel == null && it.stage == stage && it.button == button })

            compose.runOnUiThread { animate.value = false }
            compose.mainClock.advanceTimeByFrame()
            toolButton.performClick()
            val stillTools = frames(8, overlayTag = toolTag)
            assertTrue(stillTools.all { it.panel == visibleTools.last().panel && it.stage == stage && it.button == button })
            toolButton.performClick()
            assertTrue(frames(1, overlayTag = toolTag).single().panel == null)
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    @Test fun immersiveChromeMovesWithoutReflowAndReducedMotionSnaps() {
        val visible = mutableStateOf(false)
        val showBottom = mutableStateOf(true)
        val animate = mutableStateOf(true)
        val injectedOffset = mutableStateOf(0)
        val inject = InstrumentationRegistry.getArguments().getString("injectBookPanelJump") == "true"
        compose.setContent {
            MaterialTheme {
                Box(Modifier.fillMaxSize()) {
                    Column(Modifier.fillMaxSize().testTag("stage")) {
                        TextButton(onClick = { visible.value = !visible.value }, modifier = Modifier.testTag("toggle-chrome")) {
                            Text("Toggle")
                        }
                        TextButton(onClick = { showBottom.value = !showBottom.value }, modifier = Modifier.testTag("toggle-audio-bar")) {
                            Text("Audio")
                        }
                        Text("Body height never changes when reader chrome or companion audio enters or leaves.")
                    }
                    Box(Modifier.matchParentSize().padding(top = 96.dp, bottom = 40.dp).offset { IntOffset(0, injectedOffset.value) }) {
                        BookReaderChrome(
                            visible = visible.value,
                            animate = animate.value,
                            showBottomBar = showBottom.value,
                            topBar = {
                                Row(Modifier.fillMaxWidth().padding(8.dp)) {
                                    Text("Chapter 1")
                                }
                            },
                            bottomBar = {
                                Row(Modifier.fillMaxWidth().padding(8.dp)) {
                                    Text("Companion 00:12 / 05:00")
                                }
                            },
                        )
                    }
                }
            }
        }

        val topTag = "book-reader-top-bar"
        val bottomTag = "book-reader-bottom-bar"
        fun bounds(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().firstOrNull()?.boundsInRoot
        fun frames(count: Int, capture: Boolean = false): List<Pair<Frame, Rect?>> = buildList {
            var previous: Bitmap? = null
            repeat(count) { index ->
                if (inject && capture && index in 5..6) {
                    compose.runOnUiThread { injectedOffset.value = if (index == 5) -120 else 0 }
                }
                compose.mainClock.advanceTimeByFrame()
                val top = bounds(topTag)
                val bottom = bounds(bottomTag)
                val bitmap = if (top != null && capture) compose.onNodeWithTag(topTag)
                    .captureToImage().asAndroidBitmap().copy(Bitmap.Config.ARGB_8888, false) else null
                val before = previous
                val changed = if (before == null || bitmap == null || before.width != bitmap.width || before.height != bitmap.height) -1
                    else if (before.sameAs(bitmap)) 0 else 1
                add(Frame((index + 1) * 16, checkNotNull(bounds("stage")), checkNotNull(bounds("toggle-chrome")), top, changed) to bottom)
                before?.recycle()
                previous = bitmap
            }
            previous?.recycle()
        }

        try {
            val stage = bounds("stage")
            val button = bounds("toggle-chrome")
            compose.mainClock.autoAdvance = false
            compose.onNodeWithTag("toggle-chrome").performClick()
            val entry = frames(25, capture = true)
            val entryFrames = entry.map { it.first }
            val visibleTop = entryFrames.filter { it.panel != null }
            val topEdges = visibleTop.map { it.panel!!.top }
            val bottomEdges = entry.mapNotNull { it.second?.top }
            assertTrue("Top bar must travel across multiple frames", topEdges.size > 10 && abs(topEdges.last() - topEdges.first()) >= MotionAssertions.MIN_TRAVEL_PX)
            assertTrue("Bottom bar must travel across multiple frames", bottomEdges.size > 10 && abs(bottomEdges.last() - bottomEdges.first()) >= MotionAssertions.MIN_TRAVEL_PX)
            val problems = MotionAssertions.continuousCurve("chrome top on entry", topEdges) +
                MotionAssertions.continuousCurve("chrome bottom on entry", bottomEdges) +
                MotionAssertions.landsAndStays("chrome top", visibleTop.map { it.time }, topEdges,
                    visibleTop.map { it.changedPixels }, settleMs = 300)
            assertTrue(problems.joinToString("\n"), problems.isEmpty())
            assertTrue(entryFrames.all { it.stage == stage && it.button == button })

            // Hide companion bar independently while keeping top bar visible.
            compose.onNodeWithTag("toggle-audio-bar").performClick()
            val hideAudio = frames(25)
            val hideAudioEdges = hideAudio.mapNotNull { it.second?.top }
            assertTrue("Companion bar must visibly travel on independent exit", hideAudioEdges.size > 5 && abs(hideAudioEdges.last() - hideAudioEdges.first()) >= MotionAssertions.MIN_TRAVEL_PX)
            assertTrue(MotionAssertions.continuousCurve("companion bottom on hide", hideAudioEdges).isEmpty())
            assertTrue(hideAudio.all { it.first.panel == visibleTop.last().panel && it.first.stage == stage && it.first.button == button })
            assertTrue(hideAudio.filter { it.first.time >= 300 }.all { it.second == null })

            // Show companion bar independently while top bar stays stationary.
            compose.onNodeWithTag("toggle-audio-bar").performClick()
            val showAudio = frames(25)
            val showAudioEdges = showAudio.mapNotNull { it.second?.top }
            assertTrue("Companion bar must visibly travel on independent entry", showAudioEdges.size > 10 && abs(showAudioEdges.last() - showAudioEdges.first()) >= MotionAssertions.MIN_TRAVEL_PX)
            assertTrue(MotionAssertions.continuousCurve("companion bottom on show", showAudioEdges).isEmpty())
            assertTrue(showAudio.all { it.first.panel == visibleTop.last().panel && it.first.stage == stage && it.first.button == button })

            compose.onNodeWithTag("toggle-chrome").performClick()
            val exit = frames(25)
            val exitFrames = exit.map { it.first }
            val exitTopEdges = exitFrames.mapNotNull { it.panel?.top }
            val exitBottomEdges = exit.mapNotNull { it.second?.top }
            assertTrue("Top bar must visibly travel on exit", exitTopEdges.size > 5 && abs(exitTopEdges.last() - exitTopEdges.first()) >= MotionAssertions.MIN_TRAVEL_PX)
            assertTrue("Bottom bar must visibly travel on exit", exitBottomEdges.size > 5 && abs(exitBottomEdges.last() - exitBottomEdges.first()) >= MotionAssertions.MIN_TRAVEL_PX)
            assertTrue(MotionAssertions.continuousCurve("chrome top on exit", exitTopEdges).isEmpty())
            assertTrue(MotionAssertions.continuousCurve("chrome bottom on exit", exitBottomEdges).isEmpty())
            assertTrue(exitFrames.filter { it.time >= 300 }.all { it.panel == null && it.stage == stage && it.button == button })
            assertTrue(exit.filter { it.first.time >= 300 }.all { it.second == null })

            compose.runOnUiThread { animate.value = false }
            compose.mainClock.advanceTimeByFrame()
            compose.onNodeWithTag("toggle-chrome").performClick()
            val snappedIn = frames(8)
            val landedTop = checkNotNull(snappedIn.first().first.panel)
            val landedBottom = checkNotNull(snappedIn.first().second)
            assertEquals(visibleTop.last().panel, landedTop)
            assertTrue(snappedIn.all { it.first.panel == landedTop && it.second == landedBottom && it.first.stage == stage && it.first.button == button })
            compose.onNodeWithTag("toggle-audio-bar").performClick()
            val snappedAudioOut = frames(1).single()
            assertTrue(snappedAudioOut.first.panel == landedTop && snappedAudioOut.second == null)
            compose.onNodeWithTag("toggle-audio-bar").performClick()
            assertTrue(frames(1).single().second == landedBottom)
            compose.onNodeWithTag("toggle-chrome").performClick()
            val snappedOut = frames(1).single()
            assertTrue(snappedOut.first.panel == null && snappedOut.second == null)
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }
}
