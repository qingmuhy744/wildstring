package com.wildstring.app

import com.wildstring.app.data.Preferences
import com.wildstring.app.data.SongListSize
import org.junit.Assert.*
import org.junit.Test

class SongListSizeTest {
    @Test fun freshAndInvalidStoredPreferencesUseRecommendedMedium() {
        assertEquals(SongListSize.MEDIUM, Preferences().songListSize)
        listOf(null, "", "huge", "SMALL", "small ").forEach { value ->
            assertEquals("Unknown setting $value must preserve the default layout", SongListSize.MEDIUM, SongListSize.fromStored(value))
        }
    }
    @Test fun storedOptionsRoundTripAndKeepActionTargetsAvailable() {
        SongListSize.entries.forEach { size ->
            assertEquals(size, SongListSize.fromStored(size.key))
            assertTrue("A song action needs at least 48 dp plus vertical padding", size.rowDp >= 48 + 8)
            assertTrue("The cover must fit inside the row", size.coverDp + 8 <= size.rowDp)
        }
        assertTrue(SongListSize.SMALL.rowDp < SongListSize.MEDIUM.rowDp)
        assertTrue(SongListSize.MEDIUM.rowDp < SongListSize.LARGE.rowDp)
        assertEquals(64, SongListSize.MEDIUM.rowDp)
        assertEquals(44, SongListSize.MEDIUM.coverDp)
        assertEquals(16, SongListSize.MEDIUM.titleSp)
    }
}
