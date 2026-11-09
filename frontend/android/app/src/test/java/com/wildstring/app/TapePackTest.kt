package com.wildstring.app

import com.wildstring.app.ui.tapePackRadii
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TapePackTest {
    @Test fun supplyShrinksAsTakeUpGrows() {
        val start = tapePackRadii(0f)
        val end = tapePackRadii(1f)
        assertTrue(start.first > start.second)
        assertTrue(end.first < end.second)
        assertEquals(start.first, end.second, 1e-4f)
        assertEquals(start.second, end.first, 1e-4f)
    }

    @Test fun totalTapeAreaStaysConstant() {
        val area = { p: Float -> tapePackRadii(p).let { it.first * it.first + it.second * it.second } }
        assertEquals(area(0f), area(.37f), 1e-4f)
        assertEquals(area(0f), area(1f), 1e-4f)
    }

    @Test fun outOfRangeProgressIsClamped() {
        assertEquals(tapePackRadii(0f), tapePackRadii(-1f))
        assertEquals(tapePackRadii(1f), tapePackRadii(2f))
    }
}
