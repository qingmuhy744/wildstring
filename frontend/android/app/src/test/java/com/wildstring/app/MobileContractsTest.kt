package com.wildstring.app

import com.google.gson.Gson
import com.wildstring.app.data.*
import com.wildstring.app.playback.SleepPlan
import org.junit.Assert.*
import org.junit.Test

class MobileContractsTest {
    private val gson = Gson()
    @Test fun serverDatesAndListeningStatisticsDeserialize() {
        val track = gson.fromJson("""{"id":"a","title":"歌","artists":["艺人"],"duration_ms":5000,"play_count":7,"listened_ms":12345,"last_played_at":"2026-10-17T12:00:00+00:00"}""", Track::class.java)
        assertEquals(7, track.playCount)
        assertEquals(12345L, track.listenedMs)
        assertEquals("2026-10-17T12:00:00+00:00", track.lastPlayedAt)
        val summary = gson.fromJson("""{"play_count":8,"listened_ms":1000,"tracks_played":2,"favorites":1}""", ListeningSummary::class.java)
        assertEquals(2, summary.playedTracks); assertEquals(1, summary.lovedTracks)
    }
    @Test fun explicitNullRestoresFileLyricsInsteadOfDroppingTheField() {
        val body = com.google.gson.JsonObject().apply { add("text", com.google.gson.JsonNull.INSTANCE) }
        assertEquals("{\"text\":null}", networkGson().toJson(body))
    }
    @Test fun manualPlaylistNullDefinitionIsAccepted() {
        val playlist = gson.fromJson("{\"id\":\"p\",\"name\":\"普通\",\"kind\":\"manual\",\"version\":1,\"track_count\":0,\"definition\":null}", Playlist::class.java)
        assertEquals("manual", playlist.kind); assertNull(playlist.definition)
    }
    @Test fun smartPlaylistUpdatePreservesItsKindAndDefinition() {
        val definition = com.google.gson.JsonParser.parseString("{\"all\":[{\"is\":{\"loved\":true}}]}").asJsonObject
        val body = gson.toJsonTree(PlaylistUpdate("规则", 2, definition, "smart")).asJsonObject
        assertEquals("smart", body["kind"].asString); assertEquals(definition, body["definition"])
    }
    @Test fun remoteOffersRequireExplicitRecentPauseAndPersistedPauseIdentity() {
        val pause = SharedPlayback(version = 8, deviceId = "other", trackIds = listOf("a"), playbackState = "paused",
            pausedAt = "2026-10-19T10:00:00Z", handoffSupported = true, handoffEligible = true)
        assertTrue(pause.canOfferHandoff("local", 7, null))
        assertFalse(pause.copy(playbackState = "playing").canOfferHandoff("local", 7, null))
        assertFalse(pause.copy(handoffEligible = false).canOfferHandoff("local", 7, null))
        assertFalse(pause.copy(pausedAt = null).canOfferHandoff("local", 7, null))
        assertFalse(pause.canOfferHandoff("other", 7, null))
        assertFalse(pause.canOfferHandoff("local", 8, null))
        assertFalse(pause.copy(version = 9).canOfferHandoff("local", 7, pause.pauseEvent()))
        assertTrue(pause.copy(version = 9, pausedAt = "2026-10-19T10:01:00Z").canOfferHandoff("local", 7, pause.pauseEvent()))
        val write = pause.writeBody()
        assertEquals("paused", write.get("playback_state").asString)
        assertFalse(write.has("paused_at")); assertFalse(write.has("handoff_eligible")); assertFalse(write.has("handoff_supported"))
        assertFalse(pause.writeBody(includePlaybackState = false).has("playback_state"))
        assertFalse(SharedPlayback(version = 10, deviceId = "old", trackIds = listOf("a")).isRecentPausedHandoff())
    }
    @Test fun sharedSnapshotWriteExcludesReadOnlyTimestampAndKeepsDuplicates() {
        val snapshot = SharedPlayback(version = 4, deviceId = "device", trackIds = listOf("a", "a"), index = 1, positionMs = 1000, mode = "repeat_all")
        val json = networkGson().toJsonTree(snapshot.writeBody()).asJsonObject
        assertFalse(json.has("updated_at"))
        assertEquals(2, json.getAsJsonArray("track_ids").size())
        assertEquals(1000, json.get("position_ms").asInt)
    }
    @Test fun sleepDeadlineUsesElapsedClockAndEndOfTrackRequiresAutomaticTransition() {
        val timer = SleepPlan(deadline = 1000)
        assertFalse(timer.expired(999)); assertTrue(timer.expired(1000))
        val song = SleepPlan(entryId = "entry")
        assertTrue(song.endsOnTransition("entry", "next", true))
        assertTrue(song.endsOnTransition("entry", "entry", true))
        assertFalse(song.endsOnTransition("entry", "next", false))
        assertFalse(song.endsOnTransition("different", "next", true))
        assertFalse(SleepPlan().expired(Long.MAX_VALUE))
    }
}
