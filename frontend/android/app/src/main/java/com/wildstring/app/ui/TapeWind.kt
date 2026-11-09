package com.wildstring.app.ui

/** A position change larger than this is a seek, not normal playback progress. */
internal const val TapeWindThresholdMs = 2_000L

/** +1 when the position jumped forward (reels wind forward), -1 when it jumped back (rewind), 0 for ordinary progress. */
internal fun tapeWindDirection(previousMs: Long, currentMs: Long): Int {
    val jump = currentMs - previousMs
    return when {
        jump > TapeWindThresholdMs -> 1
        jump < -TapeWindThresholdMs -> -1
        else -> 0
    }
}
