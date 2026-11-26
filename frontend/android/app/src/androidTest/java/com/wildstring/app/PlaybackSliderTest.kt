package com.wildstring.app

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import com.wildstring.app.data.formatTime
import com.wildstring.app.ui.PlaybackSlider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

internal fun SemanticsNodeInteraction.assertPlaybackProgress(positionMs: Long, durationMs: Long) = assert(
    SemanticsMatcher.expectValue(
        SemanticsProperties.ProgressBarRangeInfo,
        ProgressBarRangeInfo(positionMs.toFloat(), 0f..durationMs.toFloat()),
    ) and SemanticsMatcher.expectValue(
        SemanticsProperties.StateDescription,
        uiString(R.string.playback_progress_time, formatTime(positionMs), formatTime(durationMs)),
    ),
)

internal fun SemanticsNodeInteraction.seekPlaybackTo(positionMs: Long) =
    assertIsEnabled().performSemanticsAction(SemanticsActions.SetProgress) { action ->
        assertTrue("Seek must accept the new position", action(positionMs.toFloat()))
    }

class PlaybackSliderTest {
    @get:Rule val compose = createComposeRule()

    @Test fun disabledSliderAnnouncesItsRangeButCannotSeek() {
        var commits = 0
        compose.setContent {
            MaterialTheme {
                PlaybackSlider(
                    value = 0f,
                    valueRange = 0f..0f,
                    enabled = false,
                    onValueChange = { commits++ },
                    onValueChangeFinished = { commits++ },
                )
            }
        }
        compose.onNodeWithContentDescription(uiString(R.string.playback_progress_label))
            .assertPlaybackProgress(0L, 0L)
            .assertIsNotEnabled()
            .assert(SemanticsMatcher.keyNotDefined(SemanticsActions.SetProgress))
            .performTouchInput { click() }
        compose.runOnIdle { assertEquals(0, commits) }
    }
}
