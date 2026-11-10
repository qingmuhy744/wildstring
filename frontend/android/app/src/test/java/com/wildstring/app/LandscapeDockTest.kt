package com.wildstring.app

import com.wildstring.app.ui.LandscapeDock
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

class LandscapeDockTest {
    private val g = 9.81f
    private fun leanedBack(degrees: Double, xSign: Float = 1f, zSign: Float = 1f) =
        Triple(xSign * g * cos(Math.toRadians(degrees)).toFloat(), 0f, zSign * g * sin(Math.toRadians(degrees)).toFloat())

    @Test fun sidewaysOnAStandCountsInBothDirections() {
        for (lean in listOf(0.0, 15.0, 40.0, 50.0, 60.0, 70.0, 75.0, 78.0)) {
            for (xSign in listOf(-1f, 1f)) for (zSign in listOf(-1f, 1f)) {
                val (x, y, z) = leanedBack(lean, xSign, zSign)
                assertTrue("lean $lean, xSign $xSign, zSign $zSign", LandscapeDock().update(x, y, z))
            }
        }
    }

    @Test fun flatAndNearlyFlatDoNotStartTheTimer() {
        val dock = LandscapeDock()
        assertFalse(dock.update(0f, 0f, g))
        assertFalse(dock.update(0f, 0f, -g))
        assertFalse(dock.update(1.7f, .5f, 9.6f))
        val (x, y, z) = leanedBack(80.0)
        assertFalse(dock.update(x, y, z))
        assertTrue(dock.update(g, 0f, 0f))
        assertFalse(dock.update(1.7f, .5f, 9.6f))
    }

    @Test fun portraitDoesNotCount() {
        val dock = LandscapeDock()
        assertFalse(dock.update(0f, g, 0f))
        assertFalse(dock.update(.5f, 9.4f, 2.5f))
        assertFalse(dock.update(3f, 4f, 8.5f))
    }

    @Test fun smallMovementsNearTheEntryAngleKeepTheTimerRunning() {
        val dock = LandscapeDock()
        val (x, y, z) = leanedBack(78.0)
        assertTrue(dock.update(x, y, z))
        val (xMoved, yMoved, zMoved) = leanedBack(79.0)
        assertTrue(dock.update(xMoved, yMoved, zMoved))
        val (xFlat, yFlat, zFlat) = leanedBack(80.0)
        assertFalse(dock.update(xFlat, yFlat, zFlat))
        assertFalse(dock.update(xMoved, yMoved, zMoved))
    }

    @Test fun smallMovementsNearTheSidewaysBoundaryKeepTheTimerRunning() {
        val dock = LandscapeDock()
        assertTrue(dock.update(5f, 3f, 7.9f))
        assertTrue(dock.update(4f, 3.8f, 8.1f))
        assertFalse(dock.update(3.8f, 4f, 8.1f))
    }

    @Test fun mildAccelerationDoesNotResetButStrongShakingDoes() {
        val dock = LandscapeDock()
        assertTrue(dock.update(g, 0f, 0f))
        assertTrue(dock.update(8f, 0f, 0f))
        assertTrue(dock.update(12.5f, 0f, 0f))
        assertFalse(dock.update(16f, 0f, 0f))
        assertFalse(dock.update(5f, 0f, 0f))
    }

    @Test fun aPromptIsRearmedOnlyAfterReturningToPortrait() {
        val dock = LandscapeDock()
        assertTrue(dock.update(g, 0f, 0f))
        dock.prompted()
        assertFalse(dock.armed)
        assertFalse(dock.update(0f, 0f, g))
        assertTrue(dock.update(g, 0f, 0f))
        assertFalse(dock.armed)
        dock.stop()
        assertTrue(dock.update(g, 0f, 0f))
        assertFalse(dock.armed)
        assertFalse(dock.update(0f, g, 0f))
        assertTrue(dock.armed)
        assertTrue(dock.update(-g, 0f, 0f))
        assertTrue(dock.armed)
    }
}
