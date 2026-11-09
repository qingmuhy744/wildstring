package com.wildstring.app

import com.wildstring.app.ui.tapeWindDirection
import org.junit.Assert.assertEquals
import org.junit.Test

class TapeWindTest {
    @Test fun ordinaryProgressIsNotAWind() {
        assertEquals(0, tapeWindDirection(10_000, 10_250))
        assertEquals(0, tapeWindDirection(10_000, 12_000))
        assertEquals(0, tapeWindDirection(10_000, 10_000))
    }

    @Test fun forwardSeekWindsForward() = assertEquals(1, tapeWindDirection(10_000, 60_000))

    @Test fun backwardSeekRewinds() = assertEquals(-1, tapeWindDirection(60_000, 10_000))
}
