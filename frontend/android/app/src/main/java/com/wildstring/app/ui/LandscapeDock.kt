package com.wildstring.app.ui

import kotlin.math.abs
import kotlin.math.sqrt

/** Tracks a sideways phone on a stand, allowing a little movement without restarting the prompt timer. */
internal class LandscapeDock {
    var held = false
        private set
    var armed = true
        private set

    fun update(x: Float, y: Float, z: Float): Boolean {
        val magnitude = sqrt(x * x + y * y + z * z)
        val stable = magnitude in 7f..13f
        val horizontal = abs(x)
        val vertical = abs(y)
        if (stable && vertical >= magnitude * .5f && vertical > horizontal * 1.2f) armed = true
        // Enter at roughly 12° above flat; keep the pose until it falls below roughly 10°.
        // The wider exit thresholds also absorb small movements around the horizontal/vertical boundary.
        held = stable && horizontal > magnitude * (if (held) .18f else .20f) &&
            horizontal > vertical * (if (held) 1f else 1.2f)
        return held
    }

    fun prompted() { armed = false }
    fun stop() { held = false }
}
