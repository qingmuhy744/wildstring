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
    // Playback interpolation reads this instead of the device clock, so a playing viewport only
    // changes when a test moves it and idle waits cannot be kept busy by wall time.
    private var playbackNow = 0L
    private fun show(synced: Boolean = true, followDelayMs: Long = 2_000, playing: Boolean = false) {
        val lyrics = Lyrics(if (synced) "synced" else "plain", (0..19).map {
            LyricLine(if (synced) it * 1000L else null, "测试歌词第 $it 行")
        })
        compose.setContent { MaterialTheme {
            LyricViewport(lyrics, 0, { seeks += it }, { toggles++ }, Modifier.width(360.dp).height(400.dp), { previews++ }, followDelayMs, playing,
                playbackClock = { playbackNow })
        } }
    }

    @Test fun tappingALyricTogglesTheCoverWithoutSeeking() {
        show()
        compose.onNodeWithTag("lyric-line-0").performClick()
        compose.onNodeWithTag("lyric-seek-preview").assertDoesNotExist()
        compose.runOnIdle { assertTrue(seeks.isEmpty()); assertEquals(1, toggles) }
    }

    @Test fun longerPreferenceKeepsTheSelectionBeyondTheDefaultDelay() {
        show(followDelayMs = 5_000, playing = true)
        // The follow timer is a coroutine delay on the Compose test clock, and playback keeps a
        // per-frame position loop running. With auto-advance on, every idle wait pumps frames for
        // that loop, so virtual time races ahead of wall time (or lags it on a slow emulator) and
        // wall-clock checks were flaky either way. Drive the test clock by hand instead.
        compose.mainClock.autoAdvance = false
        try {
            // Input injection still advances the clock by the gesture's own duration.
            compose.onNodeWithTag("lyric-scroll").performTouchInput { swipeUp(durationMillis = 450) }
            val released = compose.mainClock.currentTime
            // The timer starts only after the fling settles, so four seconds after release a
            // five-second preference cannot have expired, while the two-second default would have.
            compose.mainClock.advanceTimeBy(4_000)
            compose.onNodeWithTag("lyric-seek-preview").assertExists()
            while (compose.onAllNodesWithTag("lyric-seek-preview").fetchSemanticsNodes().isNotEmpty()) {
                assertTrue("selection should be released within 10 s", compose.mainClock.currentTime - released < 10_000)
                compose.mainClock.advanceTimeBy(250)
            }
            assertTrue("selection should be held for the full 5 s preference", compose.mainClock.currentTime - released >= 5_000)
            // Still on the manually driven clock: with auto-advance back on, this idle wait used
            // to race the playing viewport's position loop (ComposeNotIdleException).
            compose.runOnIdle { assertTrue(seeks.isEmpty()) }
        } finally {
            compose.mainClock.autoAdvance = true
        }
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

    @Test fun scrollingToTopAllowsSelectingTheFirstLyricLine() {
        show()
        val viewport = compose.onNodeWithTag("lyrics-viewport").fetchSemanticsNode().boundsInRoot
        val initialRow0 = compose.onNodeWithTag("lyric-row-0").fetchSemanticsNode().boundsInRoot
        assertTrue("first lyric row starts near the top in auto-follow mode", initialRow0.top - viewport.top < viewport.height * 0.25f)
        compose.onNodeWithTag("lyric-scroll").performTouchInput { swipeUp(durationMillis = 300) }
        compose.onNodeWithTag("lyric-scroll").performTouchInput { swipeDown(durationMillis = 300) }
        compose.onNodeWithTag("lyric-scroll").performTouchInput { swipeDown(durationMillis = 300) }
        compose.onNodeWithTag("lyric-seek-confirm").assertIsDisplayed()
        compose.onNodeWithTag("lyric-seek-confirm").performClick()
        compose.runOnIdle { assertEquals(listOf(0L), seeks); assertEquals(0, toggles) }
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
