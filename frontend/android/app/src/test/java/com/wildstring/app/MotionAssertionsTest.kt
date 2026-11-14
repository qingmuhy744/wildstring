package com.wildstring.app

import kotlin.math.pow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The checks must tell a real ease from the two defects they exist for, or a green run means nothing. */
class MotionAssertionsTest {
    /** 15 frames of `FastOutSlowInEasing` (cubic-bezier .4, 0, .2, 1) over [travel] px, starting at [from]. */
    private fun ease(from: Float, travel: Float, frames: Int = 15): List<Float> {
        fun bezier(s: Double, p1: Double, p2: Double) = 3 * (1 - s).pow(2) * s * p1 + 3 * (1 - s) * s * s * p2 + s.pow(3)
        fun at(t: Double): Double {
            var lo = 0.0; var hi = 1.0
            repeat(40) { val mid = (lo + hi) / 2; if (bezier(mid, .4, .2) < t) lo = mid else hi = mid }
            return bezier((lo + hi) / 2, 0.0, 1.0)
        }
        return (0..frames).map { from + (travel * at(it / frames.toDouble())).toFloat() }
    }

    @Test fun aSmoothEaseIsAccepted() {
        assertEquals(emptyList<String>(), MotionAssertions.continuousCurve("panel", ease(1379f, 126f)))
        assertEquals(emptyList<String>(), MotionAssertions.continuousCurve("panel", ease(1379f, -126f)))
    }

    @Test fun aMovementThatIsTooSmallToSeeIsNotJudged() {
        assertEquals(emptyList<String>(), MotionAssertions.continuousCurve("panel", listOf(100f, 101f, 102f, 103f)))
    }

    @Test fun aRowThatCollapsesInOneFrameIsReported() {
        // Measured on the old control bar: 1463 -> 1526 in a single frame at the end of the exit.
        val edge = ease(1400f, 63f, frames = 14) + listOf(1526f)
        val problems = MotionAssertions.continuousCurve("controls", edge + List(10) { 1526f })
        assertTrue(problems.toString(), problems.any { "in one frame" in it })
    }

    @Test fun buttonsThatRespaceAfterTheEaseHasEndedAreReported() {
        // Measured on the old bottom row: the buttons ease to x=198 over 240 ms, then jump to 158.
        val easeThenJump = ease(205f, -7f) + listOf(158f, 158f, 158f)
        val problems = MotionAssertions.continuousCurve("rewind button", easeThenJump)
        assertTrue(problems.toString(), problems.isNotEmpty())
    }

    @Test fun anEaseWhoseFastestFrameComesLastIsReported() {
        // Accelerating into the end: no single frame is huge, but the motion speeds up when it should settle.
        val edge = (0..15).map { 100f + (it / 15f).toDouble().pow(3.0).toFloat() * 100f }
        val problems = MotionAssertions.continuousCurve("panel", edge, maxShare = 0.5f)
        assertTrue(problems.toString(), problems.any { "fastest near the end" in it })
    }

    @Test fun edgesThatKeepTheirDistanceMoveTogether() {
        val panel = ease(1379f, 126f)
        assertEquals(emptyList<String>(), MotionAssertions.movesTogether("panel", panel, panel.map { it + 21f }))
        val trailing = ease(1379f, 126f).let { fast -> fast to fast.map { it + 21f }.drop(3) + List(3) { fast.last() + 21f } }
        assertTrue(MotionAssertions.movesTogether("panel", trailing.first, trailing.second).isNotEmpty())
    }

    @Test fun anEdgeThatShouldStayPutIsHeldToIt() {
        assertEquals(emptyList<String>(), MotionAssertions.staysPut("top edge", List(10) { 215f }))
        assertTrue(MotionAssertions.staysPut("top edge", listOf(215f, 219f, 232f, 222f, 215f)).isNotEmpty())
    }

    @Test fun nothingMayMoveOrRepaintAfterLanding() {
        val times = (1..30).map { it * 16 }
        val still = List(30) { 1505f }
        assertEquals(emptyList<String>(), MotionAssertions.landsAndStays("panel", times, still, List(30) { if (it < 15) -1 else 0 }))

        // Index 22 is t=368ms, past the 320ms settle point: a repaint here is the "flash after landing".
        val flashes = List(30) { if (it == 22) 19415 else 0 }
        val flash = MotionAssertions.landsAndStays("controls", times, still, flashes)
        assertTrue(flash.toString(), flash.any { "still changed after landing" in it && "t=368ms 19415px" in it })

        // A repaint before the settle point is the animation itself and must not be reported.
        val early = List(30) { if (it == 10) 19415 else 0 }
        assertEquals(emptyList<String>(), MotionAssertions.landsAndStays("controls", times, still, early))

        // The panel is at rest at t=320ms, then moves 20 px: both values fall inside the window.
        val lateMove = still.mapIndexed { index, value -> if (index >= 25) value + 20f else value }
        assertTrue(MotionAssertions.landsAndStays("panel", times, lateMove, List(30) { 0 }).any { "still moving" in it })
    }
}
