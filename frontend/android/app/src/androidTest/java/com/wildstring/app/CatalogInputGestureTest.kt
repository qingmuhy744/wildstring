package com.wildstring.app

import android.view.View
import android.view.inputmethod.EditorInfo
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.SoftwareKeyboardController
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.wildstring.app.data.BrowseGroup
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
        compose.onNodeWithContentDescription("清空搜索").performClick()
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
        compose.onNodeWithContentDescription("清空搜索").performClick()
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
                    AlphabetRail(groups, "A", Modifier.align(Alignment.CenterEnd).width(30.dp).height(560.dp)) { jumps += it }
                }
            }
        } }
        compose.onNodeWithTag("alphabet-B").assertIsNotEnabled()
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
}
