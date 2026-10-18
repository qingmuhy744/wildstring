package com.wildstring.app

import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.data.*
import com.wildstring.app.ui.MusicViewModel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Actual strict Pydantic contracts, only against the explicitly supplied disposable server. */
class RecommendationRealBackendTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun actualBackendSupportsPrivatePreferencesRankingsLocalAndExternalDiscoveryContracts() {
        val endpoint = InstrumentationRegistry.getArguments().getString("realBackend")
        assumeTrue("Disposable realBackend is required", endpoint != null)
        val vm = compose.runOnIdle { ViewModelProvider(compose.activity)[MusicViewModel::class.java] }
        compose.runOnIdle { vm.repository.session.invalidate(); vm.sharing.mode("off"); vm.connect(endpoint!!, "admin", "disposable-browser-test-password", true) }
        compose.waitUntil(20_000) { vm.state.value.connected && !vm.state.value.connecting }
        var original: RecommendationPreferences? = null
        try { runBlocking {
            val api = vm.repository.agentApi()
            original = api.recommendationPreferences()
            val saved = api.saveRecommendationPreferences(original!!.copy(connectionId = "local", useAi = false, count = 5,
                sources = listOf("personal", "community", "discovery", "revisit"), externalEnabled = false, externalUseAi = false,
                externalRefreshDays = 7))
            assertEquals("local", saved.connectionId); assertEquals(7, saved.externalRefreshDays)
            val daily = api.refreshDaily(); assertTrue(daily.items.size <= 5)
            assertEquals("local", daily.connectionId); assertFalse(daily.sourceStatus.isEmpty())
            daily.items.forEach { assertEquals(it.track.id, api.track(vm.repository.url("api", "v1", "tracks", it.track.id)).id) }
            val natural = api.discover(DiscoveryRequest("测试曲", connectionId = "local"))
            assertEquals("local", natural.mode); assertEquals("local", natural.connectionId)
            listOf("personal", "community").forEach { scope ->
                val ranking = api.listeningRankings(scope, "all", "listened_ms")
                assertEquals(scope, ranking.scope); assertEquals("all", ranking.period)
                assertTrue(ranking.items.all { it.track.id.isNotBlank() && it.rank > 0 })
            }
            val disabled = api.externalMusic()
            assertEquals("disabled", disabled.status); assertTrue(disabled.items.isEmpty())
            // No external source is enabled in this contract check: no live account or outbound music API is used.
            val manual = api.saveRecommendationPreferences(saved.copy(externalEnabled = true, externalSources = emptyList(), externalRefreshDays = 0))
            assertEquals(0, manual.externalRefreshDays)
            val external = api.refreshExternalMusic()
            assertTrue(external.status in listOf("empty", "manual", "ready", "unavailable"))
            assertEquals("local", external.connectionId); assertTrue(external.items.isEmpty())
            assertTrue(vm.agent.all("connections").all { it.text("id").isNotBlank() })
        } } finally {
            runBlocking { original?.let { old -> runCatching { val api = vm.repository.api(); val current = api.recommendationPreferences(); api.saveRecommendationPreferences(old.copy(version = current.version)) } } }
            compose.runOnIdle { vm.repository.session.invalidate() }
        }
    }
}
