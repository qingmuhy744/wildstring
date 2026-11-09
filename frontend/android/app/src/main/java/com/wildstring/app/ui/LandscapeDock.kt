package com.wildstring.app.ui

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * True when gravity says the phone stands on its long edge, as on a stand: gravity runs along the short axis (x), the long axis (y)
 * is nearly level, and the screen is not lying flat. A stand leans the phone back 15 to 40 degrees, so some z is expected.
 * Values are the accelerometer in m/s² in the device frame; a phone being shaken (magnitude far from 1g) is rejected.
 */
internal fun isDockedLandscape(x: Float, y: Float, z: Float): Boolean {
    val magnitude = sqrt(x * x + y * y + z * z)
    return magnitude in 8.8f..10.8f && abs(x) >= 6.5f && abs(y) <= 3.5f && abs(z) <= 7.5f
}
