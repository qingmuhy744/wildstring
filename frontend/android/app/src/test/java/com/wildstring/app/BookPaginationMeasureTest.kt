package com.wildstring.app

import com.wildstring.app.data.BookBlock
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
}
