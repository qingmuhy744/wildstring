package com.wildstring.app

import com.wildstring.app.ui.isDockedLandscape
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

class LandscapeDockTest {
    private val g = 9.81f
    private fun leanedBack(degrees: Double, sign: Float = 1f) = Triple(sign * g * cos(Math.toRadians(degrees)).toFloat(), 0f, g * sin(Math.toRadians(degrees)).toFloat())

    @Test fun uprightLandscapeEitherWayCounts() {
        assertTrue(isDockedLandscape(g, 0f, 0f))
        assertTrue(isDockedLandscape(-g, 0f, 0f))
    }

    @Test fun aStandLeaningTheScreenBackCounts() {
        listOf(15.0, 25.0, 40.0).forEach { lean ->
            val (x, y, z) = leanedBack(lean)
            assertTrue("lean $lean", isDockedLandscape(x, y, z))
        }
    }

    @Test fun lyingFlatNeverCounts() {
        assertFalse(isDockedLandscape(0f, 0f, g))
        assertFalse(isDockedLandscape(0f, 0f, -g))
        assertFalse(isDockedLandscape(1.7f, .5f, 9.6f))
    }

    @Test fun nearlyFlatOnADeskDoesNotCount() {
        val (x, y, z) = leanedBack(70.0)
        assertFalse(isDockedLandscape(x, y, z))
    }

    @Test fun portraitDoesNotCount() {
        assertFalse(isDockedLandscape(0f, g, 0f))
        assertFalse(isDockedLandscape(.5f, 9.4f, 2.5f))
    }

    @Test fun shakingIsRejected() {
        assertFalse(isDockedLandscape(16f, 0f, 0f))
        assertFalse(isDockedLandscape(5f, 0f, 0f))
    }
}
