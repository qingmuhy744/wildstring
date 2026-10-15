package dev.wildstring.app

import dev.wildstring.app.playback.ListeningClock
import org.junit.Assert.assertEquals
import org.junit.Test

class ListeningClockTest {
    @Test fun countsAdvancementButNotBufferingPausedTimeOrSeeks() {
        val clock = ListeningClock()
        clock.reset(0, 0, true)
        assertEquals(3000L, clock.sample(5000, 3000, true))
        assertEquals(3000L, clock.sample(10000, 3000, false))
        assertEquals(3000L, clock.sample(20000, 3000, false))
        clock.reset(20000, 90000, true)
        assertEquals(4000L, clock.sample(21000, 91000, true))
    }
    @Test fun capsReportedAdvancementByMonotonicTime() {
        val clock = ListeningClock()
        clock.reset(100, 100, true)
        assertEquals(500L, clock.sample(600, 10000, true))
        assertEquals(500L, clock.sample(700, 0, true))
    }
}
