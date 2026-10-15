package com.wildstring.app

import com.wildstring.app.data.ArtworkPixels
import org.junit.Assert.*
import org.junit.Test

class ArtworkPixelsTest {
    @Test fun dominantColorComesFromArtworkRatherThanNeutralPixels() {
        val blue = 0xFF1450D2.toInt()
        val tint = ArtworkPixels.tint(IntArray(64) { if (it < 48) blue else 0xFFFFFFFF.toInt() })
        assertEquals(blue, tint)
    }
    @Test fun blurSoftensEdgesWithoutMutatingTheSource() {
        val input = IntArray(256) { if (it % 16 < 8) 0xFF000000.toInt() else 0xFFFFFFFF.toInt() }
        val original = input.copyOf()
        val blurred = ArtworkPixels.blur(input, 16, 16, 2)
        assertArrayEquals(original, input)
        assertTrue((blurred[7] and 255) in 1..254)
        assertTrue((blurred[8] and 255) in 1..254)
        assertEquals(0xFF1A3456.toInt(), ArtworkPixels.blur(intArrayOf(0xFF1A3456.toInt()), 1, 1).single())
    }
    @Test fun invalidDimensionsCannotAllocateAnUnboundedBlur() {
        assertThrows(IllegalArgumentException::class.java) { ArtworkPixels.blur(IntArray(4), 1000, 1000) }
        assertThrows(IllegalArgumentException::class.java) { ArtworkPixels.blur(IntArray(4), 2, 2, 1000) }
    }
}
