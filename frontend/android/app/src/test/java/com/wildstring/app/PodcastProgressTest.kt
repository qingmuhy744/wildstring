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
    @Test fun onlyAutomaticContinuationSkipsCompletedEpisodes() {
        assertFalse(podcastSkipsCompleted(completed = true, automatic = true, explicitRestart = true))
        assertTrue(podcastSkipsCompleted(completed = true, automatic = true))
        assertFalse(podcastSkipsCompleted(completed = true, automatic = false))
        assertFalse(podcastSkipsCompleted(completed = false, automatic = true))
    }
    @Test fun userStartedCompletedEpisodeRestartsFromTheBeginning() {
        assertTrue(podcastShouldRestart(true, automatic = false, explicitRestart = false, requestedMs = null, mode = "auto"))
        assertTrue(podcastShouldRestart(true, automatic = false, explicitRestart = false, requestedMs = 90_000, mode = "ask"))
        assertFalse(podcastShouldRestart(false, automatic = false, explicitRestart = false, requestedMs = null, mode = "auto"))
        assertFalse(podcastShouldRestart(false, automatic = false, explicitRestart = false, requestedMs = 90_000, mode = "restart"))
        assertTrue(podcastShouldRestart(false, automatic = false, explicitRestart = false, requestedMs = null, mode = "restart"))
        assertTrue(podcastShouldRestart(false, automatic = true, explicitRestart = true, requestedMs = null, mode = "auto"))
    }
    @Test fun automaticNextMarkerOnlyMatchesItsOwnEpisode() {
        assertTrue(podcastAutomaticNextMatches("next", "next"))
        assertFalse(podcastAutomaticNextMatches("next", "other"))
        assertFalse(podcastAutomaticNextMatches(null, "next"))
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

    @Test fun resumeUsesLatestOperationRatherThanMaximumPosition() {
        val local = checkpoint().copy(update = checkpoint().update.copy(deviceId = "device-A", sessionId = "session-one", sequence = 4))
        val own = EpisodeProgress("episode", version = 8, sessionId = "session-one", deviceId = "device-A", sequence = 3, positionSeconds = 900)
        assertEquals(1_210_000L, podcastResumePosition(own, local, 1_210_000L))
        assertEquals(600_000L, podcastResumePosition(own.copy(sessionId = "other", deviceId = "device-B", positionSeconds = 600), local, 1_210_000L))
        assertEquals(1_210_000L, podcastResumePosition(null, local.copy(conflict = true), 1_210_000L))
        assertEquals(1_200_000L, podcastResumePosition(null, local.copy(conflict = true), null))
        assertEquals(0L, podcastResumePosition(null, null, null))
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
