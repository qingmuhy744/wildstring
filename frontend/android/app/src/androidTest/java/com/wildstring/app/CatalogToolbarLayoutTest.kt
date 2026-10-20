package com.wildstring.app

import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.ui.CatalogToolbar
import com.wildstring.app.ui.MusicState
import com.wildstring.app.ui.classicLightColors
import java.io.File
import kotlin.math.roundToInt
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Verify actual text layout and action bounds at phone widths, not only semantics. */
class CatalogToolbarLayoutTest {
    @get:Rule val compose = createComposeRule()
    private val state = mutableStateOf(MusicState(kind = "tracks", sort = "name", total = 28))
    private var played = 0
    private var selected = false

    private fun show(width: Int, scale: Float = 1f) {
        var expectedPixels = 0
        compose.setContent {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val density = LocalDensity.current
                // A phone CI emulator can also exercise a 700dp component by
                // scaling its density; never silently clip the requested width.
                val previewDensity = minOf(density.density, (constraints.maxWidth - 2).coerceAtLeast(1).toFloat() / width)
                SideEffect { expectedPixels = (width * previewDensity).roundToInt() }
                CompositionLocalProvider(LocalDensity provides Density(previewDensity, scale)) {
                    MaterialTheme(colorScheme = classicLightColors) {
                        Surface(Modifier.width(width.dp).testTag("toolbar-preview")) {
                            CatalogToolbar(state.value, play = { played++ }, sort = { state.value = state.value.copy(sort = it) },
                                reverse = { state.value = state.value.copy(order = if (state.value.order == "asc") "desc" else "asc") },
                                multi = { selected = true }, download = {}, edit = {}, order = {}, delete = {})
                        }
                    }
                }
            }
        }
        val actualPixels = compose.onNodeWithTag("toolbar-preview").fetchSemanticsNode().size.width
        assertEquals("The requested viewport must not be clipped", expectedPixels, actualPixels)
    }

    private fun assertCountIsComplete() {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithTag("catalog-count").assertIsDisplayed()
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertEquals(1, layouts.single().lineCount)
        assertFalse("Count must not be clipped or ellipsized", layouts.single().hasVisualOverflow)
        assertFalse(layouts.single().isLineEllipsized(0))
        val count = compose.onNodeWithTag("catalog-count").getUnclippedBoundsInRoot()
        val play = compose.onNodeWithTag("catalog-play-all").getUnclippedBoundsInRoot()
        assertTrue("Count stays vertically centered next to play", kotlin.math.abs((count.top.value + count.bottom.value - play.top.value - play.bottom.value) / 2) <= 1f)
    }

    private fun assertControlsInsideToolbar() {
        val parent = compose.onNodeWithTag("catalog-toolbar").getUnclippedBoundsInRoot()
        for (tag in listOf("catalog-play-all", "catalog-count", "catalog-sort", "catalog-more")) {
            val node = compose.onNodeWithTag(tag).assertIsDisplayed().getUnclippedBoundsInRoot()
            assertTrue("$tag left edge", node.left >= parent.left)
            assertTrue("$tag right edge", node.right <= parent.right)
            assertTrue("$tag bottom edge", node.bottom <= parent.bottom)
        }
    }

    private fun capture(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: context.getExternalFilesDir(null)!!
        directory.mkdirs()
        File(directory, name).outputStream().use {
            compose.onNodeWithTag("toolbar-preview").captureToImage().asAndroidBitmap()
                .compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Test fun narrowPhoneKeepsCountHorizontalAndActionsWork() {
        show(320)
        assertCountIsComplete(); assertControlsInsideToolbar()
        val play = compose.onNodeWithTag("catalog-play-all").getUnclippedBoundsInRoot()
        val sort = compose.onNodeWithTag("catalog-sort").getUnclippedBoundsInRoot()
        assertTrue("Normal phone text stays in one row after folding direction into the menu",
            kotlin.math.abs((play.top.value + play.bottom.value - sort.top.value - sort.bottom.value) / 2) <= 1f)
        compose.onNodeWithTag("catalog-sort-order").assertDoesNotExist()
        capture("catalog-toolbar-phone.png")
        compose.onNodeWithTag("catalog-play-all").performClick(); assertEquals(1, played)
        compose.onNodeWithTag("catalog-sort").performClick()
        compose.onNodeWithText("最近听过").performClick()
        compose.runOnIdle { assertEquals("last_played_at", state.value.sort) }
        compose.onNodeWithTag("catalog-sort").performClick()
        compose.onNodeWithTag("catalog-sort-order-desc").performClick()
        compose.runOnIdle { assertEquals("desc", state.value.order) }
        compose.onNodeWithTag("catalog-sort").performClick()
        compose.onNodeWithTag("catalog-sort-order-desc").performClick()
        compose.runOnIdle { assertEquals("Selecting the current direction must not toggle it", "desc", state.value.order) }
        compose.onNodeWithTag("catalog-more").performClick()
        compose.onNodeWithText("多选加入").performClick(); assertTrue(selected)
    }

    @Test fun veryNarrowViewportUsesSecondRowRatherThanClippingCount() {
        show(280)
        assertCountIsComplete(); assertControlsInsideToolbar()
        val play = compose.onNodeWithTag("catalog-play-all").getUnclippedBoundsInRoot()
        val sort = compose.onNodeWithTag("catalog-sort").getUnclippedBoundsInRoot()
        assertTrue(sort.top >= play.bottom)
    }

    @Test fun enlargedFontKeepsFourDigitCountAndAllActionsVisible() {
        state.value = state.value.copy(total = 1672, sort = "last_played_at")
        show(320, 2f)
        assertCountIsComplete(); assertControlsInsideToolbar()
        capture("catalog-toolbar-large-font.png")
    }

    @Test fun wideScreenKeepsSingleRow() {
        state.value = state.value.copy(total = 1672)
        show(700)
        assertCountIsComplete(); assertControlsInsideToolbar()
        val play = compose.onNodeWithTag("catalog-play-all").getUnclippedBoundsInRoot()
        val sort = compose.onNodeWithTag("catalog-sort").getUnclippedBoundsInRoot()
        assertTrue(kotlin.math.abs((play.top.value + play.bottom.value - sort.top.value - sort.bottom.value) / 2) <= 1f)
        capture("catalog-toolbar-wide.png")
    }

    @Test fun standardPhoneAlbumPreservesSingleRowAndSongSpace() {
        state.value = state.value.copy(collection = "albums", sort = "track_number")
        show(411)
        assertCountIsComplete(); assertControlsInsideToolbar()
        val play = compose.onNodeWithTag("catalog-play-all").getUnclippedBoundsInRoot()
        val sort = compose.onNodeWithTag("catalog-sort").getUnclippedBoundsInRoot()
        assertTrue(kotlin.math.abs((play.top.value + play.bottom.value - sort.top.value - sort.bottom.value) / 2) <= 1f)
    }

    @Test fun manualPlaylistKeepsCompactOriginalActions() {
        state.value = state.value.copy(collection = "playlists")
        show(320)
        assertCountIsComplete()
        compose.onNodeWithTag("catalog-sort").assertDoesNotExist()
        compose.onNodeWithTag("catalog-more").performClick()
        compose.onNodeWithText("多选加入").assertIsDisplayed()
    }

    @Test fun emptyAndCollectingListsStillDisablePlayback() {
        state.value = state.value.copy(total = 0)
        show(320)
        assertCountIsComplete(); assertControlsInsideToolbar()
        compose.onNodeWithTag("catalog-play-all").assertIsNotEnabled()
        compose.runOnIdle { state.value = state.value.copy(total = 28, collecting = true) }
        compose.onNodeWithText("准备中…").assertIsDisplayed()
        compose.onNodeWithTag("catalog-play-all").assertIsNotEnabled()
        assertCountIsComplete(); assertControlsInsideToolbar()
    }
}
