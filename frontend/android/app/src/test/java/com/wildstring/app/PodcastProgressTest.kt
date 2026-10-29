package com.wildstring.app

import com.google.gson.Gson
import com.wildstring.app.data.*
import org.junit.Assert.*
import org.junit.Test

class PodcastProgressTest {
    private fun checkpoint() = EpisodeCheckpoint(EpisodeProgress("episode", version = 5),
        PodcastProgressUpdate("session-one", "device-A", 5, 1, 1200, 3600, "play"))

    @Test fun rewindIsANewEventAndKeepsTheCapturedRevision() {
        val value = checkpoint().checkpoint(300_000, 3600_000, "seek")
        assertEquals(300L, value.update.positionSeconds)
        assertEquals(2L, value.update.sequence)
        assertEquals(5L, value.update.baseVersion)
        assertTrue(value.dirty)
    }
    @Test fun delayedAcknowledgementCannotEraseANewerLocalCheckpoint() {
        val old = checkpoint()
        val newer = old.checkpoint(500_000, 3600_000, "seek")
        val accepted = newer.acknowledged(old.update, EpisodeProgress("episode", version = 6, sessionId = "session-one"))
        assertTrue(accepted.dirty)
        assertEquals(500L, accepted.update.positionSeconds)
        assertEquals(5L, accepted.update.baseVersion)
        val replacement = accepted.copy(update = accepted.update.copy(sessionId = "session-two"))
        assertEquals(replacement, replacement.acknowledged(old.update, EpisodeProgress("episode", version = 7)))
    }
    @Test fun offlineCheckpointSurvivesSerializationAndCannotReclaim() {
        val gson = Gson()
        val pending = gson.fromJson(gson.toJson(checkpoint().checkpoint(1500_000, 3600_000, "progress")), EpisodeCheckpoint::class.java)
        assertTrue(pending.conflictsWith(EpisodeProgress("episode", version = 6, sessionId = "other-session")))
        assertFalse(pending.conflictsWith(EpisodeProgress("episode", version = 6, sessionId = "session-one")))
        assertTrue(pending.copy(conflict = true).conflictsWith(pending.remote))
        assertEquals(1500L, pending.update.positionSeconds)
    }
    @Test fun endedCannotBeLostToTheFollowingPauseOrStop() {
        val ended = checkpoint().checkpoint(3600_000, 3600_000, "ended")
        assertEquals(ended, ended.checkpoint(3600_000, 3600_000, "pause"))
        assertEquals(ended, ended.checkpoint(3600_000, 3600_000, "stop"))
        val replay = ended.checkpoint(0, 3600_000, "seek")
        assertEquals("seek", replay.update.event)
        assertEquals(0L, replay.update.positionSeconds)
    }
    @Test fun conflictKeepsTheLatestLocalPositionWithoutChangingOwnership() {
        val conflict = checkpoint().copy(conflict = true)
        val later = conflict.checkpoint(1500_000, 3600_000, "progress")
        assertTrue(later.conflict)
        assertTrue(later.dirty)
        assertEquals(1500L, later.update.positionSeconds)
        assertEquals(conflict.update.sessionId, later.update.sessionId)
        assertEquals(conflict.update.baseVersion, later.update.baseVersion)
        assertTrue(later.conflictsWith(EpisodeProgress("episode", version = 10, sessionId = "new-device")))
    }
}
