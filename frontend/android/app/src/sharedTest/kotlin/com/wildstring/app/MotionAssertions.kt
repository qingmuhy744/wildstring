package com.wildstring.app

import kotlin.math.abs

/**
 * Frame-by-frame checks for animations that must read as one continuous movement.
 *
 * A screenshot or a single before/after layout cannot show a second jump, a button that re-spaces
 * after the animation has landed, or a container trailing the content it hosts. Record one value per
 * frame (an edge position in px, a pixel count) with the Compose test clock stepped by hand, then
 * hand the series to these functions. Each returns the problems it found, so a test can print them
 * together with the recorded table.
 *
 * Pure Kotlin on purpose: the JVM unit tests in `MotionAssertionsTest` prove that the checks tell a
 * smooth curve from a jump, and the instrumented tests reuse the same code.
 */
object MotionAssertions {
    /** Movement shorter than this is treated as rounding noise, not as an animation. */
    const val MIN_TRAVEL_PX = 10f

    /** A step smaller than this counts as "not moving". */
    private const val STILL_PX = 0.5f

    /**
     * [edge] is one value per frame, for example the left edge of a button or the bottom of a panel.
     *
     * - No single frame takes more than [maxShare] of the total travel (a jump).
     * - The fastest frame is not in the last third of the movement. An ease-out slows down towards
     *   the end, so a late maximum means something was removed or re-laid-out when the animation ended.
     */
    fun continuousCurve(name: String, edge: List<Float>, maxShare: Float = 0.35f): List<String> {
        if (edge.size < 2) return emptyList()
        val travel = abs(edge.last() - edge.first())
        if (travel < MIN_TRAVEL_PX) return emptyList()
        val steps = edge.zipWithNext { a, b -> b - a }
        val problems = mutableListOf<String>()
        val biggest = steps.maxOf { abs(it) }
        if (biggest > travel * maxShare) problems += "The $name moved %.1f of %.1f px in one frame".format(biggest, travel)
        val moving = steps.indices.filter { abs(steps[it]) > STILL_PX }
        if (moving.size >= 4) {
            val first = moving.first()
            val last = moving.last()
            val peak = steps.indices.maxBy { abs(steps[it]) }
            if (peak > first + 0.65f * (last - first)) problems += "The $name moves fastest near the end of the switch (frame $peak of $first..$last)"
        }
        return problems
    }

    /** Two edges that belong together keep a constant distance during the whole movement. */
    fun movesTogether(name: String, first: List<Float>, second: List<Float>, tolerancePx: Float = 2f): List<String> {
        val gap = first.zip(second) { a, b -> b - a }
        if (gap.isEmpty() || gap.max() - gap.min() <= tolerancePx) return emptyList()
        return listOf("The $name drifted by up to %.1f px".format(gap.max() - gap.min()))
    }

    /** An edge that must not move at all, for example the top of a panel that hangs from a fixed header. */
    fun staysPut(name: String, edge: List<Float>, tolerancePx: Float = 2f): List<String> =
        if (edge.isEmpty() || edge.max() - edge.min() <= tolerancePx) emptyList()
        else listOf("The $name moved %.1f px; it must stay put".format(edge.max() - edge.min()))

    /**
     * After [settleMs] nothing may move and no pixel may change. [times], [edge] and [changedPixels]
     * are parallel per-frame series; a changed-pixel value of -1 means the size changed, so no
     * comparison was possible.
     */
    fun landsAndStays(
        name: String, times: List<Int>, edge: List<Float>, changedPixels: List<Int>, settleMs: Int = 320,
    ): List<String> {
        val problems = mutableListOf<String>()
        val late = times.indices.filter { times[it] >= settleMs }
        if (late.isEmpty()) return problems
        val moved = late.maxOf { edge[it] } - late.minOf { edge[it] }
        if (moved > 1f) problems += "The $name was still moving after $settleMs ms"
        val flashes = late.filter { changedPixels[it] > 0 }
        if (flashes.isNotEmpty()) problems += "The $name still changed after landing: " + flashes.joinToString { "t=${times[it]}ms ${changedPixels[it]}px" }
        return problems
    }
}
