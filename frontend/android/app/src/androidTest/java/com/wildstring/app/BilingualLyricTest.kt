package com.wildstring.app

import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.Gson
import com.wildstring.app.data.LyricLine
import com.wildstring.app.data.LyricSize
import com.wildstring.app.data.Lyrics
import com.wildstring.app.ui.LyricViewport
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import kotlin.math.abs

class BilingualLyricTest {
    @get:Rule val compose = createComposeRule()
    private val position = mutableLongStateOf(0L)
    private val seeks = mutableListOf<Long>()

    private fun show(lyrics: Lyrics, lyricSize: LyricSize = LyricSize.MEDIUM) {
        compose.setContent { MaterialTheme {
            LyricViewport(lyrics, position.longValue, { seeks += it }, {},
                Modifier.width(360.dp).height(400.dp), lyricSize = lyricSize)
        } }
    }

    @Test fun lyricSizePresetsChangeTheRenderedTypography() {
        val lyrics = Lyrics("synced", listOf(LyricLine(0, "A lyric line that is long enough to measure")))
        show(lyrics, LyricSize.SMALL)
        val small = compose.onNodeWithTag("lyric-line-0").fetchSemanticsNode().boundsInRoot.height
        show(lyrics, LyricSize.LARGE)
        val large = compose.onNodeWithTag("lyric-line-0").fetchSemanticsNode().boundsInRoot.height
        assertTrue("large lyric preset must render taller text", large > small)
    }

    private fun languageFixture(): Lyrics {
        val name = InstrumentationRegistry.getArguments().getString("lyricFixture")
        val source = if (name != null) {
            require(name.matches(Regex("[a-z0-9_-]+\\.json")))
            InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.resolve(name).readText()
        } else """{"kind":"synced","source":"fixture","lines":[
          {"time_ms":1000,"text":"Synthetic English sentence","translation":"合成中文译文",
           "romanization":"he cheng", "words":[{"start_ms":1000,"end_ms":2000,"text":"Synthetic English sentence"}]},
          {"time_ms":3000,"text":"A second synthetic sentence","translation":"第二句合成译文"}] }"""
        return Gson().fromJson(source, Lyrics::class.java)
    }

    @Test fun chineseTranslationAppearsBeforeEnglishSourceAndCanBeHiddenWithoutSeeking() {
        val lyrics = languageFixture()
        val index = lyrics.lines.indexOfFirst { !it.translation.isNullOrBlank() }
        assertTrue("fixture needs an aligned translation", index >= 0)
        position.longValue = lyrics.lines[index].timeMs ?: 0L
        show(lyrics)
        compose.onNodeWithTag("lyric-line-$index").assertIsDisplayed()
        compose.onNodeWithTag("lyric-translation-$index").assertIsDisplayed()
        val original = compose.onNodeWithTag("lyric-line-$index").fetchSemanticsNode().boundsInRoot
        val translated = compose.onNodeWithTag("lyric-translation-$index").fetchSemanticsNode().boundsInRoot
        assertTrue("Chinese translation belongs above the English source", translated.bottom <= original.top)
        compose.onNodeWithTag("lyric-translation-toggle").performClick()
        compose.onNodeWithTag("lyric-translation-$index").assertDoesNotExist()
        compose.onNodeWithTag("lyric-translation-toggle").performClick()
        compose.onNodeWithTag("lyric-translation-$index").assertIsDisplayed()
        if (!lyrics.lines[index].romanization.isNullOrBlank()) {
            compose.onNodeWithTag("lyric-romanization-$index").assertDoesNotExist()
            compose.onNodeWithTag("lyric-romanization-toggle").performClick()
            compose.onNodeWithTag("lyric-romanization-$index").assertIsDisplayed()
        }
        compose.runOnIdle { assertTrue(seeks.isEmpty()) }
        if (InstrumentationRegistry.getArguments().getString("lyricScreenshot") == "true") {
            val destination = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.resolve("lyric-languages-preview.png")
            destination.outputStream().use { output ->
                compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output)
            }
        }
    }

    @Test fun adjacentLineFollowsInOneContinuousMotionWithoutAMidwayStop() {
        compose.mainClock.autoAdvance = false
        show(Lyrics("synced", (0..19).map { LyricLine(it * 1000L, "合成歌词第 $it 行") }))
        compose.mainClock.advanceTimeBy(2_000)
        val center = compose.onNodeWithTag("lyrics-viewport").fetchSemanticsNode().boundsInRoot.center.y
        compose.runOnIdle { position.longValue = 1_000L }
        val distances = mutableListOf<Float>()
        repeat(110) {
            compose.mainClock.advanceTimeByFrame()
            distances += compose.onNodeWithTag("lyric-line-1").fetchSemanticsNode().boundsInRoot.center.y - center
        }
        assertTrue("active line ends at the viewport center", abs(distances.last()) < 2f)
        var moving = false
        var stoppedFrames = 0
        distances.zipWithNext().forEach { (before, after) ->
            val step = abs(after - before)
            if (step > .5f) moving = true
            stoppedFrames = if (moving && abs(after) > 4f && step < .08f) stoppedFrames + 1 else 0
            assertTrue("scrolling must not stop midway and then start a second centering animation", stoppedFrames < 3)
        }
        compose.runOnIdle { assertTrue(seeks.isEmpty()) }
    }

    @Test fun wrappedBilingualDestinationCanBeReachedDirectlyAfterALargeSeek() {
        val lyrics = Lyrics("synced", (0..19).map { index ->
            LyricLine(index * 1000L, "A longer synthetic sentence that wraps onto more than one line $index",
                translation = "较长的合成中文译文也会自动换行，和原文一起居中。")
        })
        show(lyrics)
        compose.runOnIdle { position.longValue = 18_000L }
        compose.onNodeWithTag("lyric-line-18").assertIsDisplayed()
        compose.onNodeWithTag("lyric-translation-18").assertIsDisplayed()
        val viewport = compose.onNodeWithTag("lyrics-viewport").fetchSemanticsNode().boundsInRoot
        val row = compose.onNodeWithTag("lyric-row-18").fetchSemanticsNode().boundsInRoot
        assertTrue("variable-height destination is centered in the same animation", abs(row.center.y - viewport.center.y) < 3f)
    }
}
