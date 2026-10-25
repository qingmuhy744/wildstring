package com.wildstring.app

import com.wildstring.app.data.*
import org.junit.Assert.*
import org.junit.Test

class CatalogWindowTest {
    private fun page(offset: Int, total: Int = 1300) = CatalogPage(tracks =
        (offset until minOf(offset + 50, total)).map { Track("song-$it", "歌曲 $it", listOf("艺人"), "专辑", 180000) }, total = total)

    @Test fun alphabetJumpAndEarlierPagesKeepAbsolutePositions() {
        val window = CatalogWindow().withPage(0, page(0)).withPage(1000, page(1000)).withPage(950, page(950))
        assertEquals("song-1027", window.trackAt(1027)?.id)
        assertEquals("song-999", window.trackAt(999)?.id)
        assertNull(window.trackAt(500))
        assertEquals(1300, window.total)
    }

    @Test fun evictedPagesRemainMissingWithoutRenumberingOtherRows() {
        var window = CatalogWindow()
        for (offset in 0 until 1300 step 50) window = window.withPage(offset, page(offset))
        assertEquals(24, window.pages.size)
        assertNull(window.trackAt(0))
        assertEquals("song-1299", window.trackAt(1299)?.id)
        window = window.withPage(0, page(0))
        assertEquals("song-0", window.trackAt(0)?.id)
        assertEquals(1300, window.total)
    }

    @Test fun changedCollectionCannotSilentlyMergeIntoExistingWindow() {
        val window = CatalogWindow().withPage(0, page(0))
        assertThrows(IllegalArgumentException::class.java) { window.withPage(50, page(50, 1299)) }
    }

    @Test fun indexIsOnlyAvailableForNameOrderedCatalogs() {
        val query = CatalogQuery(tab = "library", kind = "tracks")
        assertTrue(query.indexed)
        assertFalse(query.copy(order = "desc").indexed)
        assertTrue(query.copy(collection = "artists", collectionId = "artist").indexed)
        assertFalse(query.copy(sort = "play_count").indexed)
        assertFalse(query.copy(kind = "recent").indexed)
        assertFalse(query.copy(collection = "albums", collectionId = "album").indexed)
        assertFalse(query.copy(collection = "artists", collectionId = "artist", albumFilter = "album").indexed)
        assertFalse(query.copy(collection = "playlists", collectionId = "favorites").indexed)
    }
    @Test fun librarySelectionHasAnIndependentCatalogCacheIdentity() {
        val all = CatalogQuery(tab = "library", kind = "tracks")
        assertNotEquals(all.key, all.copy(libraryId = "classical").key)
        assertNotEquals(all.copy(libraryId = "pop").key, all.copy(libraryId = "classical").key)
    }

}
