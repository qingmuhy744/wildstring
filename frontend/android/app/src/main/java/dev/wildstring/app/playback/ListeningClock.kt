package dev.wildstring.app.playback

/** Counts actual media advancement, bounded by monotonic elapsed time. */
class ListeningClock {
    var totalMs = 0L
        private set
    private var wall = 0L
    private var position = 0L
    private var wasPlaying = false
    fun reset(now: Long, mediaPosition: Long, playing: Boolean) {
        wall = now; position = mediaPosition; wasPlaying = playing
    }
    fun sample(now: Long, mediaPosition: Long, playing: Boolean): Long {
        if (wasPlaying) totalMs += (mediaPosition - position).coerceAtLeast(0).coerceAtMost((now - wall).coerceAtLeast(0))
        reset(now, mediaPosition, playing)
        return totalMs
    }
}
