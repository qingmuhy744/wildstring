package com.wildstring.app

import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import com.wildstring.app.data.LyricLine
import com.wildstring.app.data.Lyrics
import com.wildstring.app.ui.LyricViewport
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class LyricGestureTest {
    @get:Rule val compose = createComposeRule()
    private val seeks = mutableListOf<Long>()
    private var toggles = 0
    private var previews = 0
    private fun show(synced: Boolean = true, followDelayMs: Long = 2_000) {
        val lyrics = Lyrics(if (synced) "synced" else "plain", (0..19).map {
            LyricLine(if (synced) it * 1000L else null, "测试歌词第 $it 行")
        })
        compose.setContent { MaterialTheme {
            LyricViewport(lyrics, 0, { seeks += it }, { toggles++ }, Modifier.width(360.dp).height(400.dp), { previews++ }, followDelayMs)
        } }
    }

    @Test fun tappingALyricTogglesTheCoverWithoutSeeking() {
        show()
        compose.onNodeWithTag("lyric-line-0").performClick()
        compose.onNodeWithTag("lyric-seek-preview").assertDoesNotExist()
        compose.runOnIdle { assertTrue(seeks.isEmpty()); assertEquals(1, toggles) }
    }

    @Test fun longerPreferenceKeepsTheSelectionBeyondTheDefaultDelay() {
        show(followDelayMs = 5_000)
        compose.onNodeWithTag("lyric-scroll").performTouchInput { swipeUp(durationMillis = 450) }
        val started = android.os.SystemClock.elapsedRealtime()
        compose.waitUntil(3_000) { android.os.SystemClock.elapsedRealtime() - started >= 2_200 }
        compose.onNodeWithTag("lyric-seek-preview").assertExists()
        compose.waitUntil(4_500) { compose.onAllNodesWithTag("lyric-seek-preview").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("lyric-seek-preview").assertDoesNotExist()
        compose.runOnIdle { assertTrue(seeks.isEmpty()) }
    }

    @Test fun scrollingPreviewsTimeAndOnlyTheConfirmButtonSeeks() {
        show()
        compose.onNodeWithTag("lyric-scroll").performTouchInput { swipeUp(durationMillis = 450) }
        compose.onNodeWithTag("lyric-seek-confirm").assertIsDisplayed()
        compose.runOnIdle { assertTrue(seeks.isEmpty()); assertEquals(0, toggles) }
        compose.onNodeWithTag("lyric-seek-confirm").performClick()
        compose.runOnIdle { assertEquals(1, seeks.size); assertTrue(seeks.single() > 0); assertEquals(0, toggles) }
        compose.onNodeWithTag("lyric-seek-preview").assertDoesNotExist()
    }

    @Test fun tappingTextTogglesWithoutSeekingAndBlankSpaceToggles() {
        show()
        compose.onNodeWithTag("lyric-line-0").performTouchInput { click(center) }
        compose.onNodeWithTag("lyric-seek-confirm").assertDoesNotExist()
        compose.runOnIdle { assertTrue(seeks.isEmpty()); assertEquals(1, toggles) }
        compose.onNodeWithTag("lyrics-viewport").performTouchInput { click(Offset(8f, 8f)) }
        compose.runOnIdle { assertTrue(seeks.isEmpty()); assertEquals(2, toggles) }
    }

    @Test fun plainLyricsScrollWithoutSeekingOrToggling() {
        show(synced = false)
        compose.onNodeWithTag("lyric-scroll").performTouchInput { swipeUp(durationMillis = 450) }
        compose.onNodeWithTag("lyric-seek-confirm").assertDoesNotExist()
        compose.runOnIdle { assertTrue(seeks.isEmpty()); assertEquals(0, toggles) }
    }

    @Test fun holdingLyricsOrBlankSpacePreviewsArtworkWithoutSelectingOrSeeking() {
        show()
        compose.onNodeWithTag("lyric-line-0").performTouchInput { longClick() }
        compose.onNodeWithTag("lyric-seek-preview").assertDoesNotExist()
        compose.runOnIdle { assertEquals(1, previews); assertTrue(seeks.isEmpty()); assertEquals(0, toggles) }
        compose.onNodeWithTag("lyrics-viewport").performTouchInput { longClick(Offset(8f, 8f)) }
        compose.runOnIdle { assertEquals(2, previews); assertTrue(seeks.isEmpty()); assertEquals(0, toggles) }
    }

    @Test fun movingBeforeAHoldCancelsArtworkPreview() {
        show()
        compose.onNodeWithTag("lyric-scroll").performTouchInput {
            down(center)
            moveBy(Offset(0f, -80f))
            advanceEventTime(700)
            up()
        }
        compose.runOnIdle { assertEquals(0, previews); assertTrue(seeks.isEmpty()); assertEquals(0, toggles) }
    }
}
