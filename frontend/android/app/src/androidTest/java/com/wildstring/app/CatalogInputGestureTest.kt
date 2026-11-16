package com.wildstring.app

import android.view.View
import android.view.inputmethod.EditorInfo
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.SoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.wildstring.app.data.BrowseGroup
import com.wildstring.app.ui.ALPHABET_RAIL_FADE_MS
import com.wildstring.app.ui.ALPHABET_RAIL_IDLE_DELAY_MS
import com.wildstring.app.ui.AlphabetRail
import com.wildstring.app.ui.CatalogSearch
import com.wildstring.app.ui.LocalTactileFeedback
import com.wildstring.app.ui.TactileKind
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class CatalogInputGestureTest {
    @get:Rule val compose = createComposeRule()

    @Test fun composingChineseCommitsOnceAndPreservesCursorAndFocus() {
        var query by mutableStateOf("")
        val searches = mutableListOf<String>()
        lateinit var inputView: View
        var keyboard: SoftwareKeyboardController? = null
        compose.setContent { MaterialTheme {
            inputView = LocalView.current
            keyboard = LocalSoftwareKeyboardController.current
            CatalogSearch(query) { query = it; searches += it }
        } }
        compose.onNodeWithTag("catalog-search").performClick()
        // Wait for the real IME lifecycle before this test takes over its connection.
        // Compose idleness alone does not wait for the system keyboard to finish closing.
        awaitKeyboard(inputView, visible = true)
        compose.runOnIdle { keyboard?.hide() }
        awaitKeyboard(inputView, visible = false)
        val connection = compose.runOnIdle { requireNotNull(inputView.onCreateInputConnection(EditorInfo())) }
        compose.runOnIdle { connection.setComposingText("xu", 1) }
        compose.onNodeWithTag("catalog-search").assertTextEquals("xu").assertIsFocused()
        compose.runOnIdle { assertTrue("Uncommitted IME buffer was submitted: $searches", searches.isEmpty()); connection.setComposingText("xusong", 1) }
        compose.runOnIdle { assertTrue("Uncommitted IME buffer was submitted: $searches", searches.isEmpty()); connection.commitText("许嵩", 1) }
        compose.onNodeWithTag("catalog-search").assertTextEquals("许嵩").assertIsFocused()
        compose.runOnIdle { assertEquals(listOf("许嵩"), searches); connection.setSelection(1, 1); connection.setComposingText("hao", 1) }
        compose.onNodeWithTag("catalog-search").assertTextEquals("许hao嵩")
        compose.runOnIdle { assertEquals(listOf("许嵩"), searches); connection.commitText("好", 1) }
        compose.onNodeWithTag("catalog-search").assertTextEquals("许好嵩").assertIsFocused()
        compose.runOnIdle { assertEquals(listOf("许嵩", "许好嵩"), searches) }
        compose.onNodeWithContentDescription(uiString(R.string.clear_search)).performClick()
        compose.onNodeWithTag("catalog-search").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString(""))).assertIsFocused()
        compose.runOnIdle { assertEquals("", query) }
    }

    private fun awaitKeyboard(view: View, visible: Boolean) {
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                ViewCompat.getRootWindowInsets(view)?.isVisible(WindowInsetsCompat.Type.ime()) == visible
            }
        }
    }

    @Test fun imeSearchCommitsPendingCompositionAndEnglishStillSearches() {
        var query by mutableStateOf("")
        lateinit var inputView: View
        compose.setContent { MaterialTheme {
            inputView = LocalView.current
            CatalogSearch(query) { query = it }
        } }
        compose.onNodeWithTag("catalog-search").performClick()
        val connection = compose.runOnIdle { requireNotNull(inputView.onCreateInputConnection(EditorInfo())) }
        compose.runOnIdle { connection.setComposingText("许嵩", 1) }
        compose.onNodeWithTag("catalog-search").performImeAction()
        compose.runOnIdle { assertEquals("许嵩", query) }
        compose.onNodeWithContentDescription(uiString(R.string.clear_search)).performClick()
        compose.onNodeWithTag("catalog-search").performTextInput("Rock")
        compose.runOnIdle { assertEquals("Rock", query) }
    }

    @Test fun railJumpsBeforeReleaseAndOnlyNewPopulatedLettersProduceFeedback() {
        val keys = listOf("0–9") + ('A'..'Z').map { it.toString() } + "#"
        val starts = mapOf("A" to 10, "M" to 110, "Z" to 160)
        val groups = keys.map { BrowseGroup(it, starts[it], if (it in starts) 10 else 0) }
        val jumps = mutableListOf<Int>()
        val effects = mutableListOf<TactileKind>()
        compose.setContent { MaterialTheme {
            CompositionLocalProvider(LocalTactileFeedback provides { effects += it }) {
                Box(Modifier.width(360.dp).height(560.dp)) {
                    AlphabetRail(groups, "A", Modifier.align(Alignment.CenterEnd).width(30.dp).height(560.dp), jump = { jumps += it })
                }
            }
        } }
        compose.onNodeWithTag("alphabet-0–9").assertIsNotEnabled()
        compose.onNodeWithTag("alphabet-A").assertIsSelected()
        compose.onNodeWithTag("alphabet-rail").performTouchInput {
            down(Offset(center.x, height * 2.5f / 28f))
            moveTo(Offset(center.x, height * 13.5f / 28f), delayMillis = 150)
        }
        compose.onNodeWithTag("alphabet-preview").assertIsDisplayed()
        val firstBubble = compose.onNodeWithTag("alphabet-preview").fetchSemanticsNode().boundsInRoot.top
        compose.runOnIdle { assertEquals(listOf(110), jumps); assertEquals(listOf(TactileKind.Tap), effects) }
        compose.onNodeWithTag("alphabet-rail").performTouchInput {
            moveTo(Offset(center.x, height * 13.6f / 28f), delayMillis = 100)
            moveTo(Offset(center.x, height * 14.5f / 28f), delayMillis = 100)
        }
        compose.runOnIdle { assertEquals(listOf(110), jumps); assertEquals(1, effects.size) }
        compose.onNodeWithTag("alphabet-rail").performTouchInput {
            moveTo(Offset(center.x, height * 26.5f / 28f), delayMillis = 150)
        }
        compose.runOnIdle { assertEquals(listOf(110, 160), jumps); assertEquals(2, effects.size) }
        assertTrue(compose.onNodeWithTag("alphabet-preview").fetchSemanticsNode().boundsInRoot.top > firstBubble)
        compose.onNodeWithTag("alphabet-rail").performTouchInput { up() }
        compose.onNodeWithTag("alphabet-preview").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf(110, 160), jumps); assertEquals(2, effects.size) }
    }

    @Test fun railStaysOutsideContentStacksItsLettersAndFadesOnlyWhenIdle() {
        val keys = listOf("0–9") + ('A'..'Z').map { it.toString() } + "#"
        val starts = mapOf("A" to 10, "B" to 20, "C" to 30, "M" to 110, "Z" to 160)
        val groups = keys.map { BrowseGroup(it, starts[it], if (it in starts) 10 else 0) }
        val density = compose.density
        val jumps = mutableListOf<Int>()
        compose.setContent { MaterialTheme {
            Box(Modifier.width(360.dp).height(560.dp)) {
                // Content keeps the rail plus an 8dp gap of its own, mirroring the catalog's reserved gutter.
                Box(Modifier.fillMaxHeight().width(360.dp - 44.dp - 8.dp).testTag("rail-content"))
                // The instrumented host reports animators disabled; this test drives the fade explicitly.
                AlphabetRail(groups, "A", Modifier.align(Alignment.CenterEnd).width(44.dp).fillMaxHeight(), jump = { jumps += it },
                    motionAllowed = true)
            }
        } }
        val rail = compose.onNodeWithTag("alphabet-rail").fetchSemanticsNode().boundsInRoot
        val content = compose.onNodeWithTag("rail-content").fetchSemanticsNode().boundsInRoot
        assertTrue("Rail left ${rail.left} overlaps content ending at ${content.right}", rail.left >= content.right + with(density) { 8.dp.toPx() })
        // The letter column is inset 6dp inside the 44dp rail so a letter never touches the covers.
        assertEquals(with(density) { 32.dp.toPx() }, rail.width, 1f)
        // Every letter shares one column; the tick sits at its edge, out of the glyph flow.
        val a = compose.onNodeWithTag("alphabet-A").fetchSemanticsNode().boundsInRoot
        val m = compose.onNodeWithTag("alphabet-M").fetchSemanticsNode().boundsInRoot
        assertEquals("Monospace letters must share one centre", a.center.x, m.center.x, 1f)
        // The tag is the tappable slot (a whole share of the column); its visual inside is the fixed 14dp box.
        val visual = compose.onNodeWithTag("alphabet-visual-A", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertEquals(with(density) { 14.dp.toPx() }, visual.height, 1f)
        assertEquals("The glyph must stay centred in its slot", a.center.y, visual.center.y, 1f)
        assertEquals("The visual must stay centred horizontally too", a.center.x, visual.center.x, 1f)
        compose.onNodeWithTag("alphabet-0–9").assertIsNotEnabled()
        compose.onNodeWithTag("alphabet-A").assertIsSelected()

        // Every point of the column belongs to a letter; only enabled letters jump.
        val b = compose.onNodeWithTag("alphabet-B", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val c = compose.onNodeWithTag("alphabet-C", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        // Each slot is taller than its 14dp visual, and neighbouring slots share one edge.
        assertTrue("A slot must be taller than its visual (${b.height} vs ${visual.height})", b.height > visual.height)
        assertEquals("Neighbouring slots must share one edge, with no dead strip", c.top, b.bottom, 1f)
        compose.onNodeWithTag("alphabet-B").assertIsNotSelected()
        compose.onNodeWithTag("alphabet-B").performClick()
        compose.runOnIdle { assertEquals(listOf(20), jumps) }
        // Tapping the rail between two glyphs at the boundary still hits a letter, not a dead strip.
        val before = jumps.size
        val boundary = (b.bottom + c.top) / 2f - rail.top
        compose.onNodeWithTag("alphabet-rail").performTouchInput { click(Offset(center.x, boundary)) }
        compose.runOnIdle { assertEquals("A press between letters must still jump", before + 1, jumps.size) }
        compose.onNodeWithTag("alphabet-X").assertIsNotEnabled()

        // The rail rests faded after the idle delay, and a press restores it before any drag is recognised.
        fun state() = compose.onNodeWithTag("alphabet-rail").fetchSemanticsNode()
            .config.getOrNull(SemanticsProperties.StateDescription)
        assertEquals(uiString(R.string.alphabet_rail_active), state())
        // The idle timer is a coroutine delay: frame-by-frame stepping runs it and the fade together.
        var frame = 0
        while (state() != uiString(R.string.alphabet_rail_idle) && frame < 300) {
            compose.mainClock.advanceTimeByFrame(); frame++
        }
        assertTrue("The rail must fade after ${ALPHABET_RAIL_IDLE_DELAY_MS}ms of no interaction", frame < 300)
        compose.onNodeWithTag("alphabet-rail").performTouchInput { down(center) }
        compose.mainClock.advanceTimeBy(ALPHABET_RAIL_FADE_MS.toLong())
        assertEquals(uiString(R.string.alphabet_rail_active), state())
        compose.onNodeWithTag("alphabet-rail").performTouchInput { up() }
    }
}
