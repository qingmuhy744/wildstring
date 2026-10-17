package com.wildstring.app

import com.google.gson.JsonParser
import com.wildstring.app.data.*
import com.wildstring.app.ui.*
import org.junit.Assert.*
import org.junit.Test

class RecommendationContractsTest {
    @Test fun localIsExplicitAndExternalModelUseRequiresSeparateConsent() {
        val gson = networkGson()
        val body = JsonParser.parseString(gson.toJson(DiscoveryRequest("摇滚"))).asJsonObject
        assertEquals("local", body["connection_id"].asString)
        val preferences = RecommendationPreferences()
        assertEquals("local", preferences.connectionId); assertFalse(preferences.useAi)
        assertFalse(preferences.externalEnabled); assertFalse(preferences.externalUseAi)
        assertEquals(7, preferences.externalRefreshDays); assertEquals(6, preferences.externalCallLimit)
        assertEquals(setOf("personal", "community", "discovery", "revisit"), preferences.sources.toSet())
    }
    @Test fun recommendationPreferencesPreserveIndependentExternalAndLocalSources() {
        val gson = networkGson()
        val value = gson.fromJson("""{"version":2,"connection_id":"personal-one","sources":["community"],"external_enabled":true,"external_use_ai":true,"external_sources":["lastfm_tags"],"external_refresh_days":14,"external_call_limit":8,"lastfm_tags":["rock"]}""", RecommendationPreferences::class.java)
        val saved = JsonParser.parseString(gson.toJson(value.copy(count = 30))).asJsonObject
        assertEquals(14, saved["external_refresh_days"].asInt); assertEquals(8, saved["external_call_limit"].asInt)
        assertEquals("lastfm_tags", saved["external_sources"].asJsonArray.single().asString)
        assertEquals("community", saved["sources"].asJsonArray.single().asString)
    }
    @Test fun oldPreviewSchemaRetainsSafeDefaultsAndBudgetIsNotAnotherPersonsDetail() {
        val response = networkGson().fromJson("""{"title":"候选","items":[],"mode":"local"}""", DiscoveryResult::class.java)
        assertEquals(emptyList<RecommendationWarning>(), response.warnings)
        assertEquals(emptyList<RecommendationSourceStatus>(), response.sourceStatus)
        val connection = JsonParser.parseString("""{"scope":"instance","daily_call_budget":20,"daily_calls_used":6,"my_usage":{"calls":2}}""").asJsonObject
        assertEquals("实例共享 · 每日预算 20 次 · 已用 6 次", connectionBudget(connection))
    }
    @Test fun externalCandidateIdentityIsNeverConvertedToPlayableTrackAndSourceLinksAreHttpsOnly() {
        val value = networkGson().fromJson("""{"id":"batch","status":"ready","items":[{"external_id":"external-hash","name":"库外歌曲","artists":["艺人"],"source_url":"https://www.last.fm/music/artist/song","reason":"真实资料","evidence":[],"local_track":null,"wanted":false}]}""", ExternalMusicResult::class.java)
        assertNull(value.items.single().localTrack)
        assertEquals("external-hash", value.items.single().externalId)
        assertNotNull(musicSourceUrl(value.items.single().sourceUrl))
        assertNull(musicSourceUrl(null)); assertNull(musicSourceUrl("javascript:alert(1)")); assertNull(musicSourceUrl("https://user:secret@example.com/path")); assertNull(musicSourceUrl("file:///music/example"))
    }
}
