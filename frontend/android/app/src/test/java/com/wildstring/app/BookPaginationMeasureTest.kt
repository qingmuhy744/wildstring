package com.wildstring.app

import com.wildstring.app.data.BookBlock
import com.wildstring.app.ui.BookImageSize
import com.wildstring.app.ui.computeBookImageHeight
import com.wildstring.app.ui.measurePagesWith
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BookPaginationMeasureTest {
    @Test fun splitsLongParagraphAcrossPagesPreservesUnicodeOffsetsAndBreaksOnImages() {
        val text = "AB\uD83D\uDCDA" + "CDEFGH"
        val blocks = listOf(
            BookBlock(0, "p", text, imageKey = null),
            BookBlock(1, "img", "", imageKey = "img1"),
            BookBlock(2, "p", "   ", imageKey = null),
            BookBlock(3, "p", "Tail", imageKey = null),
        )
        val pages = measurePagesWith(blocks, width = 200, height = 40, gap = 8) { _, remainder ->
            // Each 4-UTF16-unit slice occupies 30px height.
            val end1 = remainder.length.coerceAtMost(4)
            if (remainder.length <= 4) listOf(end1 to 30)
            else listOf(end1 to 30, remainder.length.coerceAtMost(8) to 60)
        }
        assertEquals(5, pages.size)
        assertEquals(0, pages[0].single().offset)
        assertEquals("AB\uD83D\uDCDA", pages[0].single().block.text)
        // Surrogate pair 📚 counts as 1 Unicode code point -> next slice starts at code-point offset 3.
        assertEquals(3, pages[1].single().offset)
        assertEquals("CDEF", pages[1].single().block.text)
        assertEquals(7, pages[2].single().offset)
        assertEquals("GH", pages[2].single().block.text)
        assertEquals("img1", pages[3].single().block.imageKey)
        assertEquals("Tail", pages[4].single().block.text)
        assertTrue(pages.none { it.isEmpty() })
    }

    @Test fun flowsImageInlineWithSurroundingParagraphsWhenSpacePermits() {
        val blocks = listOf(
            BookBlock(0, "h1", "Chapter 1", imageKey = null),
            BookBlock(1, "p", "Lead", imageKey = null),
            BookBlock(2, "img", "", imageKey = "fig1.jpg"),
            BookBlock(3, "p", "NextTail", imageKey = null),
        )
        val sizes = mapOf("fig1.jpg" to BookImageSize(640, 360))
        val pages = measurePagesWith(
            blocks = blocks,
            width = 360,
            height = 400,
            gap = 8,
            measureImage = { computeBookImageHeight(360, 400, sizes[it.imageKey], density = 1f) },
        ) { block, remainder ->
            when (block.index) {
                0 -> listOf(remainder.length to 24)
                1 -> listOf(remainder.length to 20)
                else -> {
                    val split = remainder.length.coerceAtMost(4)
                    if (remainder.length <= 4) listOf(split to 50)
                    else listOf(split to 50, remainder.length to 140)
                }
            }
        }
        assertEquals(2, pages.size)
        assertEquals(listOf(0, 1, 2, 3), pages[0].map { it.block.index })
        assertEquals(203, pages[0][2].imageHeight)
        assertEquals("Next", pages[0][3].block.text)
        assertEquals(4, pages[1].single().offset)
        assertEquals("Tail", pages[1].single().block.text)
    }

    @Test fun startsNewPageWhenImageExceedsRemainingHeightAndFlowsFollowingTextBelowIt() {
        val blocks = listOf(
            BookBlock(0, "p", "Opening", imageKey = null),
            BookBlock(1, "img", "", imageKey = "fig1.jpg"),
            BookBlock(2, "p", "Caption", imageKey = null),
        )
        val pages = measurePagesWith(
            blocks = blocks,
            width = 360,
            height = 300,
            gap = 8,
            measureImage = { 140 },
        ) { block, remainder ->
            if (block.index == 0) listOf(remainder.length to 212) else listOf(remainder.length to 60)
        }
        assertEquals(2, pages.size)
        assertEquals(listOf(0), pages[0].map { it.block.index })
        assertEquals(listOf(1, 2), pages[1].map { it.block.index })
        assertEquals(140, pages[1][0].imageHeight)
    }

    @Test fun clampsTallAndTinyBookImageHeightsWithoutStretchingSmallAssets() {
        assertEquals(203, computeBookImageHeight(360, 400, BookImageSize(640, 360), density = 1f))
        assertEquals(220, computeBookImageHeight(360, 400, BookImageSize(1200, 1800), density = 1f))
        assertEquals(40, computeBookImageHeight(360, 400, BookImageSize(20, 20), density = 2f))
        assertEquals(202, computeBookImageHeight(360, 400, null, density = 1f))
    }
}
