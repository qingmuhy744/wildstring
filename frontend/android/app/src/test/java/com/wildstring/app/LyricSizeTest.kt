package com.wildstring.app

import com.wildstring.app.data.LyricSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LyricSizeTest {
    @Test fun unknownStoredValuesUseTheRecommendedMediumPreset() {
        assertEquals(LyricSize.MEDIUM, LyricSize.fromStored(null))
        assertEquals(LyricSize.MEDIUM, LyricSize.fromStored("unknown"))
    }

    @Test fun presetsKeepAStableReadableOrder() {
        assertTrue(LyricSize.SMALL.scale < LyricSize.MEDIUM.scale)
        assertTrue(LyricSize.MEDIUM.scale < LyricSize.LARGE.scale)
        LyricSize.entries.forEach { assertEquals(it, LyricSize.fromStored(it.key)) }
    }
}
