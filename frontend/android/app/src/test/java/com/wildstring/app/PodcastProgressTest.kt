package com.wildstring.app

import com.google.gson.Gson
import com.wildstring.app.data.*
import org.junit.Assert.*
import org.junit.Test

class PodcastProgressTest {
    private fun checkpoint() = EpisodeCheckpoint(EpisodeProgress("episode", version = 5),
        PodcastProgressUpdate("session-one", "device-A", 5, 1, 1200, 3600, "play"))

    @Test fun oldOutboxJsonHasNoIntentAndNewIntentSurvivesCheckpoints() {
        val old = Gson().fromJson(Gson().toJson(checkpoint()), EpisodeCheckpoint::class.java)
        assertNull(old.update.intent)
        val resumed = old.copy(update = old.update.copy(intent = "resume")).checkpoint(1800_000, 3600_000, "pause")
        val restored = Gson().fromJson(Gson().toJson(resumed), EpisodeCheckpoint::class.java)
        assertEquals("resume", restored.update.intent)
        assertEquals("pause", restored.update.event)
    }
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

    @Test fun resumingThePreparedEpisodeDoesNotPrepareAgain() {
        assertFalse(podcastResumeNeedsPreparation("episode-entry", "episode-entry", ownsProgress = true, ended = false))
        // A finished episode starts a new session so the completed rule and next episode apply.
        assertTrue(podcastResumeNeedsPreparation("episode-entry", "episode-entry", ownsProgress = true, ended = true))
        // Another item, a lost ownership or a never prepared item all need a fresh preparation.
        assertTrue(podcastResumeNeedsPreparation("episode-entry", "other-entry", ownsProgress = true, ended = false))
        assertTrue(podcastResumeNeedsPreparation("episode-entry", "episode-entry", ownsProgress = false, ended = false))
        assertTrue(podcastResumeNeedsPreparation(null, "episode-entry", ownsProgress = true, ended = false))
    }

    @Test fun askModeOnlyPromptsWhenADialogCanBeShown() {
        assertTrue(podcastShouldAskPosition("ask", null, automatic = false, restart = false, positionMs = 1_200_000, hosted = true))
        assertFalse(podcastShouldAskPosition("ask", null, automatic = false, restart = false, positionMs = 1_200_000, hosted = false))
        assertFalse(podcastShouldAskPosition("ask", null, automatic = true, restart = false, positionMs = 1_200_000, hosted = true))
        assertFalse(podcastShouldAskPosition("ask", null, automatic = false, restart = true, positionMs = 1_200_000, hosted = true))
        assertFalse(podcastShouldAskPosition("ask", 600_000L, automatic = false, restart = false, positionMs = 600_000, hosted = true))
        assertFalse(podcastShouldAskPosition("auto", null, automatic = false, restart = false, positionMs = 1_200_000, hosted = true))
        assertFalse(podcastShouldAskPosition("ask", null, automatic = false, restart = false, positionMs = 0, hosted = true))
    }
}
