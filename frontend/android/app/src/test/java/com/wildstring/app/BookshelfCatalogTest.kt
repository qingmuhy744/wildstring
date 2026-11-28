package com.wildstring.app

import com.wildstring.app.data.BookManifest
import com.wildstring.app.data.BookSummary
import com.wildstring.app.data.canManageBooks
import com.wildstring.app.data.ebookContents
import com.wildstring.app.data.networkGson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BookshelfCatalogTest {
    private val gson = networkGson()

    @Test fun onlyLibraryManagersCanManageBooks() {
        assertEquals(listOf(true, true, false, false, false),
            listOf("owner", "librarian", "editor", "listener", null).map(::canManageBooks))
    }

    @Test fun catalogReadsCreditsAndSeriesFromServerAndOldCache() {
        val common = """"id":"book","title":"Story","library_id":"library","has_ebook":true,"authors":["Author"]"""
        val old = gson.fromJson("{$common}", BookSummary::class.java)
        assertNull(old.narrators)
        assertNull(old.ebookSummary)
        val updated = gson.fromJson(
            """{$common,"narrators":["Narrator"],"series_name":"Story","series_index":2,"ebook_summary":{"format":"txt","chapter_count":3,"total_chars":500}}""",
            BookSummary::class.java,
        )
        assertEquals(listOf("Author"), updated.authors)
        assertEquals(listOf("Narrator"), updated.narrators)
        assertEquals("Story", updated.seriesName)
        assertEquals(2.0, updated.seriesIndex!!, 0.0)
        assertEquals(3, updated.ebookSummary?.chapterCount)
    }

    @Test fun contentsPreservesRealSpineIndicesAndFallsBackForUntitledBooks() {
        val manifest = gson.fromJson(
            """{"sha256":"original","content_revision":"r2","chapters":[
                {"spine_index":0,"title":"Segment 1","level":0},
                {"spine_index":1,"title":"Part 1","level":1},
                {"spine_index":2,"title":"Volume 1","level":2},
                {"spine_index":3,"title":"Chapter 1","level":3},
                {"spine_index":4,"title":"Segment 5","level":0}
            ]}""".trimIndent(),
            BookManifest::class.java,
        )
        assertEquals(listOf(1, 2, 3), manifest.chapters.ebookContents().map { it.index })
        assertEquals(listOf(0, 4), manifest.chapters.filter { it.level == 0 }.ebookContents().map { it.index })
        assertEquals("original:r2", manifest.cacheKey)
    }
}
