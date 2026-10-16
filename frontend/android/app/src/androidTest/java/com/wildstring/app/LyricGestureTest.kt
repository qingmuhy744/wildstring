package com.wildstring.app

import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
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
    private fun show(synced: Boolean = true) {
        val lyrics = Lyrics(if (synced) "synced" else "plain", (0..19).map {
            LyricLine(if (synced) it * 1000L else null, "测试歌词第 $it 行")
        })
        compose.setContent { MaterialTheme {
            LyricViewport(lyrics, 0, { seeks += it }, { toggles++ }, Modifier.width(360.dp).height(400.dp))
        } }
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

    @Test fun tappingTextSelectsWithoutSeekingAndBlankSpaceToggles() {
        show()
        compose.onNodeWithTag("lyric-line-0").performTouchInput { click(center) }
        compose.onNodeWithTag("lyric-seek-confirm").assertIsDisplayed()
        compose.runOnIdle { assertTrue(seeks.isEmpty()); assertEquals(0, toggles) }
        compose.onNodeWithTag("lyrics-viewport").performTouchInput { click(Offset(8f, 8f)) }
        compose.runOnIdle { assertTrue(seeks.isEmpty()); assertEquals(1, toggles) }
    }

    @Test fun plainLyricsScrollWithoutSeekingOrToggling() {
        show(synced = false)
        compose.onNodeWithTag("lyric-scroll").performTouchInput { swipeUp(durationMillis = 450) }
        compose.onNodeWithTag("lyric-seek-confirm").assertDoesNotExist()
        compose.runOnIdle { assertTrue(seeks.isEmpty()); assertEquals(0, toggles) }
    }
}
