package com.wildstring.app

import android.animation.ValueAnimator
import android.os.ParcelFileDescriptor
import android.provider.Settings
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.Track
import com.wildstring.app.ui.MusicViewModel
import com.wildstring.app.ui.PlaybackRotation
import com.wildstring.app.ui.PlaybackVisual
import kotlin.math.abs
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class VinylTonearmMotionTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun shell(command: String) = ParcelFileDescriptor.AutoCloseInputStream(
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command),
    ).use { it.readBytes() }

    private fun withVisual(scale: String, body: (androidx.compose.runtime.MutableState<Boolean>, androidx.compose.runtime.MutableState<Boolean>) -> Unit) {
        val resolver = compose.activity.contentResolver
        val original = Settings.Global.getString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE)
            ?.takeIf { it.isNotBlank() && it != "null" } ?: "1.0"
        shell("settings put global animator_duration_scale $scale")
        try {
            compose.waitUntil(5_000) { ValueAnimator.areAnimatorsEnabled() == (scale != "0.0") }
            val shown = mutableStateOf(true)
            val playing = mutableStateOf(true)
            val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
            val track = Track("vinyl-test", "Vinyl test", emptyList(), null, 180_000)
            val phase = PlaybackRotation()
            compose.runOnIdle {
                compose.activity.setContent {
                    MaterialTheme {
                        if (shown.value) PlaybackVisual(vm, track, "vinyl", playing.value, false, track.durationMs, phase,
                            Modifier.size(300.dp), onArtwork = {}, onLyrics = {})
                    }
                }
            }
            compose.waitForIdle()
            body(shown, playing)
        } finally {
            compose.mainClock.autoAdvance = true
            shell("settings put global animator_duration_scale $original")
            compose.waitUntil(5_000) { ValueAnimator.areAnimatorsEnabled() == ((original.toFloatOrNull() ?: 1f) > 0f) }
        }
    }

    // A rotated canvas has a changing bounding box: its left edge measures the actual arm position.
    private fun armLeft(): Float = compose.onNodeWithTag("vinyl-tonearm", useUnmergedTree = true)
        .fetchSemanticsNode().boundsInRoot.left

    private fun frames(count: Int): List<Float> = List(count) {
        compose.mainClock.advanceTimeByFrame()
        armLeft()
    }

    @Test fun returningFromLyricsKeepsPlayingArmStill() = withVisual("1.0") { shown, _ ->
        val engaged = armLeft()
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { shown.value = false }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { shown.value = true }
        val samples = frames(45)
        val problems = MotionAssertions.staysPut("tonearm on return", listOf(engaged) + samples)
        assertTrue(problems.joinToString("\n") + "\nleft edges: $samples", problems.isEmpty())
    }

    @Test fun playbackChangesMoveArmContinuouslyAndThenStop() = withVisual("1.0") { _, playing ->
        compose.mainClock.autoAdvance = false
        for (isPlaying in listOf(false, true)) {
            val start = armLeft()
            compose.runOnIdle { playing.value = isPlaying }
            val samples = listOf(start) + frames(35)
            val problems = MotionAssertions.continuousCurve("tonearm", samples) +
                MotionAssertions.landsAndStays("tonearm", samples.indices.map { it * 16 }, samples, List(samples.size) { 0 }, settleMs = 400)
            assertTrue("Tonearm did not move for playing=$isPlaying: $samples", abs(samples.last() - samples.first()) > 10f)
            assertTrue(problems.joinToString("\n") + "\nleft edges: $samples", problems.isEmpty())
        }
    }

    @Test fun reducedMotionMovesArmInOneFrame() = withVisual("0.0") { _, playing ->
        compose.mainClock.autoAdvance = false
        val start = armLeft()
        compose.runOnIdle { playing.value = false }
        val samples = frames(8)
        assertTrue("Tonearm did not reach the paused position: $samples", abs(start - samples.last()) > 10f)
        val problems = MotionAssertions.staysPut("tonearm with reduced motion", samples.drop(2))
        assertTrue(problems.joinToString("\n") + "\nleft edges: $samples", problems.isEmpty())
    }
}
