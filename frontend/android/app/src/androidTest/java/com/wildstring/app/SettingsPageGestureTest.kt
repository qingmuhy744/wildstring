package com.wildstring.app

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import android.view.KeyEvent
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.ui.SettingsPage
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** The real settings container, including scrolling, toolbar and real touch dispatch. */
class SettingsPageGestureTest {
    @get:Rule val compose = createComposeRule()
    private val open = mutableStateOf(true)
    private var dismissals = 0
    private var selections = 0

    private fun show() {
        compose.setContent {
            MaterialTheme {
                if (open.value) SettingsPage({ open.value = false; dismissals++ }) {
                    repeat(20) { index ->
                        val row = Modifier.fillMaxWidth().height(56.dp).testTag("settings-option-$index")
                        if (index == 19) TextButton({ selections++ }, row) { Text("设置选项 $index") }
                        else Text("设置选项 $index", row)
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("settings-back").assertIsDisplayed()
    }
    private fun pageTop() = compose.onNodeWithTag("settings-page").fetchSemanticsNode().boundsInRoot.top
    private fun headerTop() = compose.onNodeWithTag("settings-back").fetchSemanticsNode().boundsInRoot.top
    private fun assertStationary(sheet: Float, header: Float) {
        assertEquals("A small content drag must not move the settings panel", sheet, pageTop(), 1f)
        assertEquals("The close action must stay at the same screen position", header, headerTop(), 1f)
        compose.runOnIdle { assertEquals(0, dismissals); assertEquals(0, selections) }
    }

    @Test fun gentleDownwardAndReverseDragsAtTopKeepPanelStill() {
        show()
        val top = pageTop()
        val header = headerTop()
        val content = compose.onNodeWithTag("settings-scroll")
        val pull = with(compose.density) { 24.dp.toPx() }
        repeat(3) {
            var touching = false
            try {
                content.performTouchInput { down(Offset(width * .5f, height * .2f)); moveBy(Offset(0f, pull), delayMillis = 160); moveBy(Offset(0f, pull), delayMillis = 160) }
                touching = true
                assertStationary(top, header)
                content.performTouchInput { moveBy(Offset(0f, -pull / 3), delayMillis = 100) }
                assertStationary(top, header)
                content.performTouchInput { up() }
                touching = false
                compose.waitForIdle()
                assertStationary(top, header)
            } finally {
                if (touching) content.performTouchInput { cancel() }
            }
        }
    }

    @Test fun scrolledContentKeepsBackVisibleAndControlsReachable() {
        show()
        val top = pageTop()
        val header = headerTop()
        compose.onNodeWithTag("settings-scroll").performTouchInput { swipeUp(durationMillis = 450) }
        compose.onNodeWithTag("settings-option-19").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("settings-back").assertIsDisplayed()
        assertStationary(top, header)
        compose.onNodeWithTag("settings-option-19").performClick()
        compose.runOnIdle { assertEquals(1, selections) }
        compose.onNodeWithTag("settings-option-0").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("settings-back").performClick()
        compose.onNodeWithTag("settings-page").assertDoesNotExist()
        compose.runOnIdle { assertEquals(1, dismissals) }
    }

    @Test fun systemBackReturnsFromSettings() {
        show()
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
        compose.onNodeWithTag("settings-page").assertDoesNotExist()
        compose.runOnIdle { assertEquals(1, dismissals) }
    }
}
